Fabrication files: Wilkinson divider (2.4 GHz) (a preview feature of Fairbeam)
Model wilkinson-divider, exported 2026-09-25T00:00:00+00:00 by Fairbeam 0.7.0

READ THIS FIRST
These files are generated from the simulation model. The simulation treats copper as a
zero-thickness perfect conductor. Clearances, minimum track/gap, tolerances, the connector
footprint and the stack-up must be checked by you against your fab's rules. Open every
file in a Gerber viewer (e.g. KiCad GerbView) before ordering. No solder mask, silkscreen
or paste layers are generated.

Board
-----
Outline:       37.786 x 27.898 mm (x -10 … 27.786, y -13.949 … 13.949; model coordinates, mm)
Outline area:  1054.148 mm²
Copper layers: 2

Stack-up (top to bottom)
------------------------
  F_Cu     copper, 35 µm assumed (simulated as 0 µm PEC), z = 0.813 mm
           Substrate: εr = 3.38, tan δ = 0.0027, thickness 0.813 mm
  B_Cu     copper, 35 µm assumed (simulated as 0 µm PEC), z = 0 mm
Total dielectric thickness: 0.813 mm (order the nearest standard thickness and re-simulate if it differs).

Copper
------
  F_Cu: 1 region(s), 136.622 mm² of copper (Divider traces)
  B_Cu: 1 region(s), 1054.148 mm² of copper (Ground plane)

Drills
------
  none

Edge connectors
---------------
  P1: left edge at (-10, 0) mm, 1.898 mm wide line on F_Cu, 50 Ω
  P2: right edge at (27.785801, 7) mm, 1.898 mm wide line on F_Cu, 50 Ω
  P3: right edge at (27.785801, -7) mm, 1.898 mm wide line on F_Cu, 50 Ω

Components (not in the Gerbers)
-------------------------------
  Isolation resistor 100 ohm: 100 Ω resistor on F_Cu at (13.319301, 0) mm, pad gap 1.898 mm

Notes
-----
  - P1: edge port on the left edge at (-10, 0) mm, 1.898 mm wide on F_Cu: an edge-launch connector (50 Ω) goes here; no drill.
  - P2: edge port on the right edge at (27.785801, 7) mm, 1.898 mm wide on F_Cu: an edge-launch connector (50 Ω) goes here; no drill.
  - P3: edge port on the right edge at (27.785801, -7) mm, 1.898 mm wide on F_Cu: an edge-launch connector (50 Ω) goes here; no drill.
  - Isolation resistor 100 ohm: place a 100 Ω resistor on F_Cu at (13.319301, 0) mm across the 1.898 mm gap (pad spacing; pick the package accordingly).

Files
-----
  Gerber: RS-274X with X2 attributes, mm, format 4.6, copper as regions (G36/G37).
  Protel-style names if your fab asks: F_Cu = .GTL, B_Cu = .GBL, Edge_Cuts = .GKO, drill = .TXT/.DRL.
  wilkinson_divider-F_Cu.gbr   Gerber X2, copper F_Cu (L1, top): Divider traces
  wilkinson_divider-B_Cu.gbr   Gerber X2, copper B_Cu (L2, bottom): Ground plane
  wilkinson_divider-Edge_Cuts.gbr Gerber X2, board outline (Profile / Edge.Cuts / GKO)
  wilkinson_divider-F_Cu.dxf   DXF R12, F_Cu copper outlines (closed polylines; holes as inner polylines), anti-pads and drills as circles
  wilkinson_divider-B_Cu.dxf   DXF R12, B_Cu copper outlines (closed polylines; holes as inner polylines), anti-pads and drills as circles
  wilkinson_divider-Edge_Cuts.dxf DXF R12, board outline and drills
  README.txt                   this file
