"""Image to textured mesh with Pixal3D (pixel-aligned TRELLIS.2), native ComfyUI nodes.

One straight-on view (front for people, side for animals) meshes best: several generated views at once get their
small differences averaged into a muddy texture.
"""
import os
from comfy import Comfy, saved_files, node as N


def mesh(comfy: Comfy, job: str, image: str, faces: int = 60000, seed: int = 56) -> dict:
    wf = {
        'img': N('LoadImage', image=comfy.upload(image, f'{os.path.basename(job)}_src.png')),
        'bgm': N('LoadBackgroundRemovalModel', bg_removal_name='birefnet.safetensors'),
        'mask': N('RemoveBackground', bg_removal_model=['bgm', 0], image=['img', 0]),
        'crop': N('ImageCropToMask', images=['img', 0], masks=['mask', 0], width=1024, height=1024, pad_factor=1.1, grow_mask=0, background='#000000'),
        'saveinput': N('SaveImage', images=['crop', 0], filename_prefix='gd_anim/input'),
        'dino': N('CLIPVisionLoader', clip_name='dino_v3_L_naf_fp32.safetensors'),
        'shapevae': N('VAELoader', vae_name='trellis_2_shape_vae_bf16.safetensors'),
        'texvae': N('VAELoader', vae_name='trellis_2_texture_vae_bf16.safetensors'),
        'unet': N('UNETLoader', unet_name='pixal3d_int8_convrot.safetensors', weight_dtype='default'),
        # Sampler wrappers as in ComfyUI's Pixal3D template (they reproduce the reference pipeline's guidance).
        'cfgA': N('CFGOverride', model=['unet', 0], cfg=1, start_percent=0.667, end_percent=1),
        'rescA': N('RescaleCFG', model=['cfgA', 0], multiplier=0.7),
        'msd3': N('ModelSamplingSD3', model=['rescA', 0], shift=5),
        'cfgB': N('CFGOverride', model=['unet', 0], cfg=1, start_percent=0.769, end_percent=1),
        'rescB': N('RescaleCFG', model=['cfgB', 0], multiplier=0.5),
        'mogem': N('LoadMoGeModel', model_name='moge_2_vitl_normal_fp16.safetensors'),
        'moge': N('MoGeInference', moge_model=['mogem', 0], image=['crop', 0], resolution_level=9, fov_x_degrees=0, batch_size=4, force_projection=True, apply_mask=True, refine_steps=0),
        'fov': N('MoGeGeometryToFOV', moge_geometry=['moge', 0], axis='horizontal', unit='degrees'),
        'cond': N('Pixal3DConditioning', clip_vision_model=['dino', 0], image=['crop', 0], camera_angle_x=['fov', 0]),
        'empty': N('EmptyTrellis2LatentStructure', batch_size=1),
        'ks1': N('KSampler', model=['msd3', 0], positive=['cond', 0], negative=['cond', 1], latent_image=['empty', 0], seed=seed, steps=12, cfg=7.5, sampler_name='euler', scheduler='normal', denoise=1),
        'struct': N('VaeDecodeStructureTrellis2', samples=['ks1', 0], vae=['shapevae', 0], resolution='32'),
        'shape': N('Trellis2ShapeStage', positive=['cond', 0], negative=['cond', 1], voxel=['struct', 0]),
        'ks2': N('KSampler', model=['rescB', 0], positive=['shape', 0], negative=['shape', 1], latent_image=['shape', 2], seed=seed + 1, steps=20, cfg=7.5, sampler_name='euler', scheduler='normal', denoise=1),
        'up': N('Trellis2UpsampleStage', positive=['shape', 0], negative=['shape', 1], shape_latent=['ks2', 0], vae=['shapevae', 0], target_resolution=1536),
        'ks3': N('KSampler', model=['rescB', 0], positive=['up', 0], negative=['up', 1], latent_image=['up', 2], seed=seed + 1, steps=12, cfg=7.5, sampler_name='euler', scheduler='simple', denoise=1),
        'dshape': N('VaeDecodeShapeTrellis', samples=['ks3', 0], vae=['shapevae', 0]),
        'tex': N('Trellis2TextureStage', positive=['up', 0], negative=['up', 1], shape_latent=['ks3', 0]),
        'ks4': N('KSampler', model=['unet', 0], positive=['tex', 0], negative=['tex', 1], latent_image=['tex', 2], seed=seed + 2, steps=12, cfg=1, sampler_name='euler', scheduler='normal', denoise=1),
        'dtex': N('VaeDecodeTextureTrellis', samples=['ks4', 0], vae=['texvae', 0], shape_subdivides=['dshape', 1]),
        # Keep small parts: boots under a long coat or a separate weapon are their own pieces, and dropping them
        # (the template drops anything under 1%) leaves a figure standing on its hem.
        'remesh': N('RemeshMesh', mesh=['dshape', 0], resolution=512, band=1, project_back=0, fix_poles=False, smooth_iters=20, drop_small_components=0.0005, precluster_max_verts=20000000,
                    **{'sign_mode': 'udf', 'sign_mode.qef': False, 'sign_mode.drop_inverted_components': True, 'sign_mode.drop_enclosed_components': False}),
        'dec': N('DecimateMesh', mesh=['remesh', 0], target_face_count=faces, placement_mode='midpoint'),
        'smooth': N('MeshSmoothNormals', mesh=['dec', 0], crease_angle=180),
        'uv': N('UnwrapMesh', mesh=['smooth', 0], segmenter='pec', resolution=2048, padding=2, weld_distance=0.0002),
        'bake': N('BakeTextureFromVoxel', mesh=['uv', 0], voxel_colors=['dtex', 0], texture_size=2048, reference_mesh=['dshape', 0]),
        'apply': N('ApplyTextureToMesh', mesh=['uv', 0], base_color=['bake', 0]),
        'save': N('SaveGLB', mesh=['apply', 0], filename_prefix='gd_anim/mesh'),
    }
    outs, dur = comfy.run(wf)
    for f in saved_files(outs):
        if f['filename'].endswith('.glb'):
            comfy.fetch(f, os.path.join(job, 'mesh.glb'))
        else:
            comfy.fetch(f, os.path.join(job, 'mesh_input.png'))
    return {'seconds': dur, 'shape': shape_check(job)}


def shape_check(job: str) -> float:
    """How well the mesh keeps the figure's proportions: its height-to-width ratio over the cut-out's (Pixal3D is
    pixel-aligned, so they agree). Well under 1 means parts were lost (boots under a coat, a weapon)."""
    import numpy as np
    from PIL import Image
    import glb
    a = np.asarray(Image.open(os.path.join(job, 'mesh_input.png')).convert('RGB')).astype(int).sum(2) > 24
    ys, xs = np.where(a)
    img_ratio = (np.ptp(ys) + 1) / (np.ptp(xs) + 1)
    p = glb.read(os.path.join(job, 'mesh.glb'))['pos']
    return round(float((np.ptp(p[:, 1]) / np.ptp(p[:, 0])) / img_ratio), 3)


def body(comfy: Comfy, job: str) -> dict:
    """Fit SAM 3D Body (Meta's MHR body: 127 joints, skinned) to the cut-out the mesh was made from."""
    wf = {
        'img': N('LoadImage', image=comfy.upload(os.path.join(job, 'mesh_input.png'), f'{os.path.basename(job)}_body.png')),
        'm': N('SAM3DBody_Loader', model_file='sam_3d_body_dinov3_bf16.safetensors'),
        'p': N('SAM3DBody_Predict', sam3d_body_model=['m', 0], image=['img', 0], run_hand_refinement=True, fov=0, batch_size=8),
        'f': N('BuildPoseFile', pose_data=['p', 0], sam3d_body_model=['m', 0], fps=24, camera_translation='off', track_index=-1,
               **{'format': 'glb', 'format.mesh_style': 'body_mesh', 'format.mesh_style.bone_vis': 'off', 'format.mesh_style.shader': 'default', 'format.bone_smooth_window': 0}),
        's': N('SaveGLB', mesh=['f', 0], filename_prefix='gd_anim/body'),
    }
    outs, dur = comfy.run(wf)
    files = saved_files(outs)
    if not files:
        raise RuntimeError('SAM 3D Body found no person in the image')
    comfy.fetch(files[0], os.path.join(job, 'body.glb'))
    return {'seconds': dur}
