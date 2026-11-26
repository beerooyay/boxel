import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_RATE, TIMELAPSE_SECONDS, timelapseTravel } from '../demo/sky-clock.js';

test('one continuous timelapse turns one orbit at any frame rate', () => {
  const total = timelapseTravel(TIMELAPSE_SECONDS);
  assert.ok(Math.abs(total * DAY_RATE - 2 * Math.PI) < 1e-12);
  for (const fps of [24, 30, 60, 144]) {
    let elapsed = 0;
    for (let i = 1; i <= fps * TIMELAPSE_SECONDS; i++) {
      const travel = timelapseTravel(i / fps) - timelapseTravel((i - 1) / fps);
      assert.ok(travel > 0);
      elapsed += travel;
    }
    assert.ok(Math.abs(elapsed - total) < 1e-10);
  }
  const delta = 0.001;
  assert.ok(Math.abs(timelapseTravel(delta) / delta - 1) < 0.001);
  assert.ok(Math.abs((total - timelapseTravel(TIMELAPSE_SECONDS - delta)) / delta - 1) < 0.001);
});
