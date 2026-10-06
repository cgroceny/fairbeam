"""Blender fixture QA: reopen generated patch model.blend and run this script.
Use --background --threads 4 --python-exit-code 1 --python scripts/check-blender-model.py.
Checks base geometry, hierarchy, camera coverage and render-only surface bias.
Also produces render-bottom.png using the fixture's bounded CPU render settings.
"""
from pathlib import Path
import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

scene = bpy.context.scene
meshes = [obj for obj in scene.objects if obj.type == "MESH"]
assert len(meshes) == 4
points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
lo = [min(point[i] for point in points) for i in range(3)]
hi = [max(point[i] for point in points) for i in range(3)]
assert all(abs(a - b) < 1e-7 for a, b in zip(lo, [-0.024, -0.018, 0]))
assert all(abs(a - b) < 1e-7 for a, b in zip(hi, [0.028, 0.019, 0.017]))
assert all(0 < point.x < 1 and 0 < point.y < 1 and point.z > 0
           for point in [world_to_camera_view(scene, scene.camera, corner) for corner in points])
patch, ground = bpy.data.objects["patch_1"], bpy.data.objects["ground_1"]
assert patch.parent.parent.name == ground.parent.parent.name == "Copper"
assert bpy.data.objects["board_1"].parent.parent.name == "Substrate"
assert patch["renderBiasMeters"] > 0 and ground["renderBiasMeters"] < 0
for obj, expected_z in [(patch, 0.0016), (ground, 0)]:
    assert all(abs((obj.matrix_world @ vertex.co).z - expected_z) < 1e-8 for vertex in obj.data.vertices)
    assert len(obj.modifiers) == 1
    modifier = obj.modifiers[0]
    assert modifier.show_render and not modifier.show_viewport
    assert modifier.name == "Fairbeam render surface bias"
for name in ["board_1", "reflected metal_1"]:
    assert not bpy.data.objects[name].modifiers
assert scene.render.threads == 4 and scene.cycles.samples == 16
assert scene.render.resolution_x <= 640 and scene.render.resolution_y <= 640
center = (Vector(lo) + Vector(hi)) / 2
camera = scene.camera
camera.location.z = center.z - abs(camera.location.z - center.z)
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
scene.render.filepath = str(Path(bpy.data.filepath).parent / "render-bottom.png")
bpy.ops.render.render(write_still=True)
print("Blender QA: exact base bounds, sheet vertices, hierarchy, framing and outward render-only biases pass")
