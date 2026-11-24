import test from 'node:test';
import assert from 'node:assert/strict';
import { riverX, terrainHeight, trail, trailCover, trailDistance, valleyWalks, waterLevel } from '../demo/landmarks.js';

test('the full tread of every valley walk survives spatial bin boundaries', () => {
  for (const route of [trail, ...Object.values(valleyWalks)]) {
    for (let i = 1; i < route.length; i++) {
      const [x, z] = route[i - 1], dx = route[i][0] - x, dz = route[i][1] - z;
      const length = Math.hypot(dx, dz), steps = Math.ceil(length / 0.25);
      for (let j = 0; j <= steps; j++) {
        const cx = x + dx * j / steps, cz = z + dz * j / steps;
        assert.ok(trailDistance(cx, cz) < 1e-8);
        for (const side of [-0.5, 0.5]) assert.equal(trailCover(cx - side * dz / length, cz + side * dx / length), 1);
      }
    }
  }
});

test('both banks of the shallow ford stay below the uphill walking limit', () => {
  const z = -25, x = riverX(z);
  const height = offset => terrainHeight(x + offset, z, 4);
  assert.ok(Math.abs(waterLevel(x, z) - height(0) - 0.32) < 1e-8);
  let previous = height(-4);
  for (let i = 1; i <= 80; i++) {
    const next = height(-4 + i * 0.1);
    assert.ok(Math.abs(next - previous) / 0.1 < 0.65);
    previous = next;
  }
});
