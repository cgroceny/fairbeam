"""Command line interface: the ``fairbeam`` command (also ``python -m fairbeam``).

    fairbeam run models/sierpinski_monopole.py --set iterations=3 --threads 6
    fairbeam run patch_antenna --server              # queue it on the desktop app's server instead
    fairbeam params models/sierpinski_monopole.py
    fairbeam geometry models/patch_antenna.py        # build only, export without running
    fairbeam index public/projects                   # rebuild the project index
    fairbeam serve --port 5320                       # local run server for the viewer
    fairbeam clean-sim --older-than 7                # remove old raw openEMS output from .sim/
    fairbeam material-cell examples/slab_cell.py     # plane-wave cell: S11/S21 of a sample
    fairbeam debye-fit --datasheet 1e9:4.4:0.02 --f-min 1e9 --f-max 10e9   # laminate -> poles
"""

import argparse
import copy
import json
import math
import os
import re
import sys
import time
from pathlib import Path

import numpy as np

from .jsonutil import finite_json
from .legacy import schema_family
from .model import load_model, resolve_params

REPO = Path(__file__).resolve().parents[2]
# the repository's folders (a source checkout); `fairbeam serve` and `fairbeam app` keep them. The
# commands that write results default to appstate.cli_defaults() instead: the same folders in a
# checkout, the desktop app's workspace in the packaged runtime
DEFAULT_OUT = REPO / "public" / "projects"
DEFAULT_SIM = REPO / ".sim"


def _overrides(pairs):
    out = {}
    for item in pairs or []:
        if "=" not in item:
            raise SystemExit(f"--set expects key=value, got '{item}'")
        k, v = item.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def _slug(model_id, overrides):
    parts = [model_id] + [f"{k}-{v}" for k, v in sorted(overrides.items())]
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", "--".join(parts)).strip("-").lower()


def _thread_count(value):
    if value.lower() == "auto":
        return "auto"
    try:
        count = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be 'auto' or a non-negative integer") from None
    if count < 0:
        raise argparse.ArgumentTypeError("must be 'auto' or a non-negative integer")
    return count


def _resolve_run_threads(requested, sim) -> int:
    """Resolve the CLI's Auto after model construction, using the actual FDTD grid."""
    if requested != "auto":
        return requested
    from . import resources

    cpus = resources.available_cpus()
    physical = resources.physical_cores(cpus)
    cells = math.prod(max(len(sim.mesh.GetLines(axis)) - 1, 1) for axis in "xyz")
    return resources.auto_threads(cpus, physical, cells)


def _build(args):
    module = load_model(args.model)
    density = getattr(args, "mesh_density", None)
    if density is not None:  # a design at another automatic mesh density (mesh convergence)
        from .convergence import density_text, module_at_density
        module = module_at_density(module, density)
    overrides = _overrides(args.set)
    values = resolve_params(module.PARAMS, overrides)
    sim = module.build(values)
    params = [p.describe(values[p.key]) for p in module.PARAMS]
    slug = args.name or _slug(module.MODEL["id"], overrides)
    label = module.MODEL["name"] + ("" if not overrides else " · " + ", ".join(
        f"{k}={v}" for k, v in sorted(overrides.items())))
    given = getattr(args, "label", None)
    if isinstance(given, str) and given.strip():   # the result name the user typed (Run dialog): the bundle's name, so lists show it
        label = given.strip()
    if density is not None:
        label += f" · {density_text(density)}"
    return module, sim, params, slug, label


def _free_name(out_dir: Path, stem: str, taken=()) -> str:
    """``stem``, or ``stem-<date>-<time>`` (then ``-2``, ``-3`` ...) when ``<out_dir>/<stem>.json``
    exists or ``taken`` holds it: the run server's naming (jobs.JobManager._name_run), so a result
    never replaces a bundle that is there already."""
    def used(name: str) -> bool:
        p = out_dir / f"{name}.json"
        return name in taken or p.exists() or p.is_symlink()

    if not used(stem):
        return stem
    stamp = time.strftime("%Y%m%d-%H%M%S")
    candidate, n = f"{stem}-{stamp}", 2
    while used(candidate):
        candidate, n = f"{stem}-{stamp}-{n}", n + 1
    return candidate


def _keeps_existing(args) -> bool:
    """Write under a free name instead of replacing ``<out>/<slug>.json``: a result of the CLI in the
    packaged runtime that goes to the desktop app's workspace (source "app") without a --name. The
    file of that name there is an example the app seeded or a result of the app (its first run of
    a model and parameters has the CLI's file name), not an earlier run of the same command. A
    checkout keeps its behaviour: the same command replaces its own result."""
    folders = getattr(args, "folders", None) or {}
    return folders.get("source") == "app" and not getattr(args, "name", None)


def _write(bundle, out_dir: Path, slug: str, *, keep_existing: bool = False):
    out_dir.mkdir(parents=True, exist_ok=True)
    if keep_existing:
        from .appstate import running_bundle_names

        # also the names of the runs the app's server is running: each writes its bundle under the
        # name it took when it started, whatever is there by then
        free = _free_name(out_dir, slug, running_bundle_names(out_dir))
        if free != slug:
            print(f"fairbeam: {slug}.json is taken in the app's workspace (an example, a result of the app, or a "
                  f"run it is running); writing {free}.json instead (pass --name to choose the file name)", flush=True)
        slug = free
    path = out_dir / f"{slug}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(finite_json(bundle), separators=(",", ":"), allow_nan=False),
                   encoding="utf-8")
    os.replace(tmp, path)
    rebuild_index(out_dir)
    return path


def _default_folders(args, *, sim: bool = True):
    """Fill in --out (and --sim-root) the user left out from ``args.folders`` (appstate.cli_defaults),
    and say where a result goes when that is not obvious: the desktop app's workspace, or a folder
    inside the packaged runtime, which the app does not show."""
    d = args.folders
    defaulted = [flag for flag, attr in (("--out", "out"), ("--sim-root", "sim_root"))
                 if (sim or attr == "out") and getattr(args, attr, None) is None]
    if getattr(args, "out", None) is None:
        args.out = str(d["out"])
    if sim and getattr(args, "sim_root", None) is None:
        args.sim_root = str(d["sim"])
    if not defaulted:
        return
    if d["source"] == "app":
        print(f"fairbeam: writing to the Fairbeam app's workspace: {args.out} (from {d['record']}; "
              "pass --out to choose another folder)", flush=True)
    elif d["source"] == "package":
        where = " and ".join(str(d["out"] if f == "--out" else d["sim"]) for f in defaulted)
        print(f"fairbeam: note: {' and '.join(defaulted)} default to {where}, inside the Fairbeam runtime: the app "
              "does not show results there, and no app workspace is known (start the Fairbeam app once). Pass "
              "--out <workspace>/projects and --sim-root <workspace>/.sim, or queue the run on the app's server "
              "with --server.", file=sys.stderr, flush=True)


def cmd_run(args):
    from .simdata import mark_running

    if args.server is not None:
        return cmd_run_server(args)
    _default_folders(args)
    module, sim, params, slug, label = _build(args)
    sim_path = str(Path(args.sim_root) / slug)
    with mark_running(sim_path):  # `fairbeam clean-sim` leaves the raw folder alone meanwhile
        _run(args, module, sim, params, slug, label, sim_path)


def _run(args, module, sim, params, slug, label, sim_path):
    from .multiport import run_model

    threads = _resolve_run_threads(args.threads, sim)
    print(f"fairbeam: {label}", flush=True)
    end_db = sim.end_criteria_db if args.end_db is None else float(args.end_db)
    # machine-readable run settings for live progress parsing (fairbeam.progress)
    thread_label = f"threads {threads}{' Auto' if args.threads == 'auto' else ''}"
    print(f"fairbeam: end criterion {end_db:g} dB, max timesteps {sim.max_timesteps}, "
          f"engine {args.engine} ({thread_label})", flush=True)
    if getattr(sim, "excitation", {}).get("type") == "gaussian-derivative":
        from .excitation import dgauss_duration_s

        print(f"fairbeam: excitation pulse {dgauss_duration_s(sim.f_max):.6g} s", flush=True)
    if args.engine == "cpu":
        from . import native_cpu_note

        if native_cpu_note():
            print(f"fairbeam: note: {native_cpu_note()}", flush=True)
    before = None
    freqs_f, field_targets = _field_request(args, sim)
    planes_req = _field_plane_request(args, sim)
    if freqs_f or planes_req:
        from . import field_planes, fields

        def before(s):
            # surface currents and field planes of the first excited port's run only (one
            # excitation, no per-port maps); attach records that port and the sections store it
            if not getattr(before, "done", False):
                if freqs_f:
                    fields.attach(s, freqs_f)
                if planes_req:
                    for pl in field_planes.attach(s, planes_req):
                        if pl["outside"]:
                            print(f"fairbeam: warning: field plane {pl['requested']:g} mm is outside the domain; "
                                  f"recorded at its edge ({pl['position']:g} mm)", flush=True)
                before.done = True
    freqs = [float(x) * 1e9 for x in args.pattern.split(",")] if args.pattern else None
    values = resolve_params(module.PARAMS, _overrides(args.set))
    sim = run_model(module, values, excite=args.excite, sim_path=sim_path, threads=threads,
                    echo=not args.quiet, engine=args.engine, exact=not args.no_exact, end_db=args.end_db,
                    n_freq=args.points, pattern_freqs=freqs, before_run=before,
                    element_patterns=None if args.element_patterns is None else args.element_patterns == "on",
                    efficiency_points=getattr(args, "efficiency", None))
    stats = sim.run_stats
    energy = (f"{stats['final_energy_db']}" if "final_energy_db" in stats
              else f"<= {stats['final_energy_bound_db']}" if "final_energy_bound_db" in stats else "?")
    print(f"\nfairbeam: {stats.get('timesteps')} timesteps in {stats.get('solver_time_s')} s, "
          f"final energy {energy} dB, converged={stats.get('converged')}", flush=True)
    results = sim.results
    sp = results.get("sparams")
    if sp and len(sp["ports"]) > 1:
        _print_sparams(results)
    for b in results["bands"]:
        print(f"  band {b['f_lo'] / 1e9:.3f}-{b['f_hi'] / 1e9:.3f} GHz, "
              f"min S11 {b['s11_min_db']:.1f} dB @ {b['f_center'] / 1e9:.3f} GHz")
    for ff in results["farfield"]:
        print(f"  far field {ff['f'] / 1e9:.3f} GHz: Dmax {ff['dmax_dbi']:.2f} dBi, "
              f"rad. efficiency {ff['rad_efficiency']}")
    for e in results.get("efficiency") or []:
        ok = e.get("reliable") or [True] * len(e["rad_efficiency"])
        vals = [v for v, k in zip(e["rad_efficiency"], ok) if v is not None and k]
        port = f" (port {e['port']} driven)" if "port" in e and len(results["efficiency"]) > 1 else ""
        unreliable = f", {ok.count(False)} unreliable (not in the range)" if False in ok else ""
        if vals:
            print(f"  efficiency over the band{port}: {len(e['f'])} frequencies, "
                  f"rad. efficiency {min(vals):.3f}-{max(vals):.3f}{unreliable}")
        elif unreliable:
            print(f"  efficiency over the band{port}: {len(e['f'])} frequencies, all unreliable")
    bundle = sim.to_bundle(module.MODEL, params, name=label)
    if freqs_f:
        from . import fields
        targets = field_targets or [ff["f"] for ff in results["farfield"]] or [b["f_center"] for b in results["bands"]]
        section = fields.collect(sim, targets)
        if section:
            bundle["fields"] = section
            driven = f"port {section['port']} driven" if "port" in section else "driven port unknown"
            print(f"  surface current: {len(section['planes'])} plane(s) at "
                  + ", ".join(f"{e['f'] / 1e9:.3f}" for e in section["planes"][0]["frequencies"]) + f" GHz ({driven})")
    if planes_req:
        from . import field_planes
        maps = field_planes.collect(sim)
        if maps:
            bundle["field_planes"] = maps
            print(f"  field planes: {len(maps)} map(s): " + ", ".join(
                f"{m['quantity']} {m['normal']} = {m['position_mm']:g} mm @ {m['f'] / 1e9:.3f} GHz (max {m['max']:.3g} {m['unit']})"
                for m in maps), flush=True)
    path = _write(bundle, Path(args.out), slug, keep_existing=_keeps_existing(args))
    print(f"fairbeam: wrote {path}")


# ------------------------------------------------------------------ fairbeam run --server

# `fairbeam run` options the run server does not take (POST /api/runs): refused with --server
_LOCAL_ONLY = (("--out", "out"), ("--sim-root", "sim_root"), ("--pattern", "pattern"), ("--excite", "excite"),
               ("--element-patterns", "element_patterns"), ("--fields", "fields"), ("--field-plane", "field_plane"),
               ("--efficiency", "efficiency"), ("--mesh-density", "mesh_density"), ("--no-exact", "no_exact"))
TERMINAL_STATUSES = ("done", "failed", "cancelled", "interrupted")


def _http(method: str, url: str, body: dict | None = None, timeout: float = 30.0):
    """One JSON request to the run server. Its error answers become ValueError with its message."""
    from urllib import error, request

    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = request.Request(url, data=data, method=method,
                          headers={"Content-Type": "application/json"} if data is not None else {})
    try:
        with request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"null")
    except error.HTTPError as e:
        try:
            payload = json.loads(e.read() or b"null") or {}
        except ValueError:
            payload = {}
        payload = payload if isinstance(payload, dict) else {}
        fields = payload.get("fields")
        detail = "; ".join(f"{k}: {v}" for k, v in fields.items()) if isinstance(fields, dict) and fields else ""
        message = payload.get("error") or f"HTTP {e.code}"
        raise ValueError(f"{message}{' (' + detail + ')' if detail else ''} [{method} {url}]") from None
    except (error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise ValueError(f"the run server at {url.split('/api/')[0]} does not answer ({reason})") from None


def server_model_key(model: str, models: list, models_dir: str | None) -> str:
    """The server's key for ``model``: a key of its model list (``patch_antenna``), or a model file
    in the server's models folder. The server runs only the models in that folder."""
    keys = {m.get("key") for m in models if isinstance(m, dict) and m.get("key")}
    if model in keys:
        return model
    path = Path(model)
    entry = next((m for m in models if isinstance(m, dict) and m.get("file") == path.name and m.get("key")), None)
    if path.is_file():
        inside = False
        if models_dir:
            try:
                inside = path.resolve().parent == Path(models_dir).resolve()
            except OSError:
                inside = False
        if entry is not None and inside:
            return entry["key"]
        raise ValueError(f"{model} is not in the server's models folder ({models_dir}); the server runs only the "
                         "models there. Save it there (or open it in the app) and pass its name.")
    for suffix in (".design.json", ".py"):
        if model.endswith(suffix) and model[:-len(suffix)] in keys:
            return model[:-len(suffix)]
    shown = ", ".join(sorted(keys)[:12])
    raise ValueError(f"the server has no model {model!r}; it has: {shown}{', ...' if len(keys) > 12 else ''}")


def cmd_run_server(args):
    """Queue the run on a run server (the desktop app's, with ``--server`` alone) instead of solving it
    here: it waits its turn in the app's queue, shows in the app's Recent runs and writes its bundle
    into the app's workspace. Follows the run's log until it ends, unless --detach."""
    from .appstate import resolve_server

    local = [flag for flag, attr in _LOCAL_ONLY if getattr(args, attr, None) not in (None, False, [])]
    if local:
        raise ValueError("not available with --server (the server runs with its own folders and outputs): "
                         + ", ".join(local))
    base = resolve_server(args.server)
    health = _http("GET", f"{base}/api/health")
    health = health if isinstance(health, dict) else {}
    models = (_http("GET", f"{base}/api/models") or {}).get("models") or []
    key = server_model_key(args.model, models, health.get("models_dir"))
    body = {"model": key, "params": _overrides(args.set), "threads": args.threads, "engine": args.engine}
    label = args.label or args.name  # the display name; the server makes the file name from it
    if label:
        body["name"] = label
    if args.end_db is not None:
        body["end_criteria_db"] = float(args.end_db)
    if args.points != 801:
        body["points"] = args.points
    job = _http("POST", f"{base}/api/runs", body)
    queue = health.get("queue") if isinstance(health.get("queue"), dict) else {}
    ahead = (1 if queue.get("running") else 0) + int(queue.get("queued") or 0)
    print(f"fairbeam: run {job['id']} of {key} queued on {base}"
          f"{f' behind {ahead} other run(s)' if ahead else ''}; the app shows it under Recent runs", flush=True)
    if args.detach:
        print(f"fairbeam: stop it in the app, or: POST {base}/api/runs/{job['id']}/cancel", flush=True)
        return 0
    return _follow_run(base, job["id"], quiet=args.quiet)


def _follow_run(base: str, job_id: str, quiet: bool = False) -> int:
    """Print the run's log from its event stream until it ends: 0 when it is done, 1 otherwise.
    Ctrl+C stops following; the run goes on in the server."""
    from urllib import error, request

    last = 0
    retries = 0
    try:
        while True:
            req = request.Request(f"{base}/api/runs/{job_id}/events?after={last}",
                                  headers={"Accept": "text/event-stream"})
            try:
                with request.urlopen(req, timeout=120) as stream:
                    retries = 0
                    data: list = []
                    for raw in stream:
                        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                        if line.startswith("data:"):
                            data.append(line[5:].lstrip())
                            continue
                        if line or not data:
                            continue  # id:, event:, a heartbeat comment, or a blank line without data
                        try:
                            ev = json.loads("\n".join(data))
                        except ValueError:
                            ev = {}
                        data = []
                        last = max(last, int(ev.get("seq") or 0))
                        kind = ev.get("type")
                        if kind == "log" and not quiet:
                            print(ev.get("line", ""), file=sys.stderr if ev.get("stream") == "stderr" else sys.stdout,
                                  flush=True)
                        elif kind == "status" and ev.get("status") in TERMINAL_STATUSES:
                            status = ev["status"]
                            tail = (f": {ev['bundle']}" if ev.get("bundle") else "") if status == "done" else (
                                f": {ev['error']}" if ev.get("error") else "")
                            print(f"fairbeam: run {job_id} {status}{tail}", flush=True)
                            return 0 if status == "done" else 1
            except (error.URLError, OSError) as e:
                retries += 1
                if retries > 3:
                    raise ValueError(f"lost the run's event stream ({getattr(e, 'reason', e)}); the run may still "
                                     f"be going: {base}/api/runs/{job_id}") from None
                time.sleep(1.0)
    except KeyboardInterrupt:
        print(f"\nfairbeam: stopped following; run {job_id} goes on in the server (stop it in the app, or "
              f"POST {base}/api/runs/{job_id}/cancel)", file=sys.stderr, flush=True)
        return 130


def _field_plane_request(args, sim):
    """E/H field planes to record: the --field-plane flags, else the model's own
    (``Simulation.field_plane_monitors``, e.g. a design's ``monitors.field_planes``), else None."""
    from . import field_planes

    specs = getattr(args, "field_plane", None)
    if specs:
        return field_planes.parse_cli(specs)
    return getattr(sim, "field_plane_monitors", None) or None


def _print_sparams(results):
    from .multiport import s_from_section

    sp = results["sparams"]
    f = np.asarray(results["frequency"])
    s = s_from_section(sp)
    k = int(np.argmin(np.abs(f - (f[0] + f[-1]) / 2)))
    cells = [f"S{i + 1}{j + 1} {20 * np.log10(max(abs(s[k, i, j]), 1e-12)):6.1f}"
             for j in range(s.shape[2]) for i in range(s.shape[1]) if not np.isnan(s[k, i, j])]
    print(f"  S-parameters at {f[k] / 1e9:.3f} GHz (dB): " + ", ".join(cells))
    qa = sp["qa"]
    print(f"  reciprocity max |Sij-Sji| {qa['reciprocity_max']}, column power max {qa['column_power_max']}, "
          f"passive={qa['passive']}")


def _efficiency_points(text: str) -> int:
    """argparse type of --efficiency: a whole number of frequencies in the allowed range."""
    from .design import EFFICIENCY_POINTS_MAX, EFFICIENCY_POINTS_MIN

    try:
        n = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected a whole number of frequencies, got {text!r}") from None
    if not EFFICIENCY_POINTS_MIN <= n <= EFFICIENCY_POINTS_MAX:
        raise argparse.ArgumentTypeError(f"{n} frequencies: use {EFFICIENCY_POINTS_MIN} to {EFFICIENCY_POINTS_MAX}")
    return n


def _field_request(args, sim):
    """Surface currents to record: (dump frequencies in Hz, frequencies to store or None), or
    (None, None). The --fields flag wins; without it, the model's own monitors
    (``Simulation.current_freqs``, e.g. a design's ``monitors.currents``) are recorded and stored
    at exactly those frequencies. With --fields the stored ones follow the far field (None)."""
    if args.fields:
        return _field_freqs(args, sim), None
    own = getattr(sim, "current_freqs", None)
    if own:
        freqs = [float(f) for f in own]
        return freqs, freqs
    return None, None


def _field_freqs(args, sim):
    """--fields dump frequencies: explicit GHz, else --pattern, else a <= 201-point grid (~0.5 %)."""
    spec = args.fields if args.fields != "auto" else args.pattern
    if spec:
        return [float(x) * 1e9 for x in spec.split(",")]
    n = int(min(201, max(21, round(400 * (sim.f_max - sim.f_min) / (sim.f_max + sim.f_min)))))
    return list(np.linspace(sim.f_min, sim.f_max, n))


def cmd_geometry(args):
    _default_folders(args, sim=False)
    module, sim, params, slug, label = _build(args)
    path = _write(sim.to_bundle(module.MODEL, params, name=label + " (geometry only)"), Path(args.out),
                  slug + "--geometry", keep_existing=_keeps_existing(args))
    print(f"fairbeam: wrote {path}")


def cmd_params(args):
    module = load_model(args.model)
    print(f"{module.MODEL['name']} ({module.MODEL['id']})")
    width = max(len(p.key) for p in module.PARAMS)
    for p in module.PARAMS:
        unit = f" {p.unit}" if p.unit else ""
        print(f"  {p.key:<{width}}  {p.default}{unit:<5}  {p.label}")


def cmd_serve(args):
    from .server import serve

    ui = Path(args.ui) if args.ui else None
    if ui is not None and not (ui / "index.html").is_file():
        raise SystemExit(f"fairbeam: --ui {ui} has no index.html (build the viewer with 'npm run build')")
    serve(host=args.host, port=args.port, models_dir=Path(args.models), projects_dir=Path(args.projects),
          jobs_dir=Path(args.jobs), python=args.python, ui_dir=ui, exit_with_parent=args.exit_with_parent,
          sim_root=Path(args.sim_root))


def cmd_app(args):
    """Serve the built viewer and the API on one free port and open the browser."""
    import webbrowser

    from .server import free_port, serve

    ui = Path(args.ui)
    if not (ui / "index.html").is_file():
        raise SystemExit(f"fairbeam: no built viewer in {ui}. Build it first:\n  npm install && npm run build")
    port = args.port or free_port()
    serve(port=port, models_dir=Path(args.models), projects_dir=Path(args.projects), jobs_dir=Path(args.jobs),
          python=args.python, ui_dir=ui, on_ready=None if args.no_browser else webbrowser.open,
          sim_root=Path(args.sim_root))


def cmd_clean_sim(args):
    """Remove raw openEMS run folders under the sim root that are older than --older-than days."""
    from .simdata import clean_sim, human_bytes

    if args.older_than < 0:
        raise ValueError("--older-than must be >= 0")
    root = Path(args.sim_root)
    if not root.is_dir():
        print(f"fairbeam: no sim folder at {root}")
        return 0
    res = clean_sim(root, older_than_days=args.older_than, dry_run=args.dry_run)
    verb = "would remove" if args.dry_run else "removed"
    for path, size in res["removed"]:
        print(f"  {verb} {path}  ({human_bytes(size)})")
    for path, reason in res["skipped"]:
        print(f"  kept {path}  (in use: {reason})")
    print(f"fairbeam: {verb} {len(res['removed'])} raw run folder(s) older than {args.older_than:g} day(s) in {root}; "
          f"{'would free' if args.dry_run else 'freed'} {human_bytes(res['freed'])} ({res['freed']} bytes)")
    return 0


def read_macro_file(path: Path) -> str:
    """A macro's text: UTF-8 (with or without BOM), else Windows-1252 (the VBA editor's ANSI)."""
    raw = Path(path).read_bytes()
    if b"\x00" in raw[:4096]:
        raise ValueError("The file is not a text macro. Export the History List or VBA macro as a .bas, .mcs or .txt file and import that.")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def cmd_import_cst(args):
    """A CST-compatible VBA macro (.bas/.mcs/.txt) as a design file, with the import report."""
    from .cst_import import import_cst

    src = Path(args.macro)
    model_id = args.id or re.sub(r"[^a-z0-9]+", "-", src.stem.lower()).strip("-") or "imported-cst"

    # the .stl files of the macro's polyhedra (fairbeam's export writes them next to the .bas)
    def stl_file(base: str):
        f = src.parent / Path(base).name
        return f.read_bytes() if f.is_file() and f.stat().st_size <= 64_000_000 else None

    res = import_cst(read_macro_file(src), model_id=model_id, name=args.name, filename=src.name, files=stl_file)
    out = Path(args.out) if args.out else Path(f"{model_id.replace('-', '_')}.design.json")
    out.write_text(json.dumps(res["design"], indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    rep = res["report"]
    c = rep["counts"]
    print(f"fairbeam: wrote {out}: {c['parameter']} parameter(s), {c['material']} material(s), {c['part']} part(s), "
          f"{c['port']} port(s), {c['resistor']} resistor(s)")
    for n in rep["notes"]:
        where = f"line {n['line']}: " if n.get("line") else ""
        print(f"  {n['severity']:<8} {where}{n['where']}: {n['message']}")
    return 0


def cmd_import_pcb(args):
    """PCB artwork (DXF, Gerber, Excellon) as a design file, with the import report."""
    from .pcb_import import import_pcb

    srcs = [Path(f) for f in args.files]
    for f in srcs:
        if not f.is_file():
            raise ValueError(f"{f}: no such file")
    model_id = args.id or re.sub(r"[^a-z0-9]+", "-", srcs[0].stem.lower()).strip("-") or "imported-pcb"
    res = import_pcb([(f.name, f.read_bytes()) for f in srcs], layer_map=args.layer_map, substrate=args.substrate,
                     thickness=args.thickness, eps_r=args.eps_r, tan_d=args.tan_d, units=args.units,
                     chord_tol=args.chord_tol, margin=args.margin, f0=args.f0, origin=args.origin,
                     model_id=model_id, name=args.name or model_id)
    out = Path(args.out) if args.out else Path(f"{model_id.replace('-', '_')}.design.json")
    out.write_text(json.dumps(res["design"], indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    rep = res["report"]
    c = rep["counts"]
    print(f"fairbeam: wrote {out}: {c['part']} part(s), {c['polygon']} polygon(s), {c['hole']} hole(s), {c['via']} via(s), "
          f"{c['port']} port(s)")
    for lay in rep["layers"]:
        print(f"  layer    {lay['source']} · {lay['layer']}: {lay['role']} ({lay['because']})")
    for n in rep["notes"]:
        where = f"line {n['line']}: " if n.get("line") else ""
        print(f"  {n['severity']:<8} {where}{n['where']}: {n['message']}")
    return 0


_GPU_BACKEND_RE = re.compile(r"backend:\s*(Metal|CUDA)\b", re.I)


def _index_engine(run: dict) -> str | None:
    """"CPU", "Metal", "CUDA" or "GPU" for the index (lets the viewer tell runs of the same model
    apart); None without a run. Bundles from before the GPU engine lack run.engine: they ran on the CPU."""
    if not isinstance(run, dict) or not run:
        return None
    if (run.get("engine") or "cpu") != "gpu":
        return "CPU"
    # the GPU fork logs "Create FDTD engine (GPU, backend: CUDA (...))"; see src/lib/benchmarks.ts
    for line in reversed(run.get("log_tail") or []):
        m = _GPU_BACKEND_RE.search(str(line))
        if m:
            return "CUDA" if m.group(1).upper() == "CUDA" else "Metal"
    return "Metal" if (run.get("host") or {}).get("os") == "Darwin" else "GPU"


def _index_params(model: dict) -> dict:
    """Parameters set to something other than their default (like src/lib/benchmarks.ts changedParams)."""
    out = {}
    for p in model.get("params") or []:
        if not isinstance(p, dict) or "key" not in p or p.get("value") is None:
            continue
        v, d = p["value"], p.get("default")
        same = (v == d) or (isinstance(v, (int, float)) and isinstance(d, (int, float))
                            and abs(v - d) <= 1e-9 * max(1.0, abs(v), abs(d)))
        if not same:
            out[p["key"]] = v
    return out


# Run quality, the same rules as src/lib/runQuality.ts (the viewer badges runs from this field so it
# need not read every bundle): keep the tolerances in step with that file.
S11_TOLERANCE_DB = 0.1
EFFICIENCY_TOLERANCE = 0.05
UNCOUPLED_S11_DB = -0.5       # |S11| at or above this over the whole band: the port is not coupled
UNCOUPLED_EFFICIENCY = 0.02   # total efficiency below this in every far-field entry


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def run_quality(b: dict) -> str | None:
    """"converged", "not-converged" or "suspicious" for a finished run; None for a bundle without
    results (a geometry preview). Mirrors runQuality() in src/lib/runQuality.ts:
      - not-converged: a run (any port's) stopped at the timestep limit;
      - suspicious: converged, but |S11| is more than 0.1 dB above 0 dB somewhere, or a far-field
        radiation efficiency is above 1.05, or the port is not coupled (|S11| never below -0.5 dB over
        the band, or the total efficiency below 2 % in every far-field entry)."""
    res, run = b.get("results"), b.get("run")
    if res is None or run is None:
        return None
    port_runs = run.get("port_runs") if isinstance(run, dict) else None
    if port_runs:
        stopped = any(not pr.get("converged") for pr in port_runs if isinstance(pr, dict))
    else:
        stopped = not (run.get("converged") if isinstance(run, dict) else False)
    if stopped:
        return "not-converged"
    uncoupled = False
    for pr in (res.get("ports") or {}).values():
        re_, im = pr.get("s11_re") or [], pr.get("s11_im") or []
        best = math.inf
        for x, y in zip(re_, im):
            if not (_finite(x) and _finite(y)):
                continue
            power = x * x + y * y
            if power > 0 and 10 * math.log10(power) > S11_TOLERANCE_DB:
                return "suspicious"
            if power > 0:
                best = min(best, 10 * math.log10(power))
        if best != math.inf and best >= UNCOUPLED_S11_DB:   # no sample at all is not judged
            uncoupled = True
    for ff in res.get("farfield") or []:
        eta = ff.get("rad_efficiency") if isinstance(ff, dict) else None
        if _finite(eta) and eta > 1 + EFFICIENCY_TOLERANCE:
            return "suspicious"
    if uncoupled or _negligible_total_efficiency(b):
        return "suspicious"
    return "converged"


def _negligible_total_efficiency(b: dict) -> bool:
    """Every far-field entry's total efficiency (radiation efficiency x (1 - |S11|^2) of the driven
    port, |S11|^2 interpolated linearly at its frequency) is below UNCOUPLED_EFFICIENCY; False when
    there is no far field or one entry's efficiency is unknown (mirrors uncoupledEfficiency)."""
    res = b.get("results") or {}
    ffs = res.get("farfield") or []
    freq = res.get("frequency") or []
    ports = res.get("ports") or {}
    own = next((p for p in b.get("ports") or [] if isinstance(p, dict) and p.get("excite")), None)
    if own is None:
        own = next((p for p in b.get("ports") or [] if isinstance(p, dict)), None)
    best = None
    for ff in ffs:
        if not isinstance(ff, dict):
            return False
        eta = ff.get("rad_efficiency")
        number = ff.get("port") if ff.get("port") is not None else (own or {}).get("number")
        pr = ports.get(str(number)) or ports.get(str((own or {}).get("number")))
        if not (_finite(eta) and eta > 0) or not pr or not _finite(ff.get("f")):
            return False
        pts = [(f, x * x + y * y) for f, x, y in zip(freq, pr.get("s11_re") or [], pr.get("s11_im") or [])
               if _finite(f) and _finite(x) and _finite(y)]
        if not pts:
            return False
        g2 = _interp_clamped(pts, ff["f"])
        total = eta * (1 - g2)
        best = total if best is None else max(best, total)
    return best is not None and best < UNCOUPLED_EFFICIENCY


def _interp_clamped(pts: list, x: float) -> float:
    """Linear interpolation of (x, y) points sorted by x, clamped to the ends."""
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    lo, hi = 0, len(pts) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if pts[mid][0] <= x:
            lo = mid
        else:
            hi = mid
    (x0, y0), (x1, y1) = pts[lo], pts[hi]
    return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)


# rebuild_index: each bundle's index entry, keyed by path and reused while its mtime and size stay the
# same, so a finished job (the server rebuilds the index after every run) parses only the new bundle
# instead of every bundle in the folder (a large sweep made that quadratic).
_INDEX_CACHE: dict[str, tuple[tuple[int, int], dict | None]] = {}


def _index_entry(f: Path) -> dict | None:
    try:
        st = f.stat()
    except OSError:
        return None
    stamp = (st.st_mtime_ns, st.st_size)
    hit = _INDEX_CACHE.get(str(f))
    if hit is not None and hit[0] == stamp:
        return copy.deepcopy(hit[1])
    entry = _read_index_entry(f)
    _INDEX_CACHE[str(f)] = (stamp, entry)
    return copy.deepcopy(entry)


def _read_index_entry(f: Path) -> dict | None:
    try:
        b = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not schema_family(b.get("schema"), "fairbeam.project/"):
        return None
    res = b.get("results") or {}
    entry = {
        "file": f.name, "name": b.get("name"), "model": b.get("model", {}).get("id"),
        "created": b.get("created"), "simulated": bool(res),
        "bands": [round(x["f_center"] / 1e9, 3) for x in res.get("bands", [])],
        "cells": b.get("mesh", {}).get("total_cells"),
    }
    # optional (newer indexes only): what tells runs of the same model apart in the viewer's pickers
    engine = _index_engine(b.get("run"))
    if engine:
        entry["engine"] = engine
    # optional (newer indexes only): measured throughput, for the host-aware time estimate
    run = b.get("run") if isinstance(b.get("run"), dict) else {}
    if isinstance(run.get("speed_mcells_s"), (int, float)) and run["speed_mcells_s"] > 0:
        entry["speed_mcells_s"] = run["speed_mcells_s"]
        if (run.get("host") or {}).get("cpu"):
            entry["host_cpu"] = run["host"]["cpu"]
    params = _index_params(b.get("model") or {})
    if params:
        entry["params"] = params
    # optional (newer indexes only): the run quality verdict, so the tree can badge runs unread
    quality = run_quality(b)
    if quality:
        entry["quality"] = quality
    return entry


def rebuild_index(out_dir: Path):
    entries = []
    for f in sorted(Path(out_dir).glob("*.json")):
        if f.name == "index.json":
            continue
        entry = _index_entry(f)
        if entry is not None:
            entries.append(entry)
    entries.sort(key=lambda e: (e["model"] or "", e["name"] or ""))
    # atomic: the viewer (and a concurrent run) must never read a half-written index
    tmp = Path(out_dir) / f"index.json.{os.getpid()}.tmp"
    tmp.write_text(json.dumps({"projects": entries, "updated": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, indent=2),
                   encoding="utf-8", newline="\n")  # LF on Windows too: index.json is committed
    os.replace(tmp, Path(out_dir) / "index.json")


def main(argv=None):
    from .appstate import cli_defaults

    ap = argparse.ArgumentParser(prog="fairbeam", description="Fairbeam on the command line.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    # where results go by default: the repository's folders in a checkout, the desktop app's
    # workspace in the packaged runtime (fairbeam.appstate)
    folders = cli_defaults(REPO)

    def model_args(p):
        p.add_argument("model", help="path to a model .py file")
        p.add_argument("--set", action="append", metavar="KEY=VALUE", help="override a model parameter")
        p.add_argument("--name", help="bundle file name (without .json)")
        p.add_argument("--label", help="display name of the result (default: the model's name and parameters)")
        p.add_argument("--out", help=f"bundle output folder (default: {folders['out']})")
        p.set_defaults(folders=folders)

    p = sub.add_parser("run", help="simulate a model and export a project bundle")
    model_args(p)
    p.add_argument("--threads", type=_thread_count, default="auto", metavar="N|auto",
                   help="FDTD threads (default: Auto from host and built mesh; 0 = openEMS automatic tuning)")
    p.add_argument("--sim-root", help=f"folder for raw openEMS output (default: {folders['sim']})")
    p.add_argument("--server", nargs="?", const="auto", metavar="URL",
                   help="queue the run on a run server instead of solving it here: the desktop app's (no URL), or "
                        "http://127.0.0.1:<port>. It waits in the app's queue, shows in the app and writes into its "
                        "workspace; MODEL is a model of the server's models folder (its name or file)")
    p.add_argument("--detach", action="store_true", help="with --server: return once the run is queued")
    p.add_argument("--points", type=int, default=801, help="frequency points")
    p.add_argument("--pattern", help="far-field frequencies in GHz, comma separated (default: band centres)")
    p.add_argument("--quiet", action="store_true", help="do not echo openEMS output")
    p.add_argument("--engine", choices=["cpu", "gpu"], default=os.environ.get("FAIRBEAM_ENGINE", "cpu"),
                   help="FDTD engine; gpu needs the openEMS GPU build (scripts/install-openems-gpu-macos.sh)")
    p.add_argument("--end-db", type=float, help="energy end criterion in dB (default: the model's, -60 unless set)")
    p.add_argument("--no-exact", action="store_true",
                   help="check the end criterion every ~4 s of wall time instead of every Nyquist period")
    p.add_argument("--excite", metavar="all|1,3",
                   help="ports to excite, one run each (default: all ports for <= 4 ports, else port 1)")
    p.add_argument("--element-patterns", choices=["on", "off"],
                   help="store complex embedded element patterns (default: on when several ports are excited)")
    p.add_argument("--fields", nargs="?", const="auto", metavar="GHZ,...",
                   help="record surface-current maps on metal sheets (at these GHz, else --pattern, "
                        "else the nearest of a ~0.5 %% frequency grid to each far-field frequency)")
    p.add_argument("--mesh-density", type=float, metavar="CELLS",
                   help="design files: run at this automatic mesh density (cells per wavelength at f max) "
                        "instead of the design's own; manual mesh lines are refused")
    p.add_argument("--field-plane", nargs=4, action="append", metavar=("Q", "NORMAL", "MM", "GHZ"),
                   help="record an E or H field map on a cut plane (repeatable): Q = E or H (Ex, Hz, ... for "
                        "one component), NORMAL = x, y or z, MM = plane position, GHZ = frequencies, comma "
                        "separated; e.g. --field-plane E z 3 2.45")
    from .design import EFFICIENCY_POINTS_DEFAULT

    p.add_argument("--efficiency", nargs="?", const=EFFICIENCY_POINTS_DEFAULT, type=_efficiency_points, metavar="N",
                   help="radiation efficiency at N frequencies across the band (default 21, 3 to 201), "
                        "from the NF2FF data after the run; adds the far field if the model has none")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("geometry", help="export geometry and mesh without simulating")
    model_args(p)
    p.set_defaults(func=cmd_geometry)

    p = sub.add_parser("params", help="list model parameters")
    p.add_argument("model")
    p.set_defaults(func=cmd_params)

    p = sub.add_parser("import-cst", help="convert a CST-compatible VBA macro (history) into a design file")
    p.add_argument("macro", help="the macro (.bas, .mcs or a history list saved as .txt)")
    p.add_argument("--out", help="design file to write (default: <id>.design.json in the current folder)")
    p.add_argument("--id", help="model id (default: from the file name)")
    p.add_argument("--name", help="display name (default: from the macro or the file name)")
    p.set_defaults(func=cmd_import_cst)

    p = sub.add_parser("import-pcb", help="convert PCB artwork (DXF, Gerber RS-274X, Excellon drill) into a design file")
    p.add_argument("files", nargs="+", help=".dxf, Gerber (.gbr, .gtl, .gbl, .gko ...) and Excellon (.drl) files")
    p.add_argument("--out", help="design file to write (default: <id>.design.json in the current folder)")
    p.add_argument("--id", help="model id (default: from the first file name)")
    p.add_argument("--name", help="display name (default: the id)")
    p.add_argument("--layer-map", metavar="NAME=ROLE,...",
                   help="layer or file name (patterns allowed) to top_copper, bottom_copper, outline or ignore, e.g. "
                        "TOP=top_copper,BOT=bottom_copper; layers not listed are recognised by name")
    p.add_argument("--substrate", default="FR4", help="substrate: a library id (fr4, ro4003c, rt5880 ...) or a name (default FR4)")
    p.add_argument("--thickness", type=float, default=1.6, help="substrate thickness in mm (default 1.6)")
    p.add_argument("--eps-r", type=float, help="relative permittivity (default: the library value, else 4.3)")
    p.add_argument("--tan-d", type=float, help="loss tangent at f0 (default: the library value, else 0.02)")
    p.add_argument("--units", choices=("auto", "mm", "inch"), default="auto",
                   help="units of DXF files (auto: from $INSUNITS, else mm); Gerber and Excellon files carry their own")
    p.add_argument("--chord-tol", type=float, default=0.02, metavar="MM",
                   help="largest distance in mm between a chord and the arc it replaces (default 0.02)")
    p.add_argument("--margin", type=float, default=2.0, metavar="MM",
                   help="substrate margin around the copper when there is no outline layer (default 2)")
    p.add_argument("--f0", type=float, default=2.45, metavar="GHZ", help="design frequency; the band is 0.6 to 1.3 x f0 (default 2.45)")
    p.add_argument("--origin", choices=("center", "keep"), default="center",
                   help="center: move the board centre to x = y = 0 (default); keep: keep the file coordinates")
    p.set_defaults(func=cmd_import_pcb)

    p = sub.add_parser("index", help="rebuild index.json for a bundle folder")
    p.add_argument("folder", nargs="?", default=str(folders["out"]))
    p.set_defaults(func=lambda a: rebuild_index(Path(a.folder)))

    p = sub.add_parser("serve", help="local run server for the viewer (127.0.0.1 only)")
    p.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1"], help="bind address (loopback only)")
    p.add_argument("--port", type=int, default=int(os.environ.get("FAIRBEAM_API_PORT", "5320")),
                   help="port (default: $FAIRBEAM_API_PORT or 5320)")
    p.add_argument("--projects", default=str(DEFAULT_OUT), help="bundle folder the runs write to")
    p.add_argument("--models", default=str(REPO / "python" / "models"), help="folder with model .py files")
    p.add_argument("--jobs", default=str(DEFAULT_SIM / "jobs"), help="job history folder")
    p.add_argument("--python", default=os.environ.get("FAIRBEAM_PYTHON") or sys.executable,
                   help="python with openEMS used for jobs and previews (default: $FAIRBEAM_PYTHON or this one)")
    p.add_argument("--ui", help="also serve the built web app (Vite dist/) from this folder at /")
    p.add_argument("--exit-with-parent", action="store_true", help="stop when the launching process exits")
    p.add_argument("--sim-root", default=str(DEFAULT_SIM),
                   help="raw openEMS output; each job uses <sim-root>/runs/<id>/, removed with the job")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("app", help="serve the built viewer and the API on a free port and open the browser")
    p.add_argument("--port", type=int, default=0, help="port (default: a free one)")
    p.add_argument("--ui", default=str(REPO / "dist"), help="built web app folder (default: dist/)")
    p.add_argument("--projects", default=str(DEFAULT_OUT))
    p.add_argument("--models", default=str(REPO / "python" / "models"))
    p.add_argument("--jobs", default=str(DEFAULT_SIM / "jobs"))
    p.add_argument("--python", default=os.environ.get("FAIRBEAM_PYTHON") or sys.executable)
    p.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    p.add_argument("--sim-root", default=str(DEFAULT_SIM), help="raw openEMS output (<sim-root>/runs/<job id>/)")
    p.set_defaults(func=cmd_app)

    p = sub.add_parser("clean-sim", help="remove old raw openEMS output from the sim folder")
    p.add_argument("--sim-root", default=str(folders["sim"]), help=f"sim folder (default: {folders['sim']})")
    p.add_argument("--older-than", type=float, default=7.0, metavar="DAYS",
                   help="remove run folders not written to for this many days (default 7)")
    p.add_argument("--dry-run", action="store_true", help="only list what would be removed")
    p.set_defaults(func=cmd_clean_sim)
    from .study import add_commands as add_study_commands  # sweep, converge, touchstone
    add_study_commands(sub, {"out": folders["out"], "sim": folders["sim"]})
    from .optimize import add_command as add_optimize_command  # optimize
    add_optimize_command(sub, {"out": folders["out"], "sim": folders["sim"]})
    from .material_cell import add_command as add_material_cell_command  # material-cell
    add_material_cell_command(sub, {"sim": folders["sim"]})
    from .debye_fit import add_command as add_debye_fit_command  # debye-fit
    add_debye_fit_command(sub)

    args = ap.parse_args(argv)
    try:
        rc = args.func(args)
    except (KeyError, ValueError) as e:
        print(f"fairbeam: error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt as e:  # Ctrl+C, or a run openEMS aborted (Simulation.run): no bundle
        print(f"\nfairbeam: interrupted{': ' + str(e) if str(e) else ''}", file=sys.stderr, flush=True)
        return 130
    return rc if isinstance(rc, int) else 0


if __name__ == "__main__":
    sys.exit(main())
