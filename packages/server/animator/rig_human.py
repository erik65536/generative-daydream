"""Humanoid rig: copy the skin of a SAM 3D Body (MHR) fit onto the generated mesh.

The MHR body is posed as in the image, aligned to the mesh by similarity ICP, its 127 bones folded into the game's
20-bone skeleton, and its skin weights copied to the mesh by nearest body points, then smoothed over the mesh.
The figure is stood up along its feet-to-neck axis (Pixal3D keeps the image's camera, which may look down a
little), turned to face +Z, scaled to `height` metres with its feet at y = 0.
"""
import os
import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation as R
import glb
from riglib import smooth_weights, top4, save_rig, quat_mat

# The game skeleton: (name, MHR joint index, parent). MHR's topology is fixed, so these indices are too.
GAME = [('hips', 1, None), ('spine', 34, 'hips'), ('spine1', 35, 'spine'), ('chest', 36, 'spine1'), ('neck', 110, 'chest'), ('head', 113, 'neck'),
        ('clavL', 74, 'chest'), ('upperL', 75, 'clavL'), ('foreL', 76, 'upperL'), ('handL', 77, 'foreL'),
        ('clavR', 38, 'chest'), ('upperR', 39, 'clavR'), ('foreR', 40, 'upperR'), ('handR', 41, 'foreR'),
        ('thighL', 2, 'hips'), ('shinL', 3, 'thighL'), ('footL', 4, 'shinL'),
        ('thighR', 18, 'hips'), ('shinR', 19, 'thighR'), ('footR', 20, 'shinR')]
NECK, ANKLE_L, ANKLE_R, HIP_L, HIP_R = 110, 4, 20, 2, 18


def posed_body(path):
    """The MHR body mesh in its fitted pose, its joints' positions, and per-vertex weights on the game bones."""
    j, acc = glb.load(path)
    prim = j['meshes'][0]['primitives'][0]
    bp = acc(prim['attributes']['POSITION']).astype(np.float64)
    bj = acc(prim['attributes']['JOINTS_0']).astype(int)
    bw = acc(prim['attributes']['WEIGHTS_0']).astype(np.float32)
    skin = j['skins'][0]; joints = skin['joints']
    ibm = acc(skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
    trs = {i: {'t': np.array(n.get('translation', [0, 0, 0]), float), 'r': np.array(n.get('rotation', [0, 0, 0, 1]), float), 's': np.array(n.get('scale', [1, 1, 1]), float)}
           for i, n in enumerate(j['nodes'])}
    anim = j['animations'][0]
    for ch in anim['channels']:
        path_ = ch['target']['path']
        if path_ not in ('translation', 'rotation', 'scale'):
            continue  # face morph weights
        trs[ch['target']['node']][path_[0]] = acc(anim['samplers'][ch['sampler']]['output'])[0].astype(float)
    par = {c: i for i, n in enumerate(j['nodes']) for c in n.get('children', [])}
    G = {}

    def glob_(i):
        if i not in G:
            M = np.eye(4); M[:3, :3] = quat_mat(trs[i]['r']) * trs[i]['s']; M[:3, 3] = trs[i]['t']
            G[i] = (glob_(par[i]) @ M) if i in par else M
        return G[i]

    S = np.stack([glob_(n) @ ibm[k] for k, n in enumerate(joints)])
    posed = np.zeros_like(bp)
    for k in range(bj.shape[1]):
        M = S[bj[:, k]]
        posed += bw[:, k:k + 1] * (np.einsum('nij,nj->ni', M[:, :3, :3], bp) + M[:, :3, 3])
    jpos = np.stack([glob_(n)[:3, 3] for n in joints])
    # Fold the 127 bones into the game bones: each MHR bone goes to its nearest game-bone ancestor.
    gidx = {m: g for g, (_, m, _) in enumerate(GAME)}
    jpar = [joints.index(par[n]) if par.get(n) in joints else -1 for n in joints]
    fold = np.zeros(len(joints), int)
    for k in range(len(joints)):
        a = k
        while a not in gidx and a >= 0:
            a = jpar[a]
        fold[k] = gidx.get(a, 0)
    fold[37] = gidx[36]  # the upper chest stays with the chest
    W = np.zeros((len(bp), len(GAME)), np.float32)
    for k in range(bj.shape[1]):
        np.add.at(W, (np.arange(len(bp)), fold[bj[:, k]]), bw[:, k])
    return posed, jpos, W


def _similarity(src, dst):
    ms, md = src.mean(0), dst.mean(0); A, B = src - ms, dst - md
    U, sv, Vt = np.linalg.svd(A.T @ B); d = np.sign(np.linalg.det(U @ Vt)); D = np.diag([1, 1, d])
    Rm = (U @ D @ Vt).T; s = (sv * np.diag(D)).sum() / (A ** 2).sum()
    return s, Rm, md - s * Rm @ ms


def align(body_pts, mesh_pts):
    """Similarity ICP of the body onto the mesh, from four starting turns; returns (transform, aligned, error)."""
    tree = cKDTree(mesh_pts)
    best = None
    for yaw in (0, 90, 180, 270):
        Ry = R.from_euler('y', yaw, degrees=True).as_matrix()
        src = body_pts @ Ry.T
        s0 = np.ptp(mesh_pts[:, 1]) / np.ptp(src[:, 1])
        off = (mesh_pts.min(0) + mesh_pts.max(0)) / 2 - (src.min(0) + src.max(0)) / 2 * s0
        T = np.eye(4); T[:3, :3] = Ry * s0; T[:3, 3] = off
        cur = src * s0 + off
        for _ in range(40):
            d, i = tree.query(cur)
            keep = d < np.percentile(d, 85)
            s, Rm, t = _similarity(cur[keep], mesh_pts[i[keep]])
            cur = s * cur @ Rm.T + t
            M = np.eye(4); M[:3, :3] = s * Rm; M[:3, 3] = t; T = M @ T
        err = tree.query(cur)[0].mean() + cKDTree(cur).query(mesh_pts)[0].mean()
        if best is None or err < best[2]:
            best = (T, cur, err)
    return best


def leg_cover(pos, joints) -> float:
    """How far (metres) the worse ankle is from the mesh around it, at its height. A leg in a boot is a few
    centimetres; a mesh that made the lower body one mass (a long coat down to the ground) leaves an ankle bare."""
    worst = 0.0
    for f in ('footL', 'footR'):
        a = joints[f]
        ring = pos[np.abs(pos[:, 1] - a[1]) < 0.03]
        d = float(np.linalg.norm(ring[:, [0, 2]] - a[[0, 2]], axis=1).min()) if len(ring) else 9.0
        worst = max(worst, d)
    return round(worst, 3)


def rig_human(job: str, height: float = 1.8) -> dict:
    mesh = glb.read(os.path.join(job, 'mesh.glb'))
    mp = mesh['pos'].astype(np.float64)
    posed, jpos, W_body = posed_body(os.path.join(job, 'body.glb'))
    T, aligned, err = align(posed, mp)
    jw = jpos @ T[:3, :3].T + T[:3, 3]
    # Weights: nearest body points, then smoothed over the mesh.
    d, i = cKDTree(aligned).query(mp, k=6)
    wi = 1 / (d + 1e-4); wi /= wi.sum(1, keepdims=True)
    W = smooth_weights(mp, mesh['idx'], (W_body[i] * wi[..., None]).sum(1), iters=12)
    # Stand up along the feet-to-neck axis, face +Z, metres, feet on the ground.
    up = jw[NECK] - (jw[ANKLE_L] + jw[ANKLE_R]) / 2; up /= np.linalg.norm(up)
    Rup = R.align_vectors([[0, 1, 0]], [up])[0].as_matrix(); ctr = mp.mean(0)
    mp = (mp - ctr) @ Rup.T + ctr; jw = (jw - ctr) @ Rup.T + ctr
    left = jw[HIP_L] - jw[HIP_R]; left[1] = 0; left /= np.linalg.norm(left)
    fwd = np.cross(left, [0, 1, 0]); yaw = np.arctan2(fwd[0], fwd[2])
    Ry = R.from_euler('y', -yaw).as_matrix()
    s = height / np.ptp(mp[:, 1])
    ground = mp[:, 1].min()
    gp = (mp - [0, ground, 0]) @ Ry.T * s; gj = (jw - [0, ground, 0]) @ Ry.T * s
    c = gj[GAME[0][1]].copy(); c[1] = 0
    gp -= c; gj -= c
    bones = [{'name': n, 'parent': p, 'pos': gj[m].tolist()} for n, m, p in GAME]
    idx4, w4 = top4(W)
    rel_err = float(err / np.ptp(mesh['pos'][:, 1]))
    meta = {'body': 'humanoid', 'height': height, 'alignError': round(rel_err, 4), 'levelledDeg': round(float(np.degrees(np.arccos(np.clip(up[1], -1, 1)))), 1),
            'legCover': leg_cover(gp, {n: gj[m] for n, m, _ in GAME})}
    out = save_rig(job, gp, mesh, idx4, w4, bones, meta)
    return {**out, **meta}
