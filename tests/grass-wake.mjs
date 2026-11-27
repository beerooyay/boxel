import test from 'node:test';
import assert from 'node:assert/strict';
import { GrassWake, GRASS_WAKE_SEGMENTS } from '../demo/meadow.js';

const close = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-5, `${actual} versus ${expected}`);

test('a straight grass track keeps its contact times and reaches tufts across tile edges as it ages', () => {
  const wake = new GrassWake(16); // 4 x 4 tiles, with a corner at the origin
  assert.equal(wake.update(0),false);
  wake.sweep(-0.98,-1.12,-0.88,-1.12,4.05,0.05);
  wake.sweep(-0.88,-1.12,-0.68,-1.12,4.15,0.10);
  wake.update(4.15);
  assert.equal(wake.head,0);
  const [x,z,dx,dz,length,ageAtStart,ageAtEnd,strength] = wake.segments;
  close(x,-0.98); close(z,-1.12); close(dx,1); close(dz,0); close(length,0.30);
  close(ageAtStart,0.15); close(ageAtEnd,0); close(strength,1);
  assert.deepEqual(Array.from(wake.tiles.keys()).filter(i=>wake.tiles[i]),[5,6]);
  wake.update(4.75);
  close(wake.segments[6],0.60); // the moving front keeps travelling after lift-off
  assert.deepEqual(Array.from(wake.tiles.keys()).filter(i=>wake.tiles[i]),[5,6,9,10]);
  assert.equal(wake.update(5.28),false);
  assert.ok(wake.tiles.every(mask=>mask===0));
});

test('a turn keeps the previous grass wake in place and a break in contact starts a separate track', () => {
  const wake = new GrassWake(16);
  wake.sweep(1,1,1.3,1,0.1,0.1);
  wake.sweep(1.3,1,1.3,1.3,0.2,0.1);
  wake.sweep(1.3,1.3,1.3,1.3,0.3,0.1);
  wake.update(0.3);
  assert.equal(wake.head,1);
  close(wake.segments[2],1); close(wake.segments[3],0); close(wake.segments[6],0.2);
  close(wake.segments[10],0); close(wake.segments[11],1); close(wake.segments[14],0.1);
  wake.sweep(1.3,1.3,1.3,1.45,0.4,0.1);
  assert.equal(wake.head,2);
  wake.sweep(-10,-10,-10,-9.85,0.5,0.1);
  wake.update(0.5);
  assert.equal(wake.head,3);
  assert.equal(wake.tiles[0],1<<3); // no bridge to the other patch
});

test('a stationary landing has a single contact time and the next moving step starts its own track', () => {
  const wake = new GrassWake(16);
  wake.land(2,3,4);
  wake.update(4.15);
  assert.deepEqual(Array.from(wake.segments.slice(0,5)),[2,3,0,0,0]);
  close(wake.segments[5],0.15); close(wake.segments[6],0.15);
  wake.sweep(2,3,2,3,4.25,0.1);
  assert.equal(wake.head,0);
  wake.sweep(2,3,2,3.1,4.35,0.1);
  wake.update(4.35);
  assert.equal(wake.head,1);
  close(wake.segments[4],0); close(wake.segments[12],0.1);
});

test('an idle animal makes no wake and repeated passes recycle the fixed pool', () => {
  const wake = new GrassWake(16);
  wake.sweep(0,0,0.0001,0,0.02,0.02);
  assert.equal(wake.update(0.02),false);
  for (let i=0; i<GRASS_WAKE_SEGMENTS; i++) wake.sweep(-5,-5,-4.8,-5,i*0.04+0.02,0.02);
  wake.update(0.42);
  assert.equal(wake.tiles[5],(1<<GRASS_WAKE_SEGMENTS)-1);
  wake.sweep(15.8,15.9,15.99,15.9,0.46,0.02);
  wake.update(0.46);
  assert.equal(wake.tiles[5],(1<<GRASS_WAKE_SEGMENTS)-2);
  assert.equal(wake.tiles[15],1);
  wake.reset();
  assert.equal(wake.update(0.5),false);
  assert.ok(wake.tiles.every(mask=>mask===0));
});
