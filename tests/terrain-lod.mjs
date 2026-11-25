import assert from 'node:assert/strict';
import test from 'node:test';
import { coarsePatch } from '../demo/terrain-lod.js';

test('a coarse patch has the same outline and winding as its full-resolution neighbour', () => {
  const stride = 15, x0 = 2, z0 = 4, x1 = 14, z1 = 12;
  const pos = new Float32Array(stride * stride * 3), indices = new Uint32Array(6 * (x1 - x0) * (z1 - z0));
  for (let i = 0; i < stride * stride; i++) pos[3 * i + 1] = (i % stride) / 4 + Math.floor(i / stride) / 8;
  const { cursor, error } = coarsePatch(indices, 0, pos, stride, x0, z0, x1, z1);
  assert.equal(error, 0);
  assert.ok(cursor < indices.length);
  const edges = new Map();
  let area = 0;
  for (let i = 0; i < cursor; i += 3) {
    const [a, b, c] = indices.subarray(i, i + 3);
    const ax = a % stride, az = Math.floor(a / stride);
    const twiceArea = (Math.floor(b / stride) - az) * (c % stride - ax) - (b % stride - ax) * (Math.floor(c / stride) - az);
    assert.ok(twiceArea > 0);
    area += twiceArea / 2;
    for (const [v, w] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(v, w) * stride * stride + Math.max(v, w);
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  assert.equal(area, (x1 - x0) * (z1 - z0));
  let outline = 0;
  for (const [key, count] of edges) {
    if (count === 2) continue;
    assert.equal(count, 1);
    const a = Math.floor(key / (stride * stride)), b = key % (stride * stride);
    const x = a % stride, z = Math.floor(a / stride);
    assert.ok((b === a + stride && (x === x0 || x === x1)) || (b === a + 1 && (z === z0 || z === z1)));
    outline++;
  }
  assert.equal(outline, 2 * (x1 - x0 + z1 - z0));

  const interior = (z0 + 3) * stride + x0 + 3;
  pos[3 * interior + 1] += 1.5;
  assert.equal(coarsePatch(indices, 0, pos, stride, x0, z0, x1, z1).error, 1.5);
});
