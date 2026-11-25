import assert from 'node:assert/strict';
import test from 'node:test';
import { waterBounds } from '../demo/water-view.js';

const vp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
const visible = () => false;
const patch = (x0, y0, z0, width, height, depth) => ({ x0, y0, z0, width, y1: y0 + height, depth });

test('the water lookup includes wave distortion and a bilinear footprint at odd resolutions', () => {
  const w = 801, h = 519, front = patch(-0.8, -1.5, 3, 1.2, 0.18, 5);
  const rect = waterBounds([front], vp, [], visible, 0.05, w, h);
  assert.ok(rect[0] > 0 && rect[1] > 0 && rect[2] < 1 && rect[3] < 1);
  for (const x of [-0.8, 0.4]) for (const y of [-1.5, -1.32]) for (const z of [3, 8]) {
    const u = 0.5 + 0.5 * x / z, v = 0.5 + 0.5 * y / z;
    assert.ok(rect[0] <= u - (0.16 * h + 2) / w && rect[2] >= u + (0.16 * h + 2) / w);
    assert.ok(rect[1] <= v - 0.16 - 2 / h && rect[3] >= v + 0.16 + 2 / h);
  }
});

test('walking through the near plane retains the visible water and rejects patches behind the eye', () => {
  const bounds = patches => waterBounds(patches, vp, [], visible, 0.05, 721, 479);
  assert.equal(bounds([patch(-2, -1, -5, 3, 1, 3)]), null);
  assert.deepEqual(bounds([patch(-2, -1, -1, 3, 2, 3)]), [0, 0, 1, 1]);
  // The upper edge is confined to the lower half until the eye dips into the waves.
  const below = bounds([patch(-2, -2, -1, 3, 0.2, 7)]);
  assert.equal(below[0], 0); assert.equal(below[2], 1);
  assert.ok(below[3] < 0.53);
});
