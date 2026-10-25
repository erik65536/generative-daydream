"""A small ComfyUI HTTP client: upload, queue, wait, fetch.

Behind the GPU broker (docs/gpu-broker.md) it sends the broker's token (GD_COMFY_TOKEN), does not count time a
prompt spends waiting for its turn (the X-Broker-State header), and sends a prompt again when a restarted broker
no longer knows it (404).
"""
import json, os, time, urllib.error, urllib.parse, urllib.request, uuid


class Comfy:
    def __init__(self, base: str):
        self.base = base.rstrip('/')
        token = os.environ.get('GD_COMFY_TOKEN')
        self.auth = {'Authorization': f'Bearer {token}'} if token else {}

    def _open(self, path: str, data: bytes | None = None, headers: dict | None = None, timeout: float = 60):
        req = urllib.request.Request(self.base + path, data=data, headers={**self.auth, **(headers or {})})
        return urllib.request.urlopen(req, timeout=timeout)

    def _get(self, path: str) -> bytes:
        with self._open(path) as r:
            return r.read()

    def upload(self, path: str, name: str) -> str:
        boundary = uuid.uuid4().hex
        data = open(path, 'rb').read()
        head = f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: image/png\r\n\r\n'
        tail = (f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="subfolder"\r\n\r\ngd_anim\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{boundary}--\r\n')
        out = json.loads(self._open('/upload/image', head.encode() + data + tail.encode(),
                                    {'Content-Type': f'multipart/form-data; boundary={boundary}'}, timeout=120).read())
        return f"{out['subfolder']}/{out['name']}" if out.get('subfolder') else out['name']

    def run(self, wf: dict, timeout: float = 3600) -> tuple[dict, float]:
        """Queue a workflow and wait. Returns (outputs, seconds of execution)."""
        # The server's tag (which process and job queued it) for the admin GPU page.
        try:
            tag = json.loads(os.environ.get('GD_PROMPT_TAG') or 'null')
        except ValueError:
            tag = None
        for _attempt in range(3):
            res = self._queue_and_wait(wf, tag, timeout)
            if res is not None:
                return res
        raise RuntimeError('the GPU broker keeps forgetting this prompt (restarting?)')

    def _queue_and_wait(self, wf: dict, tag, timeout: float):
        body = json.dumps({'prompt': wf, 'prompt_id': str(uuid.uuid4()), 'client_id': 'gd-animator', 'extra_data': {'gd': tag} if tag else {}}).encode()
        q = json.loads(self._open('/prompt', body, {'Content-Type': 'application/json'}).read())
        if 'prompt_id' not in q:
            raise RuntimeError(f'ComfyUI did not queue: {json.dumps(q)[:1500]}')
        pid = q['prompt_id']
        used, last = 0.0, time.time()
        while used < timeout:
            time.sleep(1.0)
            state = ''
            # ComfyUI can stop answering for a while under heavy load (a big model loading); the job is still queued.
            try:
                with self._open('/history/' + pid) as r:
                    state = r.headers.get('X-Broker-State') or ''
                    h = json.loads(r.read()).get(pid)
            except urllib.error.HTTPError as e:
                # ComfyUI answers {} for a prompt it does not know; only the broker answers 404: it forgot (restarted).
                if e.code == 404:
                    return None
                h = None
            except OSError:
                h = None
            now = time.time()
            # Time spent waiting for the broker to give this prompt its turn does not count.
            if not state.startswith('queued'):
                used += now - last
            last = now
            if not h:
                continue
            st = h.get('status', {})
            if st.get('status_str') == 'error':
                msg = [m[1] for m in st.get('messages', []) if m[0] == 'execution_error']
                raise RuntimeError(f"ComfyUI error: {(msg[0].get('exception_message') if msg else 'unknown')}"[:1500])
            if st.get('completed'):
                msgs = {m[0]: m[1] for m in st.get('messages', [])}
                dur = (msgs.get('execution_success', {}).get('timestamp', 0) - msgs.get('execution_start', {}).get('timestamp', 0)) / 1000
                return h.get('outputs', {}), dur
        raise TimeoutError(f'ComfyUI prompt {pid} timed out')

    def fetch(self, item: dict, dest: str) -> str:
        q = urllib.parse.urlencode({'filename': item['filename'], 'subfolder': item.get('subfolder', ''), 'type': item.get('type', 'output')})
        open(dest, 'wb').write(self._get('/view?' + q))
        return dest


def saved_files(outputs: dict) -> list[dict]:
    """Every file a workflow saved (images and 3D), in node order."""
    res = []
    for o in outputs.values():
        for v in o.values():
            if isinstance(v, list):
                res += [x for x in v if isinstance(x, dict) and 'filename' in x]
    return res


def node(cls: str, **inputs) -> dict:
    return {'class_type': cls, 'inputs': inputs}
