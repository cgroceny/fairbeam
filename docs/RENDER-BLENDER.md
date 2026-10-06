# Rendering through Blender

Fairbeam can render a design with the user's own Blender: Cycles, area-light studio lighting, physically based
materials. It is for papers, slides and posts. The run server starts Blender **in the background**
(`blender -b --factory-startup -P blender_render.py -- job.json`): no add-on, no socket, no window, and a Blender the
user has open is never touched. The in-app renderer (three.js) keeps working without Blender.

## Finding Blender

In this order: the path in Settings › General › Blender (Browse… and Detect), the `FAIRBEAM_BLENDER` environment
variable, `blender` on PATH, then the platform's usual install location (Windows: the newest
`%ProgramFiles%\Blender Foundation\Blender *\blender.exe`; macOS: `/Applications/Blender.app/Contents/MacOS/Blender`;
Linux: `/snap/bin`, `/usr/local/bin`, `/usr/bin`). Blender 3.6 or newer is required, 4.x preferred. `GET /api/blender`
(`?path=` to test one) reports `{found, ok, path, source, version, label}`. When none is found the UI says so and links
blender.org (`POST /api/blender/open-download` opens that one fixed address in the system browser).

## API (python/fairbeam/server.py, blender_job.py)

| Route | |
| --- | --- |
| `POST /api/render-jobs` | start a render, body below; 201 with the job |
| `GET /api/render-jobs/<id>` | the job: `status` (queued, running, done, failed, cancelled), `progress` 0..1, `angle_index`/`angle_count`/`angle`, `sample`/`samples`, `device`, `images[]` (each as soon as it is written), `blend`, `folder`, `error`, `elapsed_s` |
| `POST /api/render-jobs/<id>/cancel` | kills only that Blender process (its job object on Windows); partial images are removed |
| `GET /api/renders/<design>` | the folder's PNGs and `.blend` files, newest first (the same list the in-app renderer fills); `GET /api/renders/<design>/file/<file>` serves one of them; nothing else is served (the name is matched against a strict pattern and the resolved path must be a direct child of `renders/<design>/`) |
| `POST /api/renders/<design>/open` | `{}` or `{what: "folder"}` shows the folder in the file manager; `{what: "blend", file}` launches Blender (GUI) on a saved `.blend` |

Request body of `POST /api/render-jobs`: `design_id`, `options` (`RenderOptions`, below), `glb_base64` (the design's geometry
as a GLB, from `src/export/blender.ts` `blenderGlb`, at most 120 MB), `parts` (`[{name, kind: metal|dielectric|void,
material, library, color, eps_r}]`: the GLB carries part names, this carries what the look table keys on), `ports` and
`lumped` (start/stop in **metres**, direction), `save_blend` (default true), `device` (`auto|cpu|gpu`), `blender`
(path override). One render runs at a time; later ones wait (`queued`).

`RenderOptions` (src/render/options.ts of the in-app renderer; `engine` is `"blender"` here): `angles[]` (`iso`, `top`,
`front`, `right`, `back`, `left`, `bottom`, or `{name, direction:[x,y,z], up}` for the viewer's current view; a bare
`"current"` renders iso), `width`, `height` (16 to 8192), `background` (`transparent`, `studio`, `dark`), `ports` (`auto`,
`connector`, `marker`, `hidden`), `solderMask` (`none`, `green`), `groundShadow`, `projection` (`perspective`,
`orthographic`), `quality` (`preview`: Cycles 32 samples + denoiser; `final`: 256 samples + denoiser; GPU through
OptiX/CUDA/HIP/Metal/oneAPI when Cycles finds one, else CPU).

Output: `<workspace>/renders/<design-id>/<design>_<angle>_<YYYYMMDD-HHMMSS>.png` (RGBA) and
`<design>_<YYYYMMDD-HHMMSS>.blend` (the scene with materials, lights and the first angle's camera, to open and tweak).
Progress comes from Blender's own stdout (`Fra:1 … | Sample 12/32`) and the script's `@AL …` marker lines.

## The Blender script (python/fairbeam/blender_render.py)

* Imports the GLB (metres, Z up like the design) and gives every part a Principled BSDF by the look table (below).
* Flat metal sheets get a 35 µm film on the side away from the dielectric they lie on, so a zero-thickness patch is not
  coplanar with the substrate face (no z-fighting speckle) and its edge catches light.
* Ports are not in the GLB; they come in the job file. A lumped port gets a procedural **SMA jack** (4-hole flange,
  6.35 mm hex nut, threaded barrel with a 4.3 mm bore, PTFE insert, 1.27 mm centre pin) when one fits: a *probe* feed
  (the port rests on a ground plane big enough for the flange: connector under the plane, pin through the port, a
  solder dot on the patch), an *edge launch* (the port is within 2.5 mm of the ground plane's edge: the 4-hole flange
  sits flush against the board edge, centred on the board thickness, with ground tabs under the board; the centre pin
  ends in a thin blade lying flat on the trace top with a solder fillet) or a *free* feed (a port bridging a gap between
  small sheets, e.g. a dipole): a 2.2 mm semi-rigid coax, 28 mm long, leaves the gap perpendicular to the arms on the
  side away from the iso camera, its tin jacket soldered to one arm and its centre conductor bridged to the other, with
  a small SMA plug at the far end. A flange is never put over a free feed. Otherwise a red glossy rod with beads; a
  waveguide port is a thin red frame.
  Lumped elements are SMD boxes (black body, tin end caps; a pure capacitor is tan).
* Lighting: soft key, fill, rim and an overhead softbox as area lights in the camera's frame, a procedural gradient
  studio world for reflections, an optional shadow-catcher floor (hidden when looking from below). Backgrounds:
  transparent PNG, light studio grey, dark. AgX view transform (Filmic before Blender 4.0).
* Each angle: the camera looks along the preset direction and is fitted to every vertex (7 % margin, bounds centred),
  perspective (70 mm lens) or orthographic.
* Written for Blender 3.6 to 4.2: Principled sockets are looked up by either name (4.0 renamed Subsurface,
  Transmission, Specular, Clearcoat, Emission), the view transform and look fall back, and Cycles (not EEVEE) renders
  both qualities, so there is no EEVEE / EEVEE Next difference to handle.

## In the app

The Render image dialog (`src/render/RenderDialog.tsx`) hosts this: with the renderer set to Blender it shows the Blender
version (or "not found" with a blender.org link and a pointer to Settings), the quality (preview / final), a
"save .blend" choice and `BlenderRenderPanel` (progress, live pictures, Save as, Open folder, Open .blend). Finished
pictures are added to the dialog's thumbnail list next to the in-app renderer's, and both engines save into
`renders/<design>/` with the same names. `blenderEngine` in `src/render/blender.ts` is the same render as a one-call
`BlenderEngine` (`src/render/engine.ts`).

## Look table (shared with the in-app renderer, the RENDER lane)

| Kind / name | Look |
| --- | --- |
| metal; copper, cu, PEC, unknown | `#B87333`, metallic 1, roughness 0.25 |
| gold, au | `#D4AF37`, 0.20 |
| silver, ag, tin, nickel | `#C8C8C8`, 0.20 |
| aluminium | `#D0D3D4`, 0.35 |
| brass / steel | `#C8A24A` 0.30 / `#9A9DA1` 0.35 |
| FR-4 | `#C9C46A`, roughness 0.5, subsurface and a little transmission (translucent laminate); solder mask `green`: `#1B6B38`, roughness 0.32, coat 0.6 |
| Rogers, RO4xxx, Taconic, PTFE, Teflon | `#EDE6D6`, 0.6 |
| alumina, ceramic (or εr ≥ 7) | `#F1F0EC`, 0.4, coat 0.15 |
| other dielectrics | neutral grey-beige `#BDB6A8`; by εr: 3.9 to 5.2 reads as FR-4, up to 3.9 as cream laminate |
| air, vacuum, voids | not rendered |

The table is `LOOK_TABLE` in `blender_render.py`, the same numbers as `MATERIAL_LOOKS` in `src/render/materials.ts`
(`npm run check:blender-render` fails when they differ); the connector parts (SMA body, nut, PTFE, pin, SMD, port marker)
are in it too. The SMA is one jack in both renderers: a 12.7 mm square 4-hole flange, a 6.35 mm hex nut, a 5.4 mm
threaded barrel with its PTFE insert and the centre pin (`SMA` here, `SMA_MM` in `src/render/ports.ts`).

The part's own Color (Properties) wins over these defaults and stays metallic. Pale dielectric colours get a small
saturation boost because AgX desaturates them (cream would otherwise render grey).

## Measured (RTX 3060 with OptiX, 24-thread CPU; the patch starter, 1600 × 1000 unless noted)

| Render | Time |
| --- | --- |
| patch, preview (32 samples + denoise), per image | 4.3 s on the GPU, 17 s on the CPU |
| patch, final (256 samples + denoise) | 15.6 s |
| dipole with SMA, final | 13.5 s |
