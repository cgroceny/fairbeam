Fabrication files (preview): Rectangular patch antenna
Model patch-antenna, exported 2026-09-25T00:00:00+00:00 by Fairbeam 0.1.0

READ THIS FIRST
These files are generated from the simulation model. The simulation treats copper as a
zero-thickness perfect conductor. Clearances, minimum track/gap, tolerances, the connector
footprint and the stack-up must be checked by you against your fab's rules. Open every
file in a Gerber viewer (e.g. KiCad GerbView) before ordering. No solder mask, silkscreen
or paste layers are generated.

Board
-----
Outline:       60 x 60 mm (x -30 … 30, y -30 … 30; model coordinates, mm)
Outline area:  3600 mm²
Copper layers: 2

Stack-up (top to bottom)
------------------------
  F_Cu     copper, 35 µm assumed (simulated as 0 µm PEC), z = 1.524 mm
           Substrate: εr = 3.38, tan δ = 0.001, thickness 1.524 mm
  B_Cu     copper, 35 µm assumed (simulated as 0 µm PEC), z = 0 mm
Total dielectric thickness: 1.524 mm (order the nearest standard thickness and re-simulate if it differs).

Copper
------
  F_Cu: 1 region(s), 1280 mm² of copper (Patch)
  B_Cu: 1 region(s), 3600 mm² of copper (Ground plane), 1 anti-pad(s)

Drills
------
  P1 probe feed: Ø 1.3 mm plated at (-6, 0) mm, F_Cu → B_Cu

Notes
-----
  - P1: probe feed → 1.3 mm plated hole at (-6, 0) mm with a 4.2 mm clearance in B_Cu (coaxial connector from below). Adjust to your connector.

Files
-----
  Gerber: RS-274X with X2 attributes, mm, format 4.6, copper as regions (G36/G37).
  Protel-style names if your fab asks: F_Cu = .GTL, B_Cu = .GBL, Edge_Cuts = .GKO, drill = .TXT/.DRL.
  patch-antenna-F_Cu.gbr       Gerber X2, copper F_Cu (L1, top): Patch
  patch-antenna-B_Cu.gbr       Gerber X2, copper B_Cu (L2, bottom): Ground plane
  patch-antenna-Edge_Cuts.gbr  Gerber X2, board outline (Profile / Edge.Cuts / GKO)
  patch-antenna-PTH.drl        Excellon drill, plated holes (1)
  patch-antenna-F_Cu.dxf       DXF R12, F_Cu copper outlines (closed polylines; holes as inner polylines), anti-pads and drills as circles
  patch-antenna-B_Cu.dxf       DXF R12, B_Cu copper outlines (closed polylines; holes as inner polylines), anti-pads and drills as circles
  patch-antenna-Edge_Cuts.dxf  DXF R12, board outline and drills
  README.txt                   this file
