import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPicture } from '../demo/verify.js';

test('picture parity requires a visible scene and a working glow control', () => {
  const blank = new Uint8Array(400);
  const river = Uint8Array.from(blank, (_, k) => k < 200 ? 22 : 130);
  const glowing = river.slice();
  glowing[12] += 26;
  assert.equal(checkPicture(glowing, glowing, river).picturePass, true);
  assert.equal(checkPicture(blank, blank, blank).picturePass, false);
  assert.equal(checkPicture(blank, blank, river).picturePass, false);
  assert.equal(checkPicture(glowing, glowing, glowing).picturePass, false);
  assert.equal(checkPicture(blank, glowing, river).picturePass, false);
});
