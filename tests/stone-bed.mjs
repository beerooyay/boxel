import assert from 'node:assert/strict';
import test from 'node:test';
import { stoneBed, stoneDrop, stoneSpacing } from '../demo/stone-bed.js';

test('the stone seat follows a tilted tread at either yaw and rejects an unsupported lip', () => {
  const ground = (x, z) => 1 + 0.32 * x - 0.16 * z;
  for (const yaw of [0, 0.77, 2.41]) {
    const { gx, gz } = stoneBed(ground, 0, 0, 0.8, 0.6, 0.45, yaw, 0);
    assert.ok(Math.abs(gx - 0.32) < 1e-10 && Math.abs(gz + 0.16) < 1e-10);
  }
  assert.equal(
    stoneBed((x, z) => (x > 0.35 && z > 0.35 ? -1 : 0), 0, 0, 1, 0.6, 1, 0, 0),
    null,
  );
  assert.equal(
    stoneBed((x) => 2 * x, 0, 0, 0.1, 0.08, 0.09, 0, 3),
    null,
  );
});

test('projected stone outlines leave room for separate fragments across bin boundaries', () => {
  // These parallel slivers overlap on x and z. Their x-z intervals separate them.
  const sliver = shift => ({
    x0: 3.4+shift, x1: 5.0+shift, z0: 2.6, z1: 4.2,
    sum0: 6.0+shift, sum1: 9.2+shift, diff0: 0.70+shift, diff1: 0.90+shift,
  });
  const reserve = stoneSpacing();
  assert.ok(reserve(sliver(0)));
  assert.equal(reserve(sliver(0.16)), false);
  assert.ok(reserve(sliver(0.25)));
  assert.equal(reserve(sliver(0)), false);
});

function grid(size, height) {
  const pos = Float32Array.from({ length: size*size*3 }, (_, k) => {
    const i = Math.floor(k/3), x = i % size, z = Math.floor(i/size);
    return [x, height(x,z), z][k % 3];
  });
  function ground(x,z) {
    const i = Math.min(size-2, Math.floor(x)), j = Math.min(size-2, Math.floor(z));
    const u = x-i, v = z-j, b = height(i+1,j), c = height(i,j+1);
    return u+v <= 1 ? (1-u-v)*height(i,j) + u*b + v*c : (u+v-1)*height(i+1,j+1) + (1-v)*b + (1-u)*c;
  }
  return stoneDrop(pos, size, x => x, ground);
}

function underside(corners, depths) {
  const pos = depths.map(y => Float32Array.from(corners.flatMap(([x,z]) => [x,y,z])));
  return { pos, levels: [new Uint16Array([0,1,2])] };
}

test('gravity settles the selected footprint on a tilted plane for every orientation and scale', () => {
  const gx = 0.25, gz = -0.125;
  const fall = grid(11, (x,z) => 1 + gx*x + gz*z);
  const mesh = underside([[-0.8,-0.5],[0.7,-0.6],[-0.1,0.8]], [-0.45,-0.20,-0.32]);
  for (const yaw of [0, 0.8, 2.65]) for (const sy of [0.035, 0.92, 1.8]) {
    const { y } = fall(mesh, 5, 5, 0.91, sy, 0.37, yaw, 0.125, { gx, gz });
    const depth = 0.45 + (0.20 - 0.45)*0.375;
    assert.ok(Math.abs(y - (1 + 5*gx + 5*gz + depth*sy*Math.hypot(1,gx,gz))) < 1e-6);
  }
});

test('a terrain ridge can catch a rock between vertices and a peak can catch the interior of its sole', () => {
  const level = {gx: 0, gz: 0};
  const ridge = grid(3, (x,z) => x+z === 1 ? 1 : 0);
  const sliver = underside([[0.22,0.30],[0.72,0.58],[0.66,0.06]], [-0.19,-0.19,-0.19]);
  const edge = ridge(sliver, 0, 0, 1, 1, 1, 0, 0.37, level);
  assert.ok(Math.abs(edge.y - 1.19) < 1e-6);
  const bump = grid(5, (x,z) => Number(x === 2 && z === 2));
  const broad = underside([[-1.8,-1.4],[1.8,-1.4],[0,1.7]], [-0.31,-0.31,-0.31]);
  const face = bump(broad, 2, 2, 1, 1, 1, 0.09, 0.64, level);
  assert.ok(Math.abs(face.y - 1.31) < 1e-6);
});
