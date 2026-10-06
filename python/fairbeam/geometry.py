"""Read a CSXCAD structure back into plain, JSON-serialisable geometry.

Primitives are exported exactly (not tessellated) so the viewer and the CST exporter can rebuild
them with native shapes. Unsupported primitive types fall back to their bounding box and are marked
``"exact": false``.
"""

import numpy as np

from .legacy import is_reserved_name

# CSXCAD property types that describe simulation bookkeeping rather than physical structure
HELPER_TYPES = {"ProbeBox", "DumpBox", "Excitation"}
#: CSXCAD dispersive material types (fairbeam.dispersion) and their model names
DISPERSIVE_TYPES = {"DebyeMaterial": "debye", "LorentzMaterial": "lorentz"}


def _f(v):
    return [round(float(x), 6) for x in np.atleast_1d(v)]


def _primitive(prim) -> dict:
    kind = prim.GetTypeName()
    base = {"priority": int(prim.GetPriority()), "bbox": [_f(b) for b in prim.GetBoundBox()]}
    try:
        if kind == "RotPoly" and prim.HasTransform():
            # Keep the established exact compact form for a full-turn profile with only a
            # translation; this includes the designer's ordinary cone and torus build path.
            rot = _rotpoly(prim)
            if rot is not None:
                return {"priority": base["priority"], **rot}
        if prim.HasTransform():
            local = _local_primitive(prim)
            matrix = np.asarray(prim.GetTransform().GetMatrix(), dtype=float)
            if local is not None and matrix.shape == (4, 4) and np.isfinite(matrix).all():
                from .design import prim_bbox

                shape = _bundle_to_design(local)
                shape["_matrix"] = matrix.tolist()
                lo, hi = prim_bbox(shape)
                return {"kind": "transformed", "primitive": local, "matrix": matrix.tolist(),
                        "bbox": [_f(lo), _f(hi)], "priority": base["priority"], "exact": True}
            # Unknown native shapes remain explicitly approximate. Transform their local box
            # corners so the world bounds never reuse CSXCAD's untransformed GetBoundBox().
            matrix = np.asarray(prim.GetTransform().GetMatrix(), dtype=float)
            corners = [[x, y, z, 1.0] for x in (base["bbox"][0][0], base["bbox"][1][0])
                       for y in (base["bbox"][0][1], base["bbox"][1][1])
                       for z in (base["bbox"][0][2], base["bbox"][1][2])]
            world = np.asarray(corners) @ matrix.T
            lo, hi = world[:, :3].min(axis=0), world[:, :3].max(axis=0)
            return {"priority": base["priority"], "bbox": [_f(lo), _f(hi)], "kind": "bbox",
                    "source_kind": kind, "exact": False, "transformed": True}
        if kind == "RotPoly":
            rot = _rotpoly(prim)
            if rot is not None:
                return {"priority": base["priority"], **rot}
        if kind == "Box":
            return {**base, "kind": "box", "start": _f(prim.GetStart()), "stop": _f(prim.GetStop()),
                    "exact": True}
        if kind in ("Polygon", "LinPoly"):
            c0, c1 = prim.GetCoords()
            d = {**base, "kind": kind.lower(), "normal": int(prim.GetNormDir()),
                 "elevation": round(float(prim.GetElevation()), 6),
                 # in-plane coordinates follow CSXCAD: first -> axis (n+1)%3, second -> (n+2)%3
                 "points": [[round(float(a), 6), round(float(b), 6)] for a, b in zip(c0, c1)],
                 "exact": True}
            if kind == "LinPoly":
                d["length"] = round(float(prim.GetLength()), 6)
            return d
        if kind == "Cylinder":
            return {**base, "kind": "cylinder", "start": _f(prim.GetStart()), "stop": _f(prim.GetStop()),
                    "radius": round(float(prim.GetRadius()), 6), "exact": True}
        if kind == "CylindricalShell":
            # CSXCAD's radius is the middle of the wall: the tube spans radius -+ shell_width / 2
            return {**base, "kind": "cylindricalshell", "start": _f(prim.GetStart()), "stop": _f(prim.GetStop()),
                    "radius": round(float(prim.GetRadius()), 6),
                    "shell_width": round(float(prim.GetShellWidth()), 6), "exact": True}
        if kind == "Sphere":
            return {**base, "kind": "sphere", "center": _f(prim.GetCenter()),
                    "radius": round(float(prim.GetRadius()), 6), "exact": True}
        if kind in ("Curve", "Wire"):
            pts = [_f(prim.GetPoint(i)) for i in range(prim.GetNumberOfPoints())]
            d = {**base, "kind": kind.lower(), "points": pts, "exact": True}
            if kind == "Wire":
                d["radius"] = round(float(prim.GetWireRadius()), 6)
            return d
        if kind == "Polyhedron":
            verts = [_f(prim.GetVertex(i)) for i in range(prim.GetNumVertices())]
            faces = [[int(v) for v in prim.GetFace(i)] for i in range(prim.GetNumFaces())]
            return {**base, "kind": "polyhedron", "vertices": verts, "faces": faces, "exact": True}
    except Exception:  # pragma: no cover - defensive, fall back to bbox
        pass
    return {**base, "kind": "bbox", "source_kind": kind, "exact": False}


def _local_primitive(prim) -> dict | None:
    """An exact local-coordinate bundle primitive, before any CSXCAD transform."""
    kind = prim.GetTypeName()
    base = {"priority": int(prim.GetPriority()), "bbox": [_f(b) for b in prim.GetBoundBox()], "exact": True}
    if kind == "RotPoly":
        rot = _rotpoly(prim, include_transform=False)
        return {**base, **rot} if rot is not None else None
    if kind == "Box":
        return {**base, "kind": "box", "start": _f(prim.GetStart()), "stop": _f(prim.GetStop())}
    if kind in ("Polygon", "LinPoly"):
        c0, c1 = prim.GetCoords()
        d = {**base, "kind": kind.lower(), "normal": int(prim.GetNormDir()),
             "elevation": round(float(prim.GetElevation()), 6),
             "points": [[round(float(a), 6), round(float(b), 6)] for a, b in zip(c0, c1)]}
        if kind == "LinPoly":
            d["length"] = round(float(prim.GetLength()), 6)
        return d
    if kind == "Cylinder":
        return {**base, "kind": "cylinder", "start": _f(prim.GetStart()), "stop": _f(prim.GetStop()),
                "radius": round(float(prim.GetRadius()), 6)}
    if kind == "CylindricalShell":
        return {**base, "kind": "cylindricalshell", "start": _f(prim.GetStart()), "stop": _f(prim.GetStop()),
                "radius": round(float(prim.GetRadius()), 6), "shell_width": round(float(prim.GetShellWidth()), 6)}
    if kind == "Sphere":
        return {**base, "kind": "sphere", "center": _f(prim.GetCenter()), "radius": round(float(prim.GetRadius()), 6)}
    if kind in ("Curve", "Wire"):
        pts = [_f(prim.GetPoint(i)) for i in range(prim.GetNumberOfPoints())]
        d = {**base, "kind": kind.lower(), "points": pts}
        if kind == "Wire":
            d["radius"] = round(float(prim.GetWireRadius()), 6)
        return d
    if kind == "Polyhedron":
        verts = [_f(prim.GetVertex(i)) for i in range(prim.GetNumVertices())]
        faces = [[int(v) for v in prim.GetFace(i)] for i in range(prim.GetNumFaces())]
        return {**base, "kind": "polyhedron", "vertices": verts, "faces": faces}
    return None


def _bundle_to_design(p):
    """Map exact bundle primitive fields to the geometry helpers' resolved shape fields."""
    kind = p["kind"]
    if kind == "cylindricalshell":
        return {"kind": "cylinder", "start": p["start"], "stop": p["stop"],
                "radius": p["radius"] + p["shell_width"] / 2,
                "inner_radius": max(0.0, p["radius"] - p["shell_width"] / 2)}
    if kind == "rotpoly":
        # prim_bbox's profile/axis formula applies to any exact solid of revolution.
        return {"kind": "torus", "axis": p["axis"], "origin": p["origin"], "profile": p["points"]}
    if kind == "curve":
        return {"kind": "wire", "points": p["points"], "radius": 0.0}
    return dict(p)


def _translation(prim):
    """The offset of a pure-translation transform (zero without one), else None."""
    if not prim.HasTransform():
        return [0.0, 0.0, 0.0]
    m = np.asarray(prim.GetTransform().GetMatrix(), float)
    if m.shape != (4, 4) or not np.allclose(m[:3, :3], np.eye(3), atol=1e-12) or not np.allclose(m[3], [0, 0, 0, 1]):
        return None
    return [float(x) for x in m[:3, 3]]


def _rotpoly(prim, include_transform=True) -> dict | None:
    """A CSXCAD rotational polygon as the exact bundle kind ``rotpoly``: the (radial, axial)
    ``points`` turned a full revolution about the line through ``origin`` along ``axis``.

    CSXCAD turns a polygon lying in the plane normal to ``NormDir`` (at ``Elevation``) about the
    coordinate axis ``RotAxisDir`` through 0; a pure translation moves it. Only what the viewer can
    rebuild exactly is written: a full turn, the plane through the axis (elevation 0), the axis in
    that plane and no point on the far side of the axis (CSXCAD would clip it). Anything else falls
    back to the bounding box. CSXCAD's own GetBoundBox ignores the rotation, so the bbox is
    computed here."""
    n, a = int(prim.GetNormDir()), int(prim.GetRotAxisDir())
    c0, c1 = (np.asarray(c, float) for c in prim.GetCoords())
    start, stop = (float(x) for x in prim.GetAngle())
    t = _translation(prim) if include_transform else [0.0, 0.0, 0.0]
    u, v = (n + 1) % 3, (n + 2) % 3
    if t is None or a == n or abs(float(prim.GetElevation())) > 1e-12 or stop - start < 2 * np.pi - 1e-6 or len(c0) < 3:
        return None
    radial, axial = (c0, c1) if v == a else (c1, c0)
    if radial.min() < -1e-9:
        return None
    rmax = float(radial.max())
    lo, hi = [x - rmax for x in t], [x + rmax for x in t]
    lo[a], hi[a] = t[a] + float(axial.min()), t[a] + float(axial.max())
    return {"kind": "rotpoly", "axis": a, "origin": _f(t),
            "points": [[round(float(r), 6), round(float(h), 6)] for r, h in zip(radial, axial)],
            "bbox": [_f(lo), _f(hi)], "exact": True}


def read_structure(csx, materials: dict, length_unit: float = 1e-3) -> tuple[list, list, dict]:
    """Return ``(parts, helpers, nf2ff_box)``.

    ``parts``: physical properties with their primitives. ``materials`` supplies metadata recorded
    by :class:`~fairbeam.simulation.Simulation` (eps_r, tan δ, colour); properties created directly
    through CSXCAD are still exported using the values stored on the property. ``length_unit`` is
    the simulation unit in metres per displayed length unit, used to report a conducting sheet's
    SI thickness in the same unit as its geometry (mm for the default simulation).
    """
    parts: dict[str, dict] = {}
    helpers: dict[str, dict] = {}
    for prim in csx.GetAllPrimitives():
        prop = prim.GetProperty()
        name, ptype = prop.GetName(), prop.GetTypeString()
        target = helpers if ptype in HELPER_TYPES else parts
        if name not in target:
            entry = {"name": name, "type": ptype, "primitives": []}
            meta = materials.get(name, {})
            if ptype in DISPERSIVE_TYPES:
                # a dispersive dielectric is a "Material" for the viewer and the exporters: its values
                # at the band centre, and the model in material.dispersion (Simulation.dispersive)
                entry["type"] = "Material"
                eps = float(np.atleast_1d(prop.GetMaterialProperty("epsilon"))[0])
                entry["material"] = {
                    "eps_r": meta.get("eps_r", eps), "kappa": meta.get("kappa", float(
                        np.atleast_1d(prop.GetMaterialProperty("kappa"))[0])),
                    "mu_r": meta.get("mu_r", float(np.atleast_1d(prop.GetMaterialProperty("mue"))[0])),
                    "tan_d": meta.get("tan_d"), "tan_d_freq": meta.get("tan_d_freq"), "isotropic": True,
                    "dispersion": meta.get("dispersion") or {"model": DISPERSIVE_TYPES[ptype]},
                }
            elif ptype == "Material":
                eps = np.atleast_1d(prop.GetMaterialProperty("epsilon"))
                kappa = np.atleast_1d(prop.GetMaterialProperty("kappa"))
                mue = np.atleast_1d(prop.GetMaterialProperty("mue"))
                entry["material"] = {
                    "eps_r": float(eps[0]), "kappa": float(kappa[0]), "mu_r": float(mue[0]),
                    "tan_d": meta.get("tan_d"), "tan_d_freq": meta.get("tan_d_freq"),
                    "isotropic": bool(np.allclose(eps, eps[0]) and np.allclose(kappa, kappa[0])),
                }
            elif ptype == "ConductingSheet":
                # Unlike Simulation.metal, direct CSXCAD AddConductingSheet calls do not register
                # these values in sim.materials. Read the native CSXCAD property so conversion and
                # bundle display still retain the finite conductivity and SI thickness.
                entry["conductor"] = {"conductivity": float(prop.GetConductivity()),
                                      "thickness": float(prop.GetThickness()) / float(length_unit)}
            elif ptype == "LumpedElement":
                entry["lumped"] = {"R": float(prop.GetResistance()) if hasattr(prop, "GetResistance") else None}
            if ptype != "ConductingSheet" and meta.get("kind") == "metal" and meta.get("conductivity") is not None:
                # a lossy metal (simulation.LossyMetal): a conducting sheet, or a material volume
                entry["conductor"] = {"conductivity": float(meta["conductivity"]),
                                      "thickness": meta.get("thickness")}
            if "color" in meta:
                entry["color"] = meta["color"]
            if "label" in meta:
                entry["label"] = meta["label"]
            if meta.get("void") and ptype == "Material":
                entry["void"] = True
            target[name] = entry
        target[name]["primitives"].append(_primitive(prim))

    for entry in list(parts.values()) + list(helpers.values()):
        bb = np.array([p["bbox"] for p in entry["primitives"]])
        entry["bbox"] = [_f(bb[:, 0].min(axis=0)), _f(bb[:, 1].max(axis=0))]

    nf2ff = None
    # NF2FF recording surfaces only (fairbeam.fields names its dumps fairbeam_J_*, fairbeam.field_planes fairbeam_F_*)
    dumps = [e for e in helpers.values() if e["type"] == "DumpBox" and not is_reserved_name(e["name"])]
    if dumps:
        bb = np.array([p["bbox"] for e in dumps for p in e["primitives"]])
        nf2ff = {"min": _f(bb[:, 0].min(axis=0)), "max": _f(bb[:, 1].max(axis=0))}

    # ports are exported from Simulation's own records; keep only physical parts here
    physical = [e for e in parts.values() if e["type"] != "LumpedElement"]
    return physical, list(helpers.values()), nf2ff
