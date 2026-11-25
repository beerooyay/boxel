import test from 'node:test';
import assert from 'node:assert/strict';
import { groundAtlas } from '../demo/valley-light.js';
import { cameraJitter } from '../demo/temporal.js';

test('an open grade keeps its sky, including the edge of the atlas', () => {
  const height = (x, z) => 0.4 * x - 0.2 * z;
  const { data, heightRange: [min, span] } = groundAtlas(32, 16, height, () => 0.7, () => {});
  const decode = byte => min + span * byte / 255;
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const i = 3 * (32 * z + x);
    assert.equal(data[i], 0);
    assert.ok(Math.abs(decode(data[i + 1]) - height(x * 0.5 - 7.75, z * 0.5 - 7.75)) <= span / 510 + 1e-6);
    assert.ok(Math.abs(decode(data[i + 2]) - 0.7) <= span / 510);
  }
});

test('a boulder shelters its neighbours and leaves the ground intact', () => {
  const { data } = groundAtlas(64, 32, () => 2, () => 2, stamp => stamp(0, 2, 0, 3, 2, 1, Math.PI / 2));
  const occlusion = (x, z) => data[3 * ((32 + 2 * z) * 64 + 32 + 2 * x)];
  assert.ok(occlusion(1, 0) > occlusion(4, 0));
  assert.ok(occlusion(0, 2) > occlusion(2, 0));
  assert.equal(occlusion(8, 0), 0);
  for (let i = 1; i < data.length; i += 3) assert.equal(data[i], 0);
});

test('temporal sampling is centred over a cycle and restarts on camera cuts', () => {
  const eye = [1, 2, 3], forward = [0, 0, -1];
  const next = (previous, e = eye, direction = forward, t = 1) => cameraJitter(previous, e, direction, t, 100, 200);
  const previous = { eye, forward, time: 1, phase: -1 }, offsets = [];
  for (let k = 0; k < 8; k++) {
    const { phase, offset } = next(previous);
    offsets.push(offset);
    previous.phase = phase;
  }
  assert.equal(new Set(offsets.map(v => v.join())).size, 8);
  for (let axis = 0; axis < 2; axis++)
    assert.ok(Math.abs(offsets.reduce((sum, v) => sum + v[axis], 0)) < 1e-9);
  const cuts = [next(null), next(previous, [3, 2, 3]), next(previous, eye, [1, 0, 0]),
    next(previous, eye, forward, 2), next(previous, eye, forward, 0)];
  for (const cut of cuts) assert.deepEqual(cut, { phase: -1, offset: [0, 0] });
});
