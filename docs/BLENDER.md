# Blender model and render export

Open **Export geometry**, choose **Blender render package**, then extract the ZIP into a folder. On Windows, double-click `Render.cmd`. It finds Blender 4.2 at its default installation location or `blender` on PATH. The script creates an editable `model.blend` project and a transparent `render.png`, then opens the PNG. If Blender reports an error, the command window stays open so you can inspect it and retry.

On macOS or Linux, run this in the extracted folder:

```sh
blender --background --threads 4 --python-exit-code 1 --python blender-render.py
```

You can also import `model.glb` in Blender through **File → Import → glTF 2.0**. The GLB contains the viewport's tessellated solids with affine transforms, component names and material colors. Physical dimensions are converted to metres; Fairbeam Z-up is converted to glTF Y-up and the Blender importer restores Z-up. Approximate bounding-box geometry is refused instead of exported as a solid.

The package contains model geometry rather than simulation field overlays, ports, grids or selections. Flat metal stays a surface. Colors use component overrides or the current theme's scene material colors. The rendering script adds an orthographic camera and three studio lights, uses CPU Cycles with four threads and 16 samples, and outputs 640 × 480 pixels. You can edit those settings in Blender after opening the project.

The converter needs no cloud service or extra JavaScript dependencies. Export validation:

```sh
node --experimental-strip-types scripts/check-blender-export.mjs
```

Pass an output folder to that check to write a transformed copper fixture GLB and the render script for a local Blender smoke test. The test verifies transformed bounds, metre scaling, axis conversion, component names, color, GLB structure and rejection of unsupported approximation.

API references: [Three.js GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html), [Blender command-line rendering](https://docs.blender.org/manual/en/4.2/advanced/command_line/index.html).

## Direct mesh files

Direct GLB uses metres and the glTF Y-up convention, preserving material colors, component folders and solid names. Direct binary STL uses **millimetres and Z-up**. STL has no standard unit, material or component hierarchy fields; select millimetres when importing it in CAD or a slicer. Both formats tessellate the actual transformed geometry and exclude simulation overlays, grids and ports. STL facet normals are computed from the exported vertices, including correct winding under reflected transforms.

Zero-thickness metal exports as a surface; export does not thicken it or guarantee a watertight, printable model. Empty scenes, approximate geometry, missing tessellation, non-finite vertices and singular transforms are refused. If any solid fails, the whole export fails rather than producing an incomplete file. STL coordinates that cannot fit finite float32 values are also refused.

For rendering, flat metallic surfaces touching another coplanar face receive a tiny normal offset through a modifier enabled only in the render, directed away from the other solid's center. This prevents coplanar copper and substrate faces from interfering, matching the viewport's depth bias. Original mesh vertices, physical dimensions and viewport geometry stay unchanged; sheets receive no thickness. The `renderBiasMeters` custom property records the signed adjustment. You can disable **Fairbeam render surface bias** in Blender to render the exact coincident surfaces.

Run `npm run check:mesh-export` for format checks covering binary facet structure, bounds, normals, reflection, physical units, sheets, GLB hierarchy and rejection of invalid geometry. To create a board/patch/reflected-feed fixture for Blender verification:

```sh
node --experimental-strip-types scripts/check-mesh-export.mjs /path/to/output-folder
```

The folder contains `model.glb`, `model-mm.stl` and `blender-render.py`. The render script writes a real Blender project and PNG using the bounded settings described above.

After rendering that fixture, reopen its `model.blend` in background mode with `scripts/check-blender-model.py`. This checks original sheet vertices, exact scene bounds, folder hierarchy, camera coverage and outward render-only biases, then produces `render-bottom.png` with the same bounded settings. Run it only when no local simulation is active.
