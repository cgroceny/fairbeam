import assert from 'node:assert/strict';
import { instantaneousMagnitude, padMaskEdge, smoothCurrentMap } from '../src/scene/currentAnimation.ts';

const mag = instantaneousMagnitude([1, 1], [127, 0, 0, 0, 0, 127, 0, 0], 0);
assert.deepEqual([...mag], [1000, 0]);
assert.deepEqual([...instantaneousMagnitude([1], [0, 127, 0, 0], 90)], [1000]);
assert(Math.abs(instantaneousMagnitude([1], [0, 64, 0, 0], 90)[0] - 64 * 1000 / 127) < 0.001);
assert.deepEqual([...instantaneousMagnitude([1], [127, 0, 0, 0], 90)], [0]);
assert.deepEqual([...instantaneousMagnitude([-1, 1], [0, 0, 0, 0, 127, 0, 0, 0], 0)], [-1, 1000]);
const up = smoothCurrentMap([10, -1, 30, 40], 2, 2, 2);
assert.equal(up.length, 16);
assert(up.every(Number.isFinite));
assert(up.some((v) => v === -1));
assert(up.filter((v) => v >= 0).every((v) => v >= 10 && v <= 40));
const edge = smoothCurrentMap([1000, -1, 0, -1], 2, 2, 2);
assert.equal(edge[1], 1000); // invalid neighbour contributes neither value nor opacity
assert.equal(edge[3], -1);
assert.deepEqual([...edge.slice(2, 4)], [-1, -1]); // no upsampled colour in the invalid source cell
const phasedEdge = smoothCurrentMap(instantaneousMagnitude(
  [1000, -1, 0, -1], [127, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0
), 2, 2, 2);
assert.deepEqual([...phasedEdge.slice(0, 4)], [1000, 1000, -1, -1]);
// a transparent texel beside the metal takes the neighbour's colour (no dark rim under linear
// filtering) and stays transparent; a texel with no opaque neighbour keeps black
const tex = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
padMaskEdge(tex, 3, 1);
assert.deepEqual([...tex], [10, 20, 30, 255, 10, 20, 30, 0, 0, 0, 0, 0]);
console.log('current-animation checks passed');
