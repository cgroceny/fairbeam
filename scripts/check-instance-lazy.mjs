// Real Solid owner/resource lifecycle, without a DOM, renderer or native server.
import assert from 'node:assert/strict';
import { createRoot } from 'solid-js';
import { instanceLazy } from '../src/lib/instanceLazy.ts';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function mount(Component, name) {
  let dispose, value;
  createRoot(stop => { dispose = stop; value = Component({ name }); });
  return { dispose, read: () => typeof value === 'function' ? value() : value };
}
for (const departing of [0, 1]) {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const Component = instanceLazy(() => pending);
  const roots = [mount(Component, 'design'), mount(Component, 'results')];
  assert.equal(roots[0].read(), ''); assert.equal(roots[1].read(), '');
  roots[departing].dispose();
  resolve({ default: props => props.name });
  await flush();
  assert.equal(roots[1 - departing].read(), departing === 0 ? 'results' : 'design', 'Pending surviving workspace must finish mounting');
  roots[1 - departing].dispose();
  const later = mount(Component, 'reopened');
  await flush(); assert.equal(later.read(), 'reopened', 'Resolved module remounts after both owners retire');
  later.dispose();
}
const fast = instanceLazy(() => Promise.resolve({ default: props => props.name }));
const a = mount(fast, 'A'); await flush();
const b = mount(fast, 'B'); await flush(); a.dispose();
assert.equal(b.read(), 'B', 'Retiring resolved owner cannot clear another mount'); b.dispose();
console.log('instance-lazy: pending transitions both directions, resolved-owner disposal and remount passed');
