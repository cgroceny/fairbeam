# Import fixtures

Test files for the reference-data importer (`src/import/*`, checked by `npm run check:import`, which
`npm run check:exports` also runs). They are written by `scripts/gen-import-fixtures.mjs`.

The data is the committed patch antenna (`public/projects/patch-antenna.json`) with the frequency
scaled by **+1 %**, so the comparison metrics have known answers (about +1 % resonance shift).

| File | Format |
| --- | --- |
| `patch_75ohm.s1p` | Touchstone v1 `# MHz S DB R 75` (renormalised to the project's 50 Ω on import) |
| `array2x1_synthetic.s2p` | Touchstone v1 2-port `# GHz S MA R 50`, S11 S21 S12 S22 order (synthetic array data) |
| `patch_generic_semicolon.csv` | generic CSV `Frequency (GHz);S11 (dB)` with decimal commas |

`csv/` holds small hand-written CSV / text tables (not written by the generator script) for the
column-header parsing in `src/import/curves.ts` and `src/import/text.ts`. Every file holds the same
two samples, S11 = 0.1 + j0.2 at 2.0 GHz (−13.0103 dB, 63.4349°) and 0.2 + j0.3 at 2.1 GHz, so each
must import as the same complex S11:

| File | Format |
| --- | --- |
| `csv/s11_comma_re_im.csv` | plain comma CSV `Frequency (GHz),S11 Real,S11 Imaginary` |
| `csv/s11_quoted_re_im_crlf.csv` | fully quoted CSV with commas and doubled quotes inside names (`"S1,1 ""meas, run 2"" [Imaginary Part]"`), quoted numbers, CRLF |
| `csv/s11_semicolon_db_phase.csv` | European CSV `Freq [MHz];\|S11\| (dB);S11 Phase (deg)` with decimal commas |
| `csv/s11_s21_tab_re_im.txt` | tab separated `# f (GHz)  Re(S11)  Im(S11)  S21_re  S21_im`: one complex curve per S-parameter, S11 used |
| `csv/s11_comma_mag_rad.csv` | `Frequency [Hz],S11 Magnitude,S11 Phase [rad]`: linear magnitude, phase in radians |

`touchstone/` holds small hand-written Touchstone files (not written by the generator script) for
the two Touchstone readers, `src/import/touchstone.ts` and `python/fairbeam/touchstone.py`. Both
check every file against `touchstone/expected.json`, whose values come from closed forms: Y/Z
files of known networks (matched load, series and shunt resistors), v1 noise blocks, Touchstone 2
keywords (12_21 order, Lower/Upper matrices, per-port `[Reference]`, `[Noise Data]`, `[End]`),
RI/MA/DB, Hz…GHz, comments, continuation lines, CRLF, a missing option line, and the files that
must be refused (H/G parameters, frequencies that go back).
