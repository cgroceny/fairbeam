"""UAV blade antenna (867 MHz)

Swept metal blade monopole on a 300 x 300 mm fuselage-skin ground plane, fed by a 50 ohm probe across a 2 mm gap at its base (x: flight axis, +x aft; z: up). A vertically polarised, azimuth-omnidirectional UAV telemetry antenna for the 863-870 MHz SRD / LoRa band; h = 80 mm gives |S11| about -23 dB at 867 MHz and a -10 dB band of about 0.75-1.8 GHz. See examples/designs/README.md in the antenlab repository.

Exported from the design file blade-867.design.json.
"""

import numpy as np

from antenlab import Param, Simulation
from antenlab.design import require_safe_sheet_transforms, resolve_names

_SHEET_GUARD = {'params': [{'key': 'f0', 'default': 0.867, 'label': 'Design frequency', 'unit': 'GHz', 'min': 0.1, 'max': 6}, {'key': 'gnd', 'default': 300, 'label': 'Ground plane (fuselage skin) size', 'unit': 'mm', 'min': 50, 'max': 2000}, {'key': 'h', 'default': 80, 'label': 'Blade height above the feed gap', 'unit': 'mm', 'min': 10, 'max': 400}, {'key': 'wb', 'default': 60, 'label': 'Blade base width (x)', 'unit': 'mm', 'min': 5, 'max': 300}, {'key': 'wt', 'default': 30, 'label': 'Blade top width (x)', 'unit': 'mm', 'min': 2, 'max': 300}, {'key': 'sweep', 'default': 25, 'label': 'Aft offset of the top edge centre (sweep)', 'unit': 'mm', 'min': 0, 'max': 200}, {'key': 'g', 'default': 2, 'label': 'Feed gap (ground to blade)', 'unit': 'mm', 'min': 0.5, 'max': 10}, {'key': 'wf', 'default': 4, 'label': 'Feed tab width at the base', 'unit': 'mm', 'min': 0.5, 'max': 40}, {'key': 'ht', 'default': 12, 'label': 'Height of the base taper (feed tab to full width)', 'unit': 'mm', 'min': 1, 'max': 100}, {'key': 'lam', 'expr': 'wavelength(f0)', 'label': 'Free-space wavelength at f0', 'unit': 'mm'}, {'key': 'sweep_deg', 'expr': 'degrees(atan2(sweep + (wb - wt) / 2, h - ht))', 'label': 'Leading-edge sweep angle (from vertical)', 'unit': 'deg'}], 'materials': [{'name': 'metal', 'kind': 'metal'}], 'parts': [{'material': 'metal', 'primitives': [{'kind': 'box', 'start': ['-gnd/2', '-gnd/2', 0], 'stop': ['gnd/2', 'gnd/2', 0]}], 'transforms': []}, {'material': 'metal', 'primitives': [{'kind': 'polygon', 'normal': 'y', 'elevation': 0, 'points': [['g', '-wf/2'], ['g', 'wf/2'], ['g + ht', 'wb/2'], ['g + h', 'sweep + wt/2'], ['g + h', 'sweep - wt/2'], ['g + ht', '-wb/2']]}], 'transforms': []}]}

ANTENLAB_ORGANIZATION = {'parts': {'ground': 'Antenna/Blade', 'blade': 'Ground'}, 'components': ['Antenna/Blade', 'Ground']}

C0 = 299_792_458.0


def wavelength(f_ghz):
    """Free-space wavelength in mm at f_ghz GHz."""
    return C0 / (f_ghz * 1e9) * 1e3


MODEL = {"id": "blade-867", "name": "UAV blade antenna (867 MHz)", "description": "Swept metal blade monopole on a 300 x 300 mm fuselage-skin ground plane, fed by a 50 ohm probe across a 2 mm gap at its base (x: flight axis, +x aft; z: up). A vertically polarised, azimuth-omnidirectional UAV telemetry antenna for the 863-870 MHz SRD / LoRa band; h = 80 mm gives |S11| about -23 dB at 867 MHz and a -10 dB band of about 0.75-1.8 GHz. See examples/designs/README.md in the antenlab repository."}

PARAMS = [
    Param('f0', 0.867, 'Design frequency', 'GHz', minimum=0.1, maximum=6),
    Param('gnd', 300.0, 'Ground plane (fuselage skin) size', 'mm', minimum=50, maximum=2000),
    Param('h', 80.0, 'Blade height above the feed gap', 'mm', minimum=10, maximum=400),
    Param('wb', 60.0, 'Blade base width (x)', 'mm', minimum=5, maximum=300),
    Param('wt', 30.0, 'Blade top width (x)', 'mm', minimum=2, maximum=300),
    Param('sweep', 25.0, 'Aft offset of the top edge centre (sweep)', 'mm', minimum=0, maximum=200),
    Param('g', 2.0, 'Feed gap (ground to blade)', 'mm', minimum=0.5, maximum=10),
    Param('wf', 4.0, 'Feed tab width at the base', 'mm', minimum=0.5, maximum=40),
    Param('ht', 12.0, 'Height of the base taper (feed tab to full width)', 'mm', minimum=1, maximum=100),
]


def build(p: dict) -> Simulation:
    require_safe_sheet_transforms(_SHEET_GUARD, resolve_names(_SHEET_GUARD, p))
    lam = wavelength(p['f0'])
    sweep_deg = np.degrees(np.arctan2(p['sweep'] + (p['wb'] - p['wt']) / 2, p['h'] - p['ht']))
    sim = Simulation((0.7) * 1e9, (1.05) * 1e9, boundaries=['MUR', 'MUR', 'MUR', 'MUR', 'MUR', 'MUR'], end_criteria_db=-50.0, max_timesteps=60000)
    # component 'Antenna/Blade'
    prop = sim.metal('ground')
    prop.AddBox(priority=10, start=[-p['gnd'] / 2, -p['gnd'] / 2, 0], stop=[p['gnd'] / 2, p['gnd'] / 2, 0])
    # component 'Ground'
    prop = sim.metal('blade')
    prop.AddPolygon(np.array([[p['g'], -p['wf'] / 2], [p['g'], p['wf'] / 2], [p['g'] + p['ht'], p['wb'] / 2], [p['g'] + p['h'], p['sweep'] + p['wt'] / 2], [p['g'] + p['h'], p['sweep'] - p['wt'] / 2], [p['g'] + p['ht'], -p['wb'] / 2]]).T, 'y', 0, priority=10)
    sim.lumped_port(1, 50, [0, 0, 0], [0, 0, p['g']], 'z', priority=5)
    sim.auto_mesh(cells_per_wavelength=20)
    sim.add_nf2ff_box()
    sim.pattern_freqs = [(p['f0']) * 1e9]
    sim.current_freqs = [(p['f0']) * 1e9]  # surface-current maps
    sim.efficiency_points = 21  # radiation efficiency over the band
    return sim
