import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceFlight, JUMP_HEIGHT, jumpDuration, requestJump, steerFox } from '../demo/fox-motion.js';

test('a fox clears 1.10 m at each frame rate and can jump again only after touchdown', () => {
  for (const fps of [24, 30, 60, 120]) {
    const player = { y: 7, grounded: true };
    assert(requestJump(player));
    let apex = 0, elapsed = 0;
    while (!player.grounded && elapsed < 2) {
      assert.equal(requestJump(player), false);
      advanceFlight(player, 7, 1/fps);
      elapsed += 1/fps;
      apex = Math.max(apex, player.y-7);
    }
    assert(Math.abs(apex-JUMP_HEIGHT) < 0.004);
    assert(Math.abs(elapsed-jumpDuration) <= 1/fps);
    assert.equal(player.y, 7);
    assert.equal(player.vy, 0);
    assert(requestJump(player));
  }
});

test('flight lands on the current support after crossing a ledge in either direction', () => {
  for (const landing of [2.55, 0.75]) {
    const player = { y: 2, grounded: true };
    requestJump(player);
    for (let i = 0; !player.grounded && i < 150; i++) {
      const landed = advanceFlight(player, i < 20 ? 2 : landing, 1/60);
      assert.equal(landed, player.grounded);
    }
    assert(player.grounded);
    assert.equal(player.y, landing);
  }
});

test('backing preserves heading and a sprint reversal turns before accelerating', () => {
  for (const fps of [30, 60, 120]) {
    const dt = 1/fps, pose = {yaw: 0};
    const back = steerFox(pose, 0, -1, 0, false, dt, false);
    assert(back < 0 && pose.backing);
    assert.equal(pose.yaw, 0);
    assert.equal(steerFox(pose, 0, -1, 0, true, dt, false), 0);
    assert(Math.abs(pose.bend) > 0.1);
    let speed = 0;
    for (let i = 0; i < fps*1.5; i++) {
      const prior = pose.yaw;
      speed = steerFox(pose, 0, -1, 0, true, dt, false);
      assert(Math.abs(pose.yaw-prior) <= 4.6*dt + 1e-8);
    }
    assert(speed > 4 && Math.abs(Math.abs(pose.yaw)-Math.PI) < 0.001);
    const prior = pose.yaw;
    steerFox(pose, 1, 0, 0, false, dt, true);
    assert(Math.abs(pose.yaw-prior) <= 1.7*dt + 1e-8);
  }
});
