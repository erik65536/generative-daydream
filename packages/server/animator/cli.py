"""Animator command line, called by the game server (packages/server/src/anim/animator.ts) one step at a time.

    python cli.py <step> <job-dir> '<json args>'

Steps: mesh, body, rig-human, skintokens, rig-auto, retarget. Each prints one JSON line with its result (or
{"error": ...} and exit code 1). Inputs and outputs are files in the job directory:
    input.png        the actor's standing view, cut out (front for humanoids, side for animals)
    mesh.glb         textured mesh (Pixal3D), mesh_input.png the cut-out it was made from
    body.glb         SAM 3D Body fit (humanoids)       skintokens.glb  SkinTokens rig (other bodies)
    rig.json, tex.png  the game rig the renderer reads clips.json  retargeted library clips (humanoids)
Needs numpy, scipy and Pillow (ComfyUI's embedded Python has them).
"""
import json, os, sys, traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    step, job = sys.argv[1], os.path.abspath(sys.argv[2])
    args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    os.makedirs(job, exist_ok=True)
    if step in ('mesh', 'body'):
        from comfy import Comfy
        import mesh
        comfy = Comfy(args.get('comfyUrl', 'http://127.0.0.1:8188'))
        res = mesh.mesh(comfy, job, os.path.join(job, 'input.png'), args.get('faces', 60000), args.get('seed', 56)) if step == 'mesh' else mesh.body(comfy, job)
    elif step == 'rig-human':
        from rig_human import rig_human
        res = rig_human(job, args.get('height', 1.8))
    elif step == 'skintokens':
        from skintokens import skintokens
        res = skintokens(job, args['dir'], args['python'], args.get('device', 'cuda'))
    elif step == 'rig-auto':
        from rig_auto import rig_auto
        res = rig_auto(job, args['body'], args.get('height', 1.0))
    elif step == 'retarget':
        from retarget import retarget
        res = retarget(job, args['library'], args['clips'])
    else:
        raise SystemExit(f'unknown step {step}')
    print(json.dumps({'ok': True, **res}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001 - reported to the server as one line
        print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}', 'trace': traceback.format_exc()[-2000:]}))
        sys.exit(1)
