"""Model description and geometry preview, run in child processes of the run server.

The server never imports model files itself: a model is arbitrary Python (and CSXCAD is C++), so a
broken model must not take the server down. Two entry points:

``python -m fairbeam.preview describe <models_dir>``
    one-shot: loads every ``*.py`` in the folder and prints one JSON document with MODEL and
    PARAMS per file, or an ``error`` entry for files that fail to load.

``python -m fairbeam.preview worker``
    persistent: reads one JSON request per line on stdin, answers one JSON line on stdout.
    ``{"op": "preview", "model_path": ..., "overrides": {key: "text"}}`` builds the model (the same
    code path as ``fairbeam geometry``) and returns the bundle without running openEMS.
    ``{"op": "validate", "model_path": ...}`` loads a model file and builds it with its defaults
    (after an edit in the app); errors carry the line in the model file.
    ``{"op": "preview_design", "design": {...}, "overrides": {...}}`` builds an unsaved design.
    For designs (both ops) the answer carries ``checks``: fairbeam.design_checks.lint with the
    preview bundle, also when the build fails.

In both modes the real stdout is reserved for the protocol; anything a model or openEMS prints goes
to stderr.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from dataclasses import asdict
from pathlib import Path


def _protocol_stream():
    """Duplicate fd 1 for the protocol and point fd 1 (C and Python stdout) at stderr."""
    sys.stdout.flush()
    proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    return proto


def param_type(default) -> str:
    if isinstance(default, bool):
        return "bool"
    if isinstance(default, int):
        return "int"
    if isinstance(default, float):
        return "float"
    return "str"


def param_spec(p) -> dict:
    d = asdict(p)
    d["type"] = param_type(p.default)
    return d


def describe_model(path: Path) -> dict:
    from .model import load_model

    from .design import design_key, is_design

    entry: dict = {"key": design_key(path), "file": path.name, "path": str(path.resolve()),
                   "mtime": path.stat().st_mtime, "kind": "design" if is_design(path) else "python"}
    try:
        module = load_model(path)
        model = dict(module.MODEL)
        entry["model"] = {k: v for k, v in model.items() if isinstance(v, (str, int, float, bool)) or v is None}
        entry["params"] = [param_spec(p) for p in module.PARAMS]
        doc = (module.__doc__ or "").strip()
        if doc:
            entry["doc"] = doc
        json.dumps(entry, allow_nan=False)
    except BaseException as e:  # noqa: BLE001 - SystemExit from a model file must not escape either
        entry.pop("model", None)
        entry.pop("params", None)
        entry["error"] = f"{type(e).__name__}: {e}"
        entry["traceback"] = traceback.format_exc(limit=6)
        entry["location"] = error_location(e, path)
    return entry


def error_location(exc: BaseException, model_path) -> dict | None:
    """Line (and column) in the model file where ``exc`` happened: the SyntaxError position, or the
    innermost traceback frame that belongs to the model file. For a design file: the JSON path of
    the field (``{"path": "parts[0].primitives[1].stop[2]"}``)."""
    from .design import DesignError

    if isinstance(exc, DesignError):
        return {"path": exc.where} if exc.where else None
    try:
        target = str(Path(model_path).resolve())
    except OSError:
        return None
    if isinstance(exc, SyntaxError) and exc.lineno:
        fn = exc.filename or ""
        if not fn or fn.startswith("<") or str(Path(fn).resolve()) == target:
            return {"line": int(exc.lineno), "column": int(exc.offset or 0) or None,
                    "end_line": getattr(exc, "end_lineno", None), "text": (exc.text or "").rstrip("\n") or None}
    line = None
    for frame in traceback.extract_tb(exc.__traceback__):
        try:
            if str(Path(frame.filename).resolve()) == target:
                line = {"line": frame.lineno, "column": None, "text": frame.line or None, "function": frame.name}
        except OSError:
            continue
    return line


def validate_model(model_path: str) -> dict:
    """Load a model and build it with its default parameters: MODEL, PARAMS and a preview bundle."""
    t0 = time.time()
    entry = describe_model(Path(model_path))
    if "error" in entry:
        return {"valid": False, "model": entry, "error": {"message": entry["error"], "stage": "load",
                                                          "location": entry.get("location"),
                                                          "traceback": entry.get("traceback")}}
    try:
        result = build_preview(model_path, {})
    except BaseException as e:  # noqa: BLE001
        out = {"valid": False, "model": entry,
               "error": {"message": f"{type(e).__name__}: {e}", "stage": "build",
                         "location": error_location(e, model_path), "traceback": traceback.format_exc(limit=8)}}
        if entry.get("kind") == "design":
            out["checks"] = design_checks(_read_json(model_path), {}, None, e)
        return out
    out = {"valid": True, "model": entry, "bundle": result["bundle"], "build_s": round(time.time() - t0, 3)}
    if entry.get("kind") == "design":
        out["checks"] = design_checks(_read_json(model_path), {}, result["bundle"])
    return out


def _read_json(path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def design_checks(design: dict, overrides: dict, bundle: dict | None, build_error: BaseException | None = None) -> list:
    """fairbeam.design_checks.lint for a design (never raises), plus a ``build`` error when the
    design does not build and no check already points at that field."""
    from .design import DesignError
    from .design_checks import EXPLANATIONS, lint

    values = {}
    for k, v in (overrides or {}).items():
        try:
            values[k] = float(v)
        except (TypeError, ValueError):
            pass
    try:
        checks = lint(design, values, bundle)
    except Exception:  # noqa: BLE001 - a bug in a check must not break the preview
        traceback.print_exc(file=sys.stderr)
        checks = []
    if build_error is not None:
        where = build_error.where if isinstance(build_error, DesignError) else ""
        detail = build_error.detail if isinstance(build_error, DesignError) else f"{type(build_error).__name__}: {build_error}"
        if not any(c["severity"] == "error" and (c["path"] == where or not where) for c in checks):
            checks.append({"severity": "error", "path": where, "code": "build", "message": f"does not build: {detail}", "explain": EXPLANATIONS["build"]})
    return checks


def model_files(models_dir: str | Path) -> list[Path]:
    """The model files in a folder: ``*.py`` and ``*.design.json`` (not starting with ``_``)."""
    d = Path(models_dir)
    return sorted(p for p in [*d.glob("*.py"), *d.glob("*.design.json")] if not p.name.startswith("_"))


def describe_models(models_dir: str | Path) -> list[dict]:
    return [describe_model(p) for p in model_files(models_dir)]


def build_preview(model_path: str | None, overrides: dict, design: dict | None = None) -> dict:
    """Build a model with string overrides and return its geometry-only bundle. ``design`` (a
    design dict, e.g. the designer's unsaved state) is built instead of a file."""
    from .model import load_model, resolve_params

    t0 = time.time()
    if design is not None:
        from .design import module_for
        module = module_for(design)
    else:
        module = load_model(model_path)
    values = resolve_params(module.PARAMS, {k: str(v) for k, v in overrides.items()})
    sim = module.build(values)
    params = [p.describe(values[p.key]) for p in module.PARAMS]
    label = module.MODEL["name"] + ("" if not overrides else " · " + ", ".join(
        f"{k}={v}" for k, v in sorted(overrides.items())))
    bundle = sim.to_bundle(module.MODEL, params, name=label + " (preview)")
    bundle["preview"] = True
    json.dumps(bundle, allow_nan=False)  # fail here, not in the server, on NaN/inf
    return {"bundle": bundle, "build_s": round(time.time() - t0, 3)}


def handle(req: dict) -> dict:
    op = req.get("op")
    try:
        if op == "ping":
            return {"ok": True, "result": "pong"}
        if op == "preview":
            return {"ok": True, "result": build_preview(req["model_path"], req.get("overrides") or {})}
        if op == "preview_design":
            # Most check errors still build (the designer shows the fresh geometry with the errors);
            # only the ones that would crash the openEMS/CSXCAD build are refused before building.
            checks = design_checks(req["design"], req.get("overrides") or {}, None)
            fatal = [c for c in checks if c.get("severity") == "error" and c.get("code") in BUILD_FATAL_CODES]
            if fatal:
                return _checks_response(fatal[0], checks)
            try:
                result = build_preview(None, req.get("overrides") or {}, design=req["design"])
            except BaseException as e:  # noqa: BLE001
                resp = _error_response(e, req)
                resp["checks"] = design_checks(req["design"], req.get("overrides") or {}, None, e)
                if resp["kind"] == "model":
                    # a crash inside the build that a check explains is the check's error (422), not a 500
                    explained = [c for c in resp["checks"] if c.get("severity") == "error" and c.get("code") != "build"]
                    if explained:
                        return {**_checks_response(explained[0], resp["checks"]), "traceback": resp.get("traceback")}
                return resp
            result["checks"] = design_checks(req["design"], req.get("overrides") or {}, result["bundle"])
            return {"ok": True, "result": result}
        if op == "describe":
            return {"ok": True, "result": describe_models(req["models_dir"])}
        if op == "validate":
            return {"ok": True, "result": validate_model(req["model_path"])}
        return {"ok": False, "kind": "request", "error": f"unknown op {op!r}"}
    except BaseException as e:  # noqa: BLE001
        return _error_response(e, req)


# Check codes whose error makes the openEMS/CSXCAD lumped element invalid: AddLumpedPort with R <= 0
# raises UnboundLocalError (#78); a resistor with R <= 0 is refused alongside it, as a non-physical
# element for the engine. A preview with one of these is refused with the checks, without building.
# Any other build crash that a check explains is mapped to the same 422 in handle().
BUILD_FATAL_CODES = frozenset({"port-r", "resistor-r"})


def _checks_response(first: dict, checks: list) -> dict:
    """A validation failure (HTTP 422) for a check error, with the path prefix like a DesignError."""
    path = first.get("path") or ""
    message = f"{path}: {first['message']}" if path else first["message"]
    return {"ok": False, "kind": "validation", "error": message, "detail": first["message"],
            "location": {"path": path} if path else None, "checks": checks}


def _error_response(e: BaseException, req: dict) -> dict:
    from .design import DesignError

    if isinstance(e, DesignError):
        return {"ok": False, "kind": "validation", "error": str(e), "detail": e.detail,
                "location": {"path": e.where} if e.where else None}
    if isinstance(e, (KeyError, ValueError)):
        msg = e.args[0] if isinstance(e, KeyError) and e.args else str(e)
        return {"ok": False, "kind": "validation", "error": str(msg),
                "location": error_location(e, req.get("model_path", ""))}
    return {"ok": False, "kind": "model", "error": f"{type(e).__name__}: {e}",
            "traceback": "".join(traceback.format_exception(type(e), e, e.__traceback__, limit=8)),
            "location": error_location(e, req.get("model_path", ""))}


def worker_main():
    proto = _protocol_stream()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            resp = {"ok": False, "kind": "request", "error": f"bad JSON: {e}"}
        else:
            resp = handle(req)
            resp["id"] = req.get("id")
        sys.stdout.flush()
        try:
            proto.write(json.dumps(resp, allow_nan=False, separators=(",", ":")) + "\n")
        except ValueError as e:
            proto.write(json.dumps({"ok": False, "kind": "model", "error": f"result not JSON: {e}",
                                    "id": req.get("id") if isinstance(req, dict) else None}) + "\n")
        proto.flush()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["worker"]:
        worker_main()
    elif argv[:1] == ["describe"] and len(argv) == 2:
        proto = _protocol_stream()
        proto.write(json.dumps(describe_models(argv[1]), allow_nan=False) + "\n")
        proto.flush()
    else:
        print("usage: python -m fairbeam.preview worker | describe <models_dir>", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
