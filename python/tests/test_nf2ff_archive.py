"""Synthetic HDF5 metadata/ownership controls; no solver and no field propagation."""
import copy
import json
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import h5py
import numpy as np

from fairbeam import nf2ff_archive as a
from fairbeam.nf2ff_postprocess import process


def dump(path, kind=0, *, frequencies=None):
    with h5py.File(path, "w") as f:
        f.attrs["dump_type"] = kind
        mesh = f.create_group("Mesh")
        mesh.attrs["mesh_type"] = 0
        mesh.attrs["mesh_scaling"] = 1.0
        for name, axis in {"x": [-1.0], "y": [-1.0, 1.0], "z": [-1.0, 1.0]}.items():
            mesh.create_dataset(name, data=axis)
        data = f.create_group("FieldData").create_group("FD" if kind >= 10 else "TD")
        if kind >= 10:
            data.attrs["frequency"] = frequencies
        names = [f"f{i}_{part}" for i in range(len(frequencies)) for part in ("real", "imag")] if kind >= 10 else ["00000000", "00000001", "00000002"]
        for i, name in enumerate(names):
            ds = data.create_dataset(name, data=np.ones((3, 1, 2, 2)))
            ds.attrs["d_order"] = "NXYZ"
            if kind < 10:
                ds.attrs["time"] = [i * 1e-11]


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.raw = self.base / "raw"
        self.raw.mkdir()
        self.parent = self.base / "parent.json"
        self.parent.write_text(json.dumps({"model": {"id": "sample"}, "results": {"farfield": [{"f": 1e9}], "sparams": {"unchanged": 1}}, "run": {"timesteps": 20},
            "requirements_source": {"source_id": "original"}, "requirements_snapshot": {"source_id": "original"}}), encoding="utf-8")
        mesh = {v: [-1.0, 0.0, 1.0] for v in "xyz"}
        self.d = {"recording": {"name": "nf2ff", "e_file": "nf2ff_E", "h_file": "nf2ff_H", "start": [-1.0]*3, "stop": [1.0]*3,
            "directions": [True, False, False, False, False, False], "mirror": [0]*6, "dump_type": 0, "dump_mode": 1, "frequencies": []},
            "mesh": mesh, "mesh_sha256": a.digest(a.encode(mesh)), "unit_m": 1.0, "band_hz": [1e9, 3e9], "phase_center_m": [0.0]*3,
            "boundaries": ["PML_8"]*6, "complex_fields": False, "circular": False, "lossless": False,
            "network": {"frequency_hz": [1e9, 3e9], "pacc_w": [1.0, 1.0], "gamma2": [0.1, 0.1], "port_type": "lumped"}}
        self.runtime = {"fixture": "synthetic-no-native"}

    def tearDown(self):
        self.temp.cleanup()

    def retain(self, fd=False, source_bytes=b"saved input"):
        if fd:
            self.d["recording"].update(dump_type=10, frequencies=[1e9, 2e9])
        for part, offset in (("E", 0), ("H", 1)):
            dump(self.raw / f"nf2ff_{part}_0.h5", (10 if fd else 0)+offset, frequencies=[1e9, 2e9] if fd else None)
        self.manifest = a.retain(self.raw, self.parent, source_bytes, "sample.py", {"x": 2},
            [{"port": 3, "path": self.raw, "descriptor": self.d}], runtime=self.runtime)
        self.sha = a.digest(a.encode(self.manifest))

    def load(self):
        return a.load_verified(self.raw, expected_sha256=self.sha, parent_path=self.parent, runtime=self.runtime)

    def test_td_receipt_and_frequency_admission(self):
        self.retain()
        m, _, sha = self.load()
        self.assertEqual(sha, self.sha)
        self.assertEqual(a.admit_request(m, [1.5e9])["frequencies_hz"], [1.5e9])
        for frequencies in ([], [0], [True], [float("nan")], [1e9]*2, [4e9], [1e9]*17):
            with self.subTest(frequencies=frequencies), self.assertRaises(ValueError):
                a.admit_request(m, frequencies)
        with self.assertRaises(ValueError):
            a.admit_request(m, [1e9], .25, .25)

    def test_fd_exact_only(self):
        self.retain(fd=True)
        self.assertEqual(a.admit_request(self.manifest, [2e9])["frequencies_hz"], [2e9])
        with self.assertRaisesRegex(ValueError, "recorded"):
            a.admit_request(self.manifest, [1.5e9])

    def test_td_nyquist_is_checked(self):
        self.retain()
        m = copy.deepcopy(self.manifest)
        m["ports"][0]["files"][0]["nyquist_hz"] = 1.1e9
        with self.assertRaisesRegex(ValueError, "Nyquist"):
            a.admit_request(m, [2e9])

    def test_manifest_tampering_is_not_self_certified(self):
        self.retain()
        m = copy.deepcopy(self.manifest)
        m["ports"][0]["descriptor"]["phase_center_m"][0] = .1
        (self.raw / a.MANIFEST).write_bytes(a.encode(m))
        with self.assertRaisesRegex(ValueError, "receipt"):
            self.load()

    def test_raw_hash_and_parent_hash_and_runtime(self):
        self.retain()
        raw = self.raw / "nf2ff_E_0.h5"
        old = raw.read_bytes()
        raw.write_bytes(old + b"x")
        with self.assertRaisesRegex(ValueError, "raw input hash"):
            self.load()
        raw.write_bytes(old)
        with self.assertRaisesRegex(ValueError, "runtime"):
            a.load_verified(self.raw, expected_sha256=self.sha, runtime={"different": True})
        self.parent.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "original result"):
            self.load()

    def test_paths_and_no_clobber(self):
        for name in (None, "../outside", "x/../outside", "/tmp/a", "x\\y", "x//y", "."):
            with self.subTest(name=name), self.assertRaises(ValueError):
                a.safe_file(self.raw, name, exists=False)
        dest = self.base / "once"
        a.write_new(dest, b"first")
        with self.assertRaises(FileExistsError):
            a.write_new(dest, b"second")
        self.assertEqual(dest.read_bytes(), b"first")

    def test_hdf5_external_link_refused(self):
        path = self.raw / "external.h5"
        with h5py.File(path, "w") as f:
            f.attrs["dump_type"] = 0
            f["Mesh"] = h5py.ExternalLink("other.h5", "/Mesh")
        with self.assertRaisesRegex(ValueError, "hard-linked"):
            a.hdf5_descriptor(path, 0, 1)

    def test_missing_pair_and_new_disabled_face(self):
        self.retain()
        unexpected = self.raw / "nf2ff_E_1.h5"
        unexpected.write_bytes(b"unexpected")
        with self.assertRaisesRegex(ValueError, "unexpected"):
            self.load()
        unexpected.unlink()
        (self.raw / "nf2ff_H_0.h5").unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            self.load()

    def test_derivative_preserves_parent_and_requirements_no_fdtd(self):
        self.retain()
        before = self.parent.read_bytes()
        out = self.base / "new.json"
        called = []
        def transform(root, port, request, path):
            called.append((root, port["port"], request["frequencies_hz"]))
            path.write_bytes(b"synthetic-transform-output")
            return [{"port": port["port"], "f": request["frequencies_hz"][0]}]
        with patch("fairbeam.nf2ff_postprocess.native_transform", side_effect=AssertionError("native unavailable")):
            process(self.raw, expected_sha256=self.sha, frequencies=[2e9], output=out,
                parent_path=self.parent, _runtime_identity=self.runtime, _transform=transform)
        self.assertEqual(len(called), 1)
        result = json.loads(out.read_bytes())
        parent = json.loads(before)
        for key in ("run", "requirements_source", "requirements_snapshot"):
            self.assertEqual(result[key], parent[key])
        self.assertEqual(result["results"]["sparams"], parent["results"]["sparams"])
        self.assertFalse(result["postprocess"]["fdtd_rerun"])
        self.assertEqual(result["postprocess"]["parent_sha256"], a.digest(before))
        self.assertEqual(self.parent.read_bytes(), before)
        with self.assertRaises(ValueError):
            process(self.raw, expected_sha256=self.sha, frequencies=[2e9], output=out,
                _runtime_identity=self.runtime, _transform=transform)

    def test_failure_and_input_change_publish_nothing(self):
        self.retain()
        out = self.base / "new.json"
        def fail(*args):
            raise RuntimeError("synthetic failure")
        with self.assertRaisesRegex(RuntimeError, "synthetic"):
            process(self.raw, expected_sha256=self.sha, frequencies=[2e9], output=out,
                _runtime_identity=self.runtime, _transform=fail)
        self.assertFalse(out.exists())

    def test_input_change_during_transform_publishes_nothing(self):
        self.retain()
        out = self.base / "new.json"
        def mutate(*args):
            (self.raw / "nf2ff_E_0.h5").write_bytes(b"changed")
            return []
        with self.assertRaisesRegex(ValueError, "hash"):
            process(self.raw, expected_sha256=self.sha, frequencies=[2e9], output=out,
                _runtime_identity=self.runtime, _transform=mutate)
        self.assertFalse(out.exists())

    def test_marker_and_reentrant_cleanup_guard(self):
        from fairbeam.simdata import mark_running, remove_inside
        self.retain()
        with a.raw_lock(), mark_running(self.raw):
            with a.raw_lock():
                self.assertIsNone(remove_inside(self.base, self.raw))
            self.assertTrue(self.raw.exists())
        self.assertIsNotNone(remove_inside(self.base, self.raw))
        self.assertFalse(self.raw.exists())

    def test_owned_job_request_and_api_refuse_imported_paths(self):
        from fairbeam.jobs import Job, JobManager
        from fairbeam.server import App, ApiError
        self.raw = self.base / "sim/runs/source/model"
        self.raw.mkdir(parents=True)
        self.retain()
        manager = JobManager(self.base / "jobs", self.base, sim_root=self.base / "sim", autostart=False)
        source = Job(manager.root, id="source", model="sample", model_id="sample", status="done", kind="run", bundle=self.parent.name,
            sim_dir=str(self.raw.parent), retain_nf2ff=True, retained_nf2ff={"root": str(self.raw), "sha256": self.sha})
        source.dir.mkdir()
        source.save()
        manager.jobs[source.id] = source
        app = App.__new__(App)
        app.manager = manager
        capability = app.farfield_capability(source.id)
        self.assertTrue(capability["available"])
        self.assertEqual(capability["ports"][0]["port"], 3)
        with self.assertRaises(ApiError):
            app.submit_farfield(source.id, {"frequencies_hz": [2e9], "source": "/imported"})
        job = manager.submit_postprocess(source.id, {"frequencies_hz": [2e9]})
        command = manager.default_command(job)
        self.assertIn("fairbeam.nf2ff_postprocess", command)
        self.assertNotIn("run", command)
        self.assertIsNone(job.sim_dir)
        spec = json.loads((job.dir / "nf2ff-request.json").read_bytes())
        self.assertEqual(spec["manifest_sha256"], self.sha)
        self.assertEqual(spec["parent"], str(self.parent))
        with self.assertRaisesRegex(ValueError, "queued"):
            manager.delete(source.id)
        source.retained_nf2ff["root"] = str(self.base)
        self.assertFalse(app.farfield_capability(source.id)["available"])

    def test_retention_flag_default_and_receipt_persistence(self):
        from fairbeam.jobs import JobManager, Job
        from fairbeam.progress import ProgressParser
        manager = JobManager(self.base / "jobs", self.base, sim_root=self.base / "sim", autostart=False)
        ordinary = manager.submit(model="sample", model_path="sample.py")
        self.assertNotIn("--retain-nf2ff", manager.default_command(ordinary))
        opted = manager.submit(model="sample", model_path="sample.py", retain_nf2ff=True)
        self.assertIn("--retain-nf2ff", manager.default_command(opted))
        receipt = {"root": str(Path(opted.sim_dir) / "sample"), "sha256": "a" * 64}
        manager._handle(opted, ProgressParser(), "fairbeam: retained-nf2ff " + json.dumps(receipt), "stdout")
        loaded = Job.load(manager.root, opted.dir)
        self.assertEqual(loaded.retained_nf2ff, receipt)
        with self.assertRaises(ValueError):
            manager.submit(model="sample", model_path="sample.py", kind="optimize", retain_nf2ff=True)

    def test_native_adapter_restores_only_box_and_normalizes_once(self):
        from fairbeam.nf2ff_postprocess import native_transform
        calls = []
        result = types.SimpleNamespace(E_norm=[np.ones((3, 4))], Dmax=[2.0], Prad=[1.0], r=np.array([1.0]))
        class Box:
            def __init__(self, *args, **kw):
                raise AssertionError("must not build geometry or dumps")
            def CalcNF2FF(self, root, frequencies, theta, phi, **kw):
                calls.append((self, root, frequencies, theta, phi, kw))
                Path(kw["outfile"]).write_bytes(b"synthetic")
                return result
        native = types.ModuleType("openEMS.nf2ff")
        native.nf2ff = Box
        simulation = types.ModuleType("fairbeam.simulation")
        simulation.Simulation = types.SimpleNamespace(_lossless_efficiency=lambda raw, *args: (raw, None))
        simulation._circular = lambda *args: (_ for _ in ()).throw(AssertionError("CP not requested"))
        simulation._r = lambda row, n: np.round(row, n).tolist()
        simulation._pattern_directivity = lambda *args: None
        simulation._efficiency_warning = lambda *args: None
        simulation.mirror_planes = lambda boundaries: boundaries.count("PEC")
        self.d["boundaries"][4] = "PEC"
        port = {"port": 3, "directory": "", "descriptor": self.d}
        with patch.dict("sys.modules", {"openEMS.nf2ff": native, "fairbeam.simulation": simulation}):
            fields = native_transform(self.raw, port, {"frequencies_hz": [2e9], "theta_step": 90, "phi_step": 90}, self.base / "derived.h5")
            self.assertEqual(fields[0]["prad_w"], .5)
            self.assertAlmostEqual(fields[0]["dmax_dbi"], 6.021, places=3)
            self.assertEqual(fields[0]["rad_efficiency"], .5)
            self.assertAlmostEqual(fields[0]["gain_dbi"], 3.010, places=3)
            self.assertEqual(calls[0][5]["center"], [0, 0, 0])
            self.assertFalse(calls[0][5]["read_cached"])
            self.assertEqual(calls[0][5]["radius"], 1.0)
            self.assertNotIn(self.raw, Path(calls[0][5]["outfile"]).parents)
            result.E_norm = [np.zeros((3, 4))]
            with self.assertRaisesRegex(ValueError, "invalid radiation"):
                native_transform(self.raw, port, {"frequencies_hz": [2e9], "theta_step": 90, "phi_step": 90}, self.base / "invalid.h5")

    def test_descriptor_and_hdf5_layout_fail_closed(self):
        for mutate in (lambda d: d["recording"].update(dump_type=8),
                       lambda d: d["recording"].update(e_file="../escape"),
                       lambda d: d.update(phase_center_m=[100, 0, 0]),
                       lambda d: d["network"].update(pacc_w=[None, 1]),
                       lambda d: d["mesh"]["x"].append(0)):
            d = copy.deepcopy(self.d)
            mutate(d)
            with self.assertRaises(ValueError):
                a.validate_descriptor(d)
        path = self.raw / "wrong.h5"
        dump(path)
        with h5py.File(path, "a") as f:
            f["FieldData/TD/00000000"].attrs["d_order"] = "UNKNOWN"
        with self.assertRaisesRegex(ValueError, "vector"):
            a.hdf5_descriptor(path, 0, 1)

    def test_changed_queued_request_refused_before_native_import(self):
        from fairbeam.nf2ff_postprocess import main
        request = self.base / "request.json"
        request.write_bytes(b"{}")
        with patch("fairbeam.nf2ff_postprocess._runtime", side_effect=AssertionError("must not import")):
            with self.assertRaisesRegex(ValueError, "snapshot changed"):
                main(["--request", str(request), "--sha256", "0"*64])

    def queued_transform(self, design_snapshot=False):
        from fairbeam.jobs import JobManager, Job
        self.raw = self.base / "sim/runs/source/model"
        self.raw.mkdir(parents=True)
        source_bytes = a.encode({"model": {"id": "sample"}, "schema": "fairbeam.design/1"}) if design_snapshot else b"saved input"
        self.retain(source_bytes=source_bytes)
        manager = JobManager(self.base / "jobs", self.base, sim_root=self.base / "sim", autostart=False)
        source = Job(manager.root, id="source", model="sample", model_id="sample", status="done", kind="run", bundle=self.parent.name,
            sim_dir=str(self.raw.parent), retain_nf2ff=True, retained_nf2ff={"root": str(self.raw), "sha256": self.sha},
            params={"x": 2}, overrides={"length": "3"})
        source.dir.mkdir()
        if design_snapshot:
            source.input_snapshot = {"format": "design-json-v1", "source_name": "original.design.json",
                                     "model_id": "sample", "sha256": a.digest(source_bytes)}
            (source.dir / "input").mkdir()
            (source.dir / "input/original.design.json").write_bytes(source_bytes)
        source.save()
        manager.jobs[source.id] = source
        job = manager.submit_postprocess(source.id, {"frequencies_hz": [2e9]})
        spec = json.loads((job.dir / "nf2ff-request.json").read_bytes())
        self.assertEqual(Path(spec["output"]), job.dir / "nf2ff-result.json")
        process(self.raw, expected_sha256=self.sha, frequencies=[2e9], output=Path(spec["output"]),
            parent_path=self.parent, _runtime_identity=self.runtime,
            _transform=lambda root, port, request, out: [{"f": 2e9, "port": 3}])
        return manager, source, job, self.base / job.postprocess["output_filename"]

    def test_derivative_retains_independent_admitted_design_snapshot(self):
        manager, source, job, output = self.queued_transform(design_snapshot=True)
        source_path = Path(manager.input_path(source))
        child_path = Path(manager.input_path(job))
        self.assertEqual(child_path.read_bytes(), source_path.read_bytes())
        self.assertNotEqual(child_path, source_path)
        self.assertEqual(job.input_snapshot, source.input_snapshot)
        self.assertIsNot(job.input_snapshot, source.input_snapshot)
        self.assertEqual(job.params, source.params)
        self.assertEqual(job.overrides, source.overrides)
        manager._finish_postprocess(job, 0, [])
        self.assertEqual(job.status, "done")
        source_path.write_bytes(b"later changed source job file")
        self.assertEqual(a.file_digest(Path(manager.input_path(job))), job.input_snapshot["sha256"])
        with self.assertRaisesRegex(ValueError, "input unavailable or changed"):
            manager.submit_postprocess(source.id, {"frequencies_hz": [2e9]})

    def test_cancel_after_child_staging_never_publishes(self):
        from fairbeam.progress import ProgressParser
        manager, source, job, output = self.queued_transform()
        job.status = "running"
        job.proc = object()
        manager._handle(job, ProgressParser(), f"fairbeam: wrote {job.dir / 'nf2ff-result.json'}", "stdout")
        self.assertIsNone(job.bundle)
        self.assertFalse(any(e["type"] == "result" for e in job.events))
        with patch.object(manager, "_terminate"):
            manager.cancel(job.id)
        manager._finish_postprocess(job, 0, [])
        self.assertEqual(job.status, "cancelled")
        self.assertFalse(output.exists())
        self.assertTrue((job.dir / "nf2ff-result.json").exists())
        self.assertIsNone(job.bundle)

    def test_publish_and_terminal_success_are_atomic_against_cancel(self):
        manager, source, job, output = self.queued_transform()
        job.status = "running"
        job.proc = object()
        original_write = a.write_new
        attempted = threading.Event()
        threads, cancelled = [], []
        def cancel():
            attempted.set()
            cancelled.append(manager.cancel(job.id).status)
        def publication(path, data):
            thread = threading.Thread(target=cancel)
            threads.append(thread)
            thread.start()
            self.assertTrue(attempted.wait(2))
            original_write(path, data)
        with patch.object(a, "write_new", side_effect=publication):
            manager._finish_postprocess(job, 0, [])
        for thread in threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(job.status, "done")
        self.assertEqual(cancelled, ["done"])
        self.assertEqual(output.read_bytes(), (job.dir / "nf2ff-result.json").read_bytes())
        self.assertEqual(job.postprocess["result_sha256"], a.file_digest(output))
        self.assertEqual(job.bundle, output.name)

    def test_failed_child_or_mismatched_receipt_never_publishes(self):
        manager, source, job, output = self.queued_transform()
        manager._finish_postprocess(job, 1, ["synthetic child failure"])
        self.assertEqual(job.status, "failed")
        self.assertFalse(output.exists())
        other = manager.submit_postprocess(source.id, {"frequencies_hz": [2e9]})
        staged = json.loads((job.dir / "nf2ff-result.json").read_bytes())
        staged["postprocess"]["parent_sha256"] = "0" * 64
        (other.dir / "nf2ff-result.json").write_bytes(a.encode(staged))
        manager._finish_postprocess(other, 0, [])
        self.assertEqual(other.status, "failed")
        self.assertIn("admitted source", other.error)
        self.assertFalse((self.base / other.postprocess["output_filename"]).exists())

    def test_submission_owns_source_before_delete_can_check_children(self):
        manager, source, completed, output = self.queued_transform()
        manager.cancel(completed.id)
        original_source = manager.retained_source
        admitted, release, deleting = threading.Event(), threading.Event(), threading.Event()
        submitted, failures = [], []
        def admit(job_id):
            value = original_source(job_id)
            admitted.set()
            if not release.wait(2):
                raise AssertionError("test did not release admission")
            return value
        def submit():
            try:
                submitted.append(manager.submit_postprocess(source.id, {"frequencies_hz": [2e9]}))
            except Exception as exc:
                failures.append(("submit", str(exc)))
        def delete():
            deleting.set()
            try:
                manager.delete(source.id)
                failures.append(("delete", "unexpected success"))
            except ValueError as exc:
                failures.append(("delete", str(exc)))
        with patch.object(manager, "retained_source", side_effect=admit):
            first = threading.Thread(target=submit)
            second = threading.Thread(target=delete)
            first.start()
            self.assertTrue(admitted.wait(2))
            second.start()
            self.assertTrue(deleting.wait(2))
            release.set()
            first.join(2)
            second.join(2)
            self.assertFalse(first.is_alive() or second.is_alive())
        self.assertEqual(len(submitted), 1)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0][0], "delete")
        self.assertIn("queued", failures[0][1])
        self.assertTrue(self.raw.exists())


if __name__ == "__main__":
    unittest.main()
