import test from 'node:test';
import assert from 'node:assert/strict';
import { readTuft, CLUMP } from '../demo/meadow.js';

test('a root encodes its nearest tuft across cell boundaries, including in negative coordinates', () => {
  const result = {};
  const hash = (x,z) => Math.imul(x + 123, 1831565813) ^ Math.imul(z + 317, 73244475);
  for (let x = -1.07; x < 1.6; x += 0.071) for (let z = -1.28; z < 0.75; z += 0.09) {
    readTuft(x,z,result,hash);
    const cx = Math.floor(x/CLUMP), cz = Math.floor(z/CLUMP);
    const distance = (i,j) => {
      const h = hash(i,j);
      return Math.hypot(i+0.15+0.7*(h & 65535)/65536-x/CLUMP, j+0.15+0.7*(h >>> 16)/65536-z/CLUMP);
    };
    const chosen = distance(cx + result.neighbour%3 - 1, cz + Math.floor(result.neighbour/3) - 1);
    let closest = Infinity;
    for (let j = cz-2; j <= cz+2; j++) for (let i = cx-2; i <= cx+2; i++) closest = Math.min(closest,distance(i,j));
    assert.ok(Math.abs(closest-chosen) < 1e-9 && Math.abs(result.distance-closest) < 1e-9);
  }
});

import { makeLeafSprays, SPRAY_COLUMNS, SPRAY_ROWS, SPRAY_MAX_LEVEL } from '../demo/leaf-spray.js';
const seeded = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
test('leaf sprays are the same for the same seed, and distant mips keep the crowns as full as near ones', () => {
  const a = makeLeafSprays(seeded(2024), 64), b = makeLeafSprays(seeded(2024), 64);
  assert.equal(a.levels.length, SPRAY_MAX_LEVEL + 1);
  assert.equal(a.width, 64 * SPRAY_COLUMNS); assert.equal(a.height, 64 * SPRAY_ROWS);
  assert.deepEqual(a.levels[0].bytes, b.levels[0].bytes);
  const share = ({ bytes }) => { let n = 0; for (let i = 3; i < bytes.length; i += 4) if (bytes[i] >= 128) n++; return n / (bytes.length / 4); };
  const full = share(a.levels[0]);
  assert.ok(full > 0.15 && full < 0.7, `cover ${full}`);
  for (const level of a.levels.slice(1, 4)) assert.ok(Math.abs(share(level) - full) < 0.06, `level cover ${share(level)} vs ${full}`);
});
