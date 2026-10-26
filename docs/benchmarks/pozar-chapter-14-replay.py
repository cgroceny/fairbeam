"""Replay reduced measured samples with NumPy; no Fairbeam import or native run.

This checks the published arithmetic and reported admission metadata. Original
face fields, probe traces and process logs are not distributed: their hashes
identify the contributor's source-pinned raw replay, not an independent replay
by the reader of this reduced export.
"""
from decimal import Decimal
import hashlib
import json
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parent
NAMES = ('n1', 'n2', 'n3', 'n2_time', 'n2_dt', 'n2_domain', 'n2_feed')
LIMITS = dict(pattern=.01, directivity=.01, native_directivity=.02, beamwidth_deg=1.,
              peak_deg=1., power_balance=.05, crosspol=.001, tail_db=-70.,
              change_pattern=.002, change_directivity=.003, change_beamwidth_deg=.2,
              change_power_balance=.02, feed_z_relative=.005)


def same(actual, expected):
    """Check original full-precision report, allowing only roundoff, not gates."""
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys(), (actual.keys(), expected.keys())
        for key, value in expected.items():
            same(actual[key], value)
    elif isinstance(expected, list):
        assert len(actual) == len(expected)
        for first, second in zip(actual, expected):
            same(first, second)
    elif isinstance(expected, float):
        assert np.isclose(actual, expected, rtol=2e-13, atol=2e-13), (actual, expected)
    else:
        assert actual == expected, (actual, expected)


def angular_metrics(p, theta, phi):
    assert p.shape == (91, 36) and np.isfinite(p).all()
    assert p.min() >= 0 and p.max() == 1
    periodic = np.column_stack((p, p[:, 0]))
    azimuth = np.trapezoid(periodic, x=np.deg2rad(np.r_[phi, 360.]), axis=1)
    integral = np.trapezoid(azimuth * np.sin(np.deg2rad(theta)), x=np.deg2rad(theta))
    widths, peaks = [], []
    for cut in p.T:
        k = int(np.argmax(cut))
        peaks.append(float(theta[k]))
        crossings = np.flatnonzero((cut[:-1] - .5) * (cut[1:] - .5) <= 0)
        left, right = crossings[crossings < k], crossings[crossings >= k]
        assert len(left) and len(right)

        def cross(j):
            assert cut[j+1] != cut[j]
            return theta[j] + (.5 - cut[j]) * (theta[j+1] - theta[j]) / (cut[j+1] - cut[j])

        widths.append(float(cross(right[0]) - cross(left[-1])))
    return dict(directivity=float(4*np.pi/integral), hpbw_deg=widths,
                peak_theta_deg=peaks,
                pattern_error_abs=float(abs(p - np.sin(np.deg2rad(theta))[:, None]**2).max()))


def admission(record):
    """Recalculate reported native gates; does not read the original raw files."""
    m, receipt = record['metadata'], record['receipt']
    run, native, op = m['run'], m['native'], m['operator']
    deadline = 2700. if record['name'] == 'n2_dt' else 1800.
    source = ('3d3c7250b46995df717cc3d53d59f51c34ab1435' if deadline == 2700.
              else '2647318c915550c0af617e6c5e054dad6c0dc87b')
    assert record['source_head'] == receipt['driver_head'] == source
    assert receipt['exit_code'] == 0 and receipt['failure'] is None
    assert receipt['deadline_seconds'] == deadline
    assert 0 < max(receipt['wall_seconds'], receipt['monotonic_seconds']) <= deadline
    assert native['cells'] == m['native_cells'] == np.prod(m['grid'])
    assert run['grid'] == m['grid'] and run['timesteps'] == native['timesteps']
    assert 0 < native['timesteps'] < m['max_timesteps']
    assert abs(native['dt_s']/m['declared_dt_s'] - 1) < 1e-8
    assert abs(native['numerical_time_s']/(native['timesteps']*native['dt_s']) - 1) < 1e-8
    assert native['numerical_time_s'] >= m['source_duration_s']
    assert run['converged'] is True and run['hit_timestep_limit'] is False
    energy = [run[k] for k in ('final_energy_db', 'final_energy_bound_db')
              if isinstance(run.get(k), (int, float)) and np.isfinite(run[k])]
    assert energy and max(energy) <= -90. + 1e-7 and m['end_db'] == -90.
    assert 0 < m['declared_dt_s'] <= .8*op['run']['timestep_s']
    assert m['required_usage'] == op['required_usage']
    assert set(m['required_usage']) == set(m['required_properties'])
    assert all(v and all(v) for v in m['required_usage'].values())
    assert m['actual_probe_indices'] == m['expected_probe_indices']
    assert run['engine'] == 'cpu' and run['threads'] == m['threads'] == m['nf2ff_threads'] == 4
    assert run['exact_endcriteria'] is True and m['terminal_tail_db'] <= LIMITS['tail_db']
    assert m['source_trace']['waveform_error_relative'] <= 6e-6
    xml = record['native_input_manifest']
    assert int(xml['fdtd_attributes']['NumberOfTimesteps']) == m['max_timesteps']
    assert float(xml['fdtd_attributes']['endCriteria']) == 1e-9
    assert np.isclose(float(xml['fdtd_attributes']['TimeStep']), m['declared_dt_s'], rtol=6e-6, atol=0)
    assert xml['excitation']['Type'] == '10'
    assert float(xml['grid_attributes']['DeltaUnit']) == .001
    assert set(xml['boundary'].values()) == {'PML_8'}
    for axis, count in zip('xyz', m['grid']):
        actual = np.array(xml['grid_lines_mm'][axis])
        assert len(actual) == count and np.all(np.diff(actual) > 0)
        np.testing.assert_allclose(actual, m['mesh_mm'][axis], rtol=2e-13, atol=2e-13)
    files = record['original_files_sha256']
    assert files['input.xml'] == files['../planned.xml']
    assert files['operator-input.xml'] == op['input_sha256']
    assert len([p for p in files if p.replace('\\', '/').startswith('raw/pattern_')]) == 24
    assert record['runtime']['binding_version'] == '0.37.0rc3'


def point_rows(record, samples, evidence):
    name, m = record['name'], record['metadata']
    p = samples[name + '_normalized_power']
    assert p.shape == (2, 3, 91, 36)
    voltage, current = samples[name + '_v'], samples[name + '_i']
    incident = voltage + m['reference_ohm']*current
    assert abs(incident).max() > 0 and abs(incident).min() >= .02*abs(incident).max()
    accepted = .5*np.real(voltage*np.conj(current))
    impedance = voltage/current
    rows = []
    for box in range(2):
        for k, freq in enumerate(samples['frequency_hz']):
            angular = angular_metrics(p[box, k], samples['theta_deg'], samples['phi_deg'])
            prad = float(samples[name + '_prad_w'][box, k])
            native_d = float(samples[name + '_native_dmax'][box, k])
            peak = float(samples[name + '_peak_power'][box, k])
            assert prad > 0 and native_d > 0 and accepted[k] > 0
            reconstructed = 4*np.pi*.5*peak/np.sqrt(evidence['mue0']/evidence['eps0'])/prad
            row = dict(surface=box, f_hz=float(freq), **angular, native_directivity=native_d,
                       native_reconstruction_relative_error=float(abs(reconstructed/native_d - 1)),
                       power_balance_error=float(prad/accepted[k] - 1), prad_w=prad,
                       pacc_w=float(accepted[k]), crosspol_power=float(samples[name + '_crosspol_power'][box, k]),
                       r_ohm=float(impedance[k].real), x_ohm=float(impedance[k].imag),
                       radiation_resistance_short_approx_ohm=float(20*np.pi**2*(.015*freq/evidence['c0'])**2))
            row['point_passes'] = bool(row['pattern_error_abs'] <= LIMITS['pattern']
                and abs(row['directivity'] - 1.5) <= LIMITS['directivity']
                and abs(native_d - 1.5) <= LIMITS['native_directivity']
                and max(abs(v - 90) for v in row['hpbw_deg']) <= LIMITS['beamwidth_deg']
                and max(abs(v - 90) for v in row['peak_theta_deg']) <= LIMITS['peak_deg']
                and row['crosspol_power'] <= LIMITS['crosspol']
                and abs(row['power_balance_error']) <= LIMITS['power_balance']
                and row['native_reconstruction_relative_error'] <= 1e-4)
            rows.append(row)
    return rows


def difference(first, second, patterns_a, patterns_b):
    dp = float(abs(patterns_b - patterns_a).max())
    dd = max(abs(a['directivity'] - b['directivity']) for a, b in zip(first, second))
    db = max(float(abs(np.array(a['hpbw_deg']) - b['hpbw_deg']).max()) for a, b in zip(first, second))
    de = max(abs(a['power_balance_error'] - b['power_balance_error']) for a, b in zip(first, second))
    return dict(pattern_change_abs=dp, directivity_change=dd, beamwidth_change_deg=db,
                power_balance_change=de, passes=bool(dp <= LIMITS['change_pattern']
                    and dd <= LIMITS['change_directivity'] and db <= LIMITS['change_beamwidth_deg']
                    and de <= LIMITS['change_power_balance']))


def rounded(printed, value):
    number = Decimal(printed.replace(',', ''))
    unit = Decimal(1).scaleb(number.as_tuple().exponent)
    assert abs(number - Decimal(str(value))) <= Decimal('.51')*unit, (printed, value)


def main():
    evidence = json.loads((ROOT / 'pozar-chapter-14-evidence.json').read_text(encoding='utf-8'))
    assert evidence['format'] == 'fairbeam-chapter14-reduced-measurements-v1'
    assert evidence['limits'] == LIMITS
    source = ROOT / 'pozar-chapter-14-samples.npz'
    assert hashlib.sha256(source.read_bytes()).hexdigest() == evidence['measured_sample_sha256']
    original = evidence['original_final_audit']
    assert not evidence['input_impedance_validated'] and not evidence['full_antenna_validated']
    assert tuple(r['name'] for r in evidence['records']) == NAMES
    with np.load(source, allow_pickle=False) as archive:
        samples = dict(archive)
    np.testing.assert_array_equal(samples['frequency_hz'], [9e8, 1e9, 1.1e9])
    np.testing.assert_array_equal(samples['theta_deg'], np.arange(0., 181., 2.))
    np.testing.assert_array_equal(samples['phi_deg'], np.arange(0., 360., 10.))
    assert all(np.isfinite(v).all() for v in samples.values())
    reports, surfaces = {}, []
    for record, expected in zip(evidence['records'], original['strict']['rows']):
        admission(record)
        name = record['name']
        rows = point_rows(record, samples, evidence)
        same(rows, expected['rows'])
        assert all(r['point_passes'] for r in rows)
        reports[name] = rows
        p = samples[name + '_normalized_power']
        surfaces.append(dict(name=name, **difference(rows[:3], rows[3:], p[0], p[1])))
    pairs = []
    for first, second in [('n1', 'n2'), ('n2', 'n3')] + [('n2', n) for n in NAMES[3:]]:
        delta = difference(reports[first], reports[second], samples[first + '_normalized_power'], samples[second + '_normalized_power'])
        if second == 'n2_feed':
            za, zb = [samples[n + '_v']/samples[n + '_i'] for n in (first, second)]
            delta['feed_z_change_relative'] = float((abs(zb - za)/abs(za)).max())
            delta['passes'] &= delta['feed_z_change_relative'] <= LIMITS['feed_z_relative']
        pairs.append(dict(first=first, second=second, **delta))
    same(pairs, original['strict']['changes'])
    same(surfaces, original['strict']['surface_changes'])
    assert len(pairs) == 6 and len(surfaces) == 7 and all(r['passes'] for r in pairs + surfaces)
    counts = [0, 0, 0]
    for line in (ROOT / 'pozar-chapter-14.md').read_text(encoding='utf-8').splitlines():
        if not line.startswith('| n'):
            continue
        cells = [v.strip() for v in line.strip('|').split('|')]
        if ' to ' in cells[0]:
            first, second = cells[0].split(' to ')
            row = next(r for r in pairs if (r['first'], r['second']) == (first, second))
            values = [row[k] for k in ('pattern_change_abs', 'directivity_change', 'beamwidth_change_deg', 'power_balance_change')]
            counts[1] += 1
        else:
            record = next(r for r in evidence['records'] if r['name'] == cells[0])
            m, rows = record['metadata'], reports[cells[0]]
            values = [m['native_cells'], m['native']['dt_s']*1e12]
            if cells[0] in NAMES[:3]:
                values += [max(r['pattern_error_abs'] for r in rows), max(abs(r['directivity'] - 1.5) for r in rows),
                           max(abs(v - 90) for r in rows for v in r['hpbw_deg']), max(abs(r['power_balance_error']) for r in rows)*100]
                counts[0] += 1
            else:
                values += [record['receipt']['wall_seconds'], record['receipt']['deadline_seconds']]
                counts[2] += 1
        assert len(values) == len(cells) - 1
        for text, value in zip(cells[1:], values):
            rounded(text, value)
    assert counts == [3, 6, 4]
    print(json.dumps(dict(numerical_table_rows=13, point_rows=42, mesh_control_verdicts=6,
        surface_verdicts=7, reduced_sample_arithmetic_passes=True, reported_native_admission_passes=True,
        independent_raw_replay=False, input_impedance_validated=False, full_antenna_validated=False,
        native_propagations=0), indent=2))


if __name__ == '__main__':
    main()
