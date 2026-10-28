"""Explicit tensor-grid caps. No solver execution or optional-feature fallback.

Every baseline plane is retained. Boxes constrain *intersecting intervals*, not
samples of a size field; therefore even an off-sample tiny box cannot disappear.
"""
from __future__ import annotations

from copy import deepcopy
import math
import os
import re

EXPLANATION = "Use up to 32 named boxes with unique IDs, finite coordinates, increasing bounds, and a positive cell size inside the mesh domain. Coordinates use the model length unit; manual mesh keeps these settings inactive."
ID = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{0,63}\Z")


class LocalMeshError(ValueError):
    def __init__(self, detail, where="mesh.local_regions", code="mesh-local-region"):
        self.detail, self.where, self.code = detail, where, code
        super().__init__(f"{where}: {detail}")


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def region_checks(raw, evaluate=None, *, active=True):
    """Shared first-order checks; collect precise paths for the Design editor."""
    errors, resolved = [], []
    def error(path, text):
        errors.append(LocalMeshError(text, path))
    if not isinstance(raw, list):
        error("mesh.local_regions", "local regions must be a list")
        return resolved, errors
    if len(raw) > 32:
        error("mesh.local_regions", "use at most 32 local regions")
        return resolved, errors
    ids = set()
    for i, region in enumerate(raw):
        path = f"mesh.local_regions[{i}]"
        if not isinstance(region, dict):
            error(path, "local region must be an object")
            continue
        ident, name = region.get("id"), region.get("name")
        if not isinstance(ident, str) or not ID.fullmatch(ident):
            error(path + ".id", "region id must be 1–64 letters, digits, underscores or hyphens, starting with a letter or underscore")
        elif ident in ids:
            error(path + ".id", "region ids must be unique")
        else:
            ids.add(ident)
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80 or re.search(r"[\x00-\x1f\x7f]", name):
            error(path + ".name", "region name must contain 1–80 characters without control characters")
        def read(value, field):
            if not (_finite(value) or isinstance(value, str) and value.strip()):
                error(field, "region value must be a finite number or nonempty expression")
                return None
            if not active:
                return None
            try:
                value = evaluate(value, field) if evaluate else value
                if not _finite(value):
                    raise ValueError("region value must be finite")
                return float(value)
            except (ValueError, TypeError, ArithmeticError) as exc:
                error(field, getattr(exc, "detail", str(exc)))
                return None
        def vector(key):
            value = region.get(key)
            if not isinstance(value, list) or len(value) != 3:
                error(path + "." + key, "region bounds need exactly 3 coordinates")
                return None
            return [read(v, f"{path}.{key}[{k}]") for k, v in enumerate(value)]
        start, stop = vector("start"), vector("stop")
        cap = read(region.get("cell_size"), path + ".cell_size")
        if active and start is not None and stop is not None:
            for k in range(3):
                if start[k] is not None and stop[k] is not None and stop[k] <= start[k]:
                    error(f"{path}.stop[{k}]", "region stop must be greater than start on every axis")
        if cap is not None and cap <= 0:
            error(path + ".cell_size", "region cell size must be greater than zero")
        resolved.append(dict(id=ident, name=name, start=start, stop=stop, cell_size=cap) if active else deepcopy(region))
    return resolved, errors


def resolve_regions(raw, evaluate=None, *, active=True):
    resolved, errors = region_checks(raw, evaluate, active=active)
    if errors:
        raise errors[0]
    return resolved


def precision_marker(mesh):
    if "axis_precision" in mesh and mesh["axis_precision"] != "float64":
        raise LocalMeshError("axis precision must be float64", "mesh.axis_precision")
    return mesh.get("axis_precision") == "float64"


def cell_limit():
    try:
        value = float(os.environ.get("FAIRBEAM_MAX_CELLS", 40e6))
        if not math.isfinite(value) or value < 1:
            raise ValueError()
        return int(value)
    except (ValueError, OverflowError):
        raise LocalMeshError("invalid configured cell limit", code="mesh-local-limit") from None


def _axes(sim):
    import numpy as np
    axes = [np.asarray(sim.mesh.GetLines(a), dtype=float) for a in range(3)]
    for a, x in enumerate(axes):
        if x.ndim != 1 or len(x) < 2 or not np.all(np.isfinite(x)) or np.any(np.diff(x) <= 0):
            raise LocalMeshError("grid must contain finite strictly increasing lines", f"mesh.lines.{'xyz'[a]}", "mesh-local-grid")
        if not np.all(np.isfinite(np.diff(x))):
            raise LocalMeshError("grid interval is not representable", f"mesh.lines.{'xyz'[a]}", "mesh-local-grid")
    return axes


def _ratio(axes):
    import numpy as np
    result = 1.0
    for x in axes:
        w = np.diff(x)
        if len(w) > 1:
            result = max(result, float(np.max(np.maximum(w[1:] / w[:-1], w[:-1] / w[1:]))))
    if not math.isfinite(result):
        raise LocalMeshError("grid grading is not representable", code="mesh-local-grid")
    return result


def _stats(axes, unit):
    import numpy as np
    cells = [len(x) - 1 for x in axes]
    widths = [float(np.min(np.diff(x))) for x in axes]
    minimum = min(widths)
    dt = (minimum * unit / 299792458.0) / math.sqrt(sum((minimum / w) ** 2 for w in widths))
    if not math.isfinite(dt) or dt <= 0:
        raise LocalMeshError("CFL estimate is not representable", code="mesh-local-grid")
    return dict(cells=cells, total_cells=math.prod(cells), timestep_s=dt)


def _domain(regions, axes):
    for i, r in enumerate(regions):
        for a, x in enumerate(axes):
            for key, bad in (("start", r["start"][a] < x[0]), ("stop", r["stop"][a] > x[-1])):
                if bad:
                    raise LocalMeshError("region must lie inside the mesh domain", f"mesh.local_regions[{i}].{key}[{a}]")


def interval_union(regions, axis):
    """Disjoint positive-overlap minimum-cap union, independent of input order."""
    ends = sorted({r[key][axis] for r in regions for key in ("start", "stop")})
    result = []
    for lo, hi in zip(ends, ends[1:]):
        caps = [r["cell_size"] for r in regions if r["start"][axis] < hi and r["stop"][axis] > lo]
        if caps:
            cap = min(caps)
            if result and result[-1][1] == lo and result[-1][2] == cap:
                result[-1] = (result[-1][0], hi, cap)
            else:
                result.append((lo, hi, cap))
    return result


def _needed(width, cap, limit):
    quotient = width / cap
    if not math.isfinite(quotient) or quotient > limit:
        raise LocalMeshError("explicit local regions exceed the cell limit", code="mesh-local-limit")
    return max(1, math.ceil(quotient))


def _counts(x, union, limit, ceiling):
    import numpy as np
    w = [float(v) for v in np.diff(x)]
    caps = [min((cap for lo, hi, cap in union if x[i] < hi and x[i + 1] > lo), default=math.inf) for i in range(len(w))]
    counts = [_needed(width, math.nextafter(cap, math.inf), limit) for width, cap in zip(w, caps)]
    _grade(w, counts, limit, ceiling)
    return w, caps, counts


def _grade(widths, counts, limit, ceiling):
    # Counts only increase. Budget bounds both memory and termination; baseline
    # ratios are left untouched if there is no insertion.
    pending = set(range(len(counts) - 1))
    total = sum(counts)
    if total > limit:
        raise LocalMeshError("explicit local regions exceed the cell limit", code="mesh-local-limit")
    while pending:
        i = pending.pop()
        for j, k in ((i, i + 1), (i + 1, i)):
            h, neighbor = widths[j] / counts[j], widths[k] / counts[k]
            if h > math.nextafter(ceiling * neighbor, math.inf):
                new = max(counts[j] + 1, _needed(widths[j], ceiling * neighbor, limit))
                total += new - counts[j]
                if total > limit:
                    raise LocalMeshError("explicit local regions exceed the cell limit", code="mesh-local-limit")
                counts[j] = new
                pending.update(v for v in (j - 1, j) if 0 <= v < len(counts) - 1)


def refine_axes(axes, regions, limit, ceiling):
    """Plan all integer allocations before creating any refined dense array."""
    import numpy as np
    base_cells = [len(x) - 1 for x in axes]
    if math.prod(base_cells) > limit:
        raise LocalMeshError("baseline grid exceeds the cell limit", code="mesh-local-limit")
    plans = [_counts(x, interval_union(regions, a), limit // math.prod(base_cells[b] for b in range(3) if b != a), ceiling)
             for a, x in enumerate(axes)]
    # Floating-point placement can need one extra subdivision; re-plan before
    # each allocation. This is bounded refinement, never a relaxed cap.
    for placement in range(4):
        totals = [sum(plan[2]) for plan in plans]
        if math.prod(totals) > limit:
            raise LocalMeshError("explicit local regions exceed the cell limit", code="mesh-local-limit")
        result, changed = [], False
        for a, (x, (widths, caps, counts)) in enumerate(zip(axes, plans)):
            if all(n == 1 for n in counts):
                result.append(x.copy())
                continue
            pieces = [np.linspace(x[i], x[i + 1], n + 1)[:-1] if n > 1 else x[i:i + 1] for i, n in enumerate(counts)]
            out = np.concatenate([*pieces, x[-1:]])
            w = np.diff(out)
            if np.any(w <= 0) or not np.all(np.isfinite(w)):
                raise LocalMeshError("requested cap cannot be represented at these coordinates", code="mesh-local-grid")
            offset = 0
            for i, n in enumerate(counts.copy()):
                if float(np.max(w[offset:offset + n])) > math.nextafter(caps[i], math.inf):
                    counts[i] += 1
                    changed = True
                offset += n
            if not changed and _ratio([out]) > math.nextafter(ceiling, math.inf):
                # Give inserted neighbours a small numerical margin, while
                # retaining the exact baseline ceiling in the public report.
                for i in range(len(counts) - 1):
                    if max(widths[i] / counts[i], widths[i + 1] / counts[i + 1]) > (1 + .999 * (ceiling - 1)) * min(widths[i] / counts[i], widths[i + 1] / counts[i + 1]):
                        j = i if widths[i] / counts[i] > widths[i + 1] / counts[i + 1] else i + 1
                        counts[j] += 1
                        changed = True
            _grade(widths, counts, limit // math.prod(totals[b] for b in range(3) if b != a), ceiling)
            result.append(out)
        if not changed:
            return result
    raise LocalMeshError("requested cap or grading cannot be represented", code="mesh-local-grid")


def _measured(regions, axes):
    import numpy as np
    result = []
    for i, r in enumerate(regions):
        widths = []
        for a, x in enumerate(axes):
            selected = np.diff(x)[(x[:-1] < r["stop"][a]) & (x[1:] > r["start"][a])]
            maximum = float(np.max(selected))
            if maximum > math.nextafter(r["cell_size"], math.inf):
                raise LocalMeshError("final grid interval exceeds the requested region cell size", f"mesh.local_regions[{i}].cell_size", "mesh-local-grid")
            widths.append(maximum)
        result.append(dict(deepcopy(r), max_width=widths))
    return result


def apply_regions(sim, regions, configured_ratio, protected):
    import numpy as np
    if not regions:
        return
    regions = resolve_regions(regions)
    axes = _axes(sim)
    _domain(regions, axes)
    limit = cell_limit()
    baseline_ratio = _ratio(axes)
    ceiling = max(float(configured_ratio), baseline_ratio)
    before = _stats(axes, sim.unit)
    refined = refine_axes(axes, regions, limit, ceiling)
    _measured(regions, refined)
    ratio = _ratio(refined)
    if ratio > math.nextafter(ceiling, math.inf):
        raise LocalMeshError("local insertion exceeds inherited grading ceiling", code="mesh-local-grid")
    after = _stats(refined, sim.unit)
    sim._local_mesh_state = dict(regions=regions, domain=[(float(x[0]), float(x[-1])) for x in axes],
                                protected=[[float(v) for v in p if np.any(x == v)] for p, x in zip(protected, axes)],
                                cell_limit=limit,
                                insertion=dict(stage="after-automatic-probe-alignment", before=before, after=after,
                                               added_cells=after["total_cells"] - before["total_cells"], ratio=after["total_cells"] / before["total_cells"]),
                                grading=dict(configured_max_ratio=float(configured_ratio), baseline_max_ratio=baseline_ratio,
                                             admission_ceiling=ceiling, insertion_max_ratio=ratio))
    for a, x in enumerate(refined):
        sim.mesh.SetLines(a, x)
    finalize_regions(sim, _during_generation=True)


def finalize_regions(sim, *, _during_generation=False):
    """Validate only: never re-mesh after a native port has attached its probes."""
    import numpy as np
    if getattr(sim, "_mesh_generation_error", None) and not _during_generation:
        raise LocalMeshError(sim._mesh_generation_error, code="mesh-local-grid")
    state = getattr(sim, "_local_mesh_state", None)
    if not state and not getattr(sim, "_mesh_axis_precision", False):
        return
    axes = _axes(sim)
    stats = _stats(axes, sim.unit)
    limit = min(cell_limit(), state["cell_limit"]) if state else cell_limit()
    if stats["total_cells"] > limit:
        raise LocalMeshError("final grid exceeds the cell limit", code="mesh-local-limit")
    if not state:
        return
    for a, x in enumerate(axes):
        if (float(x[0]), float(x[-1])) != state["domain"][a] or any(not np.any(x == v) for v in state["protected"][a]):
            raise LocalMeshError("finalizer removed a protected geometry/feed/domain line", f"mesh.lines.{'xyz'[a]}", "mesh-local-grid")
    _domain(state["regions"], axes)
    measured = _measured(state["regions"], axes)
    report = sim.mesh_report
    from .automesh import axis_bottleneck
    widths = [np.diff(x) for x in axes]
    ratio = _ratio(axes)
    report.update(stats, min_cell=float(min(np.min(w) for w in widths)), max_cell=float(max(np.max(w) for w in widths)),
                  max_neighbour_ratio=ratio, timesteps_per_ns=1e-9 / stats["timestep_s"],
                  memory_mb_estimate=stats["total_cells"] * 90 / 1e6,
                  axis_bottlenecks={a: axis_bottleneck(x) for a, x in zip("xyz", axes)})
    report["local_refinement"] = dict(version=1, precision="float64-round-trip", regions=measured,
                                      insertion=deepcopy(state["insertion"]), final=dict(stage="validated-current-grid", **stats),
                                      cell_limit=limit, grading=dict(state["grading"], final_max_ratio=ratio))


def capture_design_regions(sim, mesh, params, names):
    """Bounded generated-Design provenance; generic API has no symbolic claims."""
    from .design import evaluate
    precision = precision_marker(mesh)
    active = mesh.get("mode", "auto") != "manual"
    raw = mesh.get("local_regions", [])
    regions = resolve_regions(raw, lambda v, _p: evaluate(v, names), active=active)
    if active and regions != (getattr(sim, "_local_mesh_state", None) or {}).get("regions", []):
        raise LocalMeshError("captured expressions differ from the resolved mesh regions")
    if "local_regions" in mesh or precision:
        sim._design_local_mesh = dict(version=1, local_regions=deepcopy(raw), params=deepcopy(params), names=deepcopy(names),
                                      resolved=deepcopy(regions), active=active, axis_precision=precision)
    if precision:
        sim._mesh_axis_precision = True


def captured_regions(sim):
    """Validate saved capture against the live resolved request before conversion."""
    capture = getattr(sim, "_design_local_mesh", None)
    state = getattr(sim, "_local_mesh_state", None)
    if capture:
        from .design import evaluate, resolve_names
        names = resolve_names({"params": capture["params"]}, capture["names"])
        if names != capture["names"]:
            raise LocalMeshError("captured parameter definitions differ from their resolved values")
        resolved = resolve_regions(capture["local_regions"], lambda v, _p: evaluate(v, capture["names"]), active=capture["active"])
        expected = state["regions"] if capture["active"] and state else capture["resolved"]
        if resolved != expected:
            raise LocalMeshError("captured expressions differ from the resolved mesh regions")
        return deepcopy(capture)
    if state:
        return dict(version=1, local_regions=deepcopy(state["regions"]), params=[], names={}, resolved=deepcopy(state["regions"]), active=True, axis_precision=True)
    return None
