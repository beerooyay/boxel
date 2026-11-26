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
    const coverage = [];
    for (const rain of [0, 0.18, 1]) {
      const cloud = await page.evaluate(r => window.__game.verifyClouds(r), rain);
      console.log('Cloud optics', rain, cloud);
      assert.equal(cloud.glError, 0);
      assert.equal(cloud.different, 0, 'Skipping must preserve all four optical channels');
      assert.ok(cloud.opaque > cloud.pixels * 0.03 && cloud.shaded > 100, 'Clouds must have thick shaded interiors');
      if (!rain) assert.ok(cloud.clear > cloud.pixels * 0.2 && cloud.sunlit > 100, 'Fair weather needs blue gaps and lit turrets');
      coverage.push(cloud.opaque);
    }
    assert.ok(coverage[2] > coverage[0] * 2, 'A storm must close the fair-weather gaps');
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
