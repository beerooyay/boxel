// Run against either revision's normal playable page. The game sees 60 fixed
// simulation ticks per simulated second. Wall and GPU timings use real clocks.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const url = process.argv[2] || 'http://127.0.0.1:8841/demo/';
const width = Number(process.argv[3] || 1280), height = Number(process.argv[4] || 768);

function installMeter() {
  performance.setResourceTimingBufferSize(2000);
  const raf = window.requestAnimationFrame.bind(window);
  let tick, job, gl, ext;
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  const release = () => ['KeyW','ShiftLeft','KeyD'].forEach(code => key('keyup', code));
  function poll(run) {
    if (!ext) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      run.pending.forEach(q => gl.deleteQuery(q)); run.pending.length = 0; run.disjoint++;
    }
    while (run.pending.length && gl.getQueryParameter(run.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = run.pending.shift();
      run.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  }
  window.requestAnimationFrame = fn => fn.name !== 'frame' ? raf(fn) : raf(now => {
    tick = (tick ?? now) + 1000/60;
    if (!job) return fn(tick);
    const run = job, n = run.frame++;
    if (n === 0) {
      release();
      if (run.view === 'swim') {
        __game.look({ eye: [14,__game.H(14,12)+1.65,12], yaw: -Math.PI/2, pitch: -0.82 });
      } else __game.look(run.view);
    }
    if (run.view === 'swim') {
      if (n === 48) key('keydown','KeyW');
      if (n === 92) key('keydown','ShiftLeft');
      if (n === 136) key('keydown','KeyD');
    }
    const record = n >= 48 && n < 228;
    let query;
    if (record && n % 5 === 0 && ext) {
      query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    }
    const start = performance.now();
    fn(tick);
    const cpu = performance.now() - start;
    if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); run.pending.push(query); }
    if (record) {
      run.cpu.push(cpu); run.intervals.push(now-run.last);
      if (run.view === 'swim' && n % 30 === 0 && !__game.state().player.swimming) run.dry++;
    }
    run.last = now;
    poll(run);
    if (n === 227) { release(); run.state = __game.state(); }
    if (n >= 228 && !run.pending.length) {
      job = null; run.resolve();
    }
  });
  window.measureRoute = async view => {
    gl = document.querySelector('#gl').getContext('webgl2');
    ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const run = { view, frame: 0, cpu: [], intervals: [], gpu: [], pending: [], disjoint: 0, dry: 0 };
    await new Promise(resolve => { run.resolve = resolve; job = run; });
    const quantiles = values => {
      const sorted = [...values].sort((a,b) => a-b);
      const at = p => sorted.length ? +sorted[Math.ceil(sorted.length*p)-1].toFixed(3) : null;
      return { n: sorted.length, mean: sorted.length ? +(values.reduce((a,b) => a+b, 0)/values.length).toFixed(3) : null,
        median: at(.5), p95: at(.95) };
    };
    return { view, wallMs: quantiles(run.intervals), cpuMs: quantiles(run.cpu), gpuMs: quantiles(run.gpu),
      over25ms: run.intervals.filter(v => v>25).length, disjoint: run.disjoint, dry: run.dry, end: run.state.player,
      samples: __game.samples, hdr: __game.hdr, grass: run.state.instances.grassDrawn, glError: gl.getError() };
  };
}

(async () => {
  const uncapped = process.env.UNCAPPED === '1';
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || undefined,
    args: uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [] });
  try {
    const page = await browser.newPage({viewport: {width,height}, deviceScaleFactor: 1});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(installMeter);
    await page.goto(url);
    await page.waitForFunction(() => window.__game?.ready || document.querySelector('#err')?.textContent, null, {timeout:120000});
    assert.equal(await page.locator('#err').textContent(), '');
    await page.locator('#go').click();
    const views = process.env.ROUTE ? [process.env.ROUTE] : ['swim','shore','falls'];
    const routes = [];
    for (const view of views) {
      const result = await page.evaluate(v => measureRoute(v), view);
      assert.equal(result.glError, 0);
      if (view === 'swim') {
        assert.equal(result.dry, 0);
        assert.ok(Math.hypot(result.end.x-14,result.end.z-12)>5);
      }
      routes.push(result);
    }
    const specs = await page.evaluate(() => {
      const gl = document.querySelector('#gl').getContext('webgl2');
      const gpu = gl.getExtension('WEBGL_debug_renderer_info');
      const resources = performance.getEntriesByType('resource').filter(e => e.name.startsWith(location.origin));
      return { renderer: gpu && gl.getParameter(gpu.UNMASKED_RENDERER_WEBGL), canvas: [gl.drawingBufferWidth,gl.drawingBufferHeight],
        instances: __game.state().instances, resourceRequests: resources.length,
        decodedBytes: resources.reduce((s,r)=>s+r.decodedBodySize,0), encodedBytes: resources.reduce((s,r)=>s+r.encodedBodySize,0) };
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({url,width,height,uncapped,chrome:browser.version(),specs,routes}, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
