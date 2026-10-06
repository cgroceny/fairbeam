"""The material library: nominal values of common antenna materials, with where they come from.

The designer's "Material library" dialog (src/designer/materials.ts, the same list) copies an
entry's values into a design, so a design file stays self-contained: editing this list never
changes an existing design. python/tests/fixtures/material_library.json pins both lists to the
same values (python/tests/test_materials.py and scripts/check-designer.mjs).

Values are nominal: laminates vary by batch, thickness, resin content and frequency. openEMS models
dielectric loss as a constant conductivity, so tan δ is exact only at ``tan_d_freq`` (GHz). Use
the datasheet of the laminate you actually buy, or a measurement, for a design that matters.

Python models can use the library too::

    from fairbeam.materials import get
    ro = get("ro4003c")
    sub = sim.dielectric("substrate", ro["eps_r"], tan_d=ro["tan_d"], tan_d_freq=ro["tan_d_freq"] * 1e9)
"""

from __future__ import annotations

# id: stable key (recorded as "library" in a design material); name: the design material name the
# dialog proposes; kind: metal or dielectric; eps_r, tan_d; tan_d_freq: GHz; note: source and caveats
LIBRARY: list[dict] = [
    {"id": "pec", "name": "copper", "label": "PEC (copper)", "kind": "metal",
     "note": "Perfect electric conductor (openEMS metal). Copper's finite conductivity (5.8e7 S/m) "
             "and surface roughness are not modeled; the conductor loss of printed antennas is small."},
    {"id": "fr4", "name": "FR4", "label": "FR4", "kind": "dielectric", "eps_r": 4.3, "tan_d": 0.02, "tan_d_freq": 1,
     "note": "Generic glass-epoxy laminate. εr 4.2–4.7 and tan δ 0.015–0.025 vary with the resin "
             "content, the supplier and the frequency: use your laminate's datasheet."},
    {"id": "ro4003c", "name": "RO4003C", "label": "Rogers RO4003C", "kind": "dielectric", "eps_r": 3.38,
     "tan_d": 0.0027, "tan_d_freq": 10,
     "note": "Rogers RO4003C datasheet: process εr 3.38 ± 0.05 and tan δ 0.0027 at 10 GHz, 23 °C "
             "(Rogers recommends the design εr 3.55 for circuit design)."},
    {"id": "ro4350b", "name": "RO4350B", "label": "Rogers RO4350B", "kind": "dielectric", "eps_r": 3.48,
     "tan_d": 0.0037, "tan_d_freq": 10,
     "note": "Rogers RO4350B datasheet: process εr 3.48 ± 0.05 and tan δ 0.0037 at 10 GHz, 23 °C "
             "(design εr 3.66)."},
    {"id": "rt5880", "name": "RT5880", "label": "Rogers RT/duroid 5880", "kind": "dielectric", "eps_r": 2.20,
     "tan_d": 0.0009, "tan_d_freq": 10,
     "note": "Rogers RT/duroid 5880 datasheet: εr 2.20 ± 0.02 and tan δ 0.0009 at 10 GHz."},
    {"id": "tly5", "name": "TLY-5", "label": "Taconic TLY-5", "kind": "dielectric", "eps_r": 2.20,
     "tan_d": 0.0009, "tan_d_freq": 10,
     "note": "Taconic (AGC) TLY-5 datasheet: εr 2.20 ± 0.02 and tan δ 0.0009 at 10 GHz."},
    {"id": "alumina", "name": "alumina", "label": "Alumina 99.5 %", "kind": "dielectric", "eps_r": 9.8,
     "tan_d": 0.0001, "tan_d_freq": 10,
     "note": "Typical of 99.5 % alumina thin-film substrates (εr 9.7–9.9, tan δ about 0.0001 at "
             "microwave frequencies); check the supplier's value."},
    {"id": "ptfe", "name": "PTFE", "label": "PTFE (Teflon)", "kind": "dielectric", "eps_r": 2.1,
     "tan_d": 0.0002, "tan_d_freq": 10,
     "note": "Bulk PTFE, typical: εr 2.0–2.1, tan δ 0.0001–0.0003 from 1 to 10 GHz."},
    {"id": "air", "name": "air", "label": "Air / vacuum", "kind": "dielectric", "eps_r": 1, "tan_d": 0,
     "tan_d_freq": None,
     "note": "Free space. The background is vacuum already; use it with a higher priority to cut an "
             "air gap or a hole out of another dielectric."},
]

_BY_ID = {m["id"]: m for m in LIBRARY}


def get(id_: str) -> dict:
    """One library entry by id (a copy)."""
    if id_ not in _BY_ID:
        raise KeyError(f"unknown library material {id_!r}; choose one of {', '.join(_BY_ID)}")
    return dict(_BY_ID[id_])


def design_material(id_: str, name: str | None = None) -> dict:
    """A design-file material (fairbeam.design) with a copy of the entry's values."""
    m = get(id_)
    out = {"name": name or m["name"], "kind": m["kind"]}
    if m["kind"] == "dielectric":
        out["eps_r"] = m["eps_r"]
        out["tan_d"] = m["tan_d"]
        if m.get("tan_d_freq") is not None:
            out["tan_d_freq"] = m["tan_d_freq"]
    out["library"] = m["id"]
    return out


def markdown_table() -> str:
    """The library as a Markdown table (docs/MODELS.md carries it; a test keeps it current)."""
    rows = ["| Material | Kind | εr | tan δ | at | Source and caveats |", "| --- | --- | --- | --- | --- | --- |"]
    for m in LIBRARY:
        if m["kind"] == "metal":
            rows.append(f"| {m['label']} | metal | | | | {m['note']} |")
        else:
            f = f"{m['tan_d_freq']:g} GHz" if m.get("tan_d_freq") is not None else ""
            rows.append(f"| {m['label']} | dielectric | {m['eps_r']:g} | {m['tan_d']:g} | {f} | {m['note']} |")
    return "\n".join(rows)
