import http from 'node:http';

/** A fake ComfyUI: prompts finish one poll after they are queued, each with one saved image. */
export function fakeComfy() {
  const history: Record<string, unknown> = {};
  const queued: { id: string; prompt: unknown; extra: unknown }[] = [];
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    const send = (v: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/prompt') {
      queued.push({ id: body.prompt_id, prompt: body.prompt, extra: body.extra_data });
      return send({ prompt_id: body.prompt_id, number: 1, node_errors: {} });
    }
    const h = /^\/history\/(.+)$/.exec(req.url ?? '');
    if (h) {
      const q = queued.find((x) => x.id === h[1]);
      if (q && !history[q.id]) {
        history[q.id] = { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } };
        return send({});
      }
      return send(history[h[1]!] ? { [h[1]!]: history[h[1]!] } : {});
    }
    if (req.url === '/queue') return send({ queue_running: [], queue_pending: [] });
    if (req.url?.startsWith('/view')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from('PNGDATA'));
    }
    if (req.url === '/free' || req.url === '/interrupt' || req.url === '/system_stats') return send({ devices: [] });
    res.writeHead(404);
    res.end();
  });
  return { server, calls, queued };
}

