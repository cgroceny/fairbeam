"""Render jobs for "Render with Blender": options, the job file Blender reads, output names, progress parsing,
and the manager that runs one Blender process per job in the background (docs/RENDER-BLENDER.md).

Blender is started with ``-b --factory-startup -P blender_render.py -- job.json`` and nothing else: no add-on,
no socket, no GUI. Progress comes from Blender's own stdout (``Fra:1 ... | Sample 12/32``) and the ``@AL`` marker
lines of blender_render.py. Cancelling kills only that Blender process (its job object on Windows).
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

from . import blender_find, renders
from .renders import RenderError
from .procutil import popen_group, release_group, terminate_group

SCRIPT = Path(__file__).with_name("blender_render.py")
ANGLE_PRESETS = ("iso", "top", "front", "right", "back", "left", "bottom")
BACKGROUNDS = {"transparent": "transparent", "none": "transparent", "studio": "studio", "light": "studio",
               "grey": "studio", "gray": "studio", "dark": "dark", "black": "dark"}
PORT_MODES = {"hidden": "hidden", "none": "hidden", "marker": "marker", "red": "marker", "connector": "connector",
              "sma": "connector", "auto": "auto"}
MAX_SIDE = 8192
MAX_ANGLES = 12
MAX_GLB = 120_000_000


def safe_name(text: str, fallback: str = "design") -> str:
    """A file-name stem: letters, digits, dot, dash, underscore."""
    s = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(text or "")).strip("._-")[:60]
    return s or fallback


def timestamp(t: float | None = None) -> str:
    return time.strftime("%Y%m%d-%H%M%S", time.localtime(t if t is not None else time.time()))


def _angle_name(raw: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(raw).lower()).strip("-") or "view"


def normalise_options(raw: dict) -> dict:
    """Validate and complete the ``RenderOptions`` of src/render/options.ts (unknown keys are ignored)."""
    if not isinstance(raw, dict):
        raise RenderError(422, "options must be an object")
    angles_in = raw.get("angles")
    if angles_in is None:
        angles_in = ["iso"]
    if not isinstance(angles_in, list) or not 1 <= len(angles_in) <= MAX_ANGLES:
        raise RenderError(422, f"angles must list 1 to {MAX_ANGLES} views")
    angles: list = []
    seen: set[str] = set()
    for a in angles_in:
        if isinstance(a, str):
            key = a.strip().lower()
            if key in ("current", "view", "current-view"):
                key = "iso"             # the viewer's own camera travels as an object (see `RenderAngle`)
            if key not in ANGLE_PRESETS:
                raise RenderError(422, f"unknown camera angle {a!r}")
            item: object = key
            name = key
        elif isinstance(a, dict):
            d = a.get("direction")
            if not (isinstance(d, list) and len(d) == 3 and all(isinstance(x, (int, float)) and abs(x) < 1e12 for x in d)
                    and any(abs(x) > 0 for x in d)):
                raise RenderError(422, "a camera angle object needs a 3-number direction")
            up = a.get("up") or [0, 0, 1]
            if not (isinstance(up, list) and len(up) == 3 and all(isinstance(x, (int, float)) for x in up)):
                raise RenderError(422, "a camera angle up must be 3 numbers")
            name = _angle_name(a.get("name") or "current")
            item = {"name": name, "direction": [float(x) for x in d], "up": [float(x) for x in up]}
        else:
            raise RenderError(422, "bad camera angle")
        base, n = name, 2
        while name in seen:             # the same view twice: keep distinct file names
            name = f"{base}-{n}"
            n += 1
        seen.add(name)
        if isinstance(item, dict):
            item["name"] = name
        elif name != item:
            item = {"name": name, "direction": list(_preset_direction(item)), "up": [0, 0, 1]}
        angles.append(item)

    def side(key: str, default: int) -> int:
        v = raw.get(key, default)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 16 <= v <= MAX_SIDE:
            raise RenderError(422, f"{key} must be a number from 16 to {MAX_SIDE}")
        return int(round(v))

    background = BACKGROUNDS.get(str(raw.get("background", "transparent")).lower())
    if background is None:
        raise RenderError(422, "background must be transparent, studio or dark")
    ports = PORT_MODES.get(str(raw.get("ports", "auto")).lower())
    if ports is None:
        raise RenderError(422, "ports must be auto, connector, marker or hidden")
    mask = raw.get("solderMask", "none")
    mask = "green" if mask in ("green", True) else "none"
    projection = str(raw.get("projection", "perspective")).lower()
    if projection not in ("perspective", "orthographic"):
        raise RenderError(422, "projection must be perspective or orthographic")
    quality = str(raw.get("quality", "preview")).lower()
    if quality not in ("preview", "final"):
        raise RenderError(422, "quality must be preview or final")
    return {"angles": angles, "width": side("width", 1600), "height": side("height", 1000), "background": background,
            "ports": ports, "solderMask": mask, "groundShadow": bool(raw.get("groundShadow", False)),
            "projection": projection, "engine": "blender", "quality": quality}


def _preset_direction(name: str):
    return {"iso": (1.0, -1.0, 0.8), "top": (0, 0, 1), "bottom": (0, 0, -1), "front": (0, -1, 0),
            "back": (0, 1, 0), "right": (1, 0, 0), "left": (-1, 0, 0)}[name]


def angle_label(angle) -> str:
    return angle if isinstance(angle, str) else angle["name"]


def output_names(design: str, angles: list, stamp: str) -> list[str]:
    """``<design>_<angle>_<timestamp>.png`` for each angle."""
    stem = safe_name(design)
    return [f"{stem}_{angle_label(a)}_{stamp}.png" for a in angles]


def blend_name(design: str, stamp: str) -> str:
    return f"{safe_name(design)}_{stamp}.blend"


def clean_parts(parts) -> list[dict]:
    out = []
    for p in parts if isinstance(parts, list) else []:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str):
            continue
        item = {"name": p["name"], "kind": p.get("kind") if p.get("kind") in ("metal", "dielectric", "void") else "dielectric"}
        for key in ("material", "library", "label"):
            if isinstance(p.get(key), str):
                item[key] = p[key]
        if isinstance(p.get("color"), str) and re.fullmatch(r"#[0-9a-fA-F]{3,8}", p["color"]):
            item["color"] = p["color"][:7] if len(p["color"]) >= 7 else p["color"]
        if isinstance(p.get("eps_r"), (int, float)) and not isinstance(p.get("eps_r"), bool):
            item["eps_r"] = float(p["eps_r"])
        if p.get("void"):
            item["void"] = True
        out.append(item)
    return out


def _vec(v):
    return isinstance(v, list) and len(v) == 3 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v)


def clean_ports(ports, key: str = "ports") -> list[dict]:
    out = []
    for p in ports if isinstance(ports, list) else []:
        if not isinstance(p, dict) or not _vec(p.get("start")) or not _vec(p.get("stop")):
            continue
        if str(p.get("direction")).lower() not in ("x", "y", "z"):
            continue
        item = {k: p[k] for k in ("number", "type", "name", "label", "R", "L", "C", "topology") if k in p
                and isinstance(p[k], (str, int, float, type(None))) and not isinstance(p[k], bool)}
        item["direction"] = str(p["direction"]).lower()
        item["start"], item["stop"] = [float(x) for x in p["start"]], [float(x) for x in p["stop"]]
        if key == "ports":
            item["type"] = "waveguide" if p.get("type") == "waveguide" else "lumped"
        out.append(item)
    return out


def write_job_file(work: Path, *, glb: bytes, options: dict, parts, ports, lumped, names: list[str], out_dir: Path,
                   blend: Path | None, stamp: str, device: str = "auto", threads: int | None = None) -> Path:
    """The job file Blender's script reads (positions are metres, like the GLB)."""
    glb_path = work / "model.glb"
    glb_path.write_bytes(glb)
    job = {"glb": str(glb_path), "options": options, "angles": options["angles"], "parts": clean_parts(parts),
           "ports": clean_ports(ports), "lumped": clean_ports(lumped, "lumped"),
           "outputs": [str(out_dir / n) for n in names], "blend": str(blend) if blend else None, "stamp": stamp,
           "device": device if device in ("auto", "cpu", "gpu") else "auto"}
    if threads:
        job["threads"] = int(threads)
    path = work / "job.json"
    path.write_text(json.dumps(job), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------------------------- progress
FRAME_RE = re.compile(r"\bFra:(\d+)")
SAMPLE_RE = re.compile(r"\bSample\s+(\d+)\s*/\s*(\d+)")


class ProgressParser:
    """Turns Blender's stdout lines and the script's ``@AL`` markers into one progress state.

    ``progress`` is 0..1 overall: setup 4 %, then an equal share per angle (samples, then denoising and writing).
    """

    SETUP = 0.04

    def __init__(self, angle_count: int = 1):
        self.angle_count = max(1, angle_count)
        self.angle = 0            # 1-based, 0 before the first angle starts
        self.angle_name = ""
        self.sample = 0
        self.samples = 0
        self.stage = "starting"
        self.device = ""
        self.note = ""
        self.finished = False
        self.done_angles = 0
        self.error: str | None = None
        self.denoising = False
        self.outputs: list[tuple[int, str, float]] = []     # (index, path, seconds)
        self.blend: str | None = None

    @property
    def progress(self) -> float:
        if self.finished:
            return 1.0
        if self.angle == 0:
            return {"import": 0.01, "materials": 0.02, "ports": 0.03}.get(self.stage, 0.0)
        share = (1 - self.SETUP) / self.angle_count
        done = self.done_angles
        frac = 0.0
        if self.angle > done:
            frac = (self.sample / self.samples) * 0.92 if self.samples else 0.0
            if self.denoising:
                frac = 0.95
        return min(0.999, self.SETUP + share * (done + frac))

    def feed(self, line: str) -> dict | None:
        """Update from one output line; returns a marker event (``{"event": ..., ...}``) or None."""
        line = line.strip()
        if not line:
            return None
        if line.startswith("@AL "):
            return self._marker(line[4:].strip())
        m = SAMPLE_RE.search(line)
        if m and FRAME_RE.search(line):
            self.sample, self.samples = int(m.group(1)), int(m.group(2))
            self.stage = "rendering"
            # the last sample is followed by the denoiser and the PNG write
            self.denoising = self.samples > 0 and self.sample >= self.samples
            if self.denoising:
                self.stage = "denoising"
            return {"event": "sample", "sample": self.sample, "samples": self.samples}
        return None

    def _marker(self, text: str) -> dict | None:
        parts = text.split()
        if not parts:
            return None
        kind, rest = parts[0], parts[1:]
        if kind == "stage" and rest:
            self.stage = rest[0]
        elif kind == "device":
            self.device = " ".join(rest)
        elif kind == "note":
            self.note = " ".join(rest)
        elif kind == "count" and rest and rest[0].isdigit():
            self.angle_count = max(1, int(rest[0]))
        elif kind == "angle" and len(rest) >= 3:
            self.angle, self.angle_count = int(rest[0]), int(rest[1])
            self.angle_name = rest[2]
            self.sample, self.samples, self.denoising = 0, 0, False
            self.stage = "rendering"
        elif kind == "done" and len(rest) >= 4:
            idx = int(rest[0])
            self.done_angles = idx
            self.outputs.append((idx, " ".join(rest[2:-1]), float(rest[-1])))
            self.denoising = False
            return {"event": "image", "index": idx, "path": " ".join(rest[2:-1]), "seconds": float(rest[-1])}
        elif kind == "blend":
            self.blend = " ".join(rest)
            return {"event": "blend", "path": self.blend}
        elif kind == "finished":
            self.finished = True
            self.stage = "done"
        elif kind == "error":
            self.error = " ".join(rest)
        return {"event": kind}


# ---------------------------------------------------------------------------------------------- jobs
def blender_env() -> dict:
    """Environment for Blender: the server's, minus anything that points at another Python."""
    env = dict(os.environ)
    for key in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE", "PYTHONUTF8", "PYTHONIOENCODING"):
        env.pop(key, None)
    return env


def blender_command(blender: str, job_file: Path, script: Path = SCRIPT) -> list[str]:
    return [blender, "-b", "--factory-startup", "--python-exit-code", "1", "-noaudio", "-P", str(script), "--",
            str(job_file)]


class RenderJob:
    TERMINAL = ("done", "failed", "cancelled")

    def __init__(self, job_id: str, design: str, out_dir: Path, names: list[str], blend: str | None, options: dict):
        self.id = job_id
        self.design = design
        self.out_dir = out_dir
        self.names = names
        self.blend = blend
        self.options = options
        self.status = "queued"
        self.parser = ProgressParser(len(names))
        self.created = time.time()
        self.started: float | None = None
        self.finished: float | None = None
        self.error: str | None = None
        self.log: list[str] = []
        self.proc: subprocess.Popen | None = None
        self.cancel_requested = False
        self.blender: dict = {}
        self.images: list[dict] = []
        self.blend_saved = False
        self.lock = threading.Lock()
        self.work: Path | None = None

    @property
    def terminal(self) -> bool:
        return self.status in self.TERMINAL

    def add_log(self, line: str) -> None:
        self.log.append(line.rstrip())
        if len(self.log) > 400:
            del self.log[:100]

    def to_dict(self) -> dict:
        p = self.parser
        end = self.finished or time.time()
        return {
            "id": self.id, "design": self.design, "status": self.status, "stage": p.stage,
            "progress": round(p.progress if self.status == "running" else (1.0 if self.status == "done" else p.progress), 4),
            "angle_index": p.angle, "angle_count": p.angle_count, "angle": p.angle_name,
            "sample": p.sample, "samples": p.samples, "device": p.device, "note": p.note,
            "images": list(self.images), "blend": self.blend if self.blend_saved else None,
            "folder": str(self.out_dir), "error": self.error,
            "elapsed_s": round(end - self.started, 2) if self.started else 0.0,
            "image_seconds": [round(s, 2) for _i, _p, s in p.outputs], "quality": self.options.get("quality"),
            "blender": self.blender, "log_tail": self.log[-12:],
        }


class RenderManager:
    """Runs render jobs one at a time (a render uses the whole machine) on background threads."""

    KEEP = 24

    def __init__(self, workspace: Path, blender_path=lambda: None):
        # pictures go to <workspace>/renders/<design id>/, the folder the in-app renderer saves into (renders.py)
        self.workspace = Path(workspace)
        self.root = self.workspace / renders.RENDERS
        self.blender_path = blender_path
        self.jobs: dict[str, RenderJob] = {}
        self.order: list[str] = []
        self.gate = threading.Lock()
        self.lock = threading.Lock()
        self.threads: list[threading.Thread] = []

    # -- public
    def submit(self, body: dict) -> RenderJob:
        design = body.get("design_id")
        try:
            renders.check_id(design)
        except RenderError:
            raise RenderError(422, "design_id must be a short file-name-safe id")
        options = normalise_options(body.get("options") or {})
        glb_b64 = body.get("glb_base64")
        if not isinstance(glb_b64, str) or not glb_b64:
            raise RenderError(422, "glb_base64 is required (the design's geometry as a GLB)")
        try:
            glb = base64.b64decode(glb_b64, validate=True)
        except (binascii.Error, ValueError):
            raise RenderError(422, "glb_base64 is not valid base64")
        if not glb.startswith(b"glTF") or len(glb) > MAX_GLB:
            raise RenderError(422, "glb_base64 is not a GLB file")
        info = blender_find.detect(body.get("blender") if isinstance(body.get("blender"), str) else self.blender_path())
        if not info["found"]:
            raise RenderError(409, "Blender was not found. Install Blender from blender.org or set its path in Settings.")
        if not info["ok"]:
            raise RenderError(409, info.get("message") or "This Blender is too old (3.6 or newer is needed).")
        out_dir = renders.render_dir(self.workspace, design, create=True)
        stamp, n = timestamp(), 1
        while True:     # never over an earlier picture: a second render in the same second gets -2, -3, ...
            names = output_names(design, options["angles"], stamp)
            blend = blend_name(design, stamp) if body.get("save_blend", True) else None
            if not any((out_dir / f).exists() for f in names + ([blend] if blend else [])):
                break
            n += 1
            stamp = f"{timestamp()}-{n}"
        job = RenderJob("rb-" + secrets.token_hex(4), design, out_dir, names, blend, options)
        job.blender = {"path": info["path"], "version": info["version"], "label": info["label"]}
        work = self.root / ".work" / job.id
        work.mkdir(parents=True, exist_ok=True)
        job.work = work
        threads = body.get("threads")
        job_file = write_job_file(
            work, glb=glb, options=options, parts=body.get("parts"), ports=body.get("ports"),
            lumped=body.get("lumped"), names=names, out_dir=out_dir, blend=(out_dir / blend) if blend else None,
            stamp=stamp, device=str(body.get("device") or "auto"),
            threads=int(threads) if isinstance(threads, int) and not isinstance(threads, bool) and threads > 0 else None)
        with self.lock:
            self.jobs[job.id] = job
            self.order.append(job.id)
            self._trim()
        t = threading.Thread(target=self._run, args=(job, info["path"], job_file), name=f"fairbeam-render-{job.id}",
                             daemon=True)
        self.threads.append(t)
        t.start()
        return job

    def get(self, job_id: str) -> RenderJob | None:
        return self.jobs.get(job_id)

    def cancel(self, job_id: str) -> RenderJob | None:
        job = self.jobs.get(job_id)
        if job is None:
            return None
        with job.lock:
            if job.terminal:
                return job
            job.cancel_requested = True
            proc = job.proc
        if proc is not None and proc.poll() is None:
            # only this Blender process (and what it started), never anything else
            threading.Thread(target=terminate_group, args=(proc.pid,), kwargs={"grace": 1.5, "wait": proc.wait,
                             "job": getattr(proc, "win_job", None)}, daemon=True).start()
        return job

    def list(self) -> list[dict]:
        return [self.jobs[i].to_dict() for i in reversed(self.order) if i in self.jobs]

    def shutdown(self) -> None:
        for job_id in list(self.jobs):
            self.cancel(job_id)
        for t in self.threads:
            t.join(timeout=5)

    # -- internals
    def _trim(self) -> None:
        while len(self.order) > self.KEEP:
            old = self.order[0]
            if old in self.jobs and not self.jobs[old].terminal:
                break
            self.order.pop(0)
            self.jobs.pop(old, None)

    def _image(self, job: RenderJob, index: int, path: str, seconds: float) -> None:
        p = Path(path)
        item = {"index": index, "angle": angle_label(job.options["angles"][index - 1]) if index <= len(job.options["angles"]) else "",
                "name": p.name, "path": str(p), "seconds": seconds,
                "url": f"/api/renders/{job.design}/file/{p.name}"}
        job.images.append(item)

    def _run(self, job: RenderJob, blender: str, job_file: Path) -> None:
        with self.gate:
            if job.cancel_requested:
                self._finish(job, "cancelled")
                return
            job.status = "running"
            job.started = time.time()
            try:
                self._run_blender(job, blender, job_file)
            except Exception as e:  # noqa: BLE001
                job.error = f"{type(e).__name__}: {e}"
                self._finish(job, "failed")

    def _run_blender(self, job: RenderJob, blender: str, job_file: Path) -> None:
        cmd = blender_command(blender, job_file)
        job.add_log("$ " + " ".join(cmd))
        proc = popen_group(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                           env=blender_env(), cwd=str(job.work))
        with job.lock:
            job.proc = proc
        if job.cancel_requested:
            terminate_group(proc.pid, grace=0.5, wait=proc.wait, job=getattr(proc, "win_job", None))
        tail = job.work / "blender.log" if job.work else None
        logf = open(tail, "w", encoding="utf-8", errors="replace") if tail else None
        try:
            for raw in iter(proc.stdout.readline, b""):
                text = raw.decode("utf-8", "replace")
                for line in re.split(r"[\r\n]+", text):
                    if not line.strip():
                        continue
                    if logf:
                        logf.write(line + "\n")
                    event = job.parser.feed(line)
                    if event is None:
                        # keep the log short: sample progress lines would drown it
                        if "Sample" not in line:
                            job.add_log(line)
                        continue
                    if event["event"] == "image":
                        self._image(job, event["index"], event["path"], event["seconds"])
                    elif event["event"] == "blend":
                        job.blend_saved = True
                    elif event["event"] not in ("sample", "stage", "angle", "count", "device", "note"):
                        job.add_log(line)
                    else:
                        if event["event"] in ("note", "device", "angle"):
                            job.add_log(line)
        finally:
            code = proc.wait()
            release_group(proc)
            proc.stdout.close()
            if logf:
                logf.close()
        if job.cancel_requested:
            self._finish(job, "cancelled")
        elif code == 0 and job.parser.finished and len(job.images) == len(job.names):
            self._finish(job, "done")
        else:
            job.error = job.parser.error or f"Blender exited with code {code}" + (
                " without finishing" if code == 0 else "")
            self._finish(job, "failed")

    def _finish(self, job: RenderJob, status: str) -> None:
        job.finished = time.time()
        if status == "cancelled":
            # partial output of the cancelled angle is not kept
            for name in job.names:
                if not any(i["name"] == name for i in job.images):
                    try:
                        (job.out_dir / name).unlink()
                    except OSError:
                        pass
        if job.work and job.work.exists():
            if status == "failed" and (job.work / "blender.log").exists():
                try:
                    (job.out_dir / f"{job.id}-failed.log").write_text(
                        (job.work / "blender.log").read_text(encoding="utf-8", errors="replace")[-20000:], encoding="utf-8")
                except OSError:
                    pass
            shutil.rmtree(job.work, ignore_errors=True)
        job.status = status


# ---------------------------------------------------------------------------------------------- open things
def open_folder(path: Path) -> None:
    """Show a folder in the system file manager."""
    import sys
    if sys.platform == "win32":
        os.startfile(str(path))  # noqa: S606 - a folder inside the workspace the server built itself
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def open_in_blender(blender: str, blend: Path) -> None:
    """Launch Blender (GUI) on a saved .blend, detached from the server."""
    import sys
    kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
                    "env": blender_env()}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x00000008 | 0x00000200      # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([blender, str(blend)], **kwargs)
