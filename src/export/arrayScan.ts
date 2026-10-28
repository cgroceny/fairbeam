import type { ScanTable } from '../lib/arrayAnalysis.ts';

/** Data columns explicitly identify stored frequency, excitation, baseline and missing metrics. */
export function arrayScanCsv(table: ScanTable): string {
  const ports = table.weights.map(([p]) => p);
  const header = ['frequency_Hz', 'phi_deg', 'theta_deg', 'peak_realized_gain_dBi', 'scan_loss_dB', 'total_efficiency', 'power_unavailable_reason', 'baseline',
    ...ports.map(p => `P${p}_amplitude_dB`), ...ports.map(p => `P${p}_active_reflection_dB`)];
  const rows = table.rows.map(row => [table.frequencyHz, table.phi, row.theta, row.gainDbi, row.scanLossDb, row.totalEfficiency, row.powerReason, table.baseline,
    ...table.weights.map(([, w]) => w.ampDb), ...ports.map(p => row.activeDb.find(([id]) => id === p)?.[1] ?? null)]);
  return [header, ...rows].map(row => row.map(value => value === null ? '' : String(value)).join(',')).join('\n') + '\n';
}
