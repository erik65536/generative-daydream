"""Retarget clips from a humanoid animation library (Quaternius Universal Animation Library: UE-style skeleton, CC0)
onto a rig made by rig_human.

Direction-based: each game bone gets the library bone's change of world rotation, after a rest offset that turns
the game bone's bind direction onto the library bone's rest direction, so A-pose and T-pose rigs map onto each
other. The hips' movement scales with leg length. Also measured per clip: the stride (metres the body travels per
loop, from how far a planted foot slides under the hips) and the event frame (the right hand's fastest moment:
the blow landing or the spell leaving the hand).
Writes clips.json: per clip, per frame, local quaternions for every game bone plus the hips offset in metres.
"""
import os, json
import numpy as np
from scipy.spatial.transform import Rotation as R, Slerp
import glb

MAP = {'hips': 'pelvis', 'spine': 'spine_01', 'spine1': 'spine_02', 'chest': 'spine_03', 'neck': 'neck_01', 'head': 'Head',
       'clavL': 'clavicle_l', 'upperL': 'upperarm_l', 'foreL': 'lowerarm_l', 'handL': 'hand_l',
       'clavR': 'clavicle_r', 'upperR': 'upperarm_r', 'foreR': 'lowerarm_r', 'handR': 'hand_r',
       'thighL': 'thigh_l', 'shinL': 'calf_l', 'footL': 'foot_l', 'thighR': 'thigh_r', 'shinR': 'calf_r', 'footR': 'foot_r'}
# The joint each bone points at, for rest directions.
SRC_CHILD = {'pelvis': 'spine_01', 'spine_01': 'spine_02', 'spine_02': 'spine_03', 'spine_03': 'neck_01', 'neck_01': 'Head', 'Head': None,
             'clavicle_l': 'upperarm_l', 'upperarm_l': 'lowerarm_l', 'lowerarm_l': 'hand_l', 'hand_l': 'middle_01_l',
             'clavicle_r': 'upperarm_r', 'upperarm_r': 'lowerarm_r', 'lowerarm_r': 'hand_r', 'hand_r': 'middle_01_r',
             'thigh_l': 'calf_l', 'calf_l': 'foot_l', 'foot_l': 'ball_l', 'thigh_r': 'calf_r', 'calf_r': 'foot_r', 'foot_r': 'ball_r'}
TGT_CHILD = {'hips': 'spine', 'spine': 'spine1', 'spine1': 'chest', 'chest': 'neck', 'neck': 'head', 'head': None,
             'clavL': 'upperL', 'upperL': 'foreL', 'foreL': 'handL', 'handL': None, 'clavR': 'upperR', 'upperR': 'foreR', 'foreR': 'handR', 'handR': None,
             'thighL': 'shinL', 'shinL': 'footL', 'footL': None, 'thighR': 'shinR', 'shinR': 'footR', 'footR': None}


def _unit(v):
    return v / max(np.linalg.norm(v), 1e-9)


class Library:
    def __init__(self, path):
        self.j, self.acc = glb.load(path)
        nodes = self.j['nodes']
        self.byname = {n.get('name'): i for i, n in enumerate(nodes)}
        self.par = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
        self.rest_t = {i: np.array(n.get('translation', [0, 0, 0]), float) for i, n in enumerate(nodes)}
        self.rest_r = {i: np.array(n.get('rotation', [0, 0, 0, 1]), float) for i, n in enumerate(nodes)}
        self.rest_s = {i: np.array(n.get('scale', [1, 1, 1]), float) for i, n in enumerate(nodes)}
        self.anims = {a['name']: a for a in self.j['animations']}
        names = set(MAP.values()) | {c for c in SRC_CHILD.values() if c}
        self.rest = {n: self.world({}, {}, self.byname[n]) for n in names}

    def world(self, tr, rr, i):
        chain = []
        k = i
        while k is not None:
            chain.append(k); k = self.par.get(k)
        Rw, P, S = R.identity(), np.zeros(3), np.ones(3)
        for k in reversed(chain):
            P = P + Rw.apply(S * tr.get(k, self.rest_t[k]))
            Rw = Rw * R.from_quat(rr.get(k, self.rest_r[k]))
            S = S * self.rest_s[k]
        return Rw, P

    def duration(self, anim):
        return max(float(self.acc(anim['samplers'][c['sampler']]['input']).max()) for c in anim['channels'])

    def sample(self, anim, time):
        tr, rr = {}, {}
        for ch in anim['channels']:
            node, path = ch['target']['node'], ch['target']['path']
            if path not in ('translation', 'rotation'):
                continue
            smp = anim['samplers'][ch['sampler']]
            ts, vs = self.acc(smp['input']).ravel(), self.acc(smp['output'])
            t = np.clip(time, ts[0], ts[-1])
            if len(ts) == 1:
                v = vs[0]
            else:
                k = int(np.clip(np.searchsorted(ts, t) - 1, 0, len(ts) - 2))
                f = (t - ts[k]) / max(ts[k + 1] - ts[k], 1e-9)
                v = vs[k] * (1 - f) + vs[k + 1] * f if path == 'translation' else Slerp([0, 1], R.from_quat([vs[k], vs[k + 1]]))(f).as_quat()
            (tr if path == 'translation' else rr)[node] = v
        return tr, rr


def retarget(job: str, library: str, clips: list) -> dict:
    """clips: [{name, source, fps}] — e.g. {'name': 'walk', 'source': 'Walk_Loop', 'fps': 12}."""
    lib = Library(library)
    rig = json.load(open(os.path.join(job, 'rig.json')))
    tb = {x['name']: x for x in rig['bones']}
    tpos = {k: np.array(v['pos']) for k, v in tb.items()}

    def tdir(name):
        c = TGT_CHILD[name]
        if c:
            return _unit(tpos[c] - tpos[name])
        if name == 'head':
            return np.array([0, 1, 0.])
        if name.startswith('hand'):
            return _unit(tpos[name] - tpos['fore' + name[-1]])
        return _unit(np.array([0, -0.35, 1.0]))  # feet: forward and a little down

    def sdir(name):
        c = SRC_CHILD[name]
        return _unit(lib.rest[c][1] - lib.rest[name][1]) if c else np.array([0, 1, 0.])

    # A library facing -Z (its left at -X) is turned around to face +Z like the rig.
    flip = R.from_euler('y', 180, degrees=True) if lib.rest['thigh_l'][1][0] < lib.rest['thigh_r'][1][0] else R.identity()
    offset = {t: R.align_vectors([flip.apply(sdir(s))], [tdir(t)])[0] for t, s in MAP.items()}
    scale = tpos['hips'][1] / lib.rest['pelvis'][1][1]
    order = [x['name'] for x in rig['bones']]  # parents first

    path = os.path.join(job, 'clips.json')
    out = json.load(open(path)) if os.path.exists(path) else {}
    for spec in clips:
        anim = lib.anims[spec['source']]
        fps = float(spec['fps'])
        dur = lib.duration(anim)
        loop = spec['source'].endswith('_Loop')
        n = max(2, int(round(dur * fps))) if loop else max(2, int(round(dur * fps)) + 1)
        frames, feet, hand = [], [], []
        p0 = None
        for f in range(n):
            tr, rr = lib.sample(anim, f / fps if loop else min(f / fps, dur))
            wrot = {}
            for t in order:
                Rw, _ = lib.world(tr, rr, lib.byname[MAP[t]])
                wrot[t] = flip * Rw * lib.rest[MAP[t]][0].inv() * flip.inv() * offset[t]
            loc = {t: np.round(((wrot[tb[t]['parent']].inv() * wrot[t]) if tb[t]['parent'] else wrot[t]).as_quat(), 5).tolist() for t in order}
            _, hp = lib.world(tr, rr, lib.byname['pelvis']); hp = flip.apply(hp)
            if p0 is None:
                p0 = hp.copy()
            off = np.array([hp[0] - p0[0], hp[1] - lib.rest['pelvis'][1][1], hp[2] - p0[2]]) * scale
            frames.append({'q': loc, 'hips': np.round(off, 4).tolist()})
            feet.append([flip.apply(lib.world(tr, rr, lib.byname[b])[1])[2] - hp[2] for b in ('foot_l', 'foot_r')])
            hand.append(flip.apply(lib.world(tr, rr, lib.byname['hand_r'])[1]))
        clip = {'fps': fps, 'loop': loop, 'source': spec['source'], 'frames': frames}
        if spec.get('stride'):
            # A planted foot slides back under the hips at the body's speed: measure that speed over the frames each
            # foot moves backward, and take the distance it covers in one loop.
            z = np.array(feet) * scale
            dz = np.roll(z, -1, axis=0) - z
            speeds = [-dz[:, k][dz[:, k] < 0].mean() * fps for k in range(2) if (dz[:, k] < 0).any()]
            clip['stride'] = round(float(np.mean(speeds)) * n / fps, 3)
        if spec.get('event'):
            v = np.linalg.norm(np.diff(np.array(hand), axis=0), axis=1)
            clip['event'] = int(np.argmax(v) + 1)
        out[spec['name']] = clip
    json.dump(out, open(path, 'w'))
    return {name: {'frames': len(c['frames']), **({'stride': c['stride']} if 'stride' in c else {}), **({'event': c['event']} if 'event' in c else {})} for name, c in out.items()}
