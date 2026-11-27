import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { load } from '../ffi/boxel.js';
import { createWeather, liftingLevel, WEATHER_SIZE, WEATHER_TILE } from '../demo/weather.js';
import { createClouds } from '../demo/clouds.js';

test('warmer unsaturated air has a higher lifting level, and moist air condenses sooner', () => {
  assert.equal(liftingLevel(24, 1), 0);
  assert.ok(liftingLevel(24, 0.85) < liftingLevel(24, 0.68));
  assert.ok(liftingLevel(24, 0.85) > liftingLevel(12, 0.85));
  assert.ok(liftingLevel(24, 0.835) > 300 && liftingLevel(24, 0.835) < 410);
});

test('the cloud-water field stays below the dense reference and encloses its filtered footprints', async () => {
  const boxel = await load(await readFile(new URL('../demo/boxel.wasm', import.meta.url)));
  const sources = [[-6, 8, 1], [-18, -99, 0.55]];
  const sparse = createWeather(boxel, { sources }), dense = createWeather(boxel, { sources, dense: true });
  const size = WEATHER_SIZE, half = size / 2, mask = size - 1;
  try {
    for (let tick = 0; tick <= 96; tick++) {
      if (tick % 12 === 0) {
        const stats = sparse.field.stats();
        assert.ok(stats.bound <= 1 / 255 && stats.violations === 0);
        let worst = 0, excess = 0, filteredError = 0, missed = 0;
        for (let y = 0; y < size; y++) {
          const row = dense.field.row(y - half);
          for (let x = 0; x < size; x++) {
            const delta = row[x - half - dense.field.x0] - sparse.field.sample(x - half, y - half);
            worst = Math.max(worst, delta); excess = Math.max(excess, -delta);
            const i = y * size + x;
            filteredError = Math.max(filteredError, Math.abs(sparse.water[i] - dense.water[i]));
            // Check the complete bilinear footprint on both sides of every tile edge.
            const high = sparse.maxima[Math.floor(y / WEATHER_TILE) * (size / WEATHER_TILE) + Math.floor(x / WEATHER_TILE)];
            for (const oy of [-1, 0, 1]) for (const ox of [-1, 0, 1])
              missed = Math.max(missed, sparse.water[((y + oy) & mask) * size + ((x + ox) & mask)] - high);
          }
        }
        assert.equal(excess, 0); assert.ok(worst <= stats.bound);
        assert.ok(filteredError <= 1); assert.equal(missed, 0);
        assert.ok(sparse.maxima.some(v => v < 12) && sparse.maxima.some(v => v > 140));
      }
      const sun = 0.5 + 0.5 * Math.cos(tick * 0.06), storm = Math.max(0, Math.sin(tick * 0.09));
      sparse.advance(sun, storm, 4 * tick, storm); dense.advance(sun, storm, 4 * tick, storm);
    }
  } finally {
    dense.field.free(); sparse.field.free();
  }
});

test('lake evaporation supplies a rising parcel downwind of the shore', async () => {
  const boxel = await load(await readFile(new URL('../demo/boxel.wasm', import.meta.url)));
  const lake = createWeather(boxel, { sources: [[-6, 8, 1]] }), control = createWeather(boxel);
  try {
    let added = 0, east = 0;
    for (let y = 0; y < WEATHER_SIZE; y++) for (let x = 0; x < WEATHER_SIZE; x++) {
      const i = y * WEATHER_SIZE + x, gain = lake.water[i] - control.water[i];
      assert.ok(gain >= 0);
      added += gain; east += (x - WEATHER_SIZE / 2) * gain;
    }
    assert.ok(added > 0 && east / added > 2);
  } finally { lake.field.free(); control.field.free(); }
});

test('cloud rebakes upload weather again when either the field or its interpolation changes', async () => {
  const boxel = await load(await readFile(new URL('../demo/boxel.wasm', import.meta.url)));
  const sources = [[-6, 8, 1]], reference = createWeather(boxel, { sources });
  const uploads = [];
  const noop = () => {};
  const gl = new Proxy({
    createTexture() { return {}; },
    texSubImage2D(_target, _level, _x, _y, width, _height, _format, _type, bytes) {
      if (width === WEATHER_SIZE) uploads.push(bytes.slice());
    },
  }, { get: (target, key) => target[key] ?? (key === key.toUpperCase() ? 0 : noop) });
  const clouds = createClouds(gl, () => ({ u() {} }), '', boxel, { sources, test: true });
  const bake = t => clouds.update(t, [0,0,0], [0,1,0], 1, 0, true);
  try {
    bake(0);
    clouds.advance(2, 1, 0, 2, 0);
    bake(2);
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0], reference.water);

    const previous = reference.water.slice();
    reference.advance(1, 0, 4, 0);
    clouds.advance(2, 1, 0, 4, 0);
    bake(4);
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[1], previous);
    clouds.advance(2, 1, 0, 6, 0);
    bake(6);
    assert.deepEqual(uploads[2], previous.map((v, i) => Math.round((v + reference.water[i]) / 2)));
    bake(8);
    assert.equal(uploads.length, 3);
  } finally {
    reference.field.free();
  }
});
