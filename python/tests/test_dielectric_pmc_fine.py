"""Opt-in PMC meshes 12/16/20 at one clock; preserve the failed old cohort.

From python/, use fresh external paths (a plan writes a protocol):
python -m unittest tests.test_dielectric_pmc_fine -q
python -m tests.test_dielectric_pmc_fine --plan --pilot --mesh 16 --rate-mcps 26 --baseline D:/study/pmc-controls/time --out D:/study/pmc-fine-plan/n16
python -m tests.test_dielectric_pmc_fine --fdtd --pilot --mesh 16 --rate-mcps 26 --baseline D:/study/pmc-controls/time --out D:/study/pmc-fine-pilot/n16
python -m tests.test_dielectric_pmc_fine --fdtd --mesh 16 --rate-mcps 35 --baseline D:/study/pmc-controls/time --out D:/study/pmc-fine/n16
Repeat the two acquisitions for n20 with its own measured conservative rate.
python -m tests.test_dielectric_pmc_fine --compare --baseline D:/study/pmc-controls/time --out D:/study/pmc-fine

Baseline n12 is an admitted completed time control, read by its original
reader. No capture is relabeled. One thread, 45-minute full/10-minute pilot
owned deadlines. No unittest starts fields; open-example flags stay false.
"""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

from tests import dielectric_pmc_fixture as f
from tests import test_dielectric_pmc_controls as controls

FAMILY, NEW_MESHES, DT_S = (12, 16, 20), (16, 20), .285e-12


@contextmanager
def fine_context():
    meshes, dt, identity, launch = f.MESHES, f.DT_S, f.identity, f.popen_group
    def source():
        return {**identity(), 'tests/test_dielectric_pmc_controls.py': f.opened.sha(controls.__file__),
            'tests/test_dielectric_pmc_fine.py': f.opened.sha(__file__)}
    def route(command, **kwargs):
        command[command.index('tests.dielectric_pmc_fixture')] = 'tests.test_dielectric_pmc_fine'
        return launch(command, **kwargs)
    try:
        f.MESHES, f.DT_S, f.identity, f.popen_group = FAMILY, DT_S, source, route
        yield
    finally:
        f.MESHES, f.DT_S, f.identity, f.popen_group = meshes, dt, identity, launch


def read_baseline(path):
    with controls.control_context('time'):
        row = f.analyse(path)
    if row['n'] != FAMILY[0] or not row['completed_pole_control'] or not controls.reference_passes(row):
        raise ValueError('completed reference-passing n12 time control required')
    return row


def mesh_input(path):
    root = ET.parse(path).getroot()
    for parent in root.iter():
        for child in list(parent):
            if child.tag in ('FillColor', 'EdgeColor'):
                parent.remove(child)
    for tag in ('XLines', 'ZLines'):
        node = next(root.iter(tag)); node.text = ''; node.set('Qty', '0')
    return ET.tostring(root)


def prepare(out, baseline, n, rate, pilot=False):
    if isinstance(n, bool) or not isinstance(n, int) or n not in NEW_MESHES:
        raise ValueError('new fine mesh 16 or 20 required')
    out, baseline = Path(out).resolve(), Path(baseline).resolve()
    side = out.with_name(out.name+'-protocol')
    if out.exists() or side.exists() or out.is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('fresh external capture and protocol required')
    cap, limit = (90e-9, 600) if pilot else (f.CAP_S, 2700)
    with fine_context():
        sim, meta = f.build(n, cap); reference, ref = f.build(FAMILY[0], cap)
        estimate, source = f.forecast(meta, rate), f.identity()
    if estimate > limit:
        raise ValueError('fine-mesh budget exceeded; defer before launch')
    read_baseline(baseline)
    side.mkdir(parents=True)
    with fine_context():
        original, _ = f.build(FAMILY[0]); original.fdtd.Write2XML(str(side/'baseline-full.xml'))
    prior = json.loads((baseline/'field/report.json').read_text())
    if f.physics_sha(side/'baseline-full.xml') != prior['physics_sha256']:
        raise ValueError('baseline native input not reproduced at the common clock')
    reference.fdtd.Write2XML(str(side/'reference.xml')); sim.fdtd.Write2XML(str(side/'control.xml'))
    if mesh_input(side/'reference.xml') != mesh_input(side/'control.xml'):
        raise ValueError('mesh changed source, physical geometry, material, clock or boundary')
    # The dual-plane sum at n16 differs from n12 by floating-point roundoff (mm).
    if abs(meta['magnetic_wall_radius_mm']-ref['magnetic_wall_radius_mm']) > 1e-12:
        raise ValueError('physical magnetic-wall radius changed')
    for key in ('reference','declared_dt_s','angular','clearance_mm',
                'axial_pml_cells','axial_pml_width_mm','source_duration_s','windows_s'):
        if meta[key] != ref[key]:
            raise ValueError('fine family physical parameters differ')
    protocol = dict(mesh=n, baseline=str(baseline),
        baseline_admission_sha256=f.opened.sha(baseline/'admission.json'),
        baseline_report_sha256=f.opened.sha(baseline/'field/report.json'),
        source=source, runtime=f.runtime_identity(), input_physics_sha256=f.physics_sha(side/'control.xml'),
        cap_s=cap, pilot_only=pilot, native_cells=meta['native_cells'], declared_dt_s=DT_S,
        estimated_seconds=estimate, deadline_seconds=limit, qualified=False)
    f.save(side/'protocol.json', protocol)
    return protocol


def worker(out, n, cap, setup):
    out = Path(out).resolve(); side = out.parent.with_name(out.parent.name+'-protocol')
    protocol = json.loads((side/'protocol.json').read_text())
    if protocol['mesh'] != n or n not in NEW_MESHES or protocol['cap_s'] != cap:
        raise ValueError('wrong fine mesh or acquisition window')
    with fine_context():
        build = f.build
        def guarded_model(mesh, cap_s):
            sim, meta = build(mesh, cap_s); run = sim.run
            meta['fine_protocol_sha256'] = f.opened.sha(side/'protocol.json')
            def checked_run(path, *args, **kwargs):
                if f.identity() != protocol['source'] or f.runtime_identity() != protocol['runtime']:
                    raise ValueError('fine source/runtime changed before propagation')
                before = out/'before-native.xml'; sim.fdtd.Write2XML(str(before))
                if f.physics_sha(before) != protocol['input_physics_sha256']:
                    raise ValueError('fine native input changed before propagation')
                return run(path, *args, **kwargs)
            sim.run = checked_run
            return sim, meta
        try:
            f.build = guarded_model
            return f.worker(out, n, cap, setup=setup)
        finally:
            f.build = build


def family_result(rows, missing=(), rejected=()):
    changes = [dict(f_rel=abs(b['f_hz']/a['f_hz']-1), q_rel=abs(b['q']/a['q']-1))
        for a,b in zip(rows,rows[1:])] if len(rows) == 3 else []
    passed = bool(not missing and not rejected and tuple(row['n'] for row in rows) == FAMILY
        and all(row['completed_pole_control'] and controls.reference_passes(row) for row in rows)
        and len(changes) == 2 and all(row['f_rel'] <= f.GATES['f_mesh']
            and row['q_rel'] <= f.GATES['q_mesh'] for row in changes)
        and all(changes[1][key] <= changes[0][key] for key in ('f_rel','q_rel')))
    return dict(meshes=rows, changes=changes, missing=list(missing), rejected=list(rejected),
        fine_mesh_and_reference_pass=passed, qualified=False, open_example_qualified=False,
        limitation='Separate fixed-clock fine family; old n8 reference failure and open-model qualification are unchanged.')


def compare(out, baseline):
    out, baseline = Path(out).resolve(), Path(baseline).resolve()
    rows, missing, rejected = [read_baseline(baseline)], [], []
    for n in NEW_MESHES:
        folder = out/f'n{n}'; side = folder.with_name(folder.name+'-protocol')
        if not (folder/'admission.json').is_file():
            missing.append(n); continue
        try:
            protocol = json.loads((side/'protocol.json').read_text())
            if (protocol['mesh'] != n or protocol['baseline'] != str(baseline) or protocol['pilot_only']
                    or protocol['baseline_admission_sha256'] != f.opened.sha(baseline/'admission.json')
                    or protocol['baseline_report_sha256'] != f.opened.sha(baseline/'field/report.json')):
                raise ValueError('mixed baseline, mesh or pilot evidence')
            with fine_context():
                if f.identity() != protocol['source'] or f.runtime_identity() != protocol['runtime']:
                    raise ValueError('fine protocol source/runtime changed')
                meta = json.loads((folder/'field/report.json').read_text())
                if meta.get('fine_protocol_sha256') != f.opened.sha(side/'protocol.json'):
                    raise ValueError('fine protocol changed after acquisition')
                row = f.analyse(folder)
            if row['n'] != n or not row['completed_pole_control']:
                raise ValueError('fine pole quality admission failed')
            rows.append(row)
        except (ValueError, OSError, KeyError) as exc:
            rejected.append(dict(n=n, reason=str(exc)))
    return family_result(rows, missing, rejected)


class FineFamily(unittest.TestCase):
    def test_defaults_and_old_source_are_unchanged_even_after_an_exception(self):
        before = f.MESHES, f.DT_S, f.identity(), f.popen_group
        with tempfile.TemporaryDirectory() as temp:
            inputs = []
            for n in f.MESHES:
                sim, meta = f.build(n); path = Path(temp)/f'before{n}.xml'; sim.fdtd.Write2XML(str(path))
                inputs.append((n,meta,f.physics_sha(path)))
            with self.assertRaises(ValueError):
                with fine_context():
                    f.build(20); f.build(8)
            self.assertEqual((f.MESHES,f.DT_S,f.identity(),f.popen_group),before)
            for n,meta,digest in inputs:
                sim,again=f.build(n); path=Path(temp)/f'after{n}.xml'; sim.fdtd.Write2XML(str(path))
                self.assertEqual(meta,again); self.assertEqual(digest,f.physics_sha(path))
        with self.assertRaises(ValueError): f.build(20)

    def test_fine_mesh_changes_only_grid_with_common_clock_and_physical_wall(self):
        with tempfile.TemporaryDirectory() as temp, fine_context():
            previous=0; xml=[]
            for n in FAMILY:
                sim,meta=f.build(n);path=Path(temp)/f'n{n}.xml';sim.fdtd.Write2XML(str(path));xml.append(mesh_input(path))
                self.assertEqual(meta['declared_dt_s'],DT_S);self.assertGreater(meta['native_cells'],previous)
                self.assertAlmostEqual(meta['magnetic_wall_radius_mm'],f.opened.RADIUS_MM,places=13)
                previous=meta['native_cells']
            self.assertEqual(xml[0],xml[1]);self.assertEqual(xml[1],xml[2])

    def test_existing_time_input_is_reproduced_without_relabeling_it(self):
        with tempfile.TemporaryDirectory() as temp:
            paths=[Path(temp)/name for name in ('original.xml','fine.xml')]
            with controls.control_context('time'): sim,_=f.build(12);sim.fdtd.Write2XML(str(paths[0]))
            with fine_context(): sim,_=f.build(12);sim.fdtd.Write2XML(str(paths[1]))
            self.assertEqual(f.physics_sha(paths[0]),f.physics_sha(paths[1]))

    def test_wall_roundoff_does_not_reject_the_same_physical_radius(self):
        with tempfile.TemporaryDirectory() as temp:
            baseline=Path(temp)/'baseline';(baseline/'field').mkdir(parents=True)
            with controls.control_context('time'):
                sim,_=f.build(12);sim.fdtd.Write2XML(str(baseline/'field/input.xml'))
            f.save(baseline/'field/report.json',dict(physics_sha256=f.physics_sha(baseline/'field/input.xml')))
            f.save(baseline/'admission.json',{})
            for label, path in (('plain', baseline), ('parent', baseline/'..'/'baseline')):
                with self.subTest(path=label), patch(__name__+'.read_baseline') as read,patch.object(f,'run_owned') as launch:
                    result=prepare(Path(temp)/label,path,16,100.)
                    # prepare resolves aliases, including Windows short temporary paths.
                    read.assert_called_once_with(baseline.resolve());launch.assert_not_called()
                    self.assertEqual(result['declared_dt_s'],DT_S)
                    self.assertFalse(result['qualified'])

    def test_owned_command_records_the_actual_fine_module(self):
        command=['python','-m','tests.dielectric_pmc_fixture','--worker','field','--mesh','20']
        with patch.object(f,'popen_group',return_value=Mock(pid=123)) as launch:
            with fine_context(): f.popen_group(command)
            self.assertIs(launch.call_args.args[0],command)
            self.assertEqual(command[2],'tests.test_dielectric_pmc_fine');self.assertEqual(command[-2:],['--mesh','20'])

    def test_overbudget_and_invalid_mesh_refuse_before_files_or_baseline(self):
        with tempfile.TemporaryDirectory() as temp, patch(__name__+'.read_baseline') as read:
            out=Path(temp)/'fresh'
            for n in (True,12,20.,24):
                with self.assertRaises(ValueError): prepare(out,Path(temp)/'missing',n,100.)
            with self.assertRaisesRegex(ValueError,'defer'): prepare(out,Path(temp)/'missing',20,.001)
            read.assert_not_called();self.assertFalse(out.exists());self.assertFalse(out.with_name('fresh-protocol').exists())

    def test_missing_and_failed_reference_or_nonshrinking_changes_do_not_pass(self):
        rows=[dict(n=n,f_hz=h,q=q,completed_pole_control=True,f_reference_rel=.0001,q_reference_rel=.0001)
            for n,h,q in ((12,3.15e9,1000.),(16,3.151e9,1001.),(20,3.1512e9,1001.2))]
        self.assertTrue(family_result(rows)['fine_mesh_and_reference_pass'])
        for changed in (dict(q_reference_rel=.03),dict(completed_pole_control=False),dict(q=1003.)):
            bad=[dict(row) for row in rows];bad[-1].update(changed)
            self.assertFalse(family_result(bad)['fine_mesh_and_reference_pass'])
        with tempfile.TemporaryDirectory() as temp, patch(__name__+'.read_baseline',return_value=rows[0]):
            result=compare(temp,Path(temp)/'baseline')
        self.assertEqual(result['missing'],[16,20]);self.assertFalse(result['fine_mesh_and_reference_pass'])
        self.assertFalse(result['qualified']);self.assertFalse(result['open_example_qualified'])

    def test_worker_rejects_changed_runtime_before_propagation(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)/'n16/field';side=Path(temp)/'n16-protocol';side.mkdir()
            with fine_context(): source=f.identity()
            f.save(side/'protocol.json',dict(mesh=16,cap_s=f.CAP_S,source=source,runtime={},input_physics_sha256='0'*64))
            def acquisition(folder,n,cap,setup):
                folder.mkdir(parents=True);sim,_=f.build(n,cap);sim.run(str(folder/'raw'))
            with patch.object(f,'worker',side_effect=acquisition),patch.object(f.opened.ResonatorSimulation,'run') as native:
                with self.assertRaisesRegex(ValueError,'source/runtime changed'):worker(out,16,f.CAP_S,False)
                native.assert_not_called()


def main():
    p=argparse.ArgumentParser(description=__doc__);action=p.add_mutually_exclusive_group(required=True)
    for flag in ('plan','fdtd','compare'):action.add_argument('--'+flag,action='store_true')
    action.add_argument('--worker',choices=('setup','field'))
    p.add_argument('--mesh',type=int,choices=NEW_MESHES,default=16);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--baseline',type=Path);p.add_argument('--pilot',action='store_true');p.add_argument('--rate-mcps',type=float,default=10.)
    p.add_argument('--cap-ns',type=float,default=1000.,help=argparse.SUPPRESS);a=p.parse_args()
    if a.worker:worker(a.out,a.mesh,a.cap_ns/1e9,a.worker=='setup');return
    if a.baseline is None:p.error('--baseline required')
    if a.compare:result=compare(a.out,a.baseline)
    else:
        result=prepare(a.out,a.baseline,a.mesh,a.rate_mcps,a.pilot)
        if a.fdtd:
            with fine_context():result=f.acquire_serial(a.out,a.mesh,a.rate_mcps,a.pilot)
    print(json.dumps(result,indent=2,allow_nan=False))


if __name__=='__main__':
    if any('--'+flag in sys.argv for flag in ('plan','fdtd','compare','worker')):main()
    else:unittest.main()
