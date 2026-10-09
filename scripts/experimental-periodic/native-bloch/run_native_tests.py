"""Build and record the isolated native Bloch algebra controls in a fresh directory."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent
REPOSITORY = SOURCE.parents[2]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_native_result(output: str) -> dict:
    """Require the narrow kernel contract; an executable cannot advertise a solver."""
    data = json.loads(output)
    if (
        not isinstance(data, dict)
        or data.get("schema") != 1
        or data.get("status") != "passed"
        or type(data.get("groups")) is not int
        or data["groups"] != 9
        or type(data.get("checks")) is not int
        or data["checks"] <= 0
        or type(data.get("max_scaled_error")) not in (int, float)
        or not math.isfinite(data["max_scaled_error"])
        or not 0 <= data["max_scaled_error"] < 2e-12
        or data.get("native_openems_support") is not False
        or data.get("physical_validation") is not False
    ):
        raise ValueError("invalid native Bloch kernel result contract")
    return data


def _as_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return "" if value is None else str(value)


def _error_text(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"[:500]


def _terminate_owned_process(process: subprocess.Popen[str], entry: dict) -> None:
    """Best-effort tree termination with a direct-child fallback."""
    cleanup_errors: list[str] = []
    entry["process_tree_cleanup_attempted"] = True
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
        try:
            cleanup = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=creationflags,
                check=False,
            )
            entry["process_tree_cleanup_returncode"] = cleanup.returncode
            if cleanup.returncode:
                cleanup_errors.append(f"taskkill returned {cleanup.returncode}")
        except BaseException as error:
            # A failed or timed-out taskkill must not bypass the child fallback
            # or prevent collection of the command's own stdout/stderr.
            cleanup_errors.append(f"taskkill: {_error_text(error)}")
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
            entry["process_tree_cleanup_signal"] = int(signal.SIGKILL)
        except ProcessLookupError:
            entry["process_tree_cleanup"] = "process group already exited"
        except BaseException as error:
            cleanup_errors.append(f"killpg: {_error_text(error)}")

    try:
        if process.poll() is None:
            entry["direct_process_kill_attempted"] = True
            process.kill()
    except BaseException as error:
        cleanup_errors.append(f"direct process kill: {_error_text(error)}")
    if cleanup_errors:
        entry["process_cleanup_errors"] = cleanup_errors


def _collect_after_termination(process: subprocess.Popen[str], entry: dict) -> tuple[str, str]:
    """Reap a stopped child with bounded retries and return any available logs."""
    partial_stdout = ""
    partial_stderr = ""
    for attempt in range(2):
        try:
            stdout, stderr = process.communicate(timeout=10)
            return _as_text(stdout), _as_text(stderr)
        except BaseException as error:
            partial_stdout = _as_text(getattr(error, "output", None)) or partial_stdout
            partial_stderr = _as_text(getattr(error, "stderr", None)) or partial_stderr
            entry["diagnostic_collection_error"] = _error_text(error)
            if attempt == 0:
                try:
                    if process.poll() is None:
                        entry["direct_process_kill_attempted"] = True
                        process.kill()
                except BaseException as kill_error:
                    entry.setdefault("process_cleanup_errors", []).append(
                        f"diagnostic retry kill: {_error_text(kill_error)}"
                    )
    return partial_stdout, partial_stderr


def _retain_command_logs(output: Path, entry: dict, stdout: str, stderr: str) -> None:
    (output / entry["stdout"]).write_text(stdout, encoding="utf-8")
    (output / entry["stderr"]).write_text(stderr, encoding="utf-8")


def executable_path(build: Path, config: str) -> Path:
    names = ["native_bloch_tests.exe", "native_bloch_tests"]
    for directory in (build / config, build):
        for name in names:
            executable = directory / name
            if executable.is_file():
                return executable
    raise FileNotFoundError("native_bloch_tests executable was not produced")


def run_study(output: Path, *, generator: str | None = None,
              architecture: str | None = None, jobs: int = 2, config: str = "Release") -> dict:
    if jobs not in (1, 2):
        raise ValueError("native test build allows one or two jobs")
    if architecture and not generator:
        raise ValueError("an architecture requires an explicit CMake generator")
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    build = output / "build"
    frozen_source = output / "source"
    frozen_source.mkdir()
    for path in sorted(SOURCE.iterdir()):
        if path.is_file() and path.suffix in (".h", ".cpp", ".py", ".txt"):
            shutil.copyfile(path, frozen_source / path.name)
    report = {
        "schema": 1,
        "kind": "standalone-native-bloch-algebra",
        "status": "started",
        "started_utc": utc_now(),
        "evidence_domain": "synthetic",
        "native_openems_support": False,
        "physical_validation": False,
        "jobs": jobs,
        "configuration": config,
        "source_sha256": {
            str((SOURCE / path.name).relative_to(REPOSITORY)).replace("\\", "/"): sha256(path)
            for path in sorted(frozen_source.iterdir())
            if path.is_file() and path.suffix in (".h", ".cpp", ".py", ".txt")
        },
        "commands": [],
    }

    def command(arguments: list[str], name: str, timeout: int = 120) -> str:
        started = utc_now()
        entry = {"command": arguments, "cwd": str(REPOSITORY), "started_utc": started,
                 "stdout": f"{name}.stdout.txt", "stderr": f"{name}.stderr.txt"}
        report["commands"].append(entry)
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        process = subprocess.Popen(arguments, cwd=REPOSITORY, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=creationflags, start_new_session=sys.platform != "win32")
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException as error:
            # Build wrappers can spawn compiler children. Attempt to stop only
            # this command's process tree, then always try the direct child and
            # retain diagnostics even when tree cleanup itself fails.
            _terminate_owned_process(process, entry)
            stdout, stderr = _collect_after_termination(process, entry)
            _retain_command_logs(output, entry, stdout, stderr)
            status = (
                "timed_out" if isinstance(error, subprocess.TimeoutExpired)
                else "interrupted" if isinstance(error, KeyboardInterrupt)
                else "aborted"
            )
            entry.update({"finished_utc": utc_now(), "status": status,
                          "returncode": process.returncode})
            raise
        _retain_command_logs(output, entry, stdout, stderr)
        entry.update({"finished_utc": utc_now(), "returncode": process.returncode})
        if process.returncode:
            raise RuntimeError(f"{name} failed with exit code {process.returncode}; see retained logs")
        return stdout

    try:
        report["cmake_version"] = command(["cmake", "--version"], "cmake-version").splitlines()[0]
        report["git_head"] = command(["git", "rev-parse", "HEAD"], "git-head").strip()
        report["git_status"] = command(["git", "status", "--short"], "git-status").splitlines()
        configure = ["cmake", "-S", str(frozen_source), "-B", str(build), f"-DCMAKE_BUILD_TYPE={config}"]
        if generator:
            configure += ["-G", generator]
        if architecture:
            configure += ["-A", architecture]
        command(configure, "configure")
        command(["cmake", "--build", str(build), "--config", config, "--parallel", str(jobs)], "build")
        command(["ctest", "--test-dir", str(build), "-C", config, "--output-on-failure"], "ctest")
        executable = executable_path(build, config)
        report["executable_sha256"] = sha256(executable)
        report["result"] = parse_native_result(command([str(executable)], "native-tests", timeout=30))
        compiler_files = sorted(build.glob("CMakeFiles/*/CMakeCXXCompiler.cmake"))
        if compiler_files:
            compiler_file = compiler_files[-1]
            (output / "compiler.cmake.txt").write_text(compiler_file.read_text(encoding="utf-8"), encoding="utf-8")
            report["compiler_metadata_sha256"] = sha256(output / "compiler.cmake.txt")
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    except BaseException as error:
        report["status"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "aborted"
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        report["finished_utc"] = utc_now()
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="fresh directory for build, logs and manifest")
    parser.add_argument("--generator", help="optional CMake generator")
    parser.add_argument("--architecture", help="optional generator architecture, e.g. x64")
    parser.add_argument("--jobs", type=int, choices=(1, 2), default=2)
    parser.add_argument("--config", choices=("Release", "Debug"), default="Release")
    args = parser.parse_args()
    try:
        report = run_study(args.output, generator=args.generator, architecture=args.architecture,
                           jobs=args.jobs, config=args.config)
    except KeyboardInterrupt:
        print("native Bloch kernel study interrupted; see retained report.json", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"native Bloch kernel study failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"report": str(args.output.resolve() / "report.json"), "result": report["result"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
