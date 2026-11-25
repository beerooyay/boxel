import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeWalks, riverFlow, riverX, spring, terrainHeight, trail, trailCover, trailDistance, valleyWalks, waterLevel } from '../demo/landmarks.js';

test('the full tread of every valley walk survives spatial bin boundaries', () => {
  for (const route of [trail, ...Object.values(valleyWalks), ...Object.values(rangeWalks)]) {
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

test('outer treads stay below walking grade and meet at the same elevation', () => {
  for (const [name, route] of Object.entries(rangeWalks)) {
    for (let i = 1; i < route.length; i++) {
      const [x, z, y] = route[i - 1], [tx, tz, ty] = route[i], length = Math.hypot(tx - x, tz - z);
      assert.ok(Math.abs(ty - y) / length < 0.80, name);
      const steps = Math.ceil(length * 4);
      for (let j = 0; j <= steps; j++) {
        const u = j / steps, px = x + (tx - x) * u, pz = z + (tz - z) * u;
        if (Math.max(Math.abs(px), Math.abs(pz)) < 65) continue;
        const h = terrainHeight(px, pz, 24);
        assert.ok(h > waterLevel(px, pz) - 1.25, name);
        // The spring shore cuts into the tread where it approaches the water.
        if (Math.hypot(px - spring.x, pz - spring.z) > 33) assert.ok(Math.abs(h - (y + u * (ty - y))) < 0.01, name);
      }
    }
  }
  assert.deepEqual(rangeWalks.west.at(-1), rangeWalks.headwaters.at(-1));
  assert.deepEqual(rangeWalks.south.at(-1), rangeWalks.west[3]);
  assert.deepEqual(rangeWalks.east.at(-1), rangeWalks.south[3]);
});

test('the spring has a still surface and drains continuously to the original river', () => {
  assert.equal(waterLevel(spring.x, spring.z), spring.level);
  assert.ok(terrainHeight(spring.x, spring.z, 15) < spring.level - 1.25);
  assert.equal(riverFlow(spring.z, spring.level), 0);
  let last = spring.level;
  for (let z = spring.z; z <= -60; z += 0.1) {
    const x = riverX(z), level = waterLevel(x, z);
    assert.ok(level <= last + 1e-8 && last - level < 0.015);
    assert.ok(terrainHeight(x, z, 22) < level);
    last = level;
  }
  assert.equal(riverFlow(-60, last), 1);
  assert.equal(riverFlow(0, 0), 0);
});
