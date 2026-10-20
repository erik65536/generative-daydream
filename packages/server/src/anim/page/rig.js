// Load a rig (animator's rig.json + tex.png) into a three.js SkinnedMesh with toon shading and an ink outline,
// and set up the game's isometric camera.
import * as THREE from 'three';

/** Game projection: a ground metre along x is 32 px across and 16 down; a metre of height is 82/1.75 px. */
export const PX_PER_M = 32 * Math.SQRT2; // 45.25 px per ground metre (orthographic, 30° elevation)
/** Figures stand taller than a true orthographic view (82 px for 1.75 m): stretch heights, not the ground. */
export const UP_STRETCH = 82 / 1.75 / (PX_PER_M * Math.cos(Math.PI / 6));

/** Screen directions, as yaw of the model (+Z forward) about +Y. S faces the viewer (down the screen). */
export const DIRS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
export const dirYaw = (i) => Math.PI / 4 - (i * Math.PI) / 4;

export async function loadRig(base, opts = {}) {
  const data = await (await fetch(`${base}/rig.json`)).json();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(data.pos, 3));
  if (data.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
  g.setIndex(data.idx);
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(data.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(data.skinWeight, 4));
  g.computeVertexNormals();
  const welded = weldedNormals(g); // the outline must not split open at UV seams

  const bones = data.bones.map((b) => Object.assign(new THREE.Bone(), { name: b.name }));
  const byName = Object.fromEntries(bones.map((b) => [b.name, b]));
  const pos = Object.fromEntries(data.bones.map((b) => [b.name, b.pos]));
  const root = new THREE.Group();
  data.bones.forEach((b, i) => {
    const p = b.parent ? pos[b.parent] : [0, 0, 0];
    bones[i].position.set(b.pos[0] - p[0], b.pos[1] - p[1], b.pos[2] - p[2]);
    (b.parent ? byName[b.parent] : root).add(bones[i]);
  });
  const skeleton = new THREE.Skeleton(bones);

  const tex = data.texture ? await new THREE.TextureLoader().loadAsync(`${base}/${data.texture}`) : null;
  if (tex) {
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  }
  // Three soft bands: shadow, half-light, light. Kept light: the game tints figures again with the place's light
  // (render/light.ts), as it does the painted stills, and two full shadings would make dark clothes black.
  const grad = new THREE.DataTexture(new Uint8Array([165, 165, 165, 255, 215, 215, 215, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
  grad.minFilter = grad.magFilter = THREE.LinearFilter;
  grad.needsUpdate = true;
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshToonMaterial({ map: tex, color: tex ? 0xffffff : 0x999999, gradientMap: grad, side: THREE.DoubleSide }));
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(skeleton);

  // Ink outline: the back faces pushed out along the welded normals (an inverted hull), in a near-black ink.
  const og = g.clone();
  og.setAttribute('normal', welded);
  const omat = new THREE.MeshBasicMaterial({ color: opts.ink ?? 0x15130f, side: THREE.BackSide });
  omat.onBeforeCompile = (sh) => {
    sh.uniforms.outline = { value: opts.outline ?? 0.014 };
    sh.vertexShader = 'uniform float outline;\n' + sh.vertexShader.replace('#include <project_vertex>', 'transformed += normalize(objectNormal) * outline;\n#include <project_vertex>');
  };
  const outline = new THREE.SkinnedMesh(og, omat);
  root.add(outline);
  outline.bind(skeleton, mesh.bindMatrix);

  const rest = Object.fromEntries(bones.map((b) => [b.name, { p: b.position.clone(), q: b.quaternion.clone() }]));
  const bindPos = Object.fromEntries(data.bones.map((b) => [b.name, new THREE.Vector3(...b.pos)]));
  return { root, mesh, outline, bones: byName, rest, bindPos, meta: data.meta, data };
}

function weldedNormals(g) {
  const p = g.attributes.position.array, n = g.attributes.normal.array, acc = new Map();
  const key = (i) => `${Math.round(p[i * 3] * 2000)},${Math.round(p[i * 3 + 1] * 2000)},${Math.round(p[i * 3 + 2] * 2000)}`;
  const count = p.length / 3;
  for (let i = 0; i < count; i++) {
    const k = key(i), a = acc.get(k) ?? [0, 0, 0];
    a[0] += n[i * 3]; a[1] += n[i * 3 + 1]; a[2] += n[i * 3 + 2];
    acc.set(k, a);
  }
  const out = new Float32Array(p.length);
  for (let i = 0; i < count; i++) {
    const a = acc.get(key(i)), l = Math.hypot(...a) || 1;
    out[i * 3] = a[0] / l; out[i * 3 + 1] = a[1] / l; out[i * 3 + 2] = a[2] / l;
  }
  return new THREE.BufferAttribute(out, 3);
}

export function resetPose(rig) {
  for (const [n, r] of Object.entries(rig.rest)) {
    rig.bones[n].position.copy(r.p);
    rig.bones[n].quaternion.copy(r.q);
  }
}

/**
 * The game's camera and light: orthographic at 30° elevation looking toward -x -y (ground x runs to the lower right),
 * `ppm` pixels per ground metre, with the ground origin at pixel (ax, ay) of a w × h frame. Key light from the
 * upper left of the screen.
 */
export function isoScene(w, h, ax, ay, ppm) {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x3a3630, 1.6));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
  sun.position.set(-4, 7, 1.5);
  scene.add(sun);
  const cam = new THREE.OrthographicCamera(-ax / ppm, (w - ax) / ppm, ay / ppm, -(h - ay) / ppm, 0.1, 100);
  const el = Math.PI / 6;
  cam.position.set(Math.cos(el) * Math.SQRT1_2 * 20, Math.sin(el) * 20, Math.cos(el) * Math.SQRT1_2 * 20);
  cam.lookAt(0, 0, 0);
  return { scene, cam };
}
