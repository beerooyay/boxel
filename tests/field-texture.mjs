import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldTexture } from '../demo/field-texture.js';

// Apply WebGL's source offset and row stride to an independent copy of the GPU image.
function destination(size) {
  const pixels = new Uint8Array(size * size);
  let stride = 0;
  return { pixels, pixelStorei(_, rowLength) { stride = rowLength; },
    texSubImage2D(_target, _level, x, y, width, height, _format, _type, src, offset = 0) {
      for (let row = 0; row < height; row++) {
        const from = offset + row * (stride || width);
        pixels.set(src.subarray(from, from + width), (y + row) * size + x);
      }
    },
  };
}

test('the R8 upload covers changed texels, skips invisible changes and clears retired blocks', () => {
  const size = 512, cache = new FieldTexture(size), gl = destination(size);
  const live = new Map(), freed = [];
  const field = {
    blocks(visit) { for (const block of live.values()) visit(...block); },
    freed(visit) { for (const coord of freed) visit(...coord); },
    forgetFreed() { freed.length = 0; },
  };
  const activate = (x, y, k, value) => {
    const values = new Float32Array(256);
    values[k] = value;
    live.set(x, [x, y, values]);
    return values;
  };
  function check() {
    const sent = cache.uploadSparse(gl, field);
    const expected = new Uint8Array(size * size);
    for (const [bx, by, data] of live.values()) {
      for (let k = 0; k < 256; k++) {
        const x = bx * 16 + size / 2 + k % 16, y = by * 16 + size / 2 + (k >> 4);
        if (x >= 0 && x < size && y >= 0 && y < size) expected[y * size + x] = Math.min(255, Math.round(data[k] * 255));
      }
    }
    assert.deepEqual(gl.pixels, expected);
    return sent;
  }
  const west = activate(-16, 0, 0, 0.51), east = activate(15, 0, 255, 0.8);
  activate(16, 0, 0, 1); // beyond the positive edge of the texture
  assert.equal(check(), 2);
  west[0] += 0.00001;
  assert.equal(check(), 0);
  east[254] = 1;
  assert.equal(check(), 1);
  live.delete(-16); freed.push([-16, 0]);
  freed.push([15, 0]); activate(15, 0, 254, 0.4); // freed and reused between frames
  assert.ok(check() > 0);
  assert.equal(check(), 0);
});

test('dense rows use the same byte convention and overwrite the entire previous image', () => {
  const size = 32, cache = new FieldTexture(size), gl = destination(size);
  const row = Float32Array.from({ length: size }, (_, x) => x / 24);
  gl.pixels.fill(73);
  assert.equal(cache.uploadDense(gl, { row: y => y === -16 ? row : new Float32Array(size) }), size * size);
  assert.deepEqual(gl.pixels.slice(0, size), Uint8Array.from(row, v => Math.min(255, Math.round(v * 255))));
  assert.ok(gl.pixels.slice(size).every(v => v === 0));
});
