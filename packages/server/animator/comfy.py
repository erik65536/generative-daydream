"""A small ComfyUI HTTP client: upload, queue, wait, fetch."""
import json, os, time, urllib.parse, urllib.request, uuid


class Comfy:
    def __init__(self, base: str):
        self.base = base.rstrip('/')

    def _get(self, path: str) -> bytes:
        with urllib.request.urlopen(self.base + path, timeout=60) as r:
            return r.read()

    def upload(self, path: str, name: str) -> str:
        boundary = uuid.uuid4().hex
        data = open(path, 'rb').read()
        head = f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: image/png\r\n\r\n'
        tail = (f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="subfolder"\r\n\r\ngd_anim\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{boundary}--\r\n')
        req = urllib.request.Request(self.base + '/upload/image', data=head.encode() + data + tail.encode(),
                                     headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        out = json.loads(urllib.request.urlopen(req, timeout=120).read())
        return f"{out['subfolder']}/{out['name']}" if out.get('subfolder') else out['name']

    def run(self, wf: dict, timeout: float = 3600) -> tuple[dict, float]:
        """Queue a workflow and wait. Returns (outputs, seconds of execution)."""
        body = json.dumps({'prompt': wf, 'client_id': 'gd-animator'}).encode()
        req = urllib.request.Request(self.base + '/prompt', data=body, headers={'Content-Type': 'application/json'})
        q = json.loads(urllib.request.urlopen(req, timeout=60).read())
        if 'prompt_id' not in q:
            raise RuntimeError(f'ComfyUI did not queue: {json.dumps(q)[:1500]}')
        pid = q['prompt_id']
        t0 = time.time()
        while time.time() - t0 < timeout:
            time.sleep(1.0)
            h = json.loads(self._get('/history/' + pid)).get(pid)
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
