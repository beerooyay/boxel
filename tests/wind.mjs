import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { load } from '../ffi/boxel.js';
import { createWind, windDirection } from '../demo/wind.js';

test('a gust travels downwind, shelters behind a ridge and evolves in storms', async () => {
  const boxel = await load(await readFile(new URL('../demo/boxel.wasm', import.meta.url)));
  const plain = createWind(boxel, () => 0);
  const ridge = createWind(boxel, (x) => 19 * Math.exp(-((x + 8) ** 2) / 36));
  try {
    const peak = Math.max(...plain.bytes.filter((_, i) => i % 4 === 1));
    assert.ok(peak > 90);
    const before = plain.sample(11, -13);
    plain.update(0.25, 0);
    assert.ok(
      Math.abs(plain.sample(11 + plain.travel * windDirection[0], -13 + plain.travel * windDirection[1]) - before) <
        1e-6,
    );
    const centre = 4 * (32 * 64 + 32) + 2;
    assert.ok(ridge.bytes[centre] < 0.65 * plain.bytes[centre]);
    const initial = new Uint8Array(ridge.bytes);
    for (let i = 0; i < 180; i++) ridge.update(0.8, (i % 17) / 16);
    assert.notDeepEqual(ridge.bytes, initial);
    assert.equal(ridge.stats().violations, 0);
    assert.ok(ridge.stats().bound <= 1 / 255);
  } finally {
    plain.free();
    ridge.free();
  }
});

test('a passing front keeps open meadow patches moving smoothly between field updates', async () => {
  const boxel = await load(await readFile(new URL('../demo/boxel.wasm', import.meta.url)));
  const wind = createWind(boxel, () => 0);
  try {
    const patches = [];
    for (const x of [-32, 0, 32]) {
      for (const z of [-32, 0, 32]) {
        const initial = wind.sample(x, z);
        patches.push({ x, z, low: initial, high: initial, previous: initial });
      }
    }
    for (let frame = 0; frame < 5400; frame++) {
      wind.update(1 / 60, 0);
      for (const p of patches) {
        const value = wind.sample(p.x, p.z);
        assert.ok(Math.abs(value - p.previous) < 0.12, 'discontinuous change in wind load');
        p.previous = value;
        p.low = Math.min(p.low, value);
        p.high = Math.max(p.high, value);
      }
    }
    assert.ok(patches.some(p => p.high - p.low > 0.3) && patches.every(p => p.low < 0.15), 'a meadow patch held still through the front');
  } finally {
    wind.free();
  }
});
