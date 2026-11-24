import test from 'node:test';
import assert from 'node:assert/strict';
import { BrushField } from '../demo/brush.js';

function sample(field, x, z) {
  const ix = Math.floor(x * 4) & 31, iz = Math.floor(z * 4) & 31;
  return Array.from(field.bytes.subarray(4 * (32 * iz + ix), 4 * (32 * iz + ix + 1)));
}

test('a stationary foot compresses the centre, parts both sides and settles', () => {
  const field = new BrushField();
  for (let i = 0; i < 90; i++) field.advance(-0.125, 6, 0.125, 1 / 30);
  const centre = sample(field, -0.125, 0.125);
  assert.equal(centre[3], 255);
  assert.ok(Math.abs(48 * centre[2] / centre[3] - 8 - 6) < 0.12);
  assert.ok(sample(field, -0.375, 0.125)[0] < 100);
  assert.ok(sample(field, 0.125, 0.125)[0] > 156);
  field.dirty = false;
  field.advance(-0.125, 6, 0.125, 1 / 30);
  assert.equal(field.dirty, false);
});

test('a moving footprint and its recovery agree at 24, 60 and 120 Hz across the wrap', () => {
  function replay(hz) {
    const field = new BrushField();
    field.advance(7.3, 1, -0.125, 0);
    for (let i = 1; i <= hz; i++) field.advance(7.3 + 1.9 * i / hz, 1, -0.125, 1 / hz);
    assert.ok(sample(field, 8.125, -0.125)[3] > 0);
    const walking = field.bytes.slice();
    for (let i = 0; i < 2 * hz; i++) field.advance(9.2, 1, -0.125, 1 / hz);
    assert.deepEqual(sample(field, 8.125, -0.125), [128, 128, 0, 0]);
    field.advance(17.2, 10, -0.125, 1 / hz);
    assert.deepEqual(sample(field, 8.125, -0.125), [128, 128, 0, 0]);
    return walking;
  }
  assert.deepEqual(replay(24), replay(60));
  assert.deepEqual(replay(60), replay(120));
});
