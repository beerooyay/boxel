import test from 'node:test';
import assert from 'node:assert/strict';
import { clumpDistance, CLUMP } from '../demo/meadow.js';
import { makeRockSurface } from '../demo/rock-material.js';

const seeded = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };

test('tuft centres are fixed by position alone, one to a cell', () => {
  for (const [x, z] of [[0.1, 0.2], [-37.3, 12.9], [101.4, -88.8]]) {
    assert.equal(clumpDistance(x, z), clumpDistance(x, z));
    // a point never lies further from its nearest tuft than a cell's diagonal
    assert.ok(clumpDistance(x, z) < Math.SQRT2);
  }
  // somewhere in every cell there is a tuft centre
  let nearest = Infinity;
  for (let i = 0; i < 50; i++) for (let j = 0; j < 50; j++) nearest = Math.min(nearest, clumpDistance(3 * CLUMP + i * CLUMP / 50, 7 * CLUMP + j * CLUMP / 50));
  assert.ok(nearest < 0.05, `closest approach ${nearest}`);
});

test('the rock surface tiles, spans its whole range and is the same for the same seed', () => {
  const a = makeRockSurface(seeded(5501), 128), b = makeRockSurface(seeded(5501), 128);
  assert.deepEqual(a.pixels, b.pixels);
  for (const [u, v] of [[0.13, 0.71], [0.5, 0.02], [0.99, 0.4]]) {
    assert.ok(Math.abs(a.sample(u, v) - a.sample(u + 1, v - 2)) < 1e-9);
  }
  let lo = 1, hi = 0;
  for (let i = 0; i < 400; i++) { const h = a.sample(i / 400, (i * 7 % 400) / 400); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  assert.ok(lo >= 0 && hi <= 1 && hi - lo > 0.5, `range ${lo}..${hi}`);
});
