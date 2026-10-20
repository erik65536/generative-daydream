"""Minimal GLB reading: the first mesh primitive, its texture, and raw accessors (skins, animations)."""
import json, struct
import numpy as np

CT = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    """(json, accessor) for a .glb: accessor(i) returns accessor i as an array (rows per element)."""
    b = open(path, 'rb').read()
    jl = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + jl])
    bin_ = b[20 + jl + 8:]

    def acc(i):
        a = j['accessors'][i]
        v = j['bufferViews'][a['bufferView']]
        n = NC[a['type']]
        dt = CT[a['componentType']]
        arr = np.frombuffer(bin_, dtype=dt, count=a['count'] * n, offset=v.get('byteOffset', 0) + a.get('byteOffset', 0))
        arr = arr.reshape(a['count'], n) if n > 1 else arr
        if a.get('normalized') and dt != np.float32:
            arr = arr.astype(np.float32) / np.iinfo(dt).max
        return arr

    def view_bytes(i):
        v = j['bufferViews'][i]
        return bytes(bin_[v.get('byteOffset', 0): v.get('byteOffset', 0) + v['byteLength']])

    acc.view_bytes = view_bytes
    return j, acc


def read(path):
    """The first primitive of the first mesh: positions, faces, UVs, and its base-colour texture bytes."""
    j, acc = load(path)
    prim = j['meshes'][0]['primitives'][0]
    at = prim['attributes']
    out = {'pos': acc(at['POSITION']).astype(np.float32), 'idx': acc(prim['indices']).astype(np.uint32).reshape(-1, 3), 'json': j, 'acc': acc}
    if 'TEXCOORD_0' in at:
        out['uv'] = acc(at['TEXCOORD_0']).astype(np.float32)
    if j.get('images'):
        out['tex'] = acc.view_bytes(j['images'][0]['bufferView'])
    return out


def node_matrix(n):
    if 'matrix' in n:
        return np.array(n['matrix'], float).reshape(4, 4).T
    from riglib import quat_mat
    M = np.eye(4)
    M[:3, :3] = quat_mat(n.get('rotation', [0, 0, 0, 1])) * np.array(n.get('scale', [1, 1, 1]))
    M[:3, 3] = n.get('translation', [0, 0, 0])
    return M
