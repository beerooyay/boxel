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
