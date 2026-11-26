import assert from 'node:assert/strict';
import test from 'node:test';
import { seatStone, stoneSpacing } from '../demo/stone-bed.js';

test('the stone seat follows a tilted tread at either yaw and rejects an unsupported lip', () => {
  const ground = (x, z) => 1 + 0.32 * x - 0.16 * z;
  for (const yaw of [0, 0.77, 2.41]) {
    const { gx, gz, y } = seatStone(ground, 0, 0, 0.8, 0.6, 0.45, yaw, 0);
    assert.ok(Math.abs(gx - 0.32) < 1e-10 && Math.abs(gz + 0.16) < 1e-10);
    assert.ok(y > 1 && y < 1.2);
  }
  assert.equal(
    seatStone((x, z) => (x > 0.35 && z > 0.35 ? -1 : 0), 0, 0, 1, 0.6, 1, 0, 0),
    null,
  );
  assert.equal(
    seatStone((x) => 2 * x, 0, 0, 0.1, 0.08, 0.09, 0, 3),
    null,
  );
});

test('elongated stones can sit side by side but cannot cross between bins', () => {
  const reserve = stoneSpacing();
  assert.ok(reserve(3.55, 4, 1.1, 0.31, 0));
  assert.equal(reserve(4.2, 4, 0.25, 0.31, 0), false);
  assert.ok(reserve(3.55, 4.72, 1.1, 0.31, 0));
});
