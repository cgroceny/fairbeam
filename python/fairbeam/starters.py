"""Starter designs for the Start screen's "New project" (``design.template_design``).

Each one is a small parametric design that simulates in seconds and passes the design checks
without errors or warnings at its defaults: PML boundaries (8 cells), the automatic mesh at 20
cells per wavelength (the sleeve dipole keeps the 30 it was tuned on), end criterion -60 dB, far
field on for the antennas, and every loss tangent given at the design frequency f0 (openEMS
applies tan δ as a constant conductivity, exact at ``tan_d_freq`` only). The empty project and the
patch starter are in :mod:`fairbeam.design`.

Validation (one run each at the defaults, GPU engine; the numbers are in docs/DESIGNER.md,
"Starters"): the dipole, the monopole and the sleeve dipole resonate near f0, the line is matched
across its band, the open waveguide radiates from 8 to 12 GHz.
"""

from __future__ import annotations

from .design import DESIGN_SCHEMA

# the defaults every starter shares
PML = "PML_8"
END_DB = -60
MESH = {"mode": "auto", "cells_per_wavelength": 20, "refine_features": False}


def _design(id_: str, name: str, description: str, **rest) -> dict:
    return {"schema": DESIGN_SCHEMA, "model": {"id": id_, "name": name, "description": description}, **rest}


def dipole_design(id_: str, name: str) -> dict:
    """A centre-fed half-wave strip dipole in free space (a PEC strip in the y = 0 plane, along z).

    A strip of width w acts like a round wire of radius w / 4; its reactance crosses zero at about
    0.467 wavelengths tip to tip (docs/VALIDATION.md), where the input resistance is about 73 ohm."""
    return _design(
        id_, name, "Centre-fed half-wave strip dipole in free space, 50 ohm port; the length follows f0.",
        params=[
            {"key": "f0", "default": 2.4, "label": "Design frequency", "unit": "GHz", "min": 0.1, "max": 30},
            {"key": "k", "default": 0.466, "label": "Length in wavelengths (tip to tip)", "unit": "", "min": 0.3, "max": 0.7},
            {"key": "w", "default": 1.0, "label": "Strip width", "unit": "mm", "min": 0.1, "max": 20},
            {"key": "g", "default": 1.0, "label": "Feed gap", "unit": "mm", "min": 0.2, "max": 10},
            {"key": "lam", "expr": "wavelength(f0)", "label": "Free-space wavelength at f0", "unit": "mm"},
            {"key": "L", "expr": "k * lam", "label": "Dipole length (tip to tip)", "unit": "mm"},
        ],
        simulation={"f_min": "f0 * 0.7", "f_max": "f0 * 1.3", "boundaries": PML, "end_criteria_db": END_DB},
        materials=[{"name": "copper", "kind": "metal"}],
        parts=[
            {"name": "arms", "material": "copper", "label": "Dipole arms", "primitives": [
                {"kind": "box", "start": ["-w/2", "0", "g/2"], "stop": ["w/2", "0", "L/2"]},
                {"kind": "box", "start": ["-w/2", "0", "-L/2"], "stop": ["w/2", "0", "-g/2"]},
            ]},
        ],
        ports=[{"type": "lumped", "number": 1, "R": "50", "start": ["-w/2", "0", "-g/2"], "stop": ["w/2", "0", "g/2"],
                "direction": "z"}],
        resistors=[],
        mesh=dict(MESH),
        far_field={"enabled": True, "frequencies": ["f0"]},
    )


def monopole_design(id_: str, name: str) -> dict:
    """A quarter-wave strip monopole on a finite square ground plane, fed by a probe port at its base.

    Its image in the ground makes a dipole of twice the height, so the top sits about 0.233
    wavelengths above the ground; the input resistance is about half the dipole's (about 36 ohm).
    A finite ground tilts the beam up from the horizon."""
    return _design(
        id_, name, "Quarter-wave strip monopole on a finite ground plane, probe-fed at its base; the height follows f0.",
        params=[
            {"key": "f0", "default": 2.4, "label": "Design frequency", "unit": "GHz", "min": 0.1, "max": 30},
            {"key": "k", "default": 0.233, "label": "Height in wavelengths (ground to tip)", "unit": "", "min": 0.15, "max": 0.35},
            {"key": "kg", "default": 0.8, "label": "Ground plane size in wavelengths", "unit": "", "min": 0.3, "max": 3},
            {"key": "w", "default": 1.0, "label": "Strip width", "unit": "mm", "min": 0.1, "max": 20},
            {"key": "g", "default": 1.0, "label": "Feed gap (ground to strip)", "unit": "mm", "min": 0.2, "max": 10},
            {"key": "lam", "expr": "wavelength(f0)", "label": "Free-space wavelength at f0", "unit": "mm"},
            {"key": "H", "expr": "k * lam", "label": "Monopole height (ground to tip)", "unit": "mm"},
            {"key": "G", "expr": "kg * lam", "label": "Ground plane size", "unit": "mm"},
        ],
        simulation={"f_min": "f0 * 0.7", "f_max": "f0 * 1.3", "boundaries": PML, "end_criteria_db": END_DB},
        materials=[{"name": "copper", "kind": "metal"}],
        parts=[
            {"name": "gnd", "material": "copper", "label": "Ground plane", "primitives": [
                {"kind": "box", "start": ["-G/2", "-G/2", "0"], "stop": ["G/2", "G/2", "0"]}]},
            {"name": "monopole", "material": "copper", "label": "Monopole", "primitives": [
                {"kind": "box", "start": ["-w/2", "0", "g"], "stop": ["w/2", "0", "H"]}]},
        ],
        ports=[{"type": "lumped", "number": 1, "R": "50", "start": ["-w/2", "0", "0"], "stop": ["w/2", "0", "g"],
                "direction": "z"}],
        resistors=[],
        mesh=dict(MESH),
        far_field={"enabled": True, "frequencies": ["f0"]},
    )


def microstrip_design(id_: str, name: str) -> dict:
    """A 50 ohm microstrip line on FR-4 with a lumped port at each end: S11 and S21 for learning.

    The width follows from Hammerstad's formula (3.1 mm on 1.6 mm, εr 4.3); the derived
    parameters show the quasi-static line impedance and the effective permittivity, so changing
    w, h or eps_r shows what they do before a run. Both ports are excited (one run each), which gives
    the full two-port S-matrix. A line is not meant to radiate: no far field."""
    return _design(
        id_, name, "50 ohm microstrip line on FR-4 with a port at each end, for S11 and S21.",
        params=[
            {"key": "f0", "default": 2.4, "label": "Design frequency", "unit": "GHz", "min": 0.1, "max": 30},
            {"key": "l", "default": 40.0, "label": "Line length", "unit": "mm", "min": 5, "max": 300},
            {"key": "w", "default": 3.1, "label": "Line width", "unit": "mm", "min": 0.1, "max": 20},
            {"key": "h", "default": 1.6, "label": "Substrate thickness", "unit": "mm", "min": 0.1, "max": 10},
            {"key": "wb", "default": 20.0, "label": "Board width", "unit": "mm", "min": 5, "max": 200},
            {"key": "eps_r", "default": 4.3, "label": "Substrate permittivity", "unit": "", "min": 1, "max": 20},
            {"key": "e_eff", "expr": "(eps_r + 1) / 2 + (eps_r - 1) / 2 / sqrt(1 + 12 * h / w)",
             "label": "Effective permittivity (quasi-static)", "unit": ""},
            {"key": "Z0", "expr": "120 * pi / sqrt(e_eff) / (w / h + 1.393 + 0.667 * log(w / h + 1.444))",
             "label": "Line impedance (Hammerstad, w/h >= 1)", "unit": "ohm"},
            {"key": "lam_g", "expr": "wavelength(f0) / sqrt(e_eff)", "label": "Guided wavelength at f0", "unit": "mm"},
        ],
        simulation={"f_min": "f0 * 0.5", "f_max": "f0 * 1.5", "boundaries": PML, "end_criteria_db": END_DB},
        materials=[
            {"name": "copper", "kind": "metal"},
            {"name": "fr4", "kind": "dielectric", "eps_r": "eps_r", "tan_d": "0.02", "tan_d_freq": "f0"},
        ],
        parts=[
            {"name": "substrate", "material": "fr4", "label": "Substrate", "primitives": [
                {"kind": "box", "start": ["-l/2", "-wb/2", "0"], "stop": ["l/2", "wb/2", "h"]}]},
            {"name": "gnd", "material": "copper", "label": "Ground plane", "primitives": [
                {"kind": "box", "start": ["-l/2", "-wb/2", "0"], "stop": ["l/2", "wb/2", "0"]}]},
            {"name": "line", "material": "copper", "label": "Strip", "primitives": [
                {"kind": "box", "start": ["-l/2", "-w/2", "h"], "stop": ["l/2", "w/2", "h"]}]},
        ],
        ports=[
            {"type": "lumped", "number": 1, "R": "50", "start": ["-l/2", "-w/2", "0"], "stop": ["-l/2", "w/2", "h"],
             "direction": "z"},
            {"type": "lumped", "number": 2, "R": "50", "start": ["l/2", "-w/2", "0"], "stop": ["l/2", "w/2", "h"],
             "direction": "z"},
        ],
        resistors=[],
        mesh=dict(MESH),
        far_field={"enabled": False},
    )


def open_waveguide_design(id_: str, name: str) -> dict:
    """An open-ended WR-90 waveguide radiating into free space, fed by a TE10 waveguide port.

    Four PEC sheets make the guide; a sheet closes its back (a short) a quarter guide wavelength
    behind the excitation plane, so the backward half of the source adds in phase with the forward
    half at f0. The mode probes (the port's stop plane) sit well inside the guide, away from the
    open end. The band stays above the TE10 cutoff (c / 2a = 6.56 GHz for WR-90)."""
    return _design(
        id_, name, "Open-ended WR-90 waveguide radiating into free space, fed by a TE10 waveguide port.",
        params=[
            {"key": "f0", "default": 10.0, "label": "Design frequency", "unit": "GHz", "min": 1, "max": 100},
            {"key": "a", "default": 22.86, "label": "Guide width (broad wall)", "unit": "mm", "min": 1, "max": 300},
            {"key": "b", "default": 10.16, "label": "Guide height", "unit": "mm", "min": 0.5, "max": 150},
            {"key": "l", "default": 50.0, "label": "Guide length (back short to open end)", "unit": "mm", "min": 20, "max": 500},
            {"key": "fc", "expr": "c0 / (2 * a) / 1000000", "label": "TE10 cutoff frequency", "unit": "GHz"},
            {"key": "lam_g", "expr": "wavelength(f0) / sqrt(1 - (fc / f0) ** 2)", "label": "Guided wavelength at f0", "unit": "mm"},
            {"key": "zp", "expr": "lam_g / 4", "label": "Excitation plane (a quarter guide wavelength from the short)", "unit": "mm"},
        ],
        simulation={"f_min": "f0 * 0.8", "f_max": "f0 * 1.2", "boundaries": PML, "end_criteria_db": END_DB},
        materials=[{"name": "copper", "kind": "metal"}],
        parts=[
            {"name": "guide", "material": "copper", "label": "Waveguide walls", "primitives": [
                {"kind": "box", "start": ["-a/2", "-b/2", "0"], "stop": ["a/2", "-b/2", "l"]},
                {"kind": "box", "start": ["-a/2", "b/2", "0"], "stop": ["a/2", "b/2", "l"]},
                {"kind": "box", "start": ["-a/2", "-b/2", "0"], "stop": ["-a/2", "b/2", "l"]},
                {"kind": "box", "start": ["a/2", "-b/2", "0"], "stop": ["a/2", "b/2", "l"]},
            ]},
            {"name": "short", "material": "copper", "label": "Back short", "primitives": [
                {"kind": "box", "start": ["-a/2", "-b/2", "0"], "stop": ["a/2", "b/2", "0"]}]},
        ],
        ports=[{"type": "waveguide", "number": 1, "mode": "TE10", "a": "a", "b": "b",
                "start": ["-a/2", "-b/2", "zp"], "stop": ["a/2", "b/2", "zp + 5"], "direction": "z"}],
        resistors=[],
        mesh=dict(MESH),
        far_field={"enabled": True, "frequencies": ["f0"]},
    )


def sleeve_dipole_design(id_: str, name: str) -> dict:
    """The printed sleeve dipole for a UAV (examples/designs/sleeve_dipole_867.design.json): no
    ground plane, a slim FR-4 strip in the xz plane, coax-fed across the feed gap, parametrised as
    in that file (python/tests/test_starters.py keeps the two the same)."""
    return _design(
        id_, name,
        "Printed sleeve dipole on a slim vertical FR-4 strip, with no ground plane, for a UAV with a "
        "non-metal fuselage. The upper arm is a copper strip; the lower arm is the sleeve, a pair of strips "
        "either side of the coax, joined to the coax braid by a bridge at their top. A 50 ohm port across "
        "the feed gap stands for the coax inner conductor. Vertically polarised and omnidirectional in "
        "azimuth for the 863-870 MHz band, with the best match about 1 % high so that a radome pulls it "
        "into the band.",
        params=[
            {"key": "f0", "default": 0.867, "label": "Design frequency", "unit": "GHz", "min": 0.1, "max": 6},
            {"key": "l_up", "default": 68.8, "label": "Upper arm length (above the feed gap)", "unit": "mm", "min": 20, "max": 300},
            {"key": "l_sl", "default": 68.8, "label": "Sleeve length (below the feed gap)", "unit": "mm", "min": 20, "max": 300},
            {"key": "w_up", "default": 10, "label": "Upper arm width", "unit": "mm", "min": 1, "max": 100},
            {"key": "w_sl", "default": 16, "label": "Sleeve width (both strips and the coax slot)", "unit": "mm", "min": 6, "max": 100},
            {"key": "g", "default": 2, "label": "Feed gap (sleeve top to upper arm)", "unit": "mm", "min": 0.5, "max": 10},
            {"key": "wb", "default": 20, "label": "Board width", "unit": "mm", "min": 6, "max": 120},
            {"key": "t", "default": 1.6, "label": "FR-4 thickness", "unit": "mm", "min": 0.2, "max": 5},
            {"key": "w_f", "default": 2, "label": "Coax (feed line) width", "unit": "mm", "min": 0.5, "max": 10},
            {"key": "s", "default": 1, "label": "Slot between the coax and each sleeve strip", "unit": "mm", "min": 0.3, "max": 10},
            {"key": "hb", "default": 3, "label": "Height of the bridge at the sleeve top (braid solder pad)", "unit": "mm", "min": 0.5, "max": 20},
            {"key": "m", "default": 4, "label": "Board margin above the arm and below the sleeve", "unit": "mm", "min": 0, "max": 50},
            {"key": "lam", "expr": "wavelength(f0)", "label": "Free-space wavelength at f0", "unit": "mm"},
            {"key": "L", "expr": "l_up + g + l_sl", "label": "Dipole length (arm tip to sleeve end)", "unit": "mm"},
            {"key": "H", "expr": "L + 2 * m", "label": "Board height", "unit": "mm"},
            {"key": "ws", "expr": "(w_sl - w_f) / 2 - s", "label": "Width of each sleeve strip", "unit": "mm"},
        ],
        simulation={"f_min": "0.75", "f_max": "1.0", "boundaries": PML, "end_criteria_db": END_DB, "max_timesteps": 150000},
        materials=[
            {"name": "copper", "kind": "metal"},
            {"name": "fr4", "kind": "dielectric", "eps_r": 4.3, "tan_d": 0.02, "tan_d_freq": "f0"},
        ],
        parts=[
            {"name": "board", "material": "fr4", "component": "antenna", "primitives": [
                {"kind": "box", "start": ["-wb/2", "-t", "-g/2 - l_sl - m"], "stop": ["wb/2", 0, "g/2 + l_up + m"]}]},
            {"name": "upper_arm", "material": "copper", "component": "antenna", "primitives": [
                {"kind": "box", "start": ["-w_up/2", 0, "g/2"], "stop": ["w_up/2", 0, "g/2 + l_up"]}]},
            {"name": "sleeve", "material": "copper", "component": "antenna", "primitives": [
                {"kind": "box", "start": ["-w_sl/2", 0, "-g/2 - hb"], "stop": ["w_sl/2", 0, "-g/2"]},
                {"kind": "box", "start": ["-w_sl/2", 0, "-g/2 - l_sl"], "stop": ["-w_f/2 - s", 0, "-g/2 - hb"]},
                {"kind": "box", "start": ["w_f/2 + s", 0, "-g/2 - l_sl"], "stop": ["w_sl/2", 0, "-g/2 - hb"]},
            ]},
            {"name": "coax", "material": "copper", "component": "feed", "primitives": [
                {"kind": "box", "start": ["-w_f/2", 0, "-g/2 - l_sl - m"], "stop": ["w_f/2", 0, "-g/2 - hb"]}]},
        ],
        ports=[{"type": "lumped", "number": 1, "R": 50, "start": ["-w_f/2", 0, "-g/2"], "stop": ["w_f/2", 0, "g/2"],
                "direction": "z"}],
        resistors=[],
        # the example's 30 cells per wavelength: its match was tuned on that mesh
        mesh={"mode": "auto", "cells_per_wavelength": 30, "refine_features": False},
        far_field={"enabled": True, "frequencies": ["f0"]},
        monitors={"currents": ["f0"], "efficiency": {"points": 21}},
    )
