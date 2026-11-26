import assert from 'node:assert/strict';
import test from 'node:test';
import { contactVolume } from '../demo/fox-contact.js';

function box(x0, x1, y0, y1, z0, z1) {
  return {
    positions: [x0,y0,z0, x1,y0,z0, x1,y1,z0, x0,y1,z0, x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1],
    indices: [
      0,2,1, 0,3,2, 4,5,6, 4,6,7,
      0,1,5, 0,5,4, 3,6,2, 3,7,6,
      0,4,7, 0,7,3, 1,2,6, 1,6,5,
    ],
  };
}

test('grass contact preserves the gap between paws and the space under a raised body', () => {
  const dimensions = [16, 16, 16], grid = contactVolume(dimensions, [0,0,0], 1);
  const leftPaw = box(3,5,2,8,5,7), rightPaw = box(10,12,2,8,5,7), torso = box(3,12,8,12,5,9);
  const field = grid.update([leftPaw, rightPaw, torso]);
  const at = (x,y,z) => field.subarray(4*(x + 16*y + 256*z), 4*(x + 16*y + 256*z)+4);
  assert.equal(at(4,3,5)[3], 255);
  assert.equal(at(11,3,5)[3], 255);
  assert.deepEqual([...at(7,4,5)], [0,0,0,0]);
  assert.deepEqual([...at(7,7,6)], [0,0,0,0]);
  assert.equal(at(7,9,6)[3], 255);
  const [r,g,b] = at(7,9,6);
  const exit = [7+(r-128)/4,9+(g-128)/4,6+(b-128)/4];
  assert.equal(at(...exit)[3], 0);
  grid.update([box(3,5,5,8,5,7), rightPaw, torso]);
  assert.equal(at(4,3,5)[3], 0, 'lifting the paw clears its previous contact');
  assert.equal(at(11,3,5)[3], 255);
});

test('overlapping closed parts stay solid and open triangles do not fill a scanline', () => {
  const grid = contactVolume([16,16,16], [0,0,0], 1);
  const a = box(3,7,3,8,3,8), b = box(5,10,3,8,3,8);
  const field = grid.update([a,b]);
  assert.equal(field[4*(6 + 16*5 + 256*5)+3], 255);
  assert(grid.occupied > 0);
  grid.update([{ positions: a.positions, indices: [0,4,7,0,7,3] }]);
  assert.equal(grid.occupied, 0);
});
