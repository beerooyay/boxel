import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaterSurface } from '../demo/water-surface.js';
import { falls, riverLevel, riverX, waterLevel, terrainHeight } from '../demo/landmarks.js';
import { lipZ, landingAt } from '../demo/waterfall.js';

const grid = { x0: 0, z0: 0, width: 48, height: 48, step: 0.24 };
function tank(current = 0, wall = false) {
  return createWaterSurface(grid, (x, z, bed) => {
    bed.depth = wall && x >= 5.52 && x < 5.76 ? 0 : 0.6;
    bed.level = 0;
    bed.vx = 0;
    bed.vz = current;
  });
}
function dyeCentroid(water) {
  let mass = 0,
    moment = 0;
  for (let j = 0; j < grid.height; j++)
    for (let i = 0; i < grid.width; i++) {
      const z = (j + 0.5) * grid.step,
        f = water.sample((i + 0.5) * grid.step, z).light;
      mass += f;
      moment += z * f;
    }
  return moment / mass;
}
test('two contacts propagate through each other with signed superposition across tile boundaries', () => {
  const a = tank(),
    b = tank(),
    both = tank();
  for (const f of [a, both]) f.touch(3.0, 4.4, 0.8);
  for (const f of [b, both]) f.touch(5.0, 4.4, 0.6);
  let signal = 0;
  for (let tick = 0; tick < 72; tick++) {
    for (const f of [a, b, both]) f.advance(1 / 30);
    const x = a.sample(4.02, 4.44).height,
      y = b.sample(4.02, 4.44).height;
    signal = Math.max(signal, Math.min(Math.abs(x), Math.abs(y)));
    assert.ok(Math.abs(both.sample(4.02, 4.44).height - x - y) < 0.0002);
  }
  assert.ok(signal > 0.001, 'both wave trains reach the same point');
  assert.equal(both.sample(4.02, 4.44).light, 0);
});
test('waves reflect off dry rock, dye drifts downstream and wind shifts the wake', () => {
  const solid = tank(0, true),
    free = tank(),
    river = tank(0.8),
    windy = tank();
  assert.equal(solid.touch(5.64, 3.0, 1, 1), false);
  for (const f of [solid, free, river, windy]) f.touch(4.68, 3.0, 1, 1);
  let passed = 0,
    reflected = 0;
  for (let t = 0; t < 90; t++) {
    for (const f of [solid, free, river]) f.advance(1 / 30);
    windy.advance(1 / 30, 0, 0.12);
    passed = Math.max(passed, Math.abs(free.sample(6.84, 3.0).height));
    reflected = Math.max(reflected, Math.abs(free.sample(5.4, 3.0).height - solid.sample(5.4, 3.0).height));
    assert.equal(solid.sample(6.84, 3.0).height, 0);
  }
  assert.ok(passed > 0.0005 && reflected > 0.001);
  assert.ok(dyeCentroid(river) > dyeCentroid(free) + 2);
  assert.ok(dyeCentroid(windy) > dyeCentroid(free) + 0.22);
});
test('fixed steps give the same wake at 24 and 120 Hz, and reset clears it', () => {
  const slow = tank(0.74),
    fast = tank(0.74);
  for (const [f, rate] of [
    [slow, 24],
    [fast, 120]
  ]) {
    f.touch(3.84, 3.84, 1, 0.8);
    for (let i = 0; i < rate; i++) f.advance(1 / rate);
  }
  assert.deepEqual(slow.sample(3.84, 4.68), fast.sample(3.84, 4.68));
  assert.ok(Math.abs(slow.fraction - fast.fraction) < 1e-6);
  slow.reset();
  const q = slow.sample(3.84, 4.68);
  assert.equal(q.light, 0);
  assert.equal(q.height, 0);
});

const fox = { halfWidth: 0.21, halfLength: 0.48, draft: 0.416 };
test('a swimming body displaces water across tile boundaries without adding volume or lighting the lake', () => {
  const lake = tank(), drifting = tank(0.8), bank = tank(0, true);
  lake.swim(3.84, 7.68, 2.3, 0, 1/30, fox, 0.2);
  drifting.swim(3.84, 7.68, 0, 0.8, 1/30, fox, 0.2);
  bank.swim(5.64, 3, 2.3, 0, 1/30, fox, 0.2);
  for (const basin of [lake, drifting, bank]) basin.advance(1/30);
  let volume = 0, high = 0, low = 0;
  for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) {
    const x = (i+0.5)*grid.step, z = (j+0.5)*grid.step;
    const { height, light } = lake.sample(x,z);
    volume += height*grid.step**2;
    high = Math.max(high, height); low = Math.min(low, height);
    assert.equal(light, 0);
    assert.equal(drifting.sample(x,z).height, 0);
    assert.equal(bank.sample(x,z).height, 0);
  }
  assert.ok(high > 0.002 && low < -0.003);
  assert.ok(Math.abs(volume) < 1e-7);
});
test('ordinary paddling sends a signed wake past the tail and faster strokes leave a larger wake at either frame rate', () => {
  function swim(rate, speed) {
    const water = tank();
    for (let frame=0; frame<2*rate; frame++) {
      const t=(frame+0.5)/rate;
      water.swim(3+t*speed,5.76,speed,0,1/rate,fox,1.49*t);
      water.advance(1/rate);
    }
    const samples=[];
    for (let behind=0.75; behind<2.85; behind+=grid.step)
      for (let side=-1.56; side<1.57; side+=grid.step)
        samples.push(water.sample(3+2*speed-behind,5.76+side).height);
    return samples;
  }
  const gentle=swim(60,1.3), fast=swim(30,2.4), highRate=swim(120,2.4);
  assert.ok(Math.max(...gentle)>0.010 && Math.min(...gentle)<-0.010);
  assert.ok(Math.max(...fast)>2*Math.max(...gentle));
  const energy=fast.reduce((sum,h)=>sum+h*h,0);
  const difference=fast.reduce((sum,h,i)=>sum+(h-highRate[i])**2,0);
  assert.ok(difference/energy<0.03**2);
});

test('both chutes have bedrock immediately below the lip and room for the falling sheet to reach the pool', () => {
  const head=riverLevel(falls.lip), tail=riverLevel(falls.lip+falls.reach);
  for (const s of [-0.78,-0.60,-0.19,0,0.18,0.40]) {
    const lip=lipZ(s), [,landing]=landingAt(s);
    for (let i=0; i<=20; i++) {
      const t=i/20, z=lip+(landing-lip)*t;
      const x=riverX(z)+s*falls.halfWidth*(0.99+0.08*t*t);
      const bed=terrainHeight(x,z,6);
      const water=head+0.010-(head-tail+0.22)*t*t;
      if (i===0) assert.ok(water-bed < 0.60, 'the feeding water rests on the ledge');
      assert.ok(water-bed>0, 'exposed terrain does not cut through the chute');
    }
  }
});
test('the upper race feeds the falls and a scoured pool drains continuously to the ford', () => {
  const top = riverLevel(falls.lip),
    toe = falls.lip + falls.reach;
  assert.ok(top - riverLevel(toe) > 2.6);
  assert.ok(riverLevel(toe) - terrainHeight(riverX(toe), toe, 8) > 0.9);
  let prior = Infinity;
  for (let z = -99; z <= -12; z += 0.025) {
    const level = waterLevel(riverX(z), z);
    assert.ok(level <= prior + 1e-6);
    prior = level;
  }
});
test('both pool banks and the lower river have a walkable gravel shelf through the waterline', () => {
  for (const z of [-56, -43.8, -43, -42, -40, -33, -25]) {
    const level = riverLevel(z);
    for (const side of [-1, 1]) {
      const height = (d) => terrainHeight(riverX(z) + side * d, z, 6) - level;
      let wetEdge, dryEdge;
      for (let d = 0.1; d < 5.2; d += 0.025) {
        const h = height(d);
        if (wetEdge === undefined && h >= -0.22) wetEdge = d;
        if (dryEdge === undefined && h >= 0.22) dryEdge = d;
        if (Math.abs(h) < 0.23) {
          assert.ok(Math.abs(h - height(d - 0.025)) / 0.025 < 0.58, `bank grade at ${z}, ${side * d}`);
        }
      }
      assert.ok(dryEdge - wetEdge > 1.1);
    }
  }
});
