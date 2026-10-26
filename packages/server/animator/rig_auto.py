"""Any body plan: bring a SkinTokens rig back onto the textured mesh and name its chains for procedural motion.

SkinTokens returns a normalised, unwelded copy of the mesh with an unnamed skeleton. The rig is mapped back by
bounding box, weights copied to the textured mesh by nearest point, then the body is stood up and its chains named:
- quadruped (any legged walker: dogs, crabs, spiders): the leaves near the ground are feet; each leg, hip to foot,
  gets its side, its place front to back and its gait phase; the path from the root to the leaf furthest along the
  body axis is the spine and head (spine0..n); chains behind the hips are the tail (tail0..n). A body with no
  legs hanging below it (a fish, a snake) keeps its painted pose, facing the way side views are painted, and has
  only a spine and tail.
- floater: no ground contact. It is levelled so its chains hang straight down from the root (tentacles), which
  also removes the camera tilt Pixal3D keeps from the image; every chain below the root is a tentacle.
"""
import os
import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation as R
import glb
from riglib import smooth_weights, top4, save_rig


def _skeleton(path):
    j, acc = glb.load(path)
    prim = j['meshes'][0]['primitives'][0]
    sj = acc(prim['attributes']['JOINTS_0']).astype(int)
    sw = acc(prim['attributes']['WEIGHTS_0']).astype(np.float32)
    skin = j['skins'][0]; joints = skin['joints']
    ibm = acc(skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
    bind = np.linalg.inv(ibm)[:, :3, 3]
    par_node = {c: i for i, n in enumerate(j['nodes']) for c in n.get('children', [])}
    parent = [joints.index(par_node[n]) if par_node.get(n) in joints else -1 for n in joints]
    mesh_node = next(i for i, n in enumerate(j['nodes']) if 'mesh' in n)
    M = np.eye(4); k = mesh_node
    while k is not None:
        M = glb.node_matrix(j['nodes'][k]) @ M; k = par_node.get(k)
    pos = acc(prim['attributes']['POSITION']).astype(np.float64) @ M[:3, :3].T + M[:3, 3]
    return pos, sj, sw, bind, parent


def rig_auto(job: str, body: str, height: float) -> dict:
    rp, sj, sw, bind, parent = _skeleton(os.path.join(job, 'skintokens.glb'))
    NJ = len(parent)
    mesh = glb.read(os.path.join(job, 'mesh.glb'))
    mp = mesh['pos'].astype(np.float64)
    # Same shape, different normalisation: map back by bounding box.
    s = np.ptp(mp, 0).max() / np.ptp(rp, 0).max()
    cm, cr = (mp.min(0) + mp.max(0)) / 2, (rp.min(0) + rp.max(0)) / 2
    rp = (rp - cr) * s + cm; bind = (bind - cr) * s + cm
    d, i = cKDTree(rp).query(mp, k=4)
    Wsrc = np.zeros((len(rp), NJ), np.float32)
    for k in range(sj.shape[1]):
        np.add.at(Wsrc, (np.arange(len(rp)), sj[:, k]), sw[:, k])
    wi = 1 / (d + 1e-5); wi /= wi.sum(1, keepdims=True)
    W = smooth_weights(mp, mesh['idx'], (Wsrc[i] * wi[..., None]).sum(1), iters=4)

    children = [[c for c in range(NJ) if parent[c] == k] for k in range(NJ)]
    leaves = [k for k in range(NJ) if not children[k]]
    root = next(k for k in range(NJ) if parent[k] < 0)

    def path_up(k, stop=None):
        out = [k]
        while parent[out[-1]] >= 0 and out[-1] != stop:
            out.append(parent[out[-1]])
        return out[::-1]

    names = [f'b{k}' for k in range(NJ)]
    meta = {'body': body, 'height': height}
    if body == 'quadruped':
        # Feet: every leaf near the lowest one (four for a dog, six or eight for a crab or spider), at least four.
        low = sorted(leaves, key=lambda k: bind[k, 1])
        reach = np.ptp(bind[:, 1])
        feet = [k for k in low if bind[k, 1] < bind[low[0], 1] + 0.12 * reach]
        feet = feet if len(feet) >= 4 else low[:4]
        # Legs hang below the body. Without two that do (a fish, a snake), it keeps the pose it was painted in and
        # moves on its spine and tail alone.
        if sum(bind[root, 1] - bind[k, 1] > 0.1 * np.ptp(mp[:, 1]) for k in leaves) < 2:
            feet = []
            Rup = np.eye(3)
        else:
            P = bind[feet]; n = np.linalg.svd(P - P.mean(0))[2][2]; n = n if n[1] > 0 else -n
            Rup = R.align_vectors([[0, 1, 0]], [n])[0].as_matrix()
    else:
        tips = [k for k in leaves if k != root]
        down = bind[tips].mean(0) - bind[root] if tips else np.array([0, -1.0, 0])
        Rup = R.align_vectors([[0, -1, 0]], [down / np.linalg.norm(down)])[0].as_matrix()
    ctr = mp.mean(0)
    mp = (mp - ctr) @ Rup.T + ctr; bind = (bind - ctr) @ Rup.T + ctr

    yaw = 0.0
    if body == 'quadruped' and not feet:
        # Side views are painted facing left, which the mesh keeps as -x: the head is the leaf furthest that way.
        head_leaf = min((k for k in leaves if k != root), key=lambda k: bind[k, 0], default=root)
        yaw = -np.pi / 2
    elif body == 'quadruped':
        fx = bind[feet][:, [0, 2]]
        ax = np.linalg.svd(fx - fx.mean(0))[2][0]
        mid = (fx @ ax).mean()
        others = [k for k in leaves if k not in feet]
        along = lambda k: bind[k, [0, 2]] @ ax - mid
        # The head is the far end that reaches highest; the tail droops.
        head_leaf = max(others, key=lambda k: abs(along(k)) + 0.5 * bind[k, 1])
        fwd = ax * np.sign(along(head_leaf))
        yaw = np.arctan2(fwd[0], fwd[1])
    Ry = R.from_euler('y', -yaw).as_matrix()
    ground = mp[:, 1].min()
    # Legless bodies lie along the ground: their length takes the size a standing body's height does.
    sc = height / (np.ptp(mp, 0).max() if body == 'quadruped' and not feet else np.ptp(mp[:, 1]))
    gp = (mp - [0, ground, 0]) @ Ry.T * sc; gj = (bind - [0, ground, 0]) @ Ry.T * sc
    c = gj[root].copy(); c[1] = 0
    gp -= c; gj -= c

    if body == 'quadruped':
        # Legs, front to back on each side, with their gait phase: four legs walk a lateral sequence (left hind,
        # left fore, right hind, right fore); more legs walk in alternating tripods.
        sides = {'L': [], 'R': []}
        for f in feet:
            sides['L' if gj[f, 0] > gj[feet, 0].mean() else 'R'].append(f)
        if min(len(v) for v in sides.values()) == 0:  # all on one side by the mean: split by order instead
            ordered = sorted(feet, key=lambda k: gj[k, 0])
            sides = {'R': ordered[:len(ordered) // 2], 'L': ordered[len(ordered) // 2:]}
        legs = []
        for side, fs in sides.items():
            for order, f in enumerate(sorted(fs, key=lambda k: -gj[k, 2])):
                leg = [f]
                while parent[leg[-1]] >= 0 and len(children[parent[leg[-1]]]) == 1:
                    leg.append(parent[leg[-1]])
                leg = leg[::-1]
                if len(feet) == 4:
                    phase = {('L', 1): 0.0, ('L', 0): 0.25, ('R', 1): 0.5, ('R', 0): 0.75}[(side, min(order, 1))]
                else:
                    phase = 0.5 * ((order + (side == 'R')) % 2)
                tag = f'{side}{order}'
                for n_, k in enumerate(leg):
                    names[k] = f'leg{tag}_{n_}'
                legs.append({'chain': [names[k] for k in leg], 'side': side, 'order': order, 'phase': phase, 'front': order == 0})
        meta['legs'] = legs
        spine = path_up(head_leaf)[1:]  # without the root
        for n_, k in enumerate(spine):
            if names[k].startswith('b'):
                names[k] = f'spine{n_}'
        meta['spine'] = [names[k] for k in spine if names[k].startswith('spine')]
        # Tail: chains behind the root that are neither legs nor spine, and have length.
        t = 0
        for k in range(NJ):
            if names[k].startswith('b') and gj[k, 2] < gj[root, 2] - 0.02 and np.linalg.norm(gj[k] - gj[max(parent[k], 0)]) > 0.01:
                names[k] = f'tail{t}'; t += 1
        meta['tail'] = [n_ for n_ in names if n_.startswith('tail')]
    else:
        for k in range(NJ):
            if k != root:
                names[k] = f'arm{k}'
        meta['tentacles'] = len(children[root])
    names[root] = 'root'

    order, seen = [], set()

    def visit(k):
        if k in seen:
            return
        if parent[k] >= 0:
            visit(parent[k])
        seen.add(k); order.append(k)
    for k in range(NJ):
        visit(k)
    bones = [{'name': names[k], 'parent': names[parent[k]] if parent[k] >= 0 else None, 'pos': gj[k].tolist()} for k in order]
    idx4, w4 = top4(W[:, order])
    out = save_rig(job, gp, mesh, idx4, w4, bones, meta)
    return {**out, 'body': body}
