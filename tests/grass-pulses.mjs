import test from 'node:test';
import assert from 'node:assert/strict';
import { GrassPulses, GRASS_PULSES } from '../demo/meadow.js';

test('a grass pulse crosses tile boundaries, moves out and then clears its last tile', () => {
  const pulses = new GrassPulses(16); // 4 x 4 tiles, with a corner at the origin
  assert.equal(pulses.update(0),false);
  pulses.touch(-0.35,-0.35,4);
  assert.equal(pulses.update(4.10),true);
  assert.deepEqual(Array.from(pulses.tiles.keys()).filter(i => pulses.tiles[i]),[5,6,9,10]);
  const firstRadius = pulses.waves[2], firstGain = pulses.waves[3];
  pulses.update(4.65);
  assert.ok(pulses.waves[2] > firstRadius + 0.45);
  assert.ok(pulses.waves[3] > 0 && pulses.waves[3] < firstGain*0.5);
  assert.equal(pulses.update(4.90),true);
  assert.ok(pulses.waves[3]>0.05 && pulses.waves[3]<0.10);
  pulses.update(5.04);
  assert.ok(pulses.waves[3]>0 && pulses.waves[3]<0.002);
  assert.equal(pulses.update(5.07),false);
  assert.ok(pulses.tiles.every(mask => mask===0));
});

test('overlapping steps reserve one bit each and retire oldest first at capacity', () => {
  const pulses = new GrassPulses(16);
  for (let i=0; i<GRASS_PULSES; i++) pulses.touch(-5,-5,i*0.04);
  pulses.update(0.25);
  assert.equal(pulses.tiles[5],(1<<GRASS_PULSES)-1);
  pulses.touch(15.99,15.99,0.26);
  pulses.update(0.30);
  assert.equal(pulses.tiles[5],(1<<GRASS_PULSES)-2);
  assert.equal(pulses.tiles[15],1);
  pulses.reset();
  assert.equal(pulses.update(0.31),false);
  assert.ok(pulses.tiles.every(mask => mask===0));
});

test('a planted footprint stays in place while only the feather spreads into the next tile', () => {
  const pulses = new GrassPulses(16);
  pulses.touch(-1.34,-4,2);
  pulses.update(2);
  assert.equal(pulses.waves[3],0);
  assert.equal(pulses.tiles[5],1);
  assert.equal(pulses.tiles[6],0);
  pulses.update(2.85);
  assert.equal(pulses.tiles[6],1);
  assert.equal(pulses.tiles[7],0);
  assert.equal(pulses.waves[0],Math.fround(-1.34));
  assert.equal(pulses.waves[1],-4);
  pulses.update(4);
  assert.equal(pulses.update(5),false);
  assert.ok(pulses.tiles.every(mask=>mask===0));
});
