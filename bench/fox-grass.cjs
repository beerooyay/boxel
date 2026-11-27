// Run against the playable lab on a local server or Pages. Read the four
// actual GPU bend knots and classify each blade once, including its siblings.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

function readContacts() {
  const gl = document.querySelector('canvas').getContext('webgl2');
  const active = gl.getParameter(gl.ACTIVE_TEXTURE);
  const original = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  gl.activeTexture(gl.TEXTURE22);
  const tex = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
  const fbo = gl.createFramebuffer();
  const width = 96, height = 3*width;
  const pixels = new Uint8Array(4*width*height), blades = new Uint8Array(width*height);
  try {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    for (let layer = 0; layer < 4; layer++) {
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, layer);
      if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Unreadable blade knots');
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      for (let i = 0; i < blades.length; i++) blades[i] = Math.max(blades[i], pixels[4*i+3]);
    }
  } finally {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, original);
    gl.deleteFramebuffer(fbo);
    gl.activeTexture(active);
  }
  const count = { direct: 0, neighbourOnly: 0, recovering: 0 };
  for (const alpha of blades) {
    if (alpha > 220) count.direct++;
    else if (alpha > 100) count.neighbourOnly++;
    else if (alpha > 0) count.recovering++;
  }
  return count;
}

async function main() {
  const browser = await chromium.launch({channel: process.env.CHROME_CHANNEL || undefined});
  try {
    const page = await browser.newPage({viewport: {width: 1080, height: 720}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.argv[2] || 'http://127.0.0.1:8790/demo/?grass-lab');
    await page.waitForFunction(() => window.__game?.ready || document.getElementById('err').textContent, null, {timeout: 120000});
    assert.equal(await page.locator('#err').textContent(), '');
    await page.locator('#go').click();
    await page.waitForFunction(() => __game.state().grassLab.uploadBytes > 0);
    await page.locator('#labMark').click();
    const measure = async () => { await page.waitForTimeout(400); return page.evaluate(readContacts); };
    const coupled = await measure();
    assert(coupled.direct > 0 && coupled.neighbourOnly > 0);
    await page.locator('#labShare').click();
    const solo = await measure();
    assert(coupled.neighbourOnly < 12*coupled.direct, "pressure must stay local to touching blades");
    assert(solo.direct > 0 && solo.neighbourOnly === 0);
    await page.locator('#labShare').click();
    const recoupled = await measure();
    assert(recoupled.neighbourOnly > 0);
    const ground = await page.evaluate(() => __game.state().player.y);
    await page.keyboard.press('Space');
    await page.waitForFunction(y => __game.state().player.y > y+1.0, ground);
    const airborne = await page.evaluate(readContacts);
    assert.equal(airborne.neighbourOnly, 0, 'no donor pressure while airborne');
    assert.equal(airborne.direct, 0, 'raised paws must clear short grass');
    await page.waitForFunction(() => __game.state().player.grounded);
    const landed = await measure();
    assert(landed.direct > 0);
    assert.equal(await page.evaluate(() => document.querySelector('canvas').getContext('webgl2').getError()), 0);
    assert.deepEqual(errors, []);
    console.log({coupled, solo, recoupled, airborne, landed});
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
