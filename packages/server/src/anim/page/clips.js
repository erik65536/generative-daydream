// Animation clips on the game rigs. Bind rotations are identity and world-aligned (the model faces +Z, its left
// is +X, up is +Y), so a procedural clip is a few angles per bone. Humanoids play retargeted library clips;
// quadrupeds and floaters are procedural, written against named chains rather than any one creature.
// Every clip: { frames, fps, loop, stride? (metres per loop), event? (frame the blow or spell lands), fn(rig, t) }.
import * as THREE from 'three';
import { resetPose } from './rig.js';

const D = Math.PI / 180;
const ease = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;
/** Piecewise-smooth keyframes: [[t, value], ...] with t in 0..1. */
function keys(k, t) {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (t <= k[i][0]) return lerp(k[i - 1][1], k[i][1], ease((t - k[i - 1][0]) / (k[i][0] - k[i - 1][0])));
  return k[k.length - 1][1];
}
const rot = (b, x = 0, y = 0, z = 0) => b && b.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x * D, y * D, z * D, 'YXZ')));
const phase = (p) => ((p % 1) + 1) % 1;

// ------------------------------------------------------------------------------------------------- library clips

/**
 * Clips retargeted by the animator (clips.json): local quaternions per bone per frame, plus the hips offset.
 * Clips that stay on the ground keep the lower ankle at its bind height (no floating, no sinking).
 */
export function libraryClips(json) {
  const out = {};
  for (const [name, c] of Object.entries(json)) {
    const n = c.frames.length;
    out[name] = {
      frames: n, fps: c.fps, loop: c.loop, stride: c.stride, event: c.event,
      fn(rig, t) {
        const fr = c.frames[Math.min(n - 1, Math.round(t * n))];
        for (const [b, q] of Object.entries(fr.q)) rig.bones[b]?.quaternion.set(q[0], q[1], q[2], q[3]);
        rig.bones.hips.position.add(new THREE.Vector3(...fr.hips));
        if (name === 'die') return;
        rig.root.updateMatrixWorld(true);
        const lift = Math.min(...['footL', 'footR'].map((f) => rig.root.worldToLocal(rig.bones[f].getWorldPosition(new THREE.Vector3())).y - rig.bindPos[f].y));
        rig.bones.hips.position.y -= lift;
      },
    };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- chains (model space)
const _m = new THREE.Matrix4();
function modelPos(rig, b) {
  rig.root.updateMatrixWorld(true);
  _m.copy(rig.root.matrixWorld).invert().multiply(rig.bones[b].matrixWorld);
  return new THREE.Vector3().setFromMatrixPosition(_m);
}
function modelQuat(rig, b) {
  _m.copy(rig.root.matrixWorld).invert().multiply(rig.bones[b].matrixWorld);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  _m.decompose(p, q, s);
  return q;
}
/** Rotate bone `b` by `q`, given in model space. */
function rotModel(rig, b, q) {
  const bone = rig.bones[b], parentQ = bone.parent === rig.root ? new THREE.Quaternion() : modelQuat(rig, bone.parent.name);
  bone.quaternion.copy(parentQ.clone().invert().multiply(q.clone().multiply(parentQ.multiply(bone.quaternion))));
  bone.updateMatrixWorld(true);
}
/** Hinge CCD: bend a chain only about the model X axis (its sagittal plane) until its end reaches `target`. */
function chainIK(rig, chain, target, iters = 10) {
  const end = chain[chain.length - 1];
  for (let it = 0; it < iters; it++)
    for (let i = chain.length - 2; i >= 0; i--) {
      const j = modelPos(rig, chain[i]), e = modelPos(rig, end);
      const a = Math.atan2(e.z - j.z, -(e.y - j.y)), b = Math.atan2(target.z - j.z, -(target.y - j.y));
      rotModel(rig, chain[i], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -(b - a) * 0.8));
    }
}

// ------------------------------------------------------------------------------------------------- quadruped
/** Legs (from rig_auto: chain hip to foot, side, front leg, gait phase), spine and tail. */
function quad(rig) {
  if (rig._quad) return rig._quad;
  const m = rig.meta;
  const legs = (m.legs ?? []).filter((l) => l.chain.length >= 2).map((l) => ({ ...l, foot: l.chain.at(-1) }));
  return (rig._quad = { legs, spine: m.spine ?? [], tail: m.tail ?? [] });
}
const bend = (rig, names, pitch, yaw, roll = 0) => names.forEach((b) => rot(rig.bones[b], pitch / names.length, yaw / names.length, roll / names.length));
/** The neck and head: the front third of the spine. */
const neck = (Q) => Q.spine.slice(Math.floor(Q.spine.length * 0.6));
const back = (Q) => Q.spine.slice(0, Math.floor(Q.spine.length * 0.6));
function tail(rig, Q, t, amp, lift = 0) {
  Q.tail.forEach((b, i) => rot(rig.bones[b], lift / Math.max(1, Q.tail.length), amp * Math.sin(2 * Math.PI * t - i * 0.7) / Math.max(1, Q.tail.length) * 2, 0));
}
function plant(rig, Q, footAt) {
  rig.root.updateMatrixWorld(true);
  for (const L of Q.legs) chainIK(rig, L.chain.slice(1), footAt(L, rig.bindPos[L.foot]));
}
/** A gait: stance share, step height, stride, how much the body pitches and bobs; `gallop` lands four legs in pairs. */
function gait(o) {
  return {
    frames: o.frames, fps: o.fps, loop: true, stride: o.stride,
    fn(rig, t) {
      const Q = quad(rig), S = o.stride / 2;
      rig.bones.root.position.y += -o.bob + o.bob * Math.cos(4 * Math.PI * t);
      if (o.pitch) rot(rig.bones.root, o.pitch * Math.sin(2 * Math.PI * t), 0, 0);
      bend(rig, back(Q), 0, 5 * Math.sin(2 * Math.PI * t));
      bend(rig, neck(Q), o.nod * Math.cos(4 * Math.PI * t), 0);
      tail(rig, Q, t, o.tail, o.tailLift ?? 0);
      plant(rig, Q, (L, r) => {
        // Four legs gallop: hind pair, then fore pair, each foot a little after its partner. More legs keep their phases.
        const off = o.gallop && Q.legs.length === 4 ? (L.front ? 0.45 : 0) + (L.side === 'R' ? 0.1 : 0) : L.phase;
        const p = phase(t + off);
        let z, y = r.y;
        if (p < o.stance) z = lerp(S, -S, p / o.stance);
        else {
          const q = (p - o.stance) / (1 - o.stance);
          z = lerp(-S, S, ease(q));
          y += o.lift * Math.sin(Math.PI * q);
        }
        return new THREE.Vector3(r.x, y, r.z + z);
      });
    },
  };
}
export const QUADRUPED = {
  idle: { frames: 16, fps: 8, loop: true, fn(rig, t) {
    const Q = quad(rig), s = Math.sin(2 * Math.PI * t);
    rig.bones.root.position.y += -0.008 + 0.006 * s;
    bend(rig, neck(Q), 2 * s, 8 * Math.sin(2 * Math.PI * t + 1));
    tail(rig, Q, t, 10);
    plant(rig, Q, (L, r) => r.clone());
  } },
  walk: gait({ frames: 12, fps: 12, stride: 0.6, stance: 0.65, lift: 0.07, bob: 0.012, nod: 3, tail: 12 }),
  // A gallop-like run: a longer stride with a suspension, legs landing closer together, the body rocks.
  run: gait({ frames: 10, fps: 14, stride: 1.5, gallop: true, stance: 0.4, lift: 0.14, bob: 0.03, pitch: 5, nod: 6, tail: 6, tailLift: 15 }),
  attack: { frames: 12, fps: 14, loop: false, event: 6, fn(rig, t) {
    // Crouch back, lunge and bite, recover.
    const Q = quad(rig);
    rig.bones.root.position.add(new THREE.Vector3(0, keys([[0, 0], [0.35, -0.07], [0.5, -0.02], [1, 0]], t), keys([[0, 0], [0.35, -0.08], [0.5, 0.18], [0.65, 0.15], [1, 0]], t)));
    bend(rig, neck(Q), keys([[0, 0], [0.35, -12], [0.5, 22], [0.65, 18], [1, 0]], t), 0);
    tail(rig, Q, t * 2, 6, keys([[0, 0], [0.35, -15], [0.5, 10], [1, 0]], t));
    plant(rig, Q, (L, r) => {
      const f = L.front;
      return new THREE.Vector3(r.x, r.y + (f ? keys([[0, 0], [0.38, 0], [0.45, 0.08], [0.55, 0], [1, 0]], t) : 0), r.z + (f ? keys([[0, 0], [0.38, 0], [0.55, 0.16], [0.7, 0.16], [1, 0]], t) : 0));
    });
  } },
  // A howl: the head rises, the chest lifts, the hind legs sit a little.
  cast: { frames: 12, fps: 10, loop: false, event: 6, fn(rig, t) {
    const Q = quad(rig), up = keys([[0, 0], [0.4, 1], [0.75, 1], [1, 0]], t);
    rot(rig.bones.root, -10 * up, 0, 0);
    bend(rig, neck(Q), -45 * up, 0);
    tail(rig, Q, t, 4, -10 * up);
    plant(rig, Q, (L, r) => r.clone());
  } },
  hit: { frames: 6, fps: 15, loop: false, fn(rig, t) {
    const Q = quad(rig), k = keys([[0, 0], [0.25, 1], [1, 0]], t);
    rig.bones.root.position.add(new THREE.Vector3(0, -0.03 * k, -0.08 * k));
    bend(rig, neck(Q), 15 * k, 10 * k);
    plant(rig, Q, (L, r) => r.clone());
  } },
  // Collapse: the legs give, the body drops and rolls onto its side.
  die: { frames: 18, fps: 12, loop: false, fn(rig, t) {
    const Q = quad(rig), k = keys([[0, 0], [0.5, 0.6], [0.8, 1], [1, 1]], t);
    const h = rig.bindPos.root.y;
    rig.bones.root.position.y -= h * 0.62 * k;
    rot(rig.bones.root, 0, 0, -80 * keys([[0, 0], [0.45, 0.1], [0.85, 1], [1, 1]], t));
    bend(rig, neck(Q), 25 * k, 0);
    for (const L of Q.legs) L.chain.slice(1).forEach((b, i) => rot(rig.bones[b], (i % 2 ? -1 : 1) * 25 * k, 0, 0));
  } },
};

// ------------------------------------------------------------------------------------------------- floater
// Any body that hovers on hanging chains (tentacles, streamers): every bone gets its depth below the root and the
// branch it hangs from; a wave runs down each branch. Nothing here knows how many there are.
function float(rig) {
  if (rig._fl) return rig._fl;
  const bones = rig.data.bones, root = bones.find((b) => !b.parent).name;
  const depth = {}, branch = {};
  let nb = 0;
  for (const b of bones) {
    if (!b.parent) { depth[b.name] = 0; continue; }
    depth[b.name] = depth[b.parent] + 1;
    branch[b.name] = b.parent === root ? nb++ : branch[b.parent];
  }
  const low = Object.fromEntries(bones.map((b) => [b.name, rig.bindPos[b.name].y < rig.bindPos[root].y - 0.05]));
  return (rig._fl = { root, depth, branch, nb: Math.max(1, nb), low, bones });
}
function sway(rig, F, t, amp, lean = 0, speed = 1, spread = 0) {
  for (const b of F.bones) {
    if (!b.parent || !F.low[b.name]) continue;
    const d = F.depth[b.name], k = F.branch[b.name] ?? 0, ph = 2 * Math.PI * (t * speed - d * 0.12 + k / F.nb);
    const out = spread * (d === 1 ? 1 : 0.3);
    rot(rig.bones[b.name], amp * Math.sin(ph) + lean + out * Math.cos((2 * Math.PI * k) / F.nb), 0, amp * 0.6 * Math.cos(ph + k) + out * Math.sin((2 * Math.PI * k) / F.nb));
  }
}
const HOVER = 0.25;
export const FLOATER = {
  idle: { frames: 16, fps: 8, loop: true, fn(rig, t) {
    const F = float(rig);
    rig.bones[F.root].position.y += HOVER + 0.04 * Math.sin(2 * Math.PI * t);
    sway(rig, F, t, 7);
  } },
  walk: { frames: 12, fps: 10, loop: true, stride: 0.5, fn(rig, t) {
    const F = float(rig);
    rig.bones[F.root].position.y += HOVER + 0.03 * Math.sin(4 * Math.PI * t);
    rot(rig.bones[F.root], 10, 0, 0);
    sway(rig, F, t, 9, -10, 2);
  } },
  run: { frames: 10, fps: 12, loop: true, stride: 1.0, fn(rig, t) {
    const F = float(rig);
    rig.bones[F.root].position.y += HOVER + 0.05 * Math.sin(4 * Math.PI * t);
    rot(rig.bones[F.root], 20, 0, 0);
    sway(rig, F, t, 8, -22, 2.5);
  } },
  attack: { frames: 12, fps: 12, loop: false, event: 6, fn(rig, t) {
    const F = float(rig);
    rig.bones[F.root].position.add(new THREE.Vector3(0, HOVER + keys([[0, 0], [0.35, 0.08], [0.5, -0.02], [1, 0]], t), keys([[0, 0], [0.35, -0.05], [0.5, 0.12], [1, 0]], t)));
    rot(rig.bones[F.root], keys([[0, 0], [0.35, -14], [0.5, 18], [0.7, 12], [1, 0]], t), 0, 0);
    sway(rig, F, t, 5, keys([[0, 0], [0.35, -25], [0.5, 40], [0.7, 25], [1, 0]], t) / 4);
  } },
  // A pulse: the tentacles flare out and the body rises, then draws in.
  cast: { frames: 12, fps: 10, loop: false, event: 5, fn(rig, t) {
    const F = float(rig), k = keys([[0, 0], [0.4, 1], [0.7, 1], [1, 0]], t);
    rig.bones[F.root].position.y += HOVER + 0.1 * k;
    sway(rig, F, t, 4, 0, 1, 28 * k);
  } },
  hit: { frames: 6, fps: 15, loop: false, fn(rig, t) {
    const F = float(rig), k = keys([[0, 0], [0.25, 1], [1, 0]], t);
    rig.bones[F.root].position.add(new THREE.Vector3(0, HOVER - 0.04 * k, -0.08 * k));
    rot(rig.bones[F.root], -12 * k, 0, 6 * k);
    sway(rig, F, t, 4, 10 * k);
  } },
  // Sinks to the ground, tentacles going limp and spreading.
  die: { frames: 18, fps: 12, loop: false, fn(rig, t) {
    const F = float(rig), k = keys([[0, 0], [0.7, 1], [1, 1]], t);
    rig.bones[F.root].position.y += HOVER * (1 - k) - rig.bindPos[F.root].y * 0.45 * k;
    rot(rig.bones[F.root], 0, 0, 35 * k);
    sway(rig, F, t * 0.3, 3 * (1 - k), 12 * k, 1, 22 * k);
  } },
};

export const PROCEDURAL = { quadruped: QUADRUPED, floater: FLOATER };

export function pose(rig, clip, t) {
  resetPose(rig);
  clip.fn(rig, t);
  rig.root.updateMatrixWorld(true);
}
