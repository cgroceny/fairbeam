"""Run with Blender --background --threads 4 --python blender-render.py.

Creates a real .blend project and a PNG next to model.glb, without network access.
"""
from pathlib import Path
import bpy
from mathutils import Vector

folder = Path(__file__).resolve().parent
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(folder / "model.glb"))
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0
meshes = [obj for obj in scene.objects if obj.type == "MESH"]
if not meshes:
    raise RuntimeError("No mesh objects in model.glb")
points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
lo = Vector([min(point[i] for point in points) for i in range(3)])
hi = Vector([max(point[i] for point in points) for i in range(3)])
center = (lo + hi) / 2
radius = max((hi - lo).length / 2, 1e-6)
# Viewport polygonOffset is not part of glTF. Coplanar copper sheets otherwise
# interfere with substrate faces in Cycles. Bias only the evaluated render;
# original mesh vertices, dimensions, transforms and viewport model stay exact.
for obj in meshes:
    data = obj.data
    metallic = any(material and material.use_nodes and any(
        node.type == "BSDF_PRINCIPLED" and node.inputs["Metallic"].default_value > 0.5
        for node in material.node_tree.nodes) for material in data.materials)
    if not metallic or not data.polygons:
        continue
    normal = data.polygons[0].normal.copy()
    origin = data.vertices[data.polygons[0].vertices[0]].co
    extent = max((vertex.co - origin).length for vertex in data.vertices)
    if normal.length == 0 or any(abs((vertex.co - origin).dot(normal)) > max(extent * 1e-7, 1e-12) for vertex in data.vertices):
        continue
    normal_scale = (obj.matrix_world.to_3x3() @ normal).length
    if normal_scale == 0:
        continue
    world_normal = (obj.matrix_world.to_3x3().inverted().transposed() @ normal).normalized()
    world_vertices = [obj.matrix_world @ vertex.co for vertex in data.vertices]
    world_origin = obj.matrix_world @ origin
    sheet_center = sum(world_vertices, Vector()) / len(world_vertices)
    sheet_lo = Vector([min(vertex[i] for vertex in world_vertices) for i in range(3)])
    sheet_hi = Vector([max(vertex[i] for vertex in world_vertices) for i in range(3)])
    tolerance = radius * 1e-7
    touching = None
    for other in meshes:
        if other == obj:
            continue
        for face in other.data.polygons:
            face_vertices = [other.matrix_world @ other.data.vertices[index].co for index in face.vertices]
            if len(face_vertices) < 3 or any(abs((vertex - world_origin).dot(world_normal)) > tolerance for vertex in face_vertices):
                continue
            face_lo = Vector([min(vertex[i] for vertex in face_vertices) for i in range(3)])
            face_hi = Vector([max(vertex[i] for vertex in face_vertices) for i in range(3)])
            if all(sheet_lo[i] <= face_hi[i] + tolerance and face_lo[i] <= sheet_hi[i] + tolerance for i in range(3)):
                touching = other
                break
        if touching:
            break
    if touching is None:
        continue
    other_center = sum([touching.matrix_world @ Vector(corner) for corner in touching.bound_box], Vector()) / 8
    sign = -1 if (sheet_center - other_center).dot(world_normal) < 0 else 1
    modifier = obj.modifiers.new("Fairbeam render surface bias", "DISPLACE")
    modifier.direction = "NORMAL"
    modifier.mid_level = 0
    modifier.strength = sign * radius * 1e-5 / normal_scale
    modifier.show_viewport = False
    modifier.show_render = True
    obj["renderBiasMeters"] = sign * radius * 1e-5
camera_data = bpy.data.cameras.new("Fairbeam camera")
camera = bpy.data.objects.new("Fairbeam camera", camera_data)
scene.collection.objects.link(camera)
camera.location = center + Vector((1.4, -1.8, 1.3)).normalized() * radius * 4
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = radius * 2.7
camera_data.clip_start = max(radius / 1000, 1e-7)
camera_data.clip_end = radius * 100
scene.camera = camera
world = bpy.data.worlds.new("Fairbeam studio")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.35, 0.35, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
scene.world = world
for name, direction, energy in [("Key", (1, -2, 3), 4), ("Fill", (-2, -1, 1), 2), ("Rim", (0, 2, 2), 3)]:
    light_data = bpy.data.lights.new(name, "AREA")
    # Power scales with area so millimetre and metre designs are equally lit.
    light_data.energy = energy * 100 * radius * radius
    light_data.shape = "DISK"
    light_data.size = radius * 3
    light = bpy.data.objects.new(name, light_data)
    scene.collection.objects.link(light)
    light.location = center + Vector(direction) * radius * 2
    light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.cycles.use_denoising = True
scene.render.threads_mode = "FIXED"
scene.render.threads = 4
scene.render.resolution_x = 640
scene.render.resolution_y = 480
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = True
scene.render.filepath = str(folder / "render.png")
bpy.ops.wm.save_as_mainfile(filepath=str(folder / "model.blend"))
bpy.ops.render.render(write_still=True)
print("Fairbeam: created model.blend and render.png")
