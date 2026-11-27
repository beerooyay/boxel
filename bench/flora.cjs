// Count the generated valley before its CPU placement arrays are released.
// Playwright installs the probe only for this run. The game keeps no census in memory.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

function census(stands, local, upland, rosettes, plants, half) {
  const trees = [], hues = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < stands.sites.length; i += 4) {
    trees.push([stands.sites[i], stands.sites[i+2]]);
    const hue = stands.styles[i+3];
    hues[[0.78, 0.85, 0.91, 0.95, 0.985, Infinity].findIndex(limit => hue < limit)]++;
  }
  const proceduralInGrove = trees.filter(([x,z]) => ((x-18)/16)**2+((z-36)/13)**2 <= 1).length;
  const inside = ([x,z]) => Math.abs(x) <= half && Math.abs(z) <= half;
  const closePairs = [];
  for (let i = 0; i < trees.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = trees[i], b = trees[j], metres = Math.hypot(a[0]-b[0], a[1]-b[1]);
      if (metres < 1) closePairs.push({ metres, a, b, bothInside: inside(a) && inside(b) });
    }
  }
  const shapes = stands.meshes.map((mesh, i) => {
    const count = stands.tiles.filter(tile => tile.variant === i).reduce((n,tile) => n+tile.count, 0);
    return { count, nearTriangles: mesh.nearCount/3, farTriangles: mesh.farCount/3, sprays: count * mesh.foliage.length/4 };
  });
  const spiralBases = new Set();
  for (let i = 0; i < rosettes.B.length; i += 4) spiralBases.add(rosettes.B[i]+','+rosettes.B[i+1]);
  const families = ['crimsonRosette','fern','glowTube','coilfern','lanternBell','tidecup','arrowleaf'];
  const roots = families.map(() => new Set()), pieces = families.map(() => 0);
  const { P, F, S2 } = plants;
  let filaments = 0, eligibleStamps = 0, rootStamps = 0;
  let rootRuns = 0;
  for (let i = 0; i < P.length;) {
    const x = P[i], y = P[i+1], z = P[i+2], key = x+','+z;
    rootRuns++;
    let maxHeight = 0;
    do {
      const type = F[i+3];
      // A cup's five central filaments use the tube shader with a nonzero curl.
      const filament = type === 2 && S2[i+2] !== 0;
      const family = filament ? 5 : type;
      roots[family].add(key); pieces[family]++;
      if (filament) filaments++;
      const height = P[i+3]*F[i+1];
      if (height > 0.8) eligibleStamps++;
      maxHeight = Math.max(maxHeight, height);
      i += 4;
    } while (i < P.length && P[i] === x && P[i+1] === y && P[i+2] === z);
    if (maxHeight > 0.8) rootStamps++;
  }
  const understorySites = new Set(spiralBases);
  for (const family of roots) for (const site of family) understorySites.add(site);
  return {
    trees: { total: trees.length, inside: trees.filter(inside).length, outerForest: upland.length/4,
      local: local.length/5, islet: 1, proceduralInGrove, shapes, hues,
      closePairs: closePairs.sort((a,b) => a.metres-b.metres) },
    spiralRosettes: { roots: spiralBases.size, leaves: rosettes.B.length/4 },
    understory: Object.fromEntries(families.map((name,i) => [name,{roots: roots[i].size, pieces: pieces[i]}])),
    coincidentUnderstoryRoots: rootRuns + rosettes.B.length / (4*21) - understorySites.size,
    understoryRootsAtTrunks: trees.filter(([x,z]) => understorySites.has(x+','+z)).length,
    filaments, eligibleStamps, rootStamps,
  };
}

async function main() {
  const url = new URL(process.argv[2]);
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || undefined });
  try {
    for (const lab of [false,true]) for (const coarse of [false,true]) {
      const page = await browser.newPage({ hasTouch: coarse, viewport: { width: 960, height: 600 } });
      await page.route('**/game.js', async route => {
        const response = await route.fetch(), source = await response.text();
        const at = '  const heightRange = bakeGroundLight(';
        assert(source.includes(at), 'Missing valley construction hook');
        const probe = '  window.floraCensus = (' + census.toString() +
          ')(stands, sc.trees, highSites.instances, rosettes, pl, WORLD_HALF);\n';
        await route.fulfill({ response, body: source.replace(at, probe+at) });
      });
      url.search = lab ? '?grass-lab' : '';
      await page.goto(url.href);
      await page.waitForFunction(() => window.__game?.ready || document.querySelector('#err').textContent, null, {timeout:120000});
      assert.equal(await page.locator('#err').textContent(), '');
      const result = await page.evaluate(() => ({coarse: matchMedia('(pointer: coarse)').matches,
        ...window.floraCensus, render: window.__game.state().instances}));
      assert.equal(result.coarse, coarse);
      assert.equal(result.trees.total, result.render.trees);
      assert.equal(result.render.oaks, 0);
      assert.ok(result.trees.proceduralInGrove > 0, 'Native trees populate the starting hillside');
      const pieces = Object.values(result.understory).reduce((n, family) => n+family.pieces, 0);
      assert.equal(result.render.plants, lab ? 0 : pieces);
      console.log(JSON.stringify({lab, ...result}));
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
