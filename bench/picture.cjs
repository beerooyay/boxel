// The ?test page replays the same river events in both engines.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || undefined,
    args: process.env.CI ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : [],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 480 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().slice(-600)); });
    await page.goto(process.argv[2] || 'http://127.0.0.1:8790/demo/?test');
    await page.waitForFunction(() => window.__game?.ready || document.getElementById('err')?.textContent, null, { timeout: 120000 });
    assert.equal(await page.locator('#err').textContent(), '');
    const result = await page.evaluate(() => window.__game.verify('river'));
    console.log(JSON.stringify(result, null, 2));
    const sky = await page.evaluate(() => window.__game.verifySky());
    console.log('Sky cube', sky);
    assert.equal(sky.glError, 0);
    assert.ok(sky.referencePeak > 80 && sky.referenceFloor < 35, 'The reference sky must contain both galaxy light and dark sky');
    assert.equal(sky.different, 0, 'Every stored sky texel must match the full evaluation');
    assert.deepEqual(errors, []);
    assert.equal(result.glError, 0);
    assert.ok(result.withinBound && result.boundWithinTolerance && result.withinTolerance);
    assert.equal(result.boxel.violations, 0);
    assert.ok(result.picturePass, 'The river must respond to removing glow and match the dense reference');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
