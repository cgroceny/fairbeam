"""Convert bundled Python examples to editable Design documents.

Geometry is read back from CSXCAD after building the example at its defaults (or the selected
bundle's values).  That makes the export faithful to the actual model.  Python expressions cannot
be read back, so the example is rebuilt with each parameter moved and every number of the design
that is an exact linear function of the parameters becomes an expression over them; the rest stay
numbers, and the parameters that drive nothing are left out.

The copy keeps the example's name for each part (and its label and colour), its materials' names
and its description. What the conversion did is in ``model.conversion`` (shown as the conversion
notes in the designer's Properties), as notes with a code the app translates.
"""

from __future__ import annotations

import copy
import json
import math
from fractions import Fraction
from collections import Counter
from pathlib import Path

from .design import build as build_design, check_design, evaluate, in_plane, param_key_error
from .geometry import read_structure
from .model import load_model, resolve_params


class ExampleConversionError(ValueError):
    """The resolved example uses a feature that Design cannot reproduce exactly."""


def _primitive(p):
    kind = p["kind"]
    if not p.get("exact", False):
        raise ExampleConversionError(f"geometry primitive {p.get('source_kind', kind)!r} is not exactly readable")
    if kind == "transformed":
        local = p.get("primitive")
        if not isinstance(local, dict) or local.get("kind") == "transformed":
            raise ExampleConversionError("nested transformed geometry is not supported by exact example conversion")
        primitive = _primitive(local)
        primitive["transforms"] = _similarity_transforms(p.get("matrix"))
        return primitive

    q = {"kind": kind, "priority": p["priority"]}
    if kind == "box":
        # CSXCAD boxes may list their corners in any order; the design schema wants min/max per axis
        a, b = p["start"], p["stop"]
        q.update(start=[min(u, v) for u, v in zip(a, b)], stop=[max(u, v) for u, v in zip(a, b)])
    elif kind in ("polygon", "linpoly"):
        q.update(normal="xyz"[p["normal"]], elevation=p["elevation"], points=p["points"])
        if kind == "linpoly":
            q["length"] = p["length"]
    elif kind == "cylinder":
        a, b = p["start"], p["stop"]
        axes = [i for i in range(3) if abs(a[i] - b[i]) > 1e-9]
        if len(axes) != 1:
            raise ExampleConversionError("cylinder axis is not a single coordinate axis")
        axis = axes[0]
        q.update(axis="xyz"[axis], center=[a[i] for i in range(3) if i != axis],
                 range=[min(a[axis], b[axis]), max(a[axis], b[axis])], radius=p["radius"])
    elif kind == "cylindricalshell":
        a, b = p["start"], p["stop"]
        axes = [i for i in range(3) if abs(a[i] - b[i]) > 1e-9]
        if len(axes) != 1:
            raise ExampleConversionError("cylindrical shell axis is not a single coordinate axis")
        axis = axes[0]
        outer = p["radius"] + p["shell_width"] / 2
        inner = p["radius"] - p["shell_width"] / 2
        if inner < 0:
            raise ExampleConversionError("cylindrical shell has a negative inner radius")
        q.update(kind="cylinder", axis="xyz"[axis], center=[a[i] for i in range(3) if i != axis],
                 range=[min(a[axis], b[axis]), max(a[axis], b[axis])], radius=outer,
                 inner_radius=inner)
    elif kind == "sphere":
        q.update(center=p["center"], radius=p["radius"])
    elif kind == "wire":
        q.update(points=p["points"], radius=p["radius"])
    elif kind == "rotpoly":
        # RotPoly encodings are not guaranteed to match Design's cone/torus/profile forms.
        raise ExampleConversionError("CSXCAD RotPoly is not supported by exact example conversion")
    elif kind == "polyhedron":
        q.update(vertices=p["vertices"], faces=p["faces"])
    else:
        raise ExampleConversionError(f"geometry primitive {kind!r} is not supported by the Design schema")
    return q


def _similarity_transforms(matrix):
    """Decompose a row-major affine similarity into existing Design transforms.

    Design supports positive uniform scale, an axis mirror, rotations, and a move.  Keeping this
    decomposition exact lets Python-panel Apply round-trip a native CSXCAD matrix without adding a
    second transform representation to the Design schema.  Shear and nonuniform scale are refused.
    """
    import numpy as np

    try:
        m = np.asarray(matrix, dtype=float)
    except (TypeError, ValueError):
        raise ExampleConversionError("transformed geometry has an invalid matrix") from None
    if m.shape != (4, 4) or not np.isfinite(m).all():
        raise ExampleConversionError("transformed geometry has an invalid matrix")
    if not np.allclose(m[3], [0.0, 0.0, 0.0, 1.0], rtol=0.0, atol=1e-12):
        raise ExampleConversionError("transformed geometry matrix is not affine")

    linear = m[:3, :3]
    scale = float(np.linalg.norm(linear[:, 0]))
    if not math.isfinite(scale) or scale <= 0.0:
        raise ExampleConversionError("transformed geometry has a singular matrix")
    normalized = linear / scale
    gram = normalized.T @ normalized
    if not np.allclose(gram, np.eye(3), rtol=0.0, atol=1e-12):
        raise ExampleConversionError("transformed geometry uses shear or nonuniform scale")

    reflected = float(np.linalg.det(normalized)) < 0.0
    rotation = normalized.copy()
    if reflected:
        # A = R * mirrorX * scale.  Factoring the reflection on the right keeps R proper.
        rotation[:, 0] *= -1.0
    if not np.allclose(rotation.T @ rotation, np.eye(3), rtol=0.0, atol=1e-12):
        raise ExampleConversionError("transformed geometry matrix is not a similarity")

    # Extract R = Rz(gamma) * Ry(beta) * Rx(alpha), matching Design's ordered x/y/z transforms.
    cos_beta = math.hypot(float(rotation[0, 0]), float(rotation[1, 0]))
    beta = math.atan2(-float(rotation[2, 0]), cos_beta)
    if cos_beta > 1e-12:
        alpha = math.atan2(float(rotation[2, 1]), float(rotation[2, 2]))
        gamma = math.atan2(float(rotation[1, 0]), float(rotation[0, 0]))
    else:
        # At gimbal lock, choose gamma=0; this equivalent x angle reconstructs R exactly.
        alpha = math.atan2(-float(rotation[1, 2]), float(rotation[1, 1]))
        gamma = 0.0

    def clean(value):
        return 0.0 if abs(value) < 1e-12 else float(value)

    scale = 1.0 if abs(scale - 1.0) < 1e-12 else scale
    offset = [clean(v) for v in m[:3, 3]]
    transforms = [{"type": "scale", "factors": [scale, scale, scale], "origin": [0.0, 0.0, 0.0]}]
    if reflected:
        transforms.append({"type": "mirror", "plane": "x", "keep": False})
    for axis, angle in zip("xyz", (alpha, beta, gamma)):
        degrees = clean(math.degrees(angle))
        transforms.append({"type": "rotate", "axis": axis, "center": [0.0, 0.0, 0.0],
                           "angle": degrees})
    transforms.append({"type": "move", "offset": offset})

    reconstructed = np.eye(4)
    for transform in transforms:
        operation = np.eye(4)
        if transform["type"] == "scale":
            operation[:3, :3] = np.diag(transform["factors"])
        elif transform["type"] == "mirror":
            operation[0, 0] = -1.0
        elif transform["type"] == "rotate":
            angle = math.radians(transform["angle"])
            c, sn = math.cos(angle), math.sin(angle)
            if transform["axis"] == "x":
                operation[:3, :3] = [[1.0, 0.0, 0.0], [0.0, c, -sn], [0.0, sn, c]]
            elif transform["axis"] == "y":
                operation[:3, :3] = [[c, 0.0, sn], [0.0, 1.0, 0.0], [-sn, 0.0, c]]
            else:
                operation[:3, :3] = [[c, -sn, 0.0], [sn, c, 0.0], [0.0, 0.0, 1.0]]
        else:
            operation[:3, 3] = transform["offset"]
        reconstructed = operation @ reconstructed
    if not np.allclose(reconstructed, m, rtol=1e-12, atol=1e-12):
        raise ExampleConversionError("transformed geometry matrix cannot be represented exactly")
    return transforms


def _transform_signature(transforms):
    """Stable exact key: tiny transform differences must never move geometry by grouping."""
    return json.dumps(transforms, sort_keys=True, separators=(",", ":"))


def _group_primitives(primitives):
    """Keep primitives with the same native transform in one Design part."""
    groups = {}
    for source in primitives:
        converted = _primitive(source)
        transforms = converted.pop("transforms", [])
        key = _transform_signature(transforms)
        if key not in groups:
            groups[key] = {"transforms": transforms, "primitives": []}
        groups[key]["primitives"].append(converted)
    if not groups:
        groups[_transform_signature([])] = {"transforms": [], "primitives": []}
    return list(groups.values())


def _unique_split_name(base, index, used):
    suffix = index + 1
    candidate = base if index == 0 else f"{base} [{suffix}]"
    while candidate in used:
        suffix += 1
        candidate = f"{base} [{suffix}]"
    used.add(candidate)
    return candidate


def _cells(sim):
    return math.prod(max(len(sim.mesh.GetLines(a)) - 1, 1) for a in "xyz")


def _snap_coordinates(design: dict, digits: int = 6) -> None:
    """Round geometry and port coordinates to the precision the automatic mesh uses for its lines.

    Coordinates read back from a Python model carry full float precision (e.g. -20.64385458504718),
    while the mesh lines are placed with ~1e-6 mm resolution; a zero-thickness port sheet 4e-7 mm off
    its line then covers no cell edge ("unused primitive") and the port is never excited."""
    def r(v):
        if isinstance(v, float):
            return round(v, digits)
        if isinstance(v, list):
            return [r(x) for x in v]
        return v
    keys = ("start", "stop", "points", "vertices", "elevation", "length", "range", "radius", "center", "origin")
    for part in design.get("parts", []):
        for prim in part.get("primitives", []):
            for k in keys:
                if k in prim:
                    prim[k] = r(prim[k])
    for group in ("ports", "resistors"):
        for item in design.get(group, []):
            for feed in [item] + item.get("group", {}).get("members", []):
                for k in ("start", "stop"):
                    if k in feed:
                        feed[k] = r(feed[k])


def _check_reconstructible_ports(sim):
    """Refuse adapters or hidden feeds that a Design's ordinary ports would replace."""
    import numpy as np
    from openEMS.ports import LumpedPort, RectWGPort
    from .simulation import GroupedLumpedPort

    native_ports = sim._port_objs
    if len(sim.ports) != len(native_ports):
        raise ExampleConversionError("port records do not match the native port objects")
    native_types = {"lumped": LumpedPort, "waveguide": RectWGPort}
    recorded_properties = set()
    for record, port in zip(sim.ports, native_ports):
        expected = native_types.get(record["type"])
        if "group" in record:
            expected = GroupedLumpedPort
        if expected is None:
            raise ExampleConversionError(f"port type {record['type']!r} is not representable")
        number = record["number"]
        # Subclasses may override CalcPort while keeping the same geometry. Design would
        # rebuild the base class and silently lose those measurement semantics too.
        if type(port) is not expected:
            raise ExampleConversionError(
                f"port {number} uses a grouped or custom measurement adapter "
                f"({type(port).__name__}); keep this model as Python")
        if port.number != number:
            raise ExampleConversionError(f"port {number} does not match its native port number {port.number}")
        if expected is GroupedLumpedPort:
            if record != port.definition or any(type(member) is not LumpedPort for member in port.members):
                raise ExampleConversionError(f"port {number} group metadata or native members were changed")
            from .design import port_feeds
            feeds = [feed for _, feed in port_feeds(record, "port")]
            count = len(feeds)
            parallel = record["group"]["connection"] == "parallel"
            reference = record["R"] * count if parallel else record["R"] / count
            canonical = GroupedLumpedPort(record, port.members)
            if (len(port.members) != count or port.Z_ref != record["R"]
                    or not np.array_equal(port._u_weights, canonical._u_weights)
                    or not np.array_equal(port._i_weights, canonical._i_weights)):
                raise ExampleConversionError(f"port {number} group measurement was changed")
            for member, feed in zip(port.members, feeds):
                axis = "xyz".index(feed["direction"])
                length = abs(feed["stop"][axis] - feed["start"][axis])
                amplitude = feed.get("polarity", 1) / length / (1 if parallel else count) if record["excite"] else 0
                if (member.number != number or member.R != reference or member.exc_ny != axis
                        or member.excite != amplitude or member.priority != record["group"].get("priority", 5)
                        or not np.array_equal(member.start, feed["start"])
                        or not np.array_equal(member.stop, feed["stop"])):
                    raise ExampleConversionError(f"port {number} group native member was changed")
        for prop in port.port_props:
            if prop.GetQtyPrimitives() > 1:
                raise ExampleConversionError(
                    f"port {number} contains multiple primitives in {prop.GetName()!r}; "
                    "grouped feed geometry is not representable")
            recorded_properties.add(prop.GetID())

    resistor_names = {p["name"] for p in sim.lumped_elements}
    for prop in sim.csx.GetAllProperties():
        kind = prop.GetTypeString()
        if kind not in ("LumpedElement", "Excitation") or not prop.GetQtyPrimitives():
            continue
        if prop.GetID() in recorded_properties:
            continue
        if kind == "LumpedElement" and prop.GetName() in resistor_names:
            continue
        # read_structure intentionally omits lumped elements and excitations. Native
        # feeds created outside Simulation's records would otherwise disappear here.
        raise ExampleConversionError(f"unrecorded {kind} {prop.GetName()!r} cannot be represented exactly")


def _read_design(module, values: dict, source_path: Path):
    """Build the example at ``values`` and read it back as the parts of a design.

    Returns ``(sim, core)``; ``core`` holds simulation, materials, parts, ports, resistors,
    far_field and monitors (no model, params or mesh), with plain numbers throughout.  Every metal
    of the source keeps its own material, named like the source's metal ("patch", "gnd"); identical
    dielectrics share one design material, named after the first.  The parts keep their names,
    labels ("Patch", "Ground plane") and colours."""
    try:
        sim = module.build(values)
    except ExampleConversionError:
        raise
    except Exception as exc:
        raise ExampleConversionError(f"could not load/build {source_path.name} at defaults: {exc}") from exc

    if getattr(sim, "unit", 1e-3) != 1e-3:
        raise ExampleConversionError(f"simulation length unit {sim.unit:g} m is not millimetres")
    excitation = getattr(sim, "excitation", {})
    if excitation.get("type") != "gaussian-derivative":
        raise ExampleConversionError(f"excitation {excitation.get('type')!r} cannot be represented exactly")

    _check_reconstructible_ports(sim)
    parts_read, _, nf2ff = read_structure(sim.csx, sim.materials, sim.unit)
    parts, materials, shared = [], [], {}
    used_part_names = set()
    part_sources, source_counts = {}, Counter()
    for entry in parts_read:
        typ = entry["type"]
        if typ in ("Metal", "ConductingSheet"):
            conductor = entry.get("conductor") or {}
            # a metal is a part of the source (its CSXCAD property): its own material, named like it
            item = {"name": entry["name"], "kind": "metal"}
            if conductor.get("conductivity") is not None:
                item["conductivity"] = str(conductor["conductivity"])
                if conductor.get("thickness") is not None:
                    item["thickness"] = str(conductor["thickness"])
            key = ("metal", entry["name"])
        elif typ == "Material":
            m = entry.get("material", {})
            if m.get("dispersion"):
                # the Design schema has no frequency-dependent dielectric yet: writing the
                # band-centre eps_r and tan d would drop the model without a word
                raise ExampleConversionError(
                    f"material {entry['name']!r} is dispersive ({m['dispersion'].get('model')}); "
                    "Design materials are constant, so it cannot be converted without losing its frequency dependence")
            if not m.get("isotropic", True):
                raise ExampleConversionError(f"material {entry['name']!r} is anisotropic")
            if m.get("tan_d") is None and abs(m.get("kappa", 0.0)) > 1e-15:
                raise ExampleConversionError(f"material {entry['name']!r} has conductivity not recorded as a loss tangent")
            item = {"name": entry["name"], "kind": "dielectric", "eps_r": str(m["eps_r"]),
                    "tan_d": str(m.get("tan_d") or 0)}
            if abs(m.get("mu_r", 1.0) - 1.0) > 1e-10:
                item["mu_r"] = str(m["mu_r"])
            if m.get("tan_d_freq") is not None:
                item["tan_d_freq"] = str(m["tan_d_freq"] / 1e9)
            key = ("dielectric", item["eps_r"], item["tan_d"], item.get("tan_d_freq"), m.get("kappa"), item.get("mu_r"))
        elif typ == "LumpedElement":
            continue
        else:
            raise ExampleConversionError(f"CSXCAD property type {typ!r} is not representable")
        if key not in shared:
            # material names are unique in a design (a metal and a dielectric of the same name)
            base, n = item["name"], 2
            while any(m["name"] == item["name"] for m in materials):
                item["name"], n = f"{base} {n}", n + 1
            shared[key] = item["name"]
            materials.append(item)
        source_counts[entry["name"]] += 1
        for index, group in enumerate(_group_primitives(entry["primitives"])):
            part = {"name": _unique_split_name(entry["name"], index, used_part_names),
                    "material": shared[key], "primitives": group["primitives"]}
            if entry.get("label"):
                part["label"] = entry["label"] if index == 0 else f"{entry['label']} [{index + 1}]"
            if entry.get("color"):
                part["color"] = entry["color"]
            if group["transforms"]:
                part["transforms"] = group["transforms"]
            parts.append(part)
            part_sources[part["name"]] = entry["name"]

    ports = []
    for p in sim.ports:
        if p["type"] == "lumped":
            ports.append({"type": "lumped", "number": p["number"], "R": str(p["R"]),
                          **({"reference_impedance": dict(p["reference_impedance"])} if "reference_impedance" in p else {}),
                          "start": p["start"], "stop": p["stop"], "direction": p["direction"],
                          "excite": p["excite"], **({"group": copy.deepcopy(p["group"])} if "group" in p else {})})
        elif p["type"] == "waveguide":
            ports.append({"type": "waveguide", "number": p["number"], "mode": p["mode"],
                          "a": str(p["a"]), "b": str(p["b"]), "start": p["start"],
                          "stop": p["stop"], "direction": p["direction"], "excite": p["excite"]})
        else:
            raise ExampleConversionError(f"port type {p['type']!r} is not representable")
    resistors = [{"name": p["name"], **{k: str(p[k]) for k in ("R", "L", "C") if k in p},
                  **({"topology": p["topology"]} if "topology" in p else {}),
                  "start": p["start"], "stop": p["stop"], "direction": p["direction"]} for p in sim.lumped_elements]

    if not getattr(sim, "nf2ff", None):
        far_field = {"enabled": False}
    else:
        far_field = {"enabled": True}
        if getattr(sim, "nf2ff_faces", None) is not None and sim.nf2ff_faces != [True] * 6:
            far_field["faces"] = [bool(v) for v in sim.nf2ff_faces]
        if getattr(sim, "nf2ff_center", None) is not None:
            far_field["phase_center"] = [float(v) for v in sim.nf2ff_center]
        pattern = getattr(sim, "pattern_freqs", None)
        if pattern is not None:
            far_field["frequencies"] = [str(f / 1e9) for f in pattern]
    if nf2ff and not far_field["enabled"]:
        raise ExampleConversionError("NF2FF geometry was found but the Simulation has no NF2FF monitor")

    core = {
        "simulation": {"f_min": str(sim.f_min / 1e9), "f_max": str(sim.f_max / 1e9),
                       "boundaries": [str(x).upper() for x in sim.boundaries],
                       "end_criteria_db": sim.end_criteria_db, "max_timesteps": sim.max_timesteps},
        "materials": materials, "parts": parts, "ports": ports, "resistors": resistors,
        "far_field": far_field,
    }
    from .organization import restore_organization
    try:
        restore_organization(module, core, part_sources, source_counts)
    except ValueError as exc:
        raise ExampleConversionError(str(exc)) from exc
    if sim.current_freqs:
        core["monitors"] = {"currents": [str(f / 1e9) for f in sim.current_freqs]}
    if getattr(sim, "efficiency_points", None) and far_field["enabled"]:
        core.setdefault("monitors", {})["efficiency"] = {"points": int(sim.efficiency_points)}
    return sim, core


# ------------------------------------------------------------------------- parameters
#
# A Python example is a function of its PARAMS; a design holds resolved numbers.  To keep the
# parameters, the example is rebuilt with each parameter moved a little (at most two builds per
# parameter, one when it changes nothing) and every number of the design (a "slot") is fitted as
# ``a * value + b``.  A slot that is exactly linear in the parameters that move it (checked at every
# probe build, including one with all of them moved together) becomes an expression; every other
# slot stays a number.

_GEOMETRY_KEYS = ("start", "stop", "points", "vertices", "elevation", "length", "range", "radius", "inner_radius",
                  "center", "origin")
_LINE_AXES = "xyz"


def _number(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def _slot_paths(core: dict) -> list:
    """Paths (tuples of keys and indexes) of every number a parameter could drive."""
    out = []

    def walk(path, v):
        if isinstance(v, list):
            for i, x in enumerate(v):
                walk(path + (i,), x)
        elif isinstance(v, dict):
            for key, item in v.items():
                walk(path + (key,), item)
        elif _number(v) is not None:
            out.append(path)

    def scan(path, obj, keys):
        for k in keys:
            if k in obj:
                walk(path + (k,), obj[k])

    scan(("simulation",), core["simulation"], ("f_min", "f_max"))
    for i, m in enumerate(core["materials"]):
        scan(("materials", i), m, ("eps_r", "mu_r", "tan_d", "tan_d_freq"))
    for i, part in enumerate(core["parts"]):
        scan(("parts", i), part, ("transforms",))
        for j, prim in enumerate(part["primitives"]):
            scan(("parts", i, "primitives", j), prim, _GEOMETRY_KEYS)
    for i, p in enumerate(core["ports"]):
        scan(("ports", i), p, ("start", "stop", "R", "a", "b", "reference_impedance"))
        for j, member in enumerate(p.get("group", {}).get("members", [])):
            scan(("ports", i, "group", "members", j), member, ("start", "stop"))
    for i, r in enumerate(core["resistors"]):
        scan(("resistors", i), r, ("start", "stop", "R", "L", "C"))
    scan(("far_field",), core["far_field"], ("phase_center", "frequencies"))
    if "monitors" in core:
        scan(("monitors",), core["monitors"], ("currents",))
    return out


def _get(obj, path):
    for k in path:
        obj = obj[k]
    return obj


def _set(obj, path, value):
    _get(obj, path[:-1])[path[-1]] = value


def _slot_values(core: dict, lines) -> dict:
    """Every slot's value; ``lines`` are the mesh lines per axis (their slots are ("mesh", axis, i))."""
    out = {p: _number(_get(core, p)) for p in _slot_paths(core)}
    for a, axis_lines in enumerate(lines):
        for i, v in enumerate(axis_lines):
            out[("mesh", _LINE_AXES[a], i)] = float(v)
    return out


def _skeleton(core: dict) -> str:
    """The design without its numbers: what must not change when a parameter moves."""
    d = copy.deepcopy(core)
    for p in _slot_paths(d):
        _set(d, p, 0)
    return json.dumps(d, sort_keys=True)


def _slot_axis(core: dict, path):
    """The axis (0-2) of a slot that is a coordinate along one axis, else None."""
    head = path[0]
    if head in ("ports", "resistors"):
        if head == "ports" and len(path) == 7 and path[2:4] == ("group", "members") and path[5] in ("start", "stop"):
            return path[6]
        return path[3] if len(path) == 4 and path[2] in ("start", "stop") else None
    if head != "parts":
        return None
    if path[2] == "transforms":
        return None
    prim = core["parts"][path[1]]["primitives"][path[3]]
    key, rest = path[4], path[5:]
    if key in ("start", "stop") and len(rest) == 1:
        return rest[0]
    if key == "vertices" and len(rest) == 2:
        return rest[1]
    if key == "points" and len(rest) == 2:
        if prim["kind"] == "wire":
            return rest[1]
        if prim["kind"] in ("polygon", "linpoly"):
            return in_plane("xyz".index(prim["normal"]))[rest[1]]
    if key == "elevation":
        return "xyz".index(prim["normal"])
    if prim["kind"] == "cylinder":
        axis = "xyz".index(prim["axis"])
        if key == "range":
            return axis
        if key == "center" and len(rest) == 1:
            return [a for a in range(3) if a != axis][rest[0]]
    if key == "center" and prim["kind"] == "sphere" and len(rest) == 1:
        return rest[0]
    return None


def _steps(param, p0):
    """Two other values of a numeric parameter inside its range, or None."""
    lo, hi = param.minimum, param.maximum
    if isinstance(p0, int):
        d = max(1, round(0.1 * abs(p0)))
    elif p0:
        d = 0.1 * abs(p0)
    else:
        d = 0.1 * (hi - lo) if lo is not None and hi is not None else 1.0
    for a, b in ((p0 + d, p0 - d), (p0 + d, p0 + 2 * d), (p0 - d, p0 - 2 * d)):
        if all((lo is None or v >= lo) and (hi is None or v <= hi) for v in (a, b)):
            return a, b
    return None


def _decimal(x: float, digits: int = 12) -> str:
    return format(x, f".{digits}f").rstrip("0").rstrip(".") or "0"


def _coefficient(a: float, loose: bool):
    """``(numerator, denominator, value)`` of a coefficient: a small fraction (1/2, 3/4) when ``a``
    is one, else numerator None and the value rounded to 12 decimals (6 when ``loose``)."""
    f = Fraction(a).limit_denominator(100 if loose else 1000)
    if f != 0 and abs(float(f) - a) <= (1e-6 * max(1.0, abs(a)) if loose else 1e-9 * abs(a)):
        return f.numerator, f.denominator, float(f)
    return None, None, float(_decimal(a, 6 if loose else 12))


def _expression(terms: dict, p0: dict, target: float, loose: bool = False) -> str:
    """``sum(a * key) + b`` that equals ``target`` at the default values ``p0``.  ``loose`` rounds the
    coefficients to 6 decimals (a mesh line only has to stay in order, ``b`` absorbs the rounding)."""
    used, parts = 0.0, []
    for key, a in terms.items():
        num, den, value = _coefficient(a, loose)
        if value == 0:
            continue
        used += value * p0[key]
        if num is None:
            body = f"{_decimal(abs(value), 6 if loose else 12)}*{key}"
        else:
            body = key if abs(num) == 1 else f"{abs(num)}*{key}"
            if den != 1:
                body += f"/{den}"
        parts.append(("-" if value < 0 else "+", body))
    digits = 9 if loose else 12
    b = round(target - used, digits)
    if abs(b) >= 0.5 * 10.0 ** -digits or not parts:
        parts.append(("-" if b < 0 else "+", _decimal(abs(b), digits)))
    text = ""
    for i, (sign, body) in enumerate(parts):
        text += (("-" if sign == "-" else "") if i == 0 else f" {sign} ") + body
    return text


def _fit_parameters(module, source_path: Path, values: dict, base_core: dict, base_lines) -> dict:
    """Which slots of the design are exact linear functions of the example's parameters.

    Returns ``{"expressions": {slot path: text}, "carried": [key, ...], "skipped": {key: why}}``."""
    snapped = copy.deepcopy(base_core)
    _snap_coordinates(snapped)
    snapped_lines = [[round(float(v), 6) for v in axis] for axis in base_lines]
    target = _slot_values(snapped, snapped_lines)     # what the design holds now
    raw = _slot_values(base_core, base_lines)         # what the example produced
    skeleton = _skeleton(base_core)
    line_counts = [len(axis) for axis in base_lines]

    def tol(v):
        return 1e-9 * max(1.0, abs(v))

    def read(changed: dict):
        """The slot values of the example rebuilt with the ``changed`` parameter values, or None when
        it cannot be built or is a different design (other shapes, materials or ports).  An axis with
        another number of mesh lines is left out: its lines have no line-by-line meaning."""
        try:
            sim, core = _read_design(module, {**values, **changed}, source_path)
            lines = [[float(v) for v in sim.mesh.GetLines(a)] for a in "xyz"]
        except Exception:
            return None
        if _skeleton(core) != skeleton:
            return None
        lines = [axis if len(axis) == n else [] for axis, n in zip(lines, line_counts)]
        return _slot_values(core, lines)

    skipped: dict[str, str] = {}
    taint: set = set()          # slots that are not exactly linear in the parameters that move them
    deps: dict = {}             # slot -> {parameter key: coefficient}
    probes = [(dict(values), raw)]
    steps, moved_of = {}, {}
    for param in module.PARAMS:
        key, p0 = param.key, values[param.key]
        if isinstance(p0, (bool, str)) or not isinstance(p0, (int, float)):
            skipped[key] = "not a number"
            continue
        if param_key_error(key):
            skipped[key] = "its name is reserved in designs"
            continue
        pair = _steps(param, p0)
        if pair is None:
            skipped[key] = "its range is too narrow to test"
            continue
        p1, p2 = pair
        s1 = read({key: p1})
        if s1 is None:
            skipped[key] = "changes the structure of the model or fails to build"
            continue
        taint |= {p for p in raw if p not in s1}
        moved = [p for p in s1 if abs(s1[p] - raw[p]) > tol(raw[p])]
        if not moved:
            skipped[key] = "changes nothing a design holds" if all(p in s1 for p in raw) else "only changes the mesh"
            continue
        moved_of[key] = moved
        s2 = read({key: p2})
        if s2 is None:
            taint |= set(moved)
            skipped[key] = "changes the structure of the model or fails to build"
            continue
        taint |= {p for p in raw if p not in s2}
        for p in moved:
            if p in taint:
                continue
            a = (s1[p] - s2[p]) / (p1 - p2)
            if abs(raw[p] - (s2[p] + a * (p0 - p2))) > tol(raw[p]):
                taint.add(p)        # bends between the three points
            else:
                deps.setdefault(p, {})[key] = a
        taint |= {p for p in s2 if p not in moved and abs(s2[p] - raw[p]) > tol(raw[p])}
        probes.append(({**values, key: p1}, s1))
        probes.append(({**values, key: p2}, s2))
        steps[key] = p1
    candidates = {p: t for p, t in deps.items() if p not in taint and p in target}

    # one build with every parameter that drives a slot moved together: cross terms show up here
    used = sorted({k for t in candidates.values() for k in t})
    if any(len(t) > 1 for t in candidates.values()):
        joint = read({k: steps[k] for k in used})
        if joint is None:
            candidates = {p: t for p, t in candidates.items() if len(t) == 1}
        else:
            probes.append(({**values, **{k: steps[k] for k in used}}, joint))

    p0 = {k: float(values[k]) for k in used}
    expressions, terms_of = {}, {}
    for path, terms in candidates.items():
        text = _expression(terms, p0, target[path])
        for n, (vals, got) in enumerate(probes):
            if path not in got:
                break
            try:
                value = evaluate(text, {k: float(v) for k, v in vals.items() if _number(v) is not None})
            except Exception:
                break
            want, limit = (target[path], 1e-10) if n == 0 else (got[path], 1e-6 + 1e-9 * abs(got[path]))
            if abs(value - want) > limit:
                break
        else:
            expressions[path], terms_of[path] = text, terms

    # A mesh line that sits on a coordinate of the geometry follows that coordinate; the lines between
    # two such lines keep their proportional place between them, and the lines beyond the outermost
    # one keep their distance from it.  The cells stretch with the geometry and the lines stay in order.
    on_axis = {}
    for path, value in target.items():
        axis = _slot_axis(base_core, path) if path[0] != "mesh" else None
        if axis is not None:
            on_axis.setdefault(axis, []).append((value, expressions.get(path), terms_of.get(path, {})))
    p0 = {p.key: float(values[p.key]) for p in module.PARAMS if _number(values[p.key]) is not None}
    for a, axis in enumerate(_LINE_AXES):
        lines = snapped_lines[a]
        for i, v in enumerate(lines):
            path = ("mesh", axis, i)
            if path in terms_of:
                continue
            for value, text, terms in on_axis.get(a, ()):
                if abs(value - v) < 1e-9:
                    terms_of[path] = terms      # a coordinate that is a plain number pins its line
                    if text is not None:
                        expressions[path] = text
                    break
        anchors = [i for i in range(len(lines)) if ("mesh", axis, i) in terms_of]
        if not anchors:
            continue
        for i, v in enumerate(lines):
            path = ("mesh", axis, i)
            if path in terms_of:
                continue
            below = [j for j in anchors if j < i]
            above = [j for j in anchors if j > i]
            if below and above:
                lo, hi = below[-1], above[0]
                t = (v - lines[lo]) / (lines[hi] - lines[lo])
                lo_t, hi_t = terms_of[("mesh", axis, lo)], terms_of[("mesh", axis, hi)]
                terms = {k: (1 - t) * lo_t.get(k, 0.0) + t * hi_t.get(k, 0.0) for k in {*lo_t, *hi_t}}
            else:
                terms = terms_of[("mesh", axis, below[-1] if below else above[0])]
            terms = {k: terms[k] for k in sorted(terms)}
            if not terms or all(abs(a_) < 5e-7 for a_ in terms.values()):
                continue        # between fixed lines: stays where it is
            text = _expression(terms, p0, v, loose=True)
            try:
                ok = abs(evaluate(text, p0) - v) <= 1e-8
            except Exception:
                ok = False
            if ok:
                expressions[path], terms_of[path] = text, terms
    carried = [k for k in (p.key for p in module.PARAMS) if any(k in t for t in terms_of.values())]
    for param in module.PARAMS:
        if param.key not in carried and param.key not in skipped:
            skipped[param.key] = "no coordinate is an exact linear function of it"
    # a carried parameter that also moves geometry which is not a formula of it: that part stays fixed
    partial = [k for k in carried if any(p in taint and p[0] != "mesh" for p in moved_of.get(k, ()))]
    return {"expressions": expressions, "carried": carried, "partial": partial, "skipped": skipped}


def _note(code: str, text: str, **values) -> dict:
    """A conversion note: ``code`` names its text in the app (i18n key ``exampleCopy.note.<code>``,
    filled in with ``values``); ``text`` is the same sentence in English, for any other reader."""
    return {"code": code, "text": text, **({"values": values} if values else {})}


def _convert_example(source_path: Path, model_id: str, name: str,
                     overrides: dict[str, str] | None = None, origin: str | None = None) -> tuple[dict, int, int, dict]:
    """Build a Python example at the selected bundle's values or its defaults."""
    source_path = Path(source_path)
    try:
        module = load_model(source_path)
        values = resolve_params(module.PARAMS, overrides or {})
    except ExampleConversionError:
        raise
    except Exception as exc:
        raise ExampleConversionError(f"could not load/build {source_path.name} at defaults: {exc}") from exc
    sim, core = _read_design(module, values, source_path)
    base_lines = [[float(v) for v in sim.mesh.GetLines(a)] for a in "xyz"]
    fit = _fit_parameters(module, source_path, values, core, base_lines)
    materials, parts, ports, resistors, far_field = (core[k] for k in ("materials", "parts", "ports", "resistors", "far_field"))

    source_cells = _cells(sim)
    auto = getattr(sim, "mesh_report", None)
    settings = {}
    if auto:
        settings = auto.get("settings", {})
        cpw = settings.get("cells_per_wavelength", 20)
        mesh = {"mode": "auto", "cells_per_wavelength": cpw}
        for key in ("pad", "edge_rule", "max_ratio", "air_cells_per_wavelength"):
            if settings.get(key) is not None:
                mesh[key] = settings[key]
    else:
        mesh = {"mode": "auto", "cells_per_wavelength": 20}
    source_name = origin or source_path.name
    notes = [_note("source", f"Converted from the bundled example {source_name} ({source_path.name}).",
                   example=source_name, file=source_path.name),
             _note("meshLines", "This design uses the example's own mesh lines, rounded to 1e-6 mm.")]

    carried, partial, skipped = fit["carried"], fit["partial"], fit["skipped"]
    expressions = fit["expressions"]
    params = []
    for param in module.PARAMS:
        if param.key in carried:
            item = {"key": param.key, "default": values[param.key], "label": param.label}
            if param.unit:
                item["unit"] = param.unit
            if param.minimum is not None:
                item["min"] = param.minimum
            if param.maximum is not None:
                item["max"] = param.maximum
            if param.description:
                item["description"] = param.description
            params.append(item)
    if carried:
        count = sum(1 for path in expressions if path[0] != "mesh")
        notes.append(_note("carried", f"Parameters carried from the example: {', '.join(carried)}. {count} coordinates and values that "
                           "are an exact linear function of them are expressions, so the design can be swept and optimized by them; "
                           "the other numbers are fixed. Mesh lines follow the geometry they sit on and stretch with it; after a large "
                           "change of a geometry parameter switch to the automatic mesh.", params=", ".join(carried), count=count))
        if partial:
            notes.append(_note("partial", "Only partly followed (the example also derives other geometry from them by a rule that is not "
                               "a formula the design can hold, and that geometry stays at its default size): " + ", ".join(partial) + ".",
                               params=", ".join(partial)))
    frozen = [f"{p.key}={values[p.key]}" for p in module.PARAMS if p.key not in carried]
    if frozen:
        notes.append(_note("frozen", "Source parameters not carried (frozen at example defaults or resolved override values): "
                           + ", ".join(frozen) + ".", params=", ".join(frozen)))
    if sim.current_freqs:
        notes.append(_note("currents", "The example's surface-current monitors are preserved at their resolved frequencies."))
    model = {"id": model_id.replace("_", "-"), "name": name}
    for key in ("description", "reference"):
        text = module.MODEL.get(key)
        if isinstance(text, str) and text.strip():
            model[key] = text.strip()
    model["conversion"] = {"source": source_name, "notes": notes}
    design = {
        "schema": "fairbeam.design/1",
        "model": model,
        "params": params,
        "simulation": core["simulation"],
        "materials": materials, "parts": parts, "ports": ports, "resistors": resistors,
        "mesh": mesh, "far_field": far_field,
    }
    if "components" in core:
        design["components"] = core["components"]
    if "monitors" in core:
        design["monitors"] = core["monitors"]
    # snap before validating, so the design that is checked, meshed and counted below is the one returned
    _snap_coordinates(design)
    for path, text in expressions.items():
        if path[0] != "mesh":
            _set(design, path, text)
    try:
        check_design(design)
        values = {}
        # Preserve the source mesh exactly as editable manual lines. Fit the Design settings
        # separately so the retained automatic overrides remain useful for future edits.
        source_lines = [[round(float(v), 6) for v in sim.mesh.GetLines(a)] for a in "xyz"]
        for axis, line in zip("xyz", source_lines):
            if len(line) != len(set(line)):
                raise ExampleConversionError(f"rounding source {axis} mesh lines to 1e-6 mm creates duplicates")
        base = dict(mesh)
        source_min_cell = min(min(b - a for a, b in zip(line, line[1:]) if b > a)
                              for line in source_lines if len(line) > 1)
        source_max_cell = max(max(b - a for a, b in zip(line, line[1:]) if b > a)
                              for line in source_lines if len(line) > 1)
        seed = {"cells_per_wavelength": float(base.get("cells_per_wavelength", 20)),
                "air_cells_per_wavelength": float(base.get("air_cells_per_wavelength", base.get("cells_per_wavelength", 20))),
                # per-face padding (a feed guide crossing a face: 0 there) is a list; the Design's
                # automatic settings take one value, the source lines are kept as manual lines anyway
                "pad": float(max(pad) if isinstance(pad := base.get("pad", 0.25 * 299792458 / sim.f_min / sim.unit), (list, tuple)) else pad),
                "max_ratio": float(base.get("max_ratio", 1.4)),
                "edge_rule": base.get("edge_rule", "edge"),
                "dielectric_cells": float(settings.get("dielectric_cells", 5) if auto else 5)}
        # Estimate grading from actual source spacing; vary padding to account for
        # mesh extent differences between authored and generated lines.
        seed["max_ratio"] = float(base.get("max_ratio", min(2.5, max(1.15, source_max_cell / max(source_min_cell, 1e-12)))) )
        pads = sorted(set(max(0.0, seed["pad"] * f) for f in (0.0, 0.5, 1.0, 1.5)))
        target_candidates = []
        cpws = sorted(set(max(3, min(80, int(round(seed["cells_per_wavelength"] * f))))
                          for f in (0.35, 0.5, 0.7, 0.9, 1.0, 1.3, 1.7)))
        for cpw in cpws:
            for air_ratio in (0.55, 0.85):
                for pad in pads:
                    for ratio in (1.2, seed["max_ratio"], 2.0):
                        candidate = dict(seed, cells_per_wavelength=cpw, pad=pad, max_ratio=ratio,
                                 edge_rule="edge" if any(p.get("kind") in ("polygon", "linpoly") for part in parts for p in part["primitives"]) else seed["edge_rule"],
                                 dielectric_cells=int(seed["dielectric_cells"]))
                        candidate["air_cells_per_wavelength"] = max(2, round(cpw * air_ratio))
                        candidate["air_cells_per_wavelength"] = min(candidate["air_cells_per_wavelength"], cpw)
                        target_candidates.append(candidate)
        best = None
        for candidate in target_candidates:
            mesh.clear(); mesh.update({"mode": "design", "overrides": candidate})
            try:
                built = build_design(design, values)
                count = _cells(built)
            except Exception:
                continue
            score = abs(math.log(max(count, 1) / max(source_cells, 1)))
            if count > 40_000_000:
                score += 10 + math.log(count / 40_000_000)
            if best is None or score < best[0]:
                best = (score, count, candidate)
        if best is None:
            raise ExampleConversionError("no valid Design automatic mesh candidate could be built")
        fitted_mesh = {"mode": "design", "overrides": best[2]}
        mesh.clear(); mesh.update(fitted_mesh)
        fitted = build_design(design, values)
        fitted_cells = _cells(fitted)
        # a line that follows a parameter is an expression, the others stay numbers
        manual = {axis: [expressions.get(("mesh", axis, i), v) for i, v in enumerate(line)]
                  for axis, line in zip("xyz", source_lines)}
        mesh.clear(); mesh.update({"mode": "manual", "lines": manual,
                                   "automatic": fitted_mesh})
        built = build_design(design, values)
        design_cells = _cells(built)
        if design_cells > 40_000_000:
            raise ExampleConversionError("Design automatic mesh exceeds the 40 million cell run limit")
        within_tolerance = 0.7 * source_cells <= fitted_cells <= 1.3 * source_cells
        if not built.ports and ports:
            raise ValueError("converted ports were not built")
    except Exception as exc:
        raise ExampleConversionError(f"converted Design failed validation/build: {exc}") from exc
    stats = {"params_carried": len(carried), "params_total": len(module.PARAMS),
             "params_partial": list(partial), "expressions": len(expressions)}
    return design, source_cells, design_cells, stats


def conversion_preview(source_path: Path, model_id: str, name: str,
                       overrides: dict[str, str] | None = None, origin: str | None = None) -> dict:
    """Convert an example and report the fitted source and Design mesh sizes."""
    design, source_cells, design_cells, stats = _convert_example(source_path, model_id, name, overrides, origin)
    return {"design": design, "source_cells": source_cells, "design_cells": design_cells,
            "within_tolerance": 0.7 * source_cells <= design_cells <= 1.3 * source_cells, **stats}


def convert_example(source_path: Path, model_id: str, name: str,
                    overrides: dict[str, str] | None = None, origin: str | None = None) -> dict:
    """Build a Python example at the selected bundle's values or its defaults."""
    return conversion_preview(source_path, model_id, name, overrides, origin)["design"]
