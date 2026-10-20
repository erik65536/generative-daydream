"""Shared rig helpers: weight smoothing, top-4 influences, texture look, and the rig file the renderer reads."""
import io, json, os
import numpy as np
import scipy.sparse as sp
from PIL import Image, ImageCms, ImageFilter


def quat_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def adjacency(n, idx):
    e = np.concatenate([idx[:, [0, 1]], idx[:, [1, 2]], idx[:, [2, 0]]])
    A = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    return ((A + A.T) > 0).astype(np.float32)


def smooth_weights(pos, idx, W, iters=10, keep=0.5):
    """Laplacian smoothing of per-vertex weights over the mesh, so seams and folds bend softly."""
    A = adjacency(len(pos), idx)
    deg = np.asarray(A.sum(1)).ravel(); deg[deg == 0] = 1
    Dinv = sp.diags(1 / deg)
    for _ in range(iters):
        W = keep * W + (1 - keep) * (Dinv @ (A @ W))
    return W / np.maximum(W.sum(1, keepdims=True), 1e-8)


def top4(W):
    idx = np.argsort(-W, 1)[:, :4]
    w = np.take_along_axis(W, idx, 1)
    w /= np.maximum(w.sum(1, keepdims=True), 1e-8)
    return idx.astype(np.uint16), w.astype(np.float32)


_srgb, _lab = ImageCms.createProfile('sRGB'), ImageCms.createProfile('LAB')
_to_lab = ImageCms.buildTransformFromOpenProfiles(_srgb, _lab, 'RGB', 'LAB')
_to_rgb = ImageCms.buildTransformFromOpenProfiles(_lab, _srgb, 'LAB', 'RGB')


def _signed_lab(img):
    a = np.asarray(ImageCms.applyTransform(img, _to_lab)).astype(np.float64)
    a[..., 1:] = np.where(a[..., 1:] > 127, a[..., 1:] - 256, a[..., 1:])  # PIL stores a/b as signed bytes
    return a


def texture_look(tex: Image.Image, reference: Image.Image) -> Image.Image:
    """TRELLIS bakes a flat, muddy albedo: match its colours to the painting (per-channel CDF matching in Lab,
    over the subject's pixels) and restore some crispness with an unsharp mask."""
    tex = tex.convert('RGB'); ref = reference.convert('RGB')
    s = _signed_lab(ref).reshape(-1, 3)
    s = s[np.asarray(ref).reshape(-1, 3).sum(1) > 24]  # the cut-out sits on black
    t = _signed_lab(tex)
    used = np.asarray(tex).sum(2) > 6  # skip empty atlas space
    out = t.copy()
    q = np.linspace(0, 1, 257)
    for c in range(3):
        tv = t[..., c][used]
        k = 0.85 if c == 0 else 0.7  # a full match on lightness overshoots the shading baked into the painting
        out[..., c][used] = (1 - k) * tv + k * np.interp(tv, np.quantile(tv, q), np.quantile(s[:, c], q))
    out[..., 0] = np.clip(out[..., 0], 0, 255)
    out[..., 1:] = np.clip(out[..., 1:], -128, 127)
    out[..., 1:] = np.where(out[..., 1:] < 0, out[..., 1:] + 256, out[..., 1:])
    rgb = ImageCms.applyTransform(Image.fromarray(np.round(out).astype(np.uint8), 'LAB'), _to_rgb)
    return rgb.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))


def save_rig(job, pos, mesh, idx4, w4, bones, meta):
    """Write rig.json (mesh, skin, bones in metres; +Y up, facing +Z, feet at y=0) and tex.png."""
    has_tex = 'tex' in mesh
    if has_tex:
        tex = Image.open(io.BytesIO(mesh['tex']))
        ref = os.path.join(job, 'mesh_input.png')
        if os.path.exists(ref):
            tex = texture_look(tex, Image.open(ref))
        tex.save(os.path.join(job, 'tex.png'))
    data = {'meta': meta, 'bones': bones, 'texture': 'tex.png' if has_tex else None,
            'pos': np.round(pos, 5).ravel().tolist(), 'uv': np.round(mesh['uv'], 5).ravel().tolist() if 'uv' in mesh else None,
            'idx': mesh['idx'].ravel().tolist(), 'skinIndex': idx4.ravel().tolist(), 'skinWeight': np.round(w4, 4).ravel().tolist()}
    json.dump(data, open(os.path.join(job, 'rig.json'), 'w'))
    return {'verts': int(len(pos)), 'bones': len(bones)}
