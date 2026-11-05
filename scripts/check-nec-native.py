"""Opt-in native NEC2++ adapter cohort. No download or automatic retry."""
import argparse
import json
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from fairbeam.nec import C0, dipole, solve, optimize_dipole

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--solver', required=True, type=Path)
p.add_argument('--out', required=True, type=Path)
args = p.parse_args()
args.out.mkdir(parents=True, exist_ok=False)
rows = []
for n in (31, 61, 121):
    run = solve(dipole(C0 / 600000, .05, n, [.3]), args.out / f'segments-{n}', args.solver,
                pattern=True, timeout=30)
    s = run['samples'][0]
    assert len(s['pattern']) == 703
    assert abs(complex(*s['s11'])) <= 1 + 1e-9
    assert 2.0 <= s['sampled_peak_gain_dbi'] <= 2.3
    for theta in range(10, 180, 10):
        gains = [r['gain_dbi'] for r in s['pattern'] if r['theta_deg'] == theta]
        assert all(v is not None for v in gains)
        assert max(gains) - min(gains) <= .02
    rows.append({'segments': n, 'impedance_ohm': s['impedance_ohm'],
                 'sampled_peak_gain_dbi': s['sampled_peak_gain_dbi'], 'wall_time_s': run['wall_time_s']})
z = [complex(*r['impedance_ohm']) for r in rows]
changes = [abs(b-a)/abs(b) for a, b in zip(z, z[1:])]
assert changes[-1] <= .02 and changes[-1] < changes[0], changes
search = optimize_dipole((450, 520), .05, 61, .3, args.out / 'search', args.solver,
                         max_evals=12, timeout=300)
assert search['state'] == 'completed' and 1 <= len(search['evaluations']) <= 12
best = search['result']['best']
assert best and math.isfinite(best['metrics']['s11_at']['0.3'])
assert 450 <= best['params']['length_mm'] <= 520
summary = {'cases': rows, 'relative_impedance_changes': changes,
           'search_reason': search['result']['reason'], 'best': best,
           'scope': 'synthetic dipole segmentation and adapter smoke; not general physical validation'}
(args.out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print(json.dumps(summary, indent=2))
