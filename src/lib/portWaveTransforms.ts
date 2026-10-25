/** Kurokawa power waves, exp(+j omega t). No impedance-matrix intermediate:
 * an open S=1 may be valid even when (I-S) and the Z matrix are singular. */
import { cinv } from "../import/touchstone.ts";
export type WaveComplex = [number, number];
const add = (a: WaveComplex, b: WaveComplex): WaveComplex => [a[0] + b[0], a[1] + b[1]];
const mul = (a: WaveComplex, b: WaveComplex): WaveComplex => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const scale = (a: WaveComplex, s: number): WaveComplex => [a[0] * s, a[1] * s];
const product = (a: WaveComplex[][], b: WaveComplex[][]) => a.map(row => b[0].map((_, j) => row.reduce<WaveComplex>((sum, v, k) => add(sum, mul(v, b[k][j])), [0, 0])));

/** Native positive real references -> common complex target with positive real part.
 * a' = A a, b' = B a, so S' = B A^-1. V=√R(a+b), I=(a-b)/√R. */
export function renormalizePowerWaves(s: WaveComplex[][], old: number[], re: number, im: number): WaveComplex[][] {
  const factors = old.map(r => ({ u: Math.sqrt(r) / (2 * Math.sqrt(re)), v: 1 / (2 * Math.sqrt(r) * Math.sqrt(re)) }));
  const a = s.map((row, i) => row.map((v, j) => {
    const { u, v: k } = factors[i];
    return add(mul([u - k * re, -k * im], v), i === j ? [u + k * re, k * im] : [0, 0]);
  }));
  const b = s.map((row, i) => row.map((v, j) => {
    const { u, v: k } = factors[i];
    return add(mul([u + k * re, -k * im], v), i === j ? [u - k * re, k * im] : [0, 0]);
  }));
  return product(b, cinv(a));
}

/** Orthogonal equal-reference wave basis: differential, common, then unpaired.
 * The matching voltage/current references are 2Z, Z/2, Z, respectively. */
export function mixedModeWaves(s: WaveComplex[][], rows: number[][]): WaveComplex[][] {
  return rows.map(a => rows.map(b => a.reduce<WaveComplex>((sum, ai, i) =>
    add(sum, b.reduce<WaveComplex>((inner, bj, j) => add(inner, scale(s[i][j], ai * bj)), [0, 0])), [0, 0])));
}
