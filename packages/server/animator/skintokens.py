"""Run the SkinTokens auto-rigger (VAST, MIT; UniRig's successor) in its own Python environment.

It needs about 14 GB of GPU memory, so the server gives it the GPU alone (ComfyUI and the local LLM unloaded).
`device` 'cpu' works too, at about 12-18 minutes per mesh.
"""
import os, subprocess, time


def skintokens(job: str, st_dir: str, st_python: str, device: str = 'cuda') -> dict:
    out = os.path.join(job, 'skintokens.glb')
    env = {**os.environ, 'PYTHONIOENCODING': 'utf8', 'ST_DEVICE': device}
    t0 = time.time()
    log = os.path.join(job, 'skintokens.log')
    with open(log, 'w', encoding='utf8') as f:
        p = subprocess.run([st_python, 'demo.py', '--input', os.path.abspath(os.path.join(job, 'mesh.glb')), '--output', os.path.abspath(out)],
                           cwd=st_dir, env=env, stdout=f, stderr=subprocess.STDOUT)
    if p.returncode != 0 or not os.path.exists(out):
        tail = open(log, encoding='utf8', errors='replace').read()[-1500:]
        raise RuntimeError(f'SkinTokens failed ({p.returncode}): {tail}')
    return {'seconds': round(time.time() - t0, 1)}
