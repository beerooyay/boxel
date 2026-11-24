// Tarnished Promise: four acres of lake shore on Tarn, under a ringed giant.
//
// The world remembers you through three boxel fields on the unbounded plane of 12.5 cm cells:
//   glow      bioluminescence in the moss and the water   D 8 cells²/s, k 0.3/s, 60 steps/s
//   moisture  wet feet, splashes, spore rain               D 3 cells²/s, k 0.04/s, 15 steps/s
//   wear      trails packed into the soil                  no spread, k 0.008/s, 15 steps/s
// Each is certified to stay within 1/255 of computing every cell, and only the 16 × 16 blocks
// that can still matter exist. The renderer sees the map through one R8 texture per field and
// re-uploads exactly the blocks the engine holds, clearing the ones it lets go.

import { load } from '../ffi/boxel.js';

const HALF = 64;                                          // the map runs 128 m a side, centred on the origin
const N = 1024, CELL = 0.125, EXTENT = N * CELL;         // the part of the fields the renderer sees: the whole map
const LAKE = [-6, 8];                                     // lake centre (x, z)
const WATER = 0;                                          // water level
const BOXEL = 0, DENSE = 1;
const MODE_NAME = { 0: 'boxel', 1: 'dense' };
const qs = new URLSearchParams(location.search);
const TEST = qs.has('test');
const touch = matchMedia('(pointer: coarse)').matches;
if (touch) document.body.classList.add('touch');

// ---------------------------------------------------------------- noise + terrain (CPU)
function hash2(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, o = 4) { let s = 0, a = 0.5; for (let i = 0; i < o; i++) { s += a * vnoise(x, y); x = x * 2.03 + 17; y = y * 2.03 + 5; a *= 0.5; } return s; }
function ridged(x, y) { let s = 0, a = 0.55; for (let i = 0; i < 5; i++) { const v = 1 - Math.abs(vnoise(x, y) * 2 - 1); s += a * v * v; x = x * 2.1 + 3; y = y * 2.1 + 9; a *= 0.5; } return s; }
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// the lake's outline: an ellipse pushed around by lobes, coves and noise, so no stretch of shore is a circle. Measured
// in half-size coordinates, so the lake is twice the size the noise was drawn for and keeps its shape.
function lakeD(x, z) {
  x *= 0.5; z *= 0.5;
  const dx = (x - LAKE[0] * 0.5) / 1.2, dz = (z - LAKE[1] * 0.5) / 0.95, th = Math.atan2(dz, dx);
  const wob = 1 + 0.17 * Math.sin(3 * th + 1.1) + 0.09 * Math.sin(5 * th - 0.4) + 0.05 * Math.sin(8 * th + 2.0)
    + 0.24 * (fbm(x * 0.07 + 31, z * 0.07 - 12, 3) - 0.5);
  return Math.hypot(dx, dz) / wob / 1.1;
}
const ISLET = [LAKE[0] + 6.8, LAKE[1] - 5.2];
const OUTCROP = [34, -30];                                // a rocky rise north-east of the lake
function outcrop(x, z) { return 1 - sm(9, 27, Math.hypot(x - OUTCROP[0], (z - OUTCROP[1]) * 1.25)); }
function Hbase(x, z) {
  // meadow: small undulation on rolling swells
  const meadow = 0.7 + 1.1 * fbm(x * 0.045 + 3, z * 0.045 - 1) + 0.25 * fbm(x * 0.22, z * 0.22, 3) + 3.2 * (fbm(x * 0.017 - 7, z * 0.017 + 5, 3) - 0.4);
  const d = lakeD(x, z);
  // a wadeable shelf all round the shore, then a drop into the basin
  const bowl = -0.6 * (1 - sm(8.5, 10.8, d)) - 4.4 * (1 - sm(1, 8.5, d)) - 0.35;
  const t = sm(9.6, 14, d);
  let h = bowl * (1 - t) + meadow * t;
  const ri = Math.hypot(x - ISLET[0], z - ISLET[1]) * 0.5;
  if (ri < 7) h += 2.6 * Math.exp(-ri * ri / 5) * (1 - t);
  // the outcrop: broken ridges stepped into ledges, steep enough to stand as bare stone
  const o = outcrop(x, z);
  if (o > 0) { const rg = ridged(x * 0.055 + 4, z * 0.055 - 2); h += o * (2 + 7 * rg + 1.2 * Math.round(rg * 4) / 4) * t; }
  h += (hills(x, z) + summit(x, z)) * t;
  const e = Math.hypot(x, z * 1.05);
  h += sm(40, 76, e) * (4 + 8 * fbm(x * 0.04 + 9, z * 0.04 + 2));
  const m = sm(84, 520, e);
  if (m > 0) h += m * m * (18 + 115 * ridged(x * 0.0035 + 2, z * 0.0035 - 4)) + sm(84, 170, e) * 6 * fbm(x * 0.02, z * 0.02);
  return h;
}
// grassy hills with broken crowns: [x, z, radius, height, rock, seed, stretch, turn]
const HILLS = [
  [-48, 31, 15, 8, 0.8, 11, 1.3, 0.6],
  [15, -51, 13, 6.5, 0.5, 23, 1.2, 2.1],
  [53, 5, 12, 7.5, 0.9, 37, 1.4, -0.4],
  [-53, -4, 11, 5.5, 0.6, 41, 1.15, 1.2],
  [37, 48, 12, 6, 0.7, 53, 1.3, 0.3],
];
/** How far into hill k the point is: 1 at its heart, 0 past its foot. */
function hillP(x, z, k) {
  const [cx, cz, R, , , , asp, ang] = HILLS[k], dx = x - cx, dz = z - cz, c = Math.cos(ang), sn = Math.sin(ang);
  return 1 - sm(R * 0.12, R, Math.hypot((dx * c + dz * sn) / asp, -dx * sn + dz * c));
}
function hills(x, z) {
  let h = 0;
  for (let k = 0; k < HILLS.length; k++) {
    const p = hillP(x, z, k); if (p <= 0) continue;
    const [, , , ht, rock, seed] = HILLS[k], rg = ridged(x * 0.06 + seed, z * 0.06 - seed * 0.7);
    h += ht * p * (0.85 + 0.3 * (fbm(x * 0.05 + seed, z * 0.05, 3) - 0.5)) + rock * p * p * (2.6 * rg + Math.round(rg * 4) / 4);
  }
  return h;
}
// the summit: twice the outcrop, north-west across the lake. A broad foot, a steep shoulder of broken rock scored by
// gullies, and a flat crown for the lookout
const SUMMIT = { x: -36, z: -36, R: 27, top: 20.5, crown: 0.2 };
function summitQ(x, z) { return Math.hypot((x - SUMMIT.x) * 0.92, (z - SUMMIT.z) * 1.08) / SUMMIT.R; }
function summit(x, z) {
  const q = summitQ(x, z); if (q >= 1) return 0;
  const f = 1 - sm(SUMMIT.crown, 1, q), rg = ridged(x * 0.07 - 3, z * 0.07 + 8);
  const gully = ridged(x * 0.16 + 5, z * 0.16 - 1) * 0.45 + rg * 0.55, th = Math.atan2(z - SUMMIT.z, x - SUMMIT.x);
  const spur = 1 - Math.abs(Math.sin(th * 3.5 + 1.6 * fbm(x * 0.05 + 2, z * 0.05 - 6, 3)));   // ridges running down from the crown
  return SUMMIT.top * Math.pow(f, 1.35) + (5 * (gully - 0.42) + 3.4 * (spur - 0.5)) * Math.sin(Math.PI * Math.min(1, f * 1.15)) + 0.25 * fbm(x * 0.4, z * 0.4, 2) * f;
}
/** Bare stone: the outcrop, the crowns of the hills, the summit's upper slopes. 0..1 */
function rocky(x, z) {
  let r = outcrop(x, z), q = summitQ(x, z);
  if (q < 1) r = Math.max(r, 1 - sm(0.35, 0.62, q));
  for (let k = 0; k < HILLS.length; k++) r = Math.max(r, HILLS[k][4] * sm(0.55, 0.9, hillP(x, z, k)));
  return r;
}

/** A path on the ground: a polyline with its arc length and a coarse grid of its segments, for nearest-point queries. */
class Path {
  constructor(pts, reach) {
    Object.assign(this, { p: pts, s: [0], grid: new Map() });
    for (let i = 1; i < pts.length; i++) this.s.push(this.s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.length = this.s[this.s.length - 1];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      for (let gx = Math.floor((Math.min(ax, bx) - reach) / 4); gx <= Math.floor((Math.max(ax, bx) + reach) / 4); gx++)
        for (let gz = Math.floor((Math.min(az, bz) - reach) / 4); gz <= Math.floor((Math.max(az, bz) + reach) / 4); gz++) {
          const k = gx * 4096 + gz; if (!this.grid.has(k)) this.grid.set(k, []); this.grid.get(k).push(i);
        }
    }
  }
  /** The nearest point on the path, if the path comes within reach: distance, arc length, and the unit tangent. */
  near(x, z) {
    const list = this.grid.get(Math.floor(x / 4) * 4096 + Math.floor(z / 4)); if (!list) return null;
    let best = null;
    for (const i of list) {
      const [ax, az] = this.p[i], [bx, bz] = this.p[i + 1], ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
      const u = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / l2)), d = Math.hypot(x - ax - ex * u, z - az - ez * u);
      if (!best || d < best.d) { const l = Math.sqrt(l2); best = { d, s: this.s[i] + u * l, tx: ex / l, tz: ez / l }; }
    }
    return best;
  }
  /** The point at arc length s, and the tangent there: [x, z, tx, tz]. */
  at(s) {
    s = Math.min(this.length, Math.max(0, s));
    let lo = 0, hi = this.s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.s[m] <= s) lo = m; else hi = m; }
    const [ax, az] = this.p[lo], [bx, bz] = this.p[hi], l = this.s[hi] - this.s[lo] || 1, u = (s - this.s[lo]) / l;
    return [ax + (bx - ax) * u, az + (bz - az) * u, (bx - ax) / l, (bz - az) / l];
  }
}
/** Round the corners of a polyline (Chaikin), then lay points along it every `step` metres. */
function smoothPath(pts, rounds, step) {
  for (let k = 0; k < rounds; k++) {
    const out = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) { const [a, b] = [pts[i], pts[i + 1]]; out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); }
    out.push(pts[pts.length - 1]); pts = out;
  }
  const rough = new Path(pts, 0), even = [];
  for (let t = 0; t <= rough.length; t += step) even.push(rough.at(t).slice(0, 2));
  even.push(pts[pts.length - 1]);
  return even;
}
/** A height along a path, sampled every half metre and evened out over a few metres either way. */
function profile(path, f, span) {
  const n = Math.ceil(path.length / 0.5) + 1, raw = Float64Array.from({ length: n }, (_, i) => f(...path.at(i * 0.5).slice(0, 2), i * 0.5)), out = new Float64Array(n);
  const k = Math.round(span / 0.5);
  for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) { a += raw[j]; c++; } out[i] = a / c; }
  return out;
}
const along = (table, s) => { const f = Math.min(table.length - 1.001, Math.max(0, s / 0.5)), i = Math.floor(f); return table[i] + (table[i + 1] - table[i]) * (f - i); };

// the river: it rises in a spring under the north rim, cascades down a gorge it has cut, wanders past the summit's foot
// and runs into the lake. Its surface only ever falls downstream: the lowest the land allows, as you go down it.
const RIVER = new Path(smoothPath([[-9, -70], [-11, -60], [-6, -50], [-11, -39], [-6, -29], [-9, -19], [-6, -9], [-5, -2]], 3, 0.5), 8);
const riverW = (s) => 1.15 + 1.1 * s / RIVER.length + 1.6 * (1 - sm(0, 5, s));
const riverDepth = (s) => 0.35 + 0.35 * s / RIVER.length;
const RIVER_WS = (() => {
  const t = profile(RIVER, (x, z) => Hbase(x, z) - 0.5, 0);
  for (let i = 1; i < t.length; i++) t[i] = Math.min(t[i], t[i - 1]);
  const sm2 = Float64Array.from(t, (_, i) => { let a = 0, c = 0; for (let j = Math.max(0, i - 5); j <= Math.min(t.length - 1, i + 5); j++) { a += t[j]; c++; } return a / c; });
  for (let i = 0; i < sm2.length; i++) sm2[i] = Math.max(WATER, i ? Math.min(sm2[i], sm2[i - 1]) : sm2[i]);
  return sm2;
})();
const riverWS = (s) => along(RIVER_WS, s);
/** How fast the river runs at s, from how steeply it falls there. */
const riverSpeed = (s) => Math.min(2.4, 0.55 + 9 * Math.max(0, riverWS(s - 1) - riverWS(s + 1)) / 2);
function riverCarve(x, z, h) {
  const n = RIVER.near(x, z); if (!n || n.d > 9) return h;
  const w = riverW(n.s), ws = riverWS(n.s), d = n.d;
  if (ws <= WATER + 0.01 && h < ws) return h;
  if (d < w) return Math.min(h, ws - riverDepth(n.s) * (1 - (d / w) ** 2) - 0.04);
  const bank = ws - 0.04 + (d - w) * 0.9 + (d - w) ** 2 * 0.12;
  // the land never sits below the water beside the channel: a low natural levee where it would
  return Math.max(Math.min(h, bank), ws + 0.06 - Math.max(0, d - w - 0.8) * 0.45);
}

// the summit trail: from the lake's north-west shore, switchbacks up the lake face, onto the crown and out to the lookout
const LOOKOUT = (() => { const th = Math.atan2(44 * 1.08, 30 * 0.92); return { th, x: SUMMIT.x + Math.cos(th) * 4.3 / 0.92, z: SUMMIT.z + Math.sin(th) * 4.3 / 1.08 }; })();
const TRAIL = (() => {
  const at = (r, th) => [SUMMIT.x + Math.cos(th) * r / 0.92, SUMMIT.z + Math.sin(th) * r / 1.08], th = LOOKOUT.th;
  const pts = [[-13, -20.5], [-17, -21.5]];
  [23, 20, 17, 14.2, 11.6, 9.2, 7.1].forEach((r, k) => pts.push(at(r, k % 2 ? th - 0.5 : th + 0.85 - k * 0.05)));
  pts.push(at(4.4, th - 0.45), at(3.2, th - 0.15), [LOOKOUT.x, LOOKOUT.z]);
  return new Path(smoothPath(pts, 3, 0.4), 3);
})();
const TRAIL_H = profile(TRAIL, (x, z) => riverCarve(x, z, Hbase(x, z)), 1.5);
function trailCarve(x, z, h) {
  const n = TRAIL.near(x, z); if (!n || n.d > 2.4) return h;
  const hc = along(TRAIL_H, n.s), b = 1 - sm(0.7, 2.4, n.d);
  return h + (hc - h) * b * 0.9 - 0.07 * (1 - sm(0, 0.7, n.d));
}
/** The ground: the land, cut by the river and the trail. */
function H(x, z) { return trailCarve(x, z, riverCarve(x, z, Hbase(x, z))); }
/** The surface of the water over (x, z): the river where it runs above the lake, else the lake. */
function waterAt(x, z) {
  const n = RIVER.near(x, z);
  if (n && n.d < riverW(n.s) + 0.4) { const w = riverWS(n.s); if (w > WATER + 0.02) return w; }
  return WATER;
}
function normalAt(x, z, e = 0.15) {
  const hx = H(x + e, z) - H(x - e, z), hz = H(x, z + e) - H(x, z - e);
  const l = Math.hypot(hx, 2 * e, hz);
  return [-hx / l, 2 * e / l, -hz / l];
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ---------------------------------------------------------------- the field engine: boxel, Rust compiled to wasm
const TOLERANCE = 1 / 255;
const SPECS = {
  glow: { spread: 8 / 60, fade: 0.3 / 60, hz: 60, events: 1024 },
  moist: { spread: 3 / 15, fade: 0.04 / 15, hz: 15, events: 64 },
  wear: { spread: 0, fade: 0.008 / 15, hz: 15, events: 1024 },
};
const cellOf = (m) => Math.floor(m / CELL);

/** One field and the texture that shows it. boxel: a certified field on the whole plane, uploaded block by block
 *  into a copy of the texture and sent a band of block rows at a time. Dense: the full computation over the map
 *  alone, uploaded whole every step. */
class Layer {
  constructor(boxel, spec, tex) { Object.assign(this, { boxel, spec, tex, acc: 0, stepped: 0, copy: new Uint8Array(N * N), lo: new Int32Array(N / 16), hi: new Int32Array(N / 16) }); }
  set(mode) {
    this.f?.free(); this.g?.free(); this.f = this.g = null; this.acc = 0;
    if (mode === BOXEL) this.f = this.boxel.field({ spread: this.spec.spread, fade: this.spec.fade, tolerance: TOLERANCE, events: this.spec.events });
    else this.g = this.boxel.grid(this.spec, -N / 2, -N / 2, N);
    clearTexture(this.tex); this.copy.fill(0);
    this.changed = false;
  }
  deposit(x, z, r, a) { (this.f || this.g).deposit(cellOf(x), cellOf(z), r, a); this.changed = true; }
  rain(a) { (this.f || this.g).rain(a); }
  get sheet() { return this.f ? this.f.sheet : this.g.sheet; }
  /** Take the steps owed for `dt` seconds at this field's own rate, a few at most. */
  advance(dt) {
    this.acc = Math.min(this.acc + dt * this.spec.hz, 4);
    const n = Math.floor(this.acc);
    if (n === 0) return;
    this.acc -= n;
    this.stepped += n * (this.f ? this.f.awake * 256 : N * N);
    (this.f || this.g).step(n);
    this.changed = true;
  }
  /** Send what changed to the texture. Returns bytes uploaded. */
  upload() {
    if (!this.changed) return 0;
    this.changed = false;
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const M = this.copy;
    if (this.g) {
      for (let y = 0; y < N; y++) quantise(this.g.row(y - N / 2), M, y * N);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RED, gl.UNSIGNED_BYTE, M);
      return N * N;
    }
    const half = N / 32, { lo, hi } = this;
    lo.fill(N); hi.fill(0);
    const put = (bx, by, v) => {
      if (bx < -half || bx >= half || by < -half || by >= half) return;
      const X = (bx + half) * 16, row = by + half;
      for (let r = 0; r < 16; r++) {
        const at = (row * 16 + r) * N + X;
        if (v) quantise(v.subarray(r * 16, r * 16 + 16), M, at); else M.fill(0, at, at + 16);
      }
      lo[row] = Math.min(lo[row], X); hi[row] = Math.max(hi[row], X + 16);
    };
    this.f.freed((bx, by) => put(bx, by, null));
    this.f.forgetFreed();
    this.f.blocks(put);
    let bytes = 0;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, N);
    for (let row = 0; row < lo.length; row++) {
      if (hi[row] <= lo[row]) continue;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, lo[row], row * 16, hi[row] - lo[row], 16, gl.RED, gl.UNSIGNED_BYTE, M, row * 16 * N + lo[row]);
      bytes += (hi[row] - lo[row]) * 16;
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    return bytes;
  }
  stats() { return this.f ? this.f.stats() : { blocks: N * N / 256, bytes: N * N * 8, live: 0, violations: 0, bound: 0 }; }
}
function quantise(src, dst, at) { for (let i = 0; i < src.length; i++) { const v = src[i] * 255 + 0.5; dst[at + i] = v > 255 ? 255 : v; } }

async function loadEngine() {
  return { kind: 'boxel · Rust → wasm', boxel: await load(fetch('boxel.wasm')) };
}

// ---------------------------------------------------------------- GL helpers
const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: TEST, powerPreference: 'high-performance' });
if (!gl) fail('WebGL2 is not available in this browser.');
function fail(msg) { const el = document.getElementById('err'); el.hidden = false; el.textContent = msg; throw new Error(msg); }

function shader(type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); console.error(src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')); fail('shader: ' + log); }
  return s;
}
function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, HEAD + vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, HEAD + COMMON + fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) fail('link: ' + gl.getProgramInfoLog(p));
  const cache = {};
  p.u = (n) => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(p, n)));
  return p;
}
function vao(attribs, index) {
  const v = gl.createVertexArray(); gl.bindVertexArray(v);
  for (const a of attribs) {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, a.data, a.usage || gl.STATIC_DRAW);
    gl.enableVertexAttribArray(a.loc); gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
    if (a.div) gl.vertexAttribDivisor(a.loc, a.div);
    a.buffer = b;
  }
  if (index) { const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW); }
  gl.bindVertexArray(null);
  return v;
}

// HDR when the device can render to float (Corey's pipeline); otherwise the same passes in 8 bits
const HDR = !!(gl && gl.getExtension('EXT_color_buffer_float'));
const CFMT = HDR ? gl.RGBA16F : gl.RGBA8, CTYPE = HDR ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
const SAMPLES = gl ? Math.max(0, Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0)) : 0;

// ---------------------------------------------------------------- shaders
const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;
// a triangle that covers the screen
const FSQ = `out vec2 vUv; void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2. - 1., 0., 1.); }`;
// the lake's surface: a slow swell under two wind-driven wavetrains, a few centimetres high. x is the height, yz its gradient
const WAVES = `
vec3 waterWave(vec2 p, float t){
  vec2 k1 = vec2(0.21, 0.13), k2 = vec2(-0.27, 0.46), k3 = vec2(1.38, -0.8);
  float a1 = dot(p, k1) + t * 0.7, a2 = dot(p, k2) + t * 1.1, a3 = dot(p, k3) + t * 1.9;
  return vec3(0.035 * sin(a1) + 0.02 * sin(a2) + 0.008 * sin(a3), 0.035 * cos(a1) * k1 + 0.02 * cos(a2) * k2 + 0.008 * cos(a3) * k3);
}
`;
const COMMON = WAVES + `
uniform vec3 uSunDir, uSunCol, uCam, uPlanetDir;
uniform mat3 uSky;
uniform float uPix;
uniform samplerCube uMilky;
uniform float uTime, uExposure, uExtent, uSheet, uWind, uHDR, uNight, uBio;
uniform vec3 uStarDir;
uniform sampler2D uGlow, uGround, uWear;
#define PI 3.14159265
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
// cobbles: x = distance to the stone's centre, y = distance to its edge (F2 - F1), z = the stone's own hash
vec3 cobble(vec2 p){
  vec2 ip = floor(p), fp = fract(p); float d1 = 8., d2 = 8.; vec2 id1 = vec2(0.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j)); vec2 c = o + hash22(ip + o) * 0.8 + 0.1 - fp; float d = dot(c, c);
    if (d < d1) { d2 = d1; d1 = d; id1 = ip + o; } else if (d < d2) d2 = d;
  }
  return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), hash12(id1));
}
float fbm3(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 17.; a *= .5; } return s; }
vec3 glowCol(vec2 p){ return mix(vec3(0.12, 0.95, 0.85), vec3(0.62, 0.38, 1.0), smoothstep(0.25, 0.75, vnoise(p * 0.11))); }
float glowI(float g){ return 1. - exp(-g * 5.); }
vec2 fieldUV(vec2 xz){ return xz / uExtent + 0.5; }
const vec2 WIND_DIR = vec2(0.87, 0.5);
// Corey's gusts: two sine waves travelling across the world, so the wind visibly rolls over grass, leaves and water together
float windWave(vec2 p){ return sin(dot(p, vec2(0.31, 0.18)) + uTime * 1.25) * 0.55 + sin(dot(p, vec2(-0.23, 0.41)) * 1.7 + uTime * 2.3) * 0.3; }
// the flora's light breathes with the wind: the gust that bends the grass lifts the glow of what it passes, then lets it fall
float breath(vec2 p){ return 0.45 + 0.7 * smoothstep(-0.7, 0.85, windWave(p)); }
float inField(vec2 uv){ return step(0., uv.x) * step(0., uv.y) * step(uv.x, 1.) * step(uv.y, 1.); }

const vec3 STAR_COL = vec3(2.7, 1.9, 1.35);
vec3 skyBase(vec3 d){
  float h = d.y;
  vec3 c = mix(vec3(0.36, 0.18, 0.32), vec3(0.06, 0.10, 0.22), smoothstep(0.0, 0.2, h));
  c = mix(c, vec3(0.012, 0.018, 0.06), smoothstep(0.18, 0.9, h));
  vec3 n = mix(vec3(0.035, 0.06, 0.17), vec3(0.012, 0.03, 0.11), smoothstep(0.0, 0.25, h));
  n = mix(n, vec3(0.003, 0.007, 0.03), smoothstep(0.25, 0.95, h));
  c = mix(c, n, uNight);
  float s = max(dot(d, uStarDir), 0.);
  c += STAR_COL * (1. - uNight) * (0.05 * pow(s, 5.) + 0.25 * pow(s, 60.));
  c += vec3(0.10, 0.08, 0.20) * pow(max(dot(d, uPlanetDir), 0.), 4.) * 0.5;
  return mix(c, vec3(0.05, 0.04, 0.08), smoothstep(0.0, -0.25, h));
}
// ---- the bodies in Tarn's sky ----
// Each is a sphere on the sky: its direction P and its radius R on the tangent plane there. body() gives the share of
// the pixel it covers (anti-aliased over one pixel), the point on that plane, the sphere's normal and the plane's axes.
float body(vec3 d, vec3 P, float R, out vec2 q, out vec3 n, out vec3 T, out vec3 B){
  T = normalize(cross(P, vec3(0., 1., 0.))); B = cross(T, P);
  float dp = dot(d, P);
  q = vec2(dot(d, T), dot(d, B)) / max(dp, 1e-3);
  vec2 u = q / R;
  n = normalize(u.x * T + u.y * B - sqrt(max(0., 1. - dot(u, u))) * P);
  return dp > 0. ? clamp((R - length(q)) / max(uPix, 1e-5) + 0.5, 0., 1.) : 0.;
}
// starlight on a body: a soft terminator and a darkened limb, then Tarn's own sky in front of it, so a body in the day
// sky is washed with blue like a daytime moon. Bodies are dimmer at night, when the eye has opened up.
vec3 shade(vec3 surf, vec3 n, vec3 d, float soft){
  float mu = max(dot(n, -d), 0.), lit = smoothstep(-soft, soft + 0.22, dot(n, uStarDir));
  return surf * (lit * (0.6 + 0.4 * sqrt(mu)) + 0.01) * (1. - 0.42 * uNight) + skyBase(d) * 0.5;
}
// an axis leaning on the sky by lean, and latitude and longitude on the sphere about it; the longitude's seam is always
// on the far side, so the bands can turn
vec2 latLon(vec3 n, vec3 P, vec3 T, vec3 B, float lean, float turn){
  vec3 axis = normalize(B * cos(lean) - T * sin(lean));
  vec3 e2 = normalize(axis * dot(P, axis) - P), e1 = cross(axis, e2);
  return vec2(dot(n, axis), atan(dot(n, e1), dot(n, e2)) + turn);
}

// the amber giant: cream and ochre bands, rust belts, a red storm, an icy ring, and a moon just past the rings
vec3 amberGiant(vec3 d, vec3 c){
  vec3 P = uPlanetDir, T, B, nw; vec2 q; float R = 0.17, tilt = 0.38;
  float cov = body(d, P, R, q, nw, T, B);
  vec2 rq = vec2(q.x * cos(tilt) + q.y * sin(tilt), -q.x * sin(tilt) + q.y * cos(tilt));
  float rr = length(vec2(rq.x, rq.y / 0.2)), aa = clamp(1. - fwidth(rr) * 90., 0., 1.);
  if (dot(d, P) < 0.8) return c;
  float band = smoothstep(1.32 * R, 1.38 * R, rr) * (1. - smoothstep(2.2 * R, 2.28 * R, rr)) * (1. - 0.6 * smoothstep(1.7 * R, 1.75 * R, rr) * (1. - smoothstep(1.8 * R, 1.85 * R, rr)));
  vec3 ring = vec3(0.78, 0.84, 0.95) * band * mix(0.55, 0.55 + 0.45 * sin(rr * 95.) * sin(rr * 31.), aa) * 0.42 * (1. - 0.35 * uNight);
  vec3 axis = normalize(B * cos(tilt) - T * sin(tilt));
  float lat = dot(nw, axis);
  vec2 dv = (rq - vec2(0.05, -0.045)) * vec2(0.62, 1.); float rs = length(dv), sw = exp(-rs * rs / 0.0011);
  float ang = sw * 5.5; vec2 dvr = vec2(dv.x * cos(ang) - dv.y * sin(ang), dv.x * sin(ang) + dv.y * cos(ang));
  lat += (dvr.y - dv.y) * 2.2 * sw;
  float bands = sin(lat * 19. + sin(lat * 6. + q.x * 8.) * 1.6 + vnoise(q * 30. + dvr * 40. * sw) * 0.8);
  vec3 pc = mix(vec3(0.74, 0.47, 0.26), vec3(0.95, 0.84, 0.66), 0.5 + 0.5 * bands);
  pc = mix(pc, vec3(0.50, 0.22, 0.14), smoothstep(0.75, 0.95, abs(sin(lat * 7. + 1.3))) * 0.45);
  pc = mix(pc, vec3(0.92, 0.42, 0.28), smoothstep(0.03, 0.012, rs) * 0.6);
  pc = mix(pc, vec3(0.34, 0.1, 0.06), smoothstep(0.009, 0.0, rs) * 0.6);
  vec3 g = shade(pc, nw, d, 0.12) + vec3(0.95, 0.72, 0.5) * pow(1. - max(dot(nw, -d), 0.), 3.) * 0.2 * smoothstep(-0.1, 0.4, dot(nw, uStarDir));
  c = mix(c + ring, g + (rq.y > 0. ? vec3(0.) : ring), cov);
  // the moon, on an orbit in the ring plane, hidden while it passes behind
  float ph = uTime * 0.045;
  vec2 mo = vec2(cos(ph), sin(ph) * 0.2) * R * 3.1, mq = vec2(mo.x * cos(tilt) - mo.y * sin(tilt), mo.x * sin(tilt) + mo.y * cos(tilt));
  float Rm = R * 0.13; vec2 dm = q - mq; vec2 um = dm / Rm;
  float mcov = clamp((Rm - length(dm)) / max(uPix, 1e-5) + 0.5, 0., 1.) * (mo.y > 0. && length(mq) < R ? 1. - cov : 1.);
  if (mcov > 0.) {
    vec3 nm = normalize(um.x * T + um.y * B - sqrt(max(0., 1. - dot(um, um))) * P);
    float crater = smoothstep(0.62, 0.75, vnoise(um * 5. + 3.)) * 0.25 + smoothstep(0.55, 0.7, vnoise(um * 11. - 7.)) * 0.15;
    vec3 mc = vec3(0.64, 0.62, 0.70) * (0.8 + 0.25 * vnoise(um * 3.)) * (1. - crater);
    c = mix(c, shade(mc, nm, d, 0.06), mcov);
  }
  return c;
}

// the rose giant, larger and nearer: bands of light magenta and radiant orange, now and then a thread of bright yellow,
// and high white clouds combed out along its winds
vec3 roseGiant(vec3 d, vec3 c){
  vec3 P = normalize(vec3(0.327, 0.469, 0.821)), T, B, n; vec2 q; float R = 0.2;
  if (dot(d, P) < 0.9) return c;
  float cov = body(d, P, R, q, n, T, B);
  float halo = exp(-max(length(q) - R, 0.) * 60.) * (1. - cov) * 0.07 * (1. - 0.6 * uNight);
  if (cov <= 0.) return c + vec3(1., 0.55, 0.72) * halo * smoothstep(-0.2, 0.5, dot(normalize(q.x * T + q.y * B), uStarDir));
  vec2 ll = latLon(n, P, T, B, -0.24, uTime * 0.006);
  float lat = ll.x, lon = ll.y;
  // the bands are dragged through two passes of turbulence, so they curl, fold and break into waves at their edges
  vec2 w = vec2(lon * 1.5, lat * 7.);
  for (int i = 0; i < 2; i++) w += (vec2(fbm3(w * 1.15 + vec2(3.1, uTime * 0.01)), fbm3(w * 1.15 + vec2(-1.7, 5.2))) - 0.5) * vec2(1.8, 1.9);
  // and three vortices, ovals the bands wind into
  for (int i = 0; i < 3; i++) {
    vec2 c = vec2(-0.55 + 0.6 * float(i), 0.25 - 0.32 * float(i)) * vec2(1.5, 7.), dv = (w - c) * vec2(0.8, 1.);
    float sw = exp(-dot(dv, dv) / (0.55 + 0.25 * float(i))), ang = sw * (4. + 2. * float(i)) * (i == 1 ? -1. : 1.);
    w = c + vec2(dv.x * cos(ang) - dv.y * sin(ang), dv.x * sin(ang) + dv.y * cos(ang)) / vec2(0.8, 1.);
  }
  float y = w.y / 7. + 0.012 * sin(w.x * 9. + w.y * 3.);
  float b = 0.5 + 0.35 * sin(y * 14. + 0.7) + 0.15 * sin(y * 41. - 1.2);
  vec3 PINK = vec3(0.95, 0.5, 0.78), ORANGE = vec3(0.95, 0.36, 0.1), ROSE = vec3(0.78, 0.24, 0.48), YELLOW = vec3(1.0, 0.88, 0.3);
  vec3 s = mix(ORANGE, PINK, smoothstep(0.42, 0.6, b));
  s = mix(s, ROSE, smoothstep(0.8, 0.96, abs(sin(y * 6.3 + 2.))) * 0.55);
  float gold = smoothstep(0.93, 0.99, 0.5 + 0.5 * sin(y * 23. + 1.)) * smoothstep(0.62, 0.85, vnoise(vec2(lon * 1.6, y * 5.) + 1.7));
  s = mix(s, YELLOW, gold);
  s *= 0.9 + 0.2 * vnoise(vec2(lon * 9., y * 60.));
  vec2 cp = vec2(lon * 2.4 + uTime * 0.004, lat * 21.);
  float cl = smoothstep(0.54, 0.7, fbm3(cp + vec2(vnoise(cp * 0.5) * 1.3, 0.)));
  float shadow = smoothstep(0.54, 0.7, fbm3(cp + vec2(vnoise(cp * 0.5) * 1.3, 0.) + vec2(0.06, -0.35)));
  s *= 1. - 0.22 * shadow * (1. - cl);
  s = mix(s, vec3(1.0, 0.95, 0.97), cl * 0.92);
  float mu = max(dot(n, -d), 0.);
  vec3 g = shade(s * 0.82, n, d, 0.14) + vec3(1.0, 0.5, 0.75) * pow(1. - mu, 2.5) * 0.32 * smoothstep(-0.15, 0.4, dot(n, uStarDir)) * (1. - 0.4 * uNight);
  return mix(c, g, cov);
}

// an ocean world to the south-west, smaller than the giants and much nearer: deep blue seas, continents of red desert
// and pale green, white cloud and ice, a blue edge of air, the star's glint on the water; and two rings, one round its
// waist and one over its poles, so they cross
float ring2(vec2 q, float R, float tilt, float squash, float r0, float r1, out float front){
  vec2 rq = vec2(q.x * cos(tilt) + q.y * sin(tilt), -q.x * sin(tilt) + q.y * cos(tilt));
  float rr = length(vec2(rq.x, rq.y / squash));
  front = rq.y < 0. ? 1. : 0.;
  return smoothstep(r0 * R, r0 * R + 0.012 * R, rr) * (1. - smoothstep(r1 * R - 0.012 * R, r1 * R, rr)) * (0.65 + 0.35 * sin(rr / R * 60.) * sin(rr / R * 23.));
}
vec3 oceanWorld(vec3 d, vec3 c){
  vec3 P = normalize(vec3(-0.62, 0.48, 0.62)), T, B, n; vec2 q; float R = 0.135, tilt = -0.52;
  if (dot(d, P) < 0.9) return c;
  float cov = body(d, P, R, q, n, T, B);
  float fa, fb;
  float ra = ring2(q, R, tilt, 0.11, 1.5, 1.88, fa), rb = ring2(q, R, tilt + 1.5708, 0.16, 1.62, 2.02, fb);
  vec3 ringA = vec3(0.74, 0.78, 0.86) * ra * 0.34, ringB = vec3(0.86, 0.74, 0.7) * rb * 0.26;
  vec3 rings = (ringA + ringB) * (1. - 0.35 * uNight);
  if (cov <= 0.) return c + rings;
  vec2 ll = latLon(n, P, T, B, tilt, uTime * 0.012);
  vec3 sp = vec3(ll.x, sin(ll.y) * sqrt(1. - ll.x * ll.x), cos(ll.y) * sqrt(1. - ll.x * ll.x));
  float land = fbm3(sp.xy * 2.2 + 3.) * 0.55 + fbm3(sp.yz * 2.6 - 1.) * 0.45 + 0.06 * vnoise(sp.zx * 11.);
  float coast = smoothstep(0.5, 0.53, land);
  vec3 sea = mix(vec3(0.05, 0.2, 0.52), vec3(0.1, 0.42, 0.72), smoothstep(0.38, 0.5, land));
  float green = smoothstep(0.45, 0.6, vnoise(sp.yz * 5. + 2.) * 0.6 + abs(ll.x) * 0.5);
  vec3 ground = mix(vec3(0.66, 0.2, 0.12), vec3(0.58, 0.86, 0.46), green) * (0.85 + 0.25 * vnoise(sp.xy * 14.));
  vec3 s = mix(sea, ground, coast);
  s = mix(s, vec3(0.92, 0.95, 1.0), smoothstep(0.78, 0.9, abs(ll.x)));
  float cloud = smoothstep(0.55, 0.75, fbm3(vec2(ll.y * 2.4 + uTime * 0.008, ll.x * 9.) + vnoise(sp.xy * 4.)));
  s = mix(s, vec3(0.97), cloud * 0.8);
  float mu = max(dot(n, -d), 0.), lit = smoothstep(-0.1, 0.35, dot(n, uStarDir));
  vec3 g = shade(s, n, d, 0.1);
  g += vec3(1., 0.95, 0.85) * pow(max(dot(n, normalize(uStarDir - d)), 0.), 70.) * (1. - coast) * (1. - cloud) * lit * 0.6 * (1. - 0.4 * uNight);
  g += vec3(0.35, 0.6, 1.0) * pow(1. - mu, 2.6) * 0.45 * lit * (1. - 0.4 * uNight);
  return mix(c + rings, g + ringA * fa + ringB * fb, cov);
}

// a small ice world low over the far ridge, like Europa: frost plains crossed by long rust-brown cracks, mottled chaos
// terrain, a blue-white cap, and a thin bright limb
vec3 iceWorld(vec3 d, vec3 c){
  vec3 P = normalize(vec3(0.78, 0.2, -0.6)), T, B, n; vec2 q; float R = 0.05;
  if (dot(d, P) < 0.99) return c;
  float cov = body(d, P, R, q, n, T, B);
  if (cov <= 0.) return c;
  vec2 ll = latLon(n, P, T, B, 0.3, uTime * 0.01);
  vec3 sp = vec3(ll.x, sin(ll.y), cos(ll.y)) * 3.;
  float m1 = vnoise(sp.xy * 1.7 + 4.) * 0.6 + vnoise(sp.yz * 3.9) * 0.4;
  vec3 s = mix(vec3(0.86, 0.87, 0.88), vec3(0.93, 0.92, 0.88), m1);
  s = mix(s, vec3(0.66, 0.5, 0.38), smoothstep(0.6, 0.8, vnoise(sp.zx * 2.3 - 1.)) * 0.55);
  float cracks = 0.;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec3 k = normalize(vec3(sin(fi * 2.4 + 0.3), cos(fi * 1.7), sin(fi * 3.1 + 1.)));
    float a = abs(dot(n, k) + 0.05 * sin(dot(n, k.yzx) * 9. + fi));
    cracks = max(cracks, smoothstep(0.016, 0.004, a) * (0.5 + 0.5 * vnoise(sp.xy * 3. + fi)));
  }
  s = mix(s, vec3(0.5, 0.3, 0.2), cracks * 0.8);
  s = mix(s, vec3(0.78, 0.88, 1.0), smoothstep(0.62, 0.85, ll.x) * 0.7);
  float mu = max(dot(n, -d), 0.);
  vec3 g = shade(s, n, d, 0.05) + vec3(0.55, 0.72, 0.95) * pow(1. - mu, 4.) * 0.22 * smoothstep(-0.1, 0.3, dot(n, uStarDir));
  return mix(c, g, cov);
}

float cloudCover(vec3 d){
  if (d.y <= 0.015) return 0.;
  vec2 cu = d.xz / (d.y + 0.07) * 0.8 + WIND_DIR * uTime * 0.006;
  float cl = fbm3(cu * 1.2) * 0.75 + fbm3(cu * 3.1 + 7.) * 0.25;
  return smoothstep(0.56, 0.84, cl) * smoothstep(0.015, 0.2, d.y) * (1. - smoothstep(0.5, 0.9, d.y));
}
vec3 skyColor(vec3 d){
  vec3 c = skyBase(d);
  if (d.y > -0.02) {
    // the Milky Way of Tarn's galaxy, baked once into a cube map in the sky's own frame, which turns about the pole
    vec3 mw = texture(uMilky, uSky * d).rgb;
    c += mw * mw * (0.04 + 0.96 * uNight) * smoothstep(-0.02, 0.22, d.y) * 0.5;
  }
  c += STAR_COL * (1. - uNight) * 3. * smoothstep(0.99935, 0.99965, dot(d, uStarDir));
  c = iceWorld(d, c);
  c = oceanWorld(d, c);
  c = roseGiant(d, c);
  c = amberGiant(d, c);
  // clouds: soft wisps drifting downwind, lit warm on the star's side, silver-blue under the giant at night
  float cov = cloudCover(d);
  if (cov > 0.) {
    float sunS = pow(max(dot(d, uStarDir), 0.), 4.);
    vec3 sb = skyBase(d);
    vec3 cc = mix(sb * 1.35 + STAR_COL * 0.05 * sunS + vec3(0.02, 0.012, 0.03), sb * 1.6 + vec3(0.05, 0.07, 0.14) * pow(max(dot(d, uPlanetDir), 0.), 2.), uNight);
    c = mix(c, cc, cov * 0.6);
  }
  return c;
}
// what of the sky at d lets the stars through: the bodies hide them and the clouds dim them
float starsSeen(vec3 d){
  float o = 1. - cloudCover(d) * 0.85;
  vec3 P[4] = vec3[4](uPlanetDir, normalize(vec3(0.327, 0.469, 0.821)), normalize(vec3(-0.62, 0.48, 0.62)), normalize(vec3(0.78, 0.2, -0.6)));
  float R[4] = float[4](0.175, 0.205, 0.14, 0.053);
  for (int i = 0; i < 4; i++) { float c = dot(d, P[i]); if (c > 0. && length(cross(d, P[i])) < R[i] * c) o = 0.; }
  return o;
}
vec3 ambient(vec3 n){
  vec3 day = mix(vec3(0.02, 0.018, 0.035), vec3(0.05, 0.075, 0.15), n.y * 0.5 + 0.5) + vec3(0.05, 0.035, 0.09) * max(dot(n, uPlanetDir), 0.);
  vec3 nite = mix(vec3(0.006, 0.01, 0.025), vec3(0.025, 0.045, 0.11), n.y * 0.5 + 0.5) + vec3(0.04, 0.06, 0.13) * max(dot(n, uPlanetDir), 0.);
  return mix(day, nite, uNight);
}
vec3 pbr(vec3 albedo, float rough, float metal, vec3 N, vec3 V){
  vec3 L = uSunDir; vec3 Hh = normalize(L + V);
  float NdL = max(dot(N, L), 0.), NdV = max(dot(N, V), 1e-3), NdH = max(dot(N, Hh), 0.), VdH = max(dot(V, Hh), 0.);
  float a = max(rough * rough, 0.002), a2 = a * a; float dd = NdH * NdH * (a2 - 1.) + 1.;
  float D = a2 / (PI * dd * dd);
  float k = (rough + 1.) * (rough + 1.) / 8.;
  float G = NdV / (NdV * (1. - k) + k) * NdL / (NdL * (1. - k) + k);
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 F = F0 + (1. - F0) * pow(1. - VdH, 5.);
  vec3 spec = D * G * F / (4. * NdV * NdL + 1e-4);
  vec3 kd = (1. - F) * (1. - metal);
  vec3 col = (kd * albedo / PI + spec) * uSunCol * NdL;
  vec3 R = reflect(-V, N);
  vec3 env = mix(skyBase(R), ambient(N) * 1.4, rough);
  vec3 Fa = F0 + (max(vec3(1. - rough), F0) - F0) * pow(1. - NdV, 5.);
  return col + kd * albedo * ambient(N) * 2.4 + env * Fa * (1. - rough * 0.6);
}
vec3 fogged(vec3 col, vec3 wp){
  vec3 d = wp - uCam; float dist = length(d);
  float f = (1. - exp(-dist * 0.0013)) * (1. - 0.6 * smoothstep(0., 160., wp.y));
  // valley mist: thick near the water, thin on the slopes, heavier at night
  float mist = (1. - exp(-dist * 0.011)) * exp(-max(wp.y + 0.3, 0.) * 0.32) * (0.16 + 0.34 * uNight);
  vec3 vd = normalize(vec3(d.x, max(d.y, 0.02 * dist), d.z));
  vec3 fc = skyBase(vd) * 0.75;
  // the haze glows where it lies between you and the star
  fc += STAR_COL * pow(max(dot(normalize(d), uStarDir), 0.), 8.) * 0.07 * (1. - uNight);
  vec3 mc = mix(fc * 1.1 + vec3(0.03, 0.025, 0.05), vec3(0.025, 0.045, 0.11), uNight);
  return mix(mix(col, fc, clamp(f, 0., 1.)), mc, clamp(mist, 0., 0.85));
}
vec3 tonemap(vec3 c){ c *= uExposure; if (uHDR > 0.5) return min(c, vec3(48.)); c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14); return pow(clamp(c, 0., 1.), vec3(1. / 2.2)); }

// ---- Tarn's flora follows one set of rules ----
// Five pigments, from the cool shallows to the warm undergrowth. Every plant is near-black at the root, saturated
// through its body and pale at the tip; every plant takes the same sky, sun and backlight, glows from within at night,
// and answers the glow field where you stirred the ground beside it.
const vec3 TEAL = vec3(0.28, 0.88, 0.80), CYAN = vec3(0.42, 0.78, 1.0), VIOLET = vec3(0.72, 0.42, 0.98), MAGENTA = vec3(0.88, 0.30, 0.70), CRIMSON = vec3(0.84, 0.16, 0.34);
vec3 pigment(float h){
  h = clamp(h, 0., 1.) * 4.;
  return h < 1. ? mix(TEAL, CYAN, h) : h < 2. ? mix(CYAN, VIOLET, h - 1.) : h < 3. ? mix(VIOLET, MAGENTA, h - 2.) : mix(MAGENTA, CRIMSON, h - 3.);
}
vec3 floraRamp(vec3 tip, float u){
  vec3 root = tip * 0.04 + vec3(0.008, 0.012, 0.02), body = tip * vec3(0.30, 0.31, 0.36);
  return u < 0.5 ? mix(root, body, u * 2.) : mix(body, tip * 0.9, (u - 0.5) * 2.);
}
vec3 floraLight(vec3 gc, vec3 tip, vec3 N, vec3 V, float u, float self, float stir){
  if (dot(N, V) < 0.) N = -N;
  float ndl = max(dot(N, uSunDir), 0.) * 0.72 + 0.28;
  vec3 lit = gc * (ambient(N) * 2.35 + uSunCol * ndl * 0.3);
  lit += uSunCol * gc * pow(clamp(dot(-V, uSunDir), 0., 1.), 3.) * u * 0.4;
  lit += gc * self * (1. + 1.6 * uNight) * u * u;
  lit += tip * tip * stir * uBio * (0.25 + 1.1 * u * u);
  return lit;
}
// where a surface meets the lake: wet and dark under the water, a lace of foam on the line, a damp band above it
vec3 waterline(vec3 alb, vec3 wp, out float wet){
  float wl = wp.y - (${WATER.toFixed(1)} + waterWave(wp.xz, uTime).x);
  vec3 cb = cobble(wp.xz * 5.5 + wp.y * 3. + vec2(uTime * 0.12, -uTime * 0.09));
  float lace = smoothstep(0.1, 0.0, cb.y) * (0.6 + 0.4 * vnoise(wp.xz * 3. + uTime * 0.3));
  float line = smoothstep(0.13, 0.0, abs(wl - 0.03 * sin(uTime * 1.7 + wp.x * 2.)));
  wet = smoothstep(-0.06, 0.0, wl) * (1. - smoothstep(0.0, 0.22, wl));
  alb = mix(alb * (1. - 0.45 * wet), alb * vec3(0.62, 0.78, 0.8), smoothstep(0.0, -0.25, wl));
  return mix(alb, vec3(0.78, 0.84, 0.95), line * (0.45 + 0.55 * lace));
}
`;

const WORLD_VS = WAVES + `
uniform mat4 uVP; uniform float uMirror, uLodW;
uniform float uTime, uExtent, uSheet, uWind; uniform sampler2D uGlow, uGround, uWear;
vec2 fieldUV(vec2 xz){ return xz / uExtent + 0.5; }
const vec2 WIND_DIR = vec2(0.87, 0.5);
float windWave(vec2 p){ return sin(dot(p, vec2(0.31, 0.18)) + uTime * 1.25) * 0.55 + sin(dot(p, vec2(-0.23, 0.41)) * 1.7 + uTime * 2.3) * 0.3; }
vec4 project(vec3 w){ return uVP * vec4(w.x, w.y * uMirror, w.z, 1.); }
`;

const SKY = program(`
uniform vec3 uR, uU, uF; uniform vec2 uTan; uniform float uMirror;
out vec3 vDir;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2. - 1.;
  vec3 d = uF + p.x * uTan.x * uR + p.y * uTan.y * uU; d.y *= uMirror; vDir = d; gl_Position = vec4(p, 1., 1.); }`,
`in vec3 vDir; out vec4 o; void main(){ o = vec4(tonemap(skyColor(normalize(vDir))), 1.); }`);

const TERRAIN = program(WORLD_VS + `
in vec3 aPos; in vec3 aNor; out vec3 vWP; out vec3 vN;
void main(){ vWP = aPos; vN = aNor; gl_Position = project(aPos); }`,
`uniform float uClip; uniform sampler2D uRiver; in vec3 vWP; in vec3 vN; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec2 p = vWP.xz; vec2 uv = fieldUV(p); float inf = inField(uv);
  vec2 rv = texture(uRiver, uv).rg * inf;
  vec2 gr = vec2(texture(uGround, uv).r, texture(uWear, uv).r) * inf; float glow = texture(uGlow, uv).r * inf;
  float moist = min(1., gr.r + uSheet * inf), wear = gr.g;
  // the strip the lake keeps wet, breathing with the lapping
  float lap = 0.05 * sin(uTime * 0.9 + dot(vWP.xz, vec2(0.7, 0.4)) * 0.8) + 0.035 * sin(uTime * 1.7 + vWP.x * 1.3);
  float wetBand = (1. - smoothstep(0.02, 0.2 + lap, vWP.y)) * step(-0.05, vWP.y);
  moist = max(moist, max(wetBand * 0.85, rv.g * 0.75));
  float dist = length(vWP - uCam);
  vec3 N = normalize(vN);
  float dn = 1. - smoothstep(8., 45., dist);
  if (dn > 0.) {
    float e = 0.06, s = 2.6; float h0 = fbm3(p * s), hx = fbm3((p + vec2(e, 0.)) * s), hz = fbm3((p + vec2(0., e)) * s);
    N = normalize(N + dn * (1. - 0.7 * wear) * (1. - 0.6 * moist) * vec3(-(hx - h0), 0., -(hz - h0)) / e * 0.22);
  }
  float slope = 1. - N.y, y = vWP.y;
  float fine = 1. - smoothstep(30., 90., dist);
  float n1 = fbm3(p * 0.3), n2 = mix(0.5, vnoise(p * 2.7), fine), n3 = mix(0.45, vnoise(p * 9.), fine * fine);
  vec3 moss = mix(vec3(0.045, 0.09, 0.12), vec3(0.15, 0.08, 0.22), smoothstep(0.3, 0.7, n1)) * (0.8 + 0.4 * n2);
  vec3 sand = vec3(0.30, 0.22, 0.26) * (0.85 + 0.3 * n2);
  vec3 bed = vec3(0.09, 0.11, 0.12) * (0.75 + 0.5 * n2);
  vec3 rock = mix(vec3(0.15, 0.13, 0.20), vec3(0.30, 0.26, 0.34), n2);
  vec3 alb = moss; float rough = 0.88, metal = 0.;
  float shore = 1. - smoothstep(0.12, 0.45 + 0.25 * n1, y);
  alb = mix(alb, sand, shore); rough = mix(rough, 0.72, shore);
  float under = max(1. - smoothstep(-0.35, -0.05, y), rv.r * 0.9);
  alb = mix(alb, bed, under);
  float rk = max(smoothstep(0.3, 0.48, slope + 0.15 * n2), smoothstep(6., 12., y) * 0.8);
  alb = mix(alb, rock, rk); rough = mix(rough, 0.62, rk);
  float vein = rk * smoothstep(0.74, 0.8, n3) * (1. - smoothstep(12., 28., dist));
  metal = vein * 0.85; rough = mix(rough, 0.18, vein); alb = mix(alb, vec3(0.75, 0.62, 0.95), vein);
  float snow = smoothstep(45., 70., y + n1 * 18.) * (1. - smoothstep(0.5, 0.8, slope));
  alb = mix(alb, vec3(0.80, 0.76, 0.93), snow); rough = mix(rough, 0.5, snow);
  // cobbles on the beach and under the shallows, pebbles between them; wet ones go dark and glossy
  float cobZ = (1. - smoothstep(0.25, 0.7, y)) * smoothstep(-1.4, -0.9, y) * (1. - smoothstep(14., 32., dist)) * (1. - rk);
  cobZ = max(cobZ, max(rv.r, rv.g * 0.5) * (1. - smoothstep(14., 32., dist)));
  if (cobZ > 0.01) {
    vec3 cb = cobble(p * 3.1), pb = cobble(p * 8.5 + 3.7);
    float stone = smoothstep(0.015, 0.07, cb.y), peb = smoothstep(0.02, 0.08, pb.y);
    vec3 sc = mix(mix(vec3(0.20, 0.18, 0.24), vec3(0.32, 0.29, 0.36), cb.z), vec3(0.17, 0.23, 0.25), step(0.72, cb.z));
    sc *= 0.75 + 0.4 * (1. - cb.x * 1.3);
    vec3 pc2 = mix(vec3(0.14, 0.12, 0.17), vec3(0.28, 0.25, 0.3), pb.z) * mix(0.55, 1., peb);
    vec3 cobA = mix(pc2, sc, stone * smoothstep(0.35, 0.6, vnoise(p * 0.7) + 0.3));
    float wcob = cobZ * (0.6 + 0.4 * vnoise(p * 0.45));
    alb = mix(alb, cobA, wcob); rough = mix(rough, 0.55, wcob);
  }
  alb = mix(alb, vec3(0.21, 0.15, 0.19), smoothstep(0.03, 0.6, wear) * 0.75); rough = mix(rough, 0.75, wear);
  alb *= 1. - 0.5 * moist; rough = mix(rough, 0.1, smoothstep(0.02, 0.5, moist) * 0.9);
  vec3 V = normalize(uCam - vWP);
  vec3 col = pbr(alb, rough, metal, N, V);
  col += glowCol(p) * uBio * glowI(glow) * 2.6 * (1. - 0.6 * under);
  col += glowCol(p) * (0.006 + 0.05 * uNight) * (1. - shore) * (1. - rk) * (1. - under) * smoothstep(0.55, 0.9, n3) * breath(p);
  o = vec4(tonemap(fogged(col, vWP)), 0.);
}`);

const ROCK = program(WORLD_VS + `
in vec3 aPos; in vec3 aNor; in vec4 aI; in vec4 aS;
out vec3 vWP; out vec3 vN; out float vH; out vec3 vLoc; out vec3 vNl;
void main(){
  float c = cos(aI.w), s = sin(aI.w);
  vec3 p = aPos * aS.xyz; p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
  vec3 n = aNor / aS.xyz; n = normalize(vec3(c * n.x - s * n.z, n.y, s * n.x + c * n.z));
  vWP = p + aI.xyz; vN = n; vH = aS.w; vLoc = aPos * aS.xyz; vNl = aNor; gl_Position = project(vWP);
}`,
`uniform float uClip; in vec3 vWP; in vec3 vN; in float vH; in vec3 vLoc; in vec3 vNl; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 N = normalize(vN); vec3 V = normalize(uCam - vWP);
  vec2 uv = fieldUV(vWP.xz); float inf = inField(uv); float glow = texture(uGlow, uv).r * inf;
  float dist = length(uCam - vWP);
  vec3 col;
  {
    vec3 lp = vLoc * 1.6 + vec3(vH * 17.);
    // a crack network laid on the stone from three sides (triplanar), so it never stretches
    vec3 aw = abs(normalize(vNl)); aw /= aw.x + aw.y + aw.z;
    float near = 1. - smoothstep(10., 30., dist);
    float crack = 0.;
    if (near > 0.) {
      float edge = cobble(lp.zy * 1.3).y * aw.x + cobble(lp.xz * 1.3).y * aw.y + cobble(lp.xy * 1.3).y * aw.z;
      crack = (1. - smoothstep(0.0, 0.05, edge)) * near;
      vec2 q = lp.xz * 3. + lp.y * 2.7; float e = 0.05; float h0 = vnoise(q), hx = vnoise(q + vec2(e, 0.)), hz = vnoise(q + vec2(0., e));
      N = normalize(N + near * vec3(-(hx - h0), 0., -(hz - h0)) / e * 0.07);
    }
    float n1 = vnoise(lp.xz * 0.9 + lp.y), n2 = vnoise(lp.xy * 6. + lp.z * 3.), speck = vnoise(lp.zx * 22. + lp.y * 9.);
    vec3 alb = mix(vec3(0.15, 0.135, 0.19), vec3(0.27, 0.24, 0.29), n1);
    alb = mix(alb, vec3(0.31, 0.28, 0.27), smoothstep(0.55, 0.8, n2) * 0.5);
    alb *= (0.85 + 0.3 * speck) * (0.92 + 0.08 * sin(vLoc.y * 9. + n1 * 4.));
    alb *= mix(0.72, 1.12, smoothstep(-0.4, 0.8, N.y));      // weathered tops pale, overhangs shadowed
    alb *= 1. - 0.62 * crack;
    float lich = smoothstep(0.7, 0.76, vnoise(lp.xz * 7. + lp.y * 5.)) * smoothstep(0.35, 0.6, vnoise(lp.zx * 1.1)) * (1. - crack);
    vec3 lichC = mix(vec3(0.38, 0.32, 0.16), vec3(0.16, 0.36, 0.34), step(0.5, fract(vH * 7.3)));
    alb = mix(alb, lichC * (0.7 + 0.3 * speck), lich * 0.5);
    float moss = smoothstep(0.5, 0.85, N.y) * smoothstep(0.35, 0.6, vnoise(vWP.xz * 1.4 + vH * 5.) + 0.15 * speck);
    alb = mix(alb, vec3(0.035, 0.085, 0.10) * (0.8 + 0.4 * speck), moss);
    float shoreWet;
    alb = waterline(alb, vWP, shoreWet);
    float wet = clamp(max(shoreWet, (texture(uGround, uv).r + uSheet) * inf), 0., 1.);
    alb *= (1. - 0.3 * wet) * mix(0.5, 1., smoothstep(-0.3, 0.4, vLoc.y));
    col = pbr(alb, mix(0.8 - 0.15 * lich, 0.14, wet * 0.9), 0., N, V);
    col += glowCol(vWP.xz + vH * 13.) * (uBio * glowI(glow) * 2.3 * moss + (0.008 + 0.05 * uNight) * moss);
    col += lichC * lich * (0.002 + 0.16 * uNight) * (0.6 + 0.4 * sin(uTime * 0.8 + vH * 30.)) * breath(vWP.xz);
  }
  o = vec4(tonemap(fogged(col, vWP)), 0.);
}`);

// crystal: clear, cool and faceted, a milky foot that clears toward the tip, veils of inclusions drifting up through it,
// a light inside that brightens toward the tip and breathes with the wind at night, and the glow you stir around it
const CRYSTAL = program(WORLD_VS + `
in vec3 aPos; in vec3 aNor; in vec4 aC; out vec3 vWP; out vec3 vN; out vec4 vC;
void main(){ vWP = aPos; vN = aNor; vC = aC; gl_Position = project(aPos); }`,
`uniform float uClip; in vec3 vWP; in vec3 vN; in vec4 vC; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 N = normalize(vN), V = normalize(uCam - vWP);
  vec2 uv = fieldUV(vWP.xz); float glow = texture(uGlow, uv).r * inField(uv);
  float u = clamp(vC.y, 0., 1.), seed = vC.z;
  vec3 tint = pigment(vC.x * 0.62), deep = tint * tint;
  float fres = pow(1. - abs(dot(N, V)), 3.);
  float facet = hash12(floor(N.xz * 40. + N.y * 17.));
  float bands = 0.5 + 0.5 * sin(u * 38. + seed * 20.);
  float veil = smoothstep(0.45, 0.8, vnoise(vec2(u * 7. + seed * 13., seed * 31. + dot(vWP, vec3(1.3, 0.4, 0.9)))));
  float milk = 1. - smoothstep(0., 0.55, u), shoreWet;
  vec3 body = deep * mix(0.07, 0.17, milk) * (0.8 + 0.35 * facet) * (1. - 0.3 * veil);
  vec3 col = pbr(waterline(body, vWP, shoreWet), 0.08, 0., N, V);
  float inner = (0.025 + 0.22 * uNight * breath(vWP.xz)) * (smoothstep(0.3, 1., u) * 1.4 + 0.15) * (0.8 + 0.2 * bands);
  // and the star shining through it from behind
  float through = pow(clamp(dot(-V, uSunDir), 0., 1.), 2.) * (0.4 + 0.6 * u) * (1. - 0.7 * uNight);
  col += deep * (inner + (0.012 + 0.22 * fres) * (1. + uNight) + uSunCol * through * 0.14) + deep * glow * 2. * uBio * (0.4 + 0.6 * u);
  o = vec4(tonemap(fogged(col, vWP)), 0.);
}`);

// alien junipers. The skeleton (a leaning, twisting trunk, limbs, twigs, foliage pads) is grown per tree on the CPU from
// a seed, so every tree is its own; the wood is one baked mesh and the foliage is Corey's blade again, packed into pads.
// Wood and leaves share the same sway, so the pads move with their branches.
const WOOD = program(WORLD_VS + `
in vec3 aPos; in vec3 aNor; in vec4 aW; in vec4 aB;
out vec3 vWP; out vec3 vN; out vec4 vW; out float vStir; out float vHue;
void main(){
  vec3 p = aPos; float flex = aW.x, g = windWave(aB.xy) * uWind;
  p.xz += WIND_DIR * g * 0.05 * aB.z * flex * flex;
  p.y -= abs(g) * 0.01 * aB.z * flex * flex;
  vWP = p; vN = aNor; vW = aW; vHue = aB.w;
  vStir = texture(uGlow, fieldUV(aB.xy)).r;
  gl_Position = project(p);
}`,
`uniform float uClip; in vec3 vWP; in vec3 vN; in vec4 vW; in float vStir; in float vHue; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 N = normalize(vN), V = normalize(uCam - vWP);
  // juniper bark: long fibrous strips that wander and twist a little as they climb, split by dark furrows, shredding
  // in places, with silver deadwood where the bark has gone
  float ang = vW.z, up = vW.y, sd = vW.w * 7.;
  float w1 = sin(11. * ang + up * 0.35 + 3. * vnoise(vec2(up * 0.9, sd)));
  float w2 = sin(19. * ang - up * 0.2 + 4. * vnoise(vec2(up * 1.7 + 3., sd + 4.)));
  float fiber = 0.62 * w1 + 0.38 * w2;
  float furrow = smoothstep(0.3, 0.95, -fiber);
  float shred = smoothstep(0.62, 0.85, vnoise(vec2(up * 3.2, sd * 3. + floor(ang * 11. / 6.2832))));
  vec2 ring = vec2(cos(ang), sin(ang));
  float fine = vnoise(vec2(up * 22., 0.) + ring * 2.9);
  float dead = smoothstep(0.6, 0.86, vnoise(ring * 0.8 + vec2(up * 0.6, up * 1.1) + vW.w * 9.));
  vec3 bark = mix(vec3(0.165, 0.115, 0.13), vec3(0.085, 0.058, 0.07), furrow) * (0.88 + 0.2 * fine);
  bark = mix(bark, vec3(0.2, 0.15, 0.15), shred * (1. - furrow) * 0.6);
  bark = mix(bark, vec3(0.4, 0.38, 0.44) * (0.85 + 0.25 * fine), dead * 0.85);
  // the strips stand proud of the furrows: a bump from the screen-space slope of their height
  float hgt = (fiber * 0.5 + 0.5) * (1. - dead) * 0.006 * (1. - smoothstep(4., 14., length(uCam - vWP)));
  vec3 dpx = dFdx(vWP), dpy = dFdy(vWP), r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  N = normalize(abs(det) * N - sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2));
  vec3 col = pbr(bark, mix(0.8, 0.55, dead), 0., N, V);
  vec3 tint = pigment(vHue * 0.55);
  col += tint * furrow * (1. - dead) * (0.012 + 0.24 * uNight * breath(vWP.xz) + 0.6 * (1. - exp(-vStir * 6.)) * uBio) * (0.6 + 0.4 * sin(uTime * 0.7 + up * 4. - vW.w * 9.));
  o = vec4(tonemap(fogged(col, vWP)), 0.);
}`);

const JLEAF = program(WORLD_VS + `
in vec4 aR; in vec4 aD; in vec4 aM; in vec4 aB;
out vec3 vWP; out float vU; out vec3 vN; out float vStir; out float vHue; out float vSeed;
void main(){
  int vid = gl_VertexID;
  float u = vid >= 12 ? 1. : float(vid / 2) / 6.;
  float side = vid >= 12 ? 0. : ((vid % 2 == 0) ? -1. : 1.);
  vec3 up = vec3(0., 1., 0.), dir = normalize(aD.xyz);
  float L = aD.w, lift = aM.x, droop = aM.y, W = aM.z * uLodW, seed = aM.w;
  vec3 sd = cross(up, dir); sd = length(sd) < 1e-3 ? vec3(1., 0., 0.) : normalize(sd);
  vec3 p = aR.xyz + dir * L * u + up * L * (lift * sin(u * 3.1416) - droop * u * u);
  float g = windWave(aB.xy) * uWind, flex = aR.w + 0.2 * u;
  p.xz += WIND_DIR * g * 0.05 * aB.z * flex * flex;
  p += sd * sin(uTime * 2.6 + seed * 40. + u * 3.) * 0.03 * u * L;
  float w = W * sin(min(1., u * 2.5) * 1.5708) * (1. - 0.5 * u);
  vec3 wd = normalize(sd + up * 0.4 * (seed - 0.5));
  p += wd * side * w * 0.5;
  vec3 tang = normalize(dir + up * (lift * 3.1416 * cos(u * 3.1416) - 2. * droop * u));
  vN = normalize(normalize(cross(wd, tang)) + wd * side * 0.8);
  vStir = texture(uGlow, fieldUV(aB.xy)).r;
  vWP = p; vU = u; vHue = aB.w; vSeed = seed;
  gl_Position = project(p);
}`,
`uniform float uClip; in vec3 vWP; in float vU; in vec3 vN; in float vStir; in float vHue; in float vSeed; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 tint = pigment(vHue * 0.55);
  vec3 gc = floraRamp(tint, pow(vU, 1.15)) * (0.56 + 0.4 * vSeed);
  float pulse = 0.6 + 0.4 * sin(uTime * 0.9 - vU * 5. + vSeed * 40.);
  vec3 lit = floraLight(gc, tint, normalize(vN), normalize(uCam - vWP), vU, 0.3 * pulse * breath(vWP.xz), 1. - exp(-vStir * 6.));
  o = vec4(tonemap(fogged(lit, vWP)), 0.);
}`);

// grass: Corey's blade (ceeboozwah/grass), ported. Three rows plus a tip, quadratic bend, width taper,
// rounded normals, rolling gust waves, a root-mid-tip ramp with patch noise and root AO, sun backlight through
// the tips. Wired to the certified fields: wear tramples it flat, moisture droops and darkens it, glow lights
// the tips you stirred. Instances are shuffled, so drawing a prefix is an even thinning (adaptive density).
const GRASS = program(WORLD_VS + `
in vec4 aG; in vec4 aR;
out vec3 vWP; out vec2 vGA; out float vGH; out float vGlow; out float vWet; out vec3 vN; out float vPatch;
void main(){
  int vid = gl_VertexID;
  float by = vid == 6 ? 1. : float(vid / 2) * 0.35;
  float side = vid == 6 ? 0. : ((vid % 2 == 0) ? -0.5 : 0.5);
  float a = aR.x * 6.2831853; vec2 ax = vec2(cos(a), sin(a)); vec2 fd = vec2(-ax.y, ax.x);
  vec2 uv = fieldUV(aG.xy); vec2 gr = vec2(texture(uGround, uv).r, texture(uWear, uv).r); float glow = texture(uGlow, uv).r;
  float wet = min(1., gr.r + uSheet), trample = smoothstep(0.04, 0.45, gr.g);
  float H = 0.34 * (0.62 + 0.76 * aR.y) * aR.w * (1. - 0.55 * trample);
  float reed = step(1.6, aR.w);
  float W0 = (0.05 + 0.03 * aR.z) * mix(1.9, 1.0, clamp(H / 0.2, 0., 1.)) * mix(1., 0.4, reed) * uLodW;
  float wd = W0 * pow(max(1. - by, 0.), 0.75);
  float lean = (0.10 + 0.32 * aR.z) * H + trample * 0.8 * H + wet * 0.22 * H;
  float sway = windWave(aG.xy) * uWind * 0.22 * H * (1. - 0.7 * trample);
  vec3 p = vec3(aG.x, aG.z, aG.y)
         + vec3(ax.x, 0., ax.y) * side * wd
         + vec3(0., by * H * (1. - 0.18 * by * by) * (1. - 0.7 * trample), 0.)
         + by * by * (vec3(fd.x, 0., fd.y) * lean + vec3(WIND_DIR.x, 0., WIND_DIR.y) * sway);
  vN = normalize(vec3(0., 1., 0.) + vec3(ax.x, 0., ax.y) * side * 0.9 + vec3(fd.x, 0., fd.y) * (0.15 + 0.35 * by));
  vGA = vec2(by, aR.z); vGH = H; vWP = p; vGlow = glow; vWet = wet; vPatch = aR.y;
  gl_Position = project(p);
}`,
`uniform float uClip; in vec3 vWP; in vec2 vGA; in float vGH; in float vGlow; in float vWet; in vec3 vN; in float vPatch; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  float y = clamp(vGA.x, 0., 1.);
  float g = pow(y, 1.45);
  g *= mix(0.72, 1., smoothstep(0.03, 0.3, vGH));
  g = mix(0.45, g, 0.85);
  // the meadow's colour drifts teal, cyan, violet across tens of metres, in a gradient, never a step
  float hue = smoothstep(0.12, 0.88, vnoise(vWP.xz * 0.03 + 3.) * 0.8 + vnoise(vWP.xz * 0.09 - 5.) * 0.2) * 0.5 + (vPatch - 0.5) * 0.03;
  vec3 tip = pigment(hue);
  vec3 gc = floraRamp(tip, g);
  float pn = vnoise(vWP.xz * 0.28) * 0.6 + vnoise(vWP.xz * 1.1) * 0.4;
  gc *= mix(0.8, 1.2, pn);
  gc = mix(gc, tip, smoothstep(0.55, 0.95, pn) * 0.2 * y);
  gc *= (0.88 + 0.24 * vGA.y) * mix(0.42, 1., smoothstep(0., 0.55, y)) * (1. - 0.35 * vWet);
  vec3 lit = floraLight(gc, tip, normalize(vN), normalize(uCam - vWP), y, 0.17 * breath(vWP.xz), 0.);
  lit += glowCol(vWP.xz) * uBio * glowI(vGlow) * 2.6 * y * y;
  o = vec4(tonemap(fogged(lit, vWP)), 0.);
}`);

// understory: one blade, five plants. Rosettes (broad crimson leaves with a living midrib), ferns (fronds cut into
// leaflets in the fragment shader), glow tubes (capsules whose tips are lamps), coilferns (stalks that roll their tips
// into spirals) and lantern bells (arching stems that nod a glowing bulb). Each blade follows a centreline in its own
// plane; veins brighten at night and when you stir the ground beside them.
const PLANT = program(WORLD_VS + `
in vec4 aP; in vec4 aF; in vec4 aS2;
out vec3 vWP; out float vU; out float vSide; out vec3 vN; out float vType; out float vStir; out float vSeed; out float vHue;
// the centreline at u in [0, 1]: x out along the ground, y up
vec2 path(float type, float u, float L, vec4 S){
  if (type < 2.5) return vec2(L * S.x * sin(u * 1.5708), L * (S.y * u + S.z * sin(u * 3.1416) - S.w * u * u));
  if (type < 3.5) {
    float c = 0.62;
    if (u < c) return vec2(L * S.x * u, L * S.y * u);
    float k = (u - c) / (1. - c), a = k * 5.2, rad = L * 0.15 * (1. - 0.72 * k);
    return vec2(L * S.x * c + L * 0.15, L * S.y * c) + rad * vec2(-cos(a), sin(a));
  }
  return vec2(L * S.x * (1. - cos(u * 1.7)) * 1.25, L * S.y * sin(u * 2.5));
}
void main(){
  int vid = gl_VertexID;
  float u = vid >= 24 ? 1. : float(vid / 2) / 12.;
  float side = vid >= 24 ? 0. : ((vid % 2 == 0) ? -1. : 1.);
  float sc = aP.w, phi = aF.x, L = aF.y * sc, W = aF.z * sc * uLodW, type = aF.w;
  float seed = fract(phi * 7.31 + aP.x * 0.13);
  vec3 up = vec3(0., 1., 0.), dir = vec3(cos(phi), 0., sin(phi)), sd = vec3(-sin(phi), 0., cos(phi));
  vec2 c = path(type, u, L, aS2), t2 = normalize(path(type, min(u + 0.01, 1.), L, aS2) - path(type, max(u - 0.01, 0.), L, aS2));
  vec3 p = dir * c.x + up * c.y;
  float flex = type > 1.5 && type < 2.5 ? 0.3 : 1.;
  p.xz += WIND_DIR * windWave(aP.xz + dir.xz * c.x) * uWind * 0.18 * u * u * L * flex;
  p += sd * sin(uTime * 2.3 + seed * 30. + u * 3.) * 0.02 * u * L * flex;
  float w;
  if (type < 0.5) w = W * sin(min(1., u * 2.4) * 1.5708) * (1. - 0.6 * u * u);
  else if (type < 1.5) w = W * (1. - 0.72 * u) * sin(min(1., u * 4.) * 1.5708);
  else if (type < 2.5) w = W * (u < 0.85 ? 1. : sqrt(max(0., 1. - pow((u - 0.85) / 0.15, 2.))));
  else if (type < 3.5) w = W * (1. - 0.55 * u);
  else w = W * (0.28 + 1.2 * sin(clamp((u - 0.72) / 0.28, 0., 1.) * 3.1416));
  float tw = (seed - 0.5) * 1.6 * u * step(type, 1.5);
  vec3 wdir = normalize(sd * cos(tw) + up * sin(tw));
  p += wdir * side * w * 0.5;
  vec3 tang = normalize(dir * t2.x + up * t2.y);
  vN = normalize(normalize(cross(wdir, tang)) + wdir * side * (type > 1.5 ? 1.6 : 0.7));
  vStir = texture(uGlow, fieldUV(aP.xz)).r;
  vWP = p + aP.xyz; vU = u; vSide = side; vType = type; vSeed = seed; vHue = fract(aP.x * 0.21 + aP.z * 0.17);
  gl_Position = project(vWP);
}`,
`uniform float uClip; in vec3 vWP; in float vU; in float vSide; in vec3 vN; in float vType; in float vStir; in float vSeed; in float vHue; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  float u = vU, s = vSide;
  if (vType > 0.5 && vType < 1.5 && abs(s) > 0.16 + 0.84 * smoothstep(0.1, 0.65, abs(sin(u * 3.1416 * 15.)))) discard;
  // each species is a pigment and a vein; the ramp and the light are everyone's
  vec3 tip, vein;
  if (vType < 0.5) { tip = mix(CRIMSON, MAGENTA, vHue * 0.6); vein = CYAN; }
  else if (vType < 1.5) { tip = TEAL * 0.68; vein = TEAL; }
  else if (vType < 2.5) { tip = mix(CYAN, vec3(1.), 0.35); vein = CYAN; }
  else if (vType < 3.5) { tip = mix(VIOLET, CYAN, vHue * 0.4); vein = VIOLET; }
  else { tip = mix(MAGENTA, VIOLET, vHue * 0.5); vein = mix(MAGENTA, vec3(1.), 0.25); }
  vec3 gc = floraRamp(tip, pow(u, 1.1));
  float stir = 1. - exp(-vStir * 6.);
  vec3 lit = floraLight(gc, tip, normalize(vN), normalize(uCam - vWP), u, 0.06, 0.);
  float midrib = (1. - smoothstep(0.05, 0.15, abs(s))) * step(vType, 1.5);
  float edge = smoothstep(0.8, 0.98, abs(s)) * step(vType, 0.5);
  float pulse = 0.65 + 0.35 * sin(uTime * 1.3 - u * 6. + vSeed * 30.);
  float em = (midrib * 0.9 + edge * 0.45) * (0.03 + 0.38 * uNight) * pulse;
  if (vType > 1.5 && vType < 2.5) em += smoothstep(0.7, 1., u) * (0.1 + 0.8 * uNight) * pulse + 0.03;
  if (vType > 2.5 && vType < 3.5) em += smoothstep(0.55, 1., u) * (1. - smoothstep(0.04, 0.3, abs(s))) * (0.05 + 0.55 * uNight) * pulse;
  if (vType > 3.5) em += smoothstep(0.7, 0.86, u) * (0.07 + 0.58 * uNight) * pulse + 0.02;
  em *= breath(vWP.xz);
  lit += vein * (em + stir * uBio * (0.5 + midrib));
  o = vec4(tonemap(fogged(lit, vWP)), 0.);
}`);

const WATERP = program(WORLD_VS + `
in vec2 aXZ; in float aDepth; out vec3 vWP; out float vDepth; out float vWave;
void main(){
  // the swell rides up and down the beach, so the waterline itself moves
  vWave = waterWave(aXZ, uTime).x;
  vWP = vec3(aXZ.x, ${WATER.toFixed(1)} + vWave, aXZ.y); vDepth = aDepth; gl_Position = project(vWP);
}`,
`uniform sampler2D uRefl; uniform vec2 uRes; uniform vec4 uRip[12];
in vec3 vWP; in float vDepth; in float vWave; out vec4 o;
vec2 waveGrad(vec2 p){
  vec2 g = waterWave(p, uTime).yz;
  g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 1.3 + uTime * 1.1) * 0.016;
  g += vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 2.1 + uTime * 1.6) * 0.010;
  g += vec2(0.2, -0.98) * cos(dot(p, vec2(0.2, -0.98)) * 3.7 + uTime * 2.2) * 0.006;
  g += vec2(-0.9, -0.3) * cos(dot(p, vec2(-0.9, -0.3)) * 6.3 + uTime * 3.1) * 0.004;
  // wind gust patches ("cat's paws"): the same rolling waves that move the grass roughen the water as they pass
  float gw = max(0., windWave(p)) * uWind;
  g += WIND_DIR * cos(dot(p, WIND_DIR) * 9. + uTime * 5.3 + vnoise(p * 0.8) * 3.) * 0.012 * gw;
  g += vec2(-WIND_DIR.y, WIND_DIR.x) * cos(dot(p, vec2(-WIND_DIR.y, WIND_DIR.x)) * 13. + uTime * 6.1) * 0.006 * gw;
  for (int i = 0; i < 12; i++) {
    vec4 r = uRip[i]; if (r.w <= 0.) continue;
    float age = uTime - r.z; if (age < 0. || age > 8.) continue;
    vec2 d = p - r.xy; float dist = length(d) + 1e-3; float front = age * 1.4;
    float env = exp(-(dist - front) * (dist - front) * 1.6) * exp(-age * 0.55) * r.w / (1. + dist);
    g += d / dist * cos((dist - front) * 7.) * env * 0.5;
  }
  return g;
}
void main(){
  vec2 p = vWP.xz; vec2 uv = fieldUV(p);
  float glow = texture(uGlow, uv).r * inField(uv);
  vec2 g = waveGrad(p); vec3 N = normalize(vec3(-g.x, 1., -g.y));
  vec3 V = normalize(uCam - vWP); float NdV = max(dot(N, V), 0.);
  float F = 0.02 + 0.98 * pow(1. - NdV, 5.);
  vec2 suv = gl_FragCoord.xy / uRes + N.xz * 0.035;
  vec3 refl = texture(uRefl, suv).rgb;
  float d = max(vDepth + vWave, 0.);
  vec3 body = mix(vec3(0.03, 0.15, 0.17), vec3(0.008, 0.025, 0.07), smoothstep(0., 3., d));
  vec3 Hh = normalize(uSunDir + V); float spec = pow(max(dot(N, Hh), 0.), 900.) * 25.;
  vec3 hdr = body * (ambient(N) * 3. + uSunCol * 0.12) + uSunCol * spec * F * 4. * (1. - 0.75 * uNight);
  vec3 gc = pow(glowCol(p * 1.3 + 7.), vec3(1.7));
  hdr += gc * uBio * glowI(glow) * 1.9;
  hdr += vec3(0.5, 0.45, 0.6) * smoothstep(0.12, 0.0, d) * 0.1;
  vec3 col = tonemap(fogged(hdr, vWP));
  col = mix(col, refl, clamp(F * 0.9 + 0.08, 0., 1.)) + tonemap(gc * uBio * glowI(glow)) * 0.25;
  // surf: lines of foam rolling up the shelf with the swell, torn into lace, thinning to a fringe where the water ends
  vec3 cb = cobble(p * 4.5 + vec2(uTime * 0.15, -uTime * 0.11));
  float lace = smoothstep(0.09, 0.0, cb.y) * (0.45 + 0.55 * vnoise(p * 2.2 + uTime * 0.2));
  float swash = smoothstep(0.55, 0.95, sin(d * 22. - uTime * 2.0 + vnoise(p * 1.2) * 4. + vWave * 40.));
  float foam = (1. - smoothstep(0.0, 0.45, d)) * (0.35 + 0.65 * swash) * lace + smoothstep(0.045, 0.0, d) * (0.25 + 0.55 * lace);
  col = mix(col, vec3(0.74, 0.8, 0.92), clamp(foam, 0., 1.) * 0.5);
  float alpha = clamp(max(F, smoothstep(0., 1.3, d) * 0.9 + 0.04) + glow * 0.5 + foam * 0.4, 0., 1.);
  alpha *= smoothstep(-0.02, 0.03, d);
  o = vec4(col, alpha);
}`);

// the river: ripples carried downstream with the current (two layers, advected and cross-faded so they never stretch),
// white water where it runs fast and where it thins over stones, the sky in it, and the glow you stir lighting it
const RIVERP = program(WORLD_VS + `
in vec3 aP; in vec4 aF; in vec2 aT; out vec3 vWP; out vec4 vF; out vec2 vT;
void main(){
  vec3 p = aP;
  p.y += (0.008 + 0.03 * smoothstep(1., 2.2, aF.z)) * sin(aF.x * 2.7 - uTime * 3.) * (1. - aF.y * aF.y);
  vWP = p; vF = aF; vT = aT; gl_Position = project(p);
}`,
`in vec3 vWP; in vec4 vF; in vec2 vT; out vec4 o;
float ripple(vec2 q){ return vnoise(q * vec2(1.6, 3.)) * 0.6 + vnoise(q * vec2(3.7, 6.) + 4.) * 0.4; }
vec2 slope(vec2 q){ float e = 0.06; return vec2(ripple(q + vec2(e, 0.)) - ripple(q - vec2(e, 0.)), ripple(q + vec2(0., e)) - ripple(q - vec2(0., e))) / (2. * e); }
void main(){
  float s = vF.x, a = vF.y, v = vF.z, depth = vF.w;
  if (depth < -0.03) discard;
  vec2 p = vWP.xz, uv = fieldUV(p); float glow = texture(uGlow, uv).r * inField(uv);
  float ph = uTime * 0.6, f1 = fract(ph), f2 = fract(ph + 0.5), w1 = 1. - abs(2. * f1 - 1.);
  vec2 g = mix(slope(vec2(s - v * f2 * 1.6 + 3.7, a * 2.2 + 1.9)), slope(vec2(s - v * f1 * 1.6, a * 2.2)), w1) * (0.06 + 0.07 * smoothstep(0.8, 2., v));
  vec2 t = normalize(vT), n = vec2(-t.y, t.x);
  vec3 N = normalize(vec3(-(g.x * t.x + g.y * n.x), 1., -(g.x * t.y + g.y * n.y)));
  vec3 V = normalize(uCam - vWP); float NdV = max(dot(N, V), 0.), F = 0.02 + 0.98 * pow(1. - NdV, 5.);
  vec3 body = mix(vec3(0.05, 0.19, 0.2), vec3(0.012, 0.045, 0.09), smoothstep(0., 0.8, depth));
  vec3 Hh = normalize(uSunDir + V); float spec = pow(max(dot(N, Hh), 0.), 500.) * 14.;
  vec3 col = body * (ambient(N) * 3. + uSunCol * 0.14) + skyBase(reflect(-V, N)) * F * 0.7 + uSunCol * spec * F * 3. * (1. - 0.7 * uNight);
  vec3 gc = pow(glowCol(p * 1.3 + 7.), vec3(1.7));
  col += gc * uBio * glowI(glow) * 1.9;
  vec3 cb = cobble(vec2(s * 1.3 - uTime * v * 1.1, a * 2.6));
  float lace = smoothstep(0.1, 0.0, cb.y) * (0.55 + 0.45 * vnoise(vec2(s * 3. - uTime * v * 2., a * 4.)));
  float foam = smoothstep(1.1, 2.1, v) * (0.4 + 0.6 * lace) + smoothstep(0.12, 0.0, depth) * lace * 0.7 + smoothstep(0.82, 1., abs(a)) * lace * 0.3;
  vec3 fc = vec3(0.8, 0.86, 0.96) * (ambient(vec3(0., 1., 0.)) * 3.2 + uSunCol * 0.24);
  col = mix(col, fc, clamp(foam, 0., 1.) * 0.75);
  float alpha = clamp(F * 0.75 + smoothstep(0., 0.7, depth) * 0.72 + 0.14 + foam * 0.5 + glow * 0.4, 0., 1.);
  alpha *= smoothstep(-0.03, 0.05, depth) * smoothstep(${WATER.toFixed(1)} + 0.012, ${WATER.toFixed(1)} + 0.12, vWP.y);
  o = vec4(tonemap(fogged(col, vWP)), alpha);
}`);

const POINTS = program(WORLD_VS + `
in vec4 aP; uniform float uScale, uNight; uniform vec2 uCamXZ; uniform int uRain; out float vA; out vec3 vC;
void main(){
  vec3 p = aP.xyz; float s = aP.w;
  if (uRain == 1) { float t = fract(uTime * (0.08 + 0.05 * s) + aP.y); vec2 c = uCamXZ + mod(aP.xz - uCamXZ + 34., 68.) - 34.; p = vec3(c.x, 22. - t * 24., c.y); p.x += sin(uTime + s * 50.) * 0.6; p.z += cos(uTime * 0.7 + s * 31.) * 0.4; vA = smoothstep(0., 0.1, t) * (1. - smoothstep(0.85, 1., t)); s = 0.5; }
  else if (uRain == 2) {
    p += vec3(sin(uTime * 0.31 + s * 20.), sin(uTime * 0.47 + s * 13.) * 0.45, cos(uTime * 0.27 + s * 7.)) * 1.3 + vec3(WIND_DIR.x, 0., WIND_DIR.y) * sin(uTime * 0.11 + s * 3.) * 2.;
    vA = (0.05 + 0.6 * uNight) * (0.45 + 0.55 * sin(uTime * (1.1 + s * 2.) + s * 50.)) * (0.45 + 0.7 * smoothstep(-0.7, 0.85, windWave(p.xz))); s = 0.16 + 0.16 * fract(s * 31.);
  }
  else if (uRain == 3) { vA = (0.3 + 0.7 * uNight) * (0.6 + 0.4 * sin(uTime * 2.3 + s * 40.)); s = 0.2; }
  else vA = 1.;
  vC = mix(vec3(0.3, 1.0, 0.9), vec3(0.7, 0.45, 1.), fract(aP.w * 7.)) * (uRain >= 2 ? 1.5 : 3.);
  vec4 c = project(p); gl_Position = c; gl_PointSize = clamp(uScale * (0.06 + s * 0.12) / c.w, 1., uRain == 2 ? 6. : 48.);
  if (uRain == 2) vA *= smoothstep(1.2, 3.5, c.w);
}`,
`in float vA; in vec3 vC; out vec4 o; void main(){ vec2 q = gl_PointCoord - .5; float a = smoothstep(0.5, 0., length(q)) * vA; o = vec4(tonemap(vC) * a, a); }`);

// the night sky, after rawah's stars.js: thousands of point stars on the sphere of the sky's own frame, many faint and a
// few bright (counts rise as 10^0.45m), richer toward the galaxy's plane, in the colours of real stars; and the galaxy's
// band, painted once into a cube map. Both turn with the sky, and the bodies and the clouds hide the stars behind them.
const STARS = program(`
in vec4 aS; in vec4 aC;
uniform mat4 uVP; uniform mat3 uSky; uniform vec3 uCam; uniform float uMirror, uTime, uNight, uPx;
out vec3 vC; out float vI; out vec3 vDir;
void main(){
  vec3 d = aS.xyz * uSky;
  vec4 c = uVP * vec4(uCam.x + d.x * 2000., (uCam.y + d.y * 2000.) * uMirror, uCam.z + d.z * 2000., 1.);
  gl_Position = vec4(c.xy, c.w * 0.99999, c.w);
  float bright = pow(10., -0.4 * (aS.w - 1.5));
  float tw = 1. - (0.12 + 0.3 * smoothstep(0.5, 0., d.y)) * (0.5 + 0.5 * sin(uTime * (2.5 + aC.w * 6.) + aC.w * 60.));
  vI = clamp(0.2 + 0.7 * pow(bright, 0.28), 0., 1.6) * tw * smoothstep(-0.03, 0.22, d.y) * (0.55 + 0.45 * smoothstep(0., 0.5, d.y)) * (0.06 + 0.94 * uNight);
  vC = aC.rgb; vDir = d;
  gl_PointSize = (2. + 2.6 * pow(min(bright, 8.), 0.3)) * uPx;
}`, `in vec3 vC; in float vI; in vec3 vDir; out vec4 o;
void main(){
  vec2 q = gl_PointCoord - 0.5; float r2 = dot(q, q) * 4.;
  float a = (exp(-r2 * 7.) + exp(-r2 * 2.2) * 0.22) * vI * starsSeen(normalize(vDir));
  o = vec4(tonemap(vC * a * 1.5), 0.);
}`);
// the band in the galaxy's own coordinates (x toward the core, y its pole): a meandering disc, fatter toward the core,
// knotted with star clouds, split by a rift of dust, a gold bulge, blue-white arms, rose and teal nebulae. Stored as
// the square root of radiance, so eight bits are enough.
const MILKY = program(FSQ, `uniform int uFace; uniform float uSize; uniform mat3 uGal; out vec4 o;
float h13(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1, 0, 0)), f.x), mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), f.x), mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
float fbmv(vec3 p, int oct){ float a = 0.5, s = 0., n = 0.; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vn(p); n += a; p = p * 2.03 + 1.7; a *= 0.5; } return s / n; }
float sq(float x){ return x * x; }
void main(){
  vec2 uv = gl_FragCoord.xy / uSize * 2. - 1.;
  vec3 s = uFace == 0 ? vec3(1., -uv.y, -uv.x) : uFace == 1 ? vec3(-1., -uv.y, uv.x) : uFace == 2 ? vec3(uv.x, 1., uv.y)
         : uFace == 3 ? vec3(uv.x, -1., -uv.y) : uFace == 4 ? vec3(uv.x, -uv.y, 1.) : vec3(-uv.x, -uv.y, -1.);
  vec3 g = normalize(s) * uGal;
  float b = asin(clamp(g.y, -1., 1.)), l = atan(g.z, g.x), lr = abs(l);
  float width = mix(0.085, 0.16, smoothstep(2.4, 0., lr));
  float bb = b - (fbmv(g * 3. + 1.7, 3) - 0.5) * 0.11 - 0.03 * sin(l * 2. + 0.5);
  float disc = exp(-sq(bb / width)), broad = exp(-sq(bb / (width * 2.8))) * 0.22;
  float clouds = smoothstep(0.28, 0.78, fbmv(g * 7. + 11., 4)), fine = fbmv(g * 42., 4);
  float bulgeR = sqrt(l * l + sq(b * 1.8)), bulge = exp(-sq(bulgeR / 0.24)) * 1.1;
  float I = disc * (0.38 + clouds * (0.55 + 0.45 * fine)) + broad + bulge * (0.55 + 0.45 * fine);
  I *= mix(1., 0.42, smoothstep(1.4, 3., lr));
  float lane = exp(-sq((bb - 0.012 + (fbmv(g * 9. + 3.3, 3) - 0.5) * 0.07) / 0.034)) * smoothstep(-1.25, -0.15, l) * (1. - smoothstep(0.9, 1.6, l));
  float dpatch = smoothstep(0.56, 0.82, fbmv(g * 13. + 9., 4)) * smoothstep(0., 0.5, disc + bulge * 0.4);
  float coal = smoothstep(0.62, 0.9, fbmv(g * 30. + 4., 3)) * disc;
  float dust = clamp(lane * 0.88 + dpatch * 0.6 + coal * 0.5, 0., 0.94);
  I *= (1. - dust) * (0.8 + 0.4 * fbmv(g * 170., 2));
  vec3 col = mix(vec3(0.52, 0.66, 1.0), vec3(1.0, 0.8, 0.52), clamp(exp(-sq(bulgeR / 0.5)) * 1.2, 0., 1.));
  col = mix(col, vec3(0.62, 0.5, 1.0), (1. - disc) * 0.4);
  col = mix(col, vec3(1.0, 0.56, 0.4), dust * 0.55);
  float neb = smoothstep(0.62, 0.84, fbmv(g * 22. + 5.5, 3)) * disc;
  col = mix(col, vec3(1.0, 0.4, 0.55), neb * smoothstep(-0.5, 0.3, l) * (1. - smoothstep(0.7, 1.2, l)) * 0.6);
  col = mix(col, vec3(0.35, 0.92, 0.88), neb * smoothstep(1.4, 2.0, lr) * 0.45);
  o = vec4(col * sqrt(max(I * 0.5, 0.)), 1.);
}`);

// ---------------------------------------------------------------- geometry
const NEAR = { S: 384, half: HALF + 16 };
function terrainNear() {
  const { S, half } = NEAR, st = 2 * half / S, hs = new Float32Array((S + 1) * (S + 1)), pos = [], nor = [], idx = [];
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) hs[j * (S + 1) + i] = H(-half + i * st, -half + j * st);
  const at = (i, j) => hs[Math.min(S, Math.max(0, j)) * (S + 1) + Math.min(S, Math.max(0, i))];
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
    pos.push(-half + i * st, at(i, j), -half + j * st);
    const hx = at(i + 1, j) - at(i - 1, j), hz = at(i, j + 1) - at(i, j - 1), l = Math.hypot(hx, 2 * st, hz);
    nor.push(-hx / l, 2 * st / l, -hz / l);
  }
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) };
}
function terrainFar() {
  const R = 110, A = 200, pos = [], nor = [], idx = [], edge = NEAR.half - 0.5;
  for (let j = 0; j <= R; j++) {
    const r = 72 * Math.pow(1500 / 72, j / R);
    for (let i = 0; i <= A; i++) {
      const a = i / A * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
      const inside = Math.abs(x) < edge && Math.abs(z) < edge;
      pos.push(x, H(x, z) - (inside ? 4 : 0), z); nor.push(...normalAt(x, z, Math.max(0.15, r * 0.02)));
    }
  }
  for (let j = 0; j < R; j++) for (let i = 0; i < A; i++) { const a = j * (A + 1) + i, b = a + 1, c = a + A + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) };
}
function waterMesh() {
  const S = 256, x0 = LAKE[0] - 46, z0 = LAKE[1] - 40, w = 92, d = 80, xz = [], dep = [], idx = [];
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) { const x = x0 + i / S * w, z = z0 + j / S * d, n = RIVER.near(x, z); xz.push(x, z); dep.push(n && n.d < riverW(n.s) + 0.6 && riverWS(n.s) > WATER + 0.03 ? -9 : WATER - H(x, z)); }
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, e = c + 1;
    if (Math.max(dep[a], dep[b], dep[c], dep[e]) > -0.4) idx.push(a, c, b, b, c, e);
  }
  return { xz: new Float32Array(xz), dep: new Float32Array(dep), idx: new Uint32Array(idx) };
}
// the river's surface: a ribbon down its course, level across, falling along it. Per vertex: the distance down the
// river, the place across it (-1..1), the speed there and the depth of water under it, and the direction it runs.
function riverMesh() {
  const P = [], F = [], T = [], idx = [], across = 8;
  let rows = 0;
  for (let t = 0; t <= RIVER.length; t += 0.4) {
    const ws = riverWS(t); if (ws <= WATER + 0.012) break;
    const [x, z, tx, tz] = RIVER.at(t), w = riverW(t) + 0.6, v = riverSpeed(t);
    for (let k = 0; k <= across; k++) {
      const a = k / across * 2 - 1, px = x - tz * a * w, pz = z + tx * a * w;
      P.push(px, ws, pz); F.push(t, a, v, ws - H(px, pz)); T.push(tx, tz);
    }
    rows++;
  }
  for (let j = 0; j + 1 < rows; j++) for (let k = 0; k < across; k++) { const a = j * (across + 1) + k, b = a + 1, c = a + across + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  return { P: new Float32Array(P), F: new Float32Array(F), T: new Float32Array(T), idx: new Uint32Array(idx) };
}
// where the river runs, for the ground's shader: R its bed, G the banks it keeps wet. A quarter metre a texel.
function riverMask() {
  const S = 512, m = new Uint8Array(S * S * 2);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = (i + 0.5) / S * EXTENT - EXTENT / 2, z = (j + 0.5) / S * EXTENT - EXTENT / 2, n = RIVER.near(x, z);
    if (!n || riverWS(n.s) <= WATER + 0.02) continue;
    const w = riverW(n.s);
    m[(j * S + i) * 2] = 255 * (1 - sm(w - 0.4, w + 0.35, n.d));
    m[(j * S + i) * 2 + 1] = 255 * (1 - sm(w, w + 2.2, n.d));
  }
  return { S, m };
}
function rockMesh(seed, sub, tall, stack) {
  const rr = rng(Math.floor(seed * 100003));
  // fracture planes: the stone is cut flat where it broke, so lumps meet facets
  const planes = [];
  for (let q = 0, np = sub < 2 ? 3 : 7 + Math.floor(rr() * 4); q < np; q++) { const a = rr() * 6.2832, el = (rr() - 0.35) * 1.4; const n = [Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)]; planes.push([n, 0.5 + rr() * 0.3]); }
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((c) => c / l); });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let q = 0; q < sub; q++) {
    const cache = {}, nf = [];
    const mid = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (k in cache) return cache[k]; const p = v[a].map((c, i) => (c + v[b][i]) / 2); const l = Math.hypot(...p); v.push(p.map((c) => c / l)); return (cache[k] = v.length - 1); };
    for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  // big lumps, a ridge or two, ledged strata, a flat seat on the ground
  const pos = v.map(([x, y, z]) => {
    let k = 1 + 0.3 * (fbm(x * 1.3 + seed * 7, z * 1.3 + y * 1.7 - seed, 3) - 0.5) + 0.14 * (ridged(x * 0.9 + seed, z * 0.9 + y) - 0.45) + 0.06 * (vnoise(x * 6 + seed, z * 6 + y * 5) - 0.5);
    k *= 1 + (stack ? 0.08 : 0.045) * Math.round(Math.sin(y * (stack ? 6 : 9) + seed * 3) * 1.6) / 1.6;
    let px = x * k, py = y * k * (tall ? 1 : 0.72), pz = z * k;
    if (stack) {
      // a sea stack: narrower up top, twisted, with an overhang leaning out over the water on one side
      const tw = (py + 1) * 0.55, c = Math.cos(tw), sn = Math.sin(tw), taper = 1 - 0.32 * (py + 1) / 2;
      [px, pz] = [(c * px - sn * pz) * taper, (sn * px + c * pz) * taper];
      px += 0.28 * Math.max(0, py - 0.2) ** 2;
    }
    for (const [n, d] of planes) { const dp = px * n[0] + py * n[1] + pz * n[2]; if (dp > d) { const f = (dp - d) * 0.9; px -= n[0] * f; py -= n[1] * f; pz -= n[2] * f; } }
    if (py < -0.22) py = -0.22 + (py + 0.22) * 0.25;
    return [px, py, pz];
  });
  const nor = pos.map(() => [0, 0, 0]);
  for (const [a, b, c] of f) {
    const A = pos[a], B = pos[b], C = pos[c];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const q of [a, b, c]) { nor[q][0] += n[0]; nor[q][1] += n[1]; nor[q][2] += n[2]; }
  }
  return { pos: new Float32Array(pos.flat()), nor: new Float32Array(nor.map((n) => { const l = Math.hypot(...n) || 1; return n.map((x) => x / l); }).flat()), idx: new Uint32Array(f.flat()) };
}
// crystals, each grown on its own: an uneven hexagonal prism that swells a little, then narrows into a pyramid set off
// its axis (or snapped flat where it broke), a child crystal now and then at its foot. Every crystal leans, between 7 and
// 43 degrees and roughly away from its cluster's heart, as a druse grows. Each one is a capsule for spacing, and is only
// kept when it clears every capsule already grown, so no two crystals ever pass through each other.
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** The least distance between the segments p1 q1 and p2 q2. */
function segDist(p1, q1, p2, q2) {
  const d1 = sub3(q1, p1), d2 = sub3(q2, p2), w = sub3(p1, p2), a = dot3(d1, d1), e = dot3(d2, d2), b = dot3(d1, d2), c = dot3(d1, w), f = dot3(d2, w), den = a * e - b * b;
  let s = den > 1e-9 ? clamp01((b * f - c * e) / den) : 0, t = (b * s + f) / e;
  if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
  return Math.hypot(...sub3([p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s], [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t]));
}
function growCrystals(sites) {
  const r = rng(4747), W = { pos: [], nor: [], c: [] }, caps = [];
  const fits = (a, b, rad) => caps.every(([p, q, cr]) => segDist(a, b, p, q) > rad + cr + 0.025);
  // one face, wound and lit outward from the crystal's axis point m
  const tri = (A, B, C, m, attr) => {
    const u = sub3(B, A), w = sub3(C, A); let n = norm(cross(u, w));
    const ctr = [(A[0] + B[0] + C[0]) / 3 - m[0], (A[1] + B[1] + C[1]) / 3 - m[1], (A[2] + B[2] + C[2]) / 3 - m[2]];
    if (dot3(n, ctr) < 0) { n = n.map((x) => -x); [B, C] = [C, B]; }
    for (const P of [A, B, C]) { W.pos.push(...P); W.nor.push(...n); W.c.push(attr[0], attr[1](P), attr[2], 0); }
  };
  const crystal = (base, dir, L, rad, hue) => {
    const top = [base[0] + dir[0] * L, base[1] + dir[1] * L, base[2] + dir[2] * L];
    if (!fits(base, top, rad * 1.08)) return false;
    caps.push([base, top, rad * 1.08]);
    const e1 = norm(cross(dir, Math.abs(dir[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(dir, e1), seed = r();
    const corner = Array.from({ length: 6 }, () => 0.8 + 0.38 * r()), twist = (r() - 0.5) * 0.12, swell = 1 + r() * 0.1;
    const at = (u, k, s) => { const a = k / 6 * Math.PI * 2 + twist * u, q = rad * corner[k % 6] * s; return [base[0] + dir[0] * L * u + (e1[0] * Math.cos(a) + e2[0] * Math.sin(a)) * q, base[1] + dir[1] * L * u + (e1[1] * Math.cos(a) + e2[1] * Math.sin(a)) * q, base[2] + dir[2] * L * u + (e1[2] * Math.cos(a) + e2[2] * Math.sin(a)) * q]; };
    const along = (P) => dot3(sub3(P, base), dir) / L, attr = [hue, along, seed];
    const broken = r() < 0.22, shoulder = broken ? 0.86 : 0.7 + r() * 0.1;
    const rings = [[-0.12, 1], [0.38, swell], [shoulder, 0.97]];
    for (let j = 0; j < rings.length - 1; j++) for (let k = 0; k < 6; k++) {
      const a0 = at(rings[j][0], k, rings[j][1]), a1 = at(rings[j][0], k + 1, rings[j][1]), b0 = at(rings[j + 1][0], k, rings[j + 1][1]), b1 = at(rings[j + 1][0], k + 1, rings[j + 1][1]);
      const m = [base[0] + dir[0] * L * 0.4, base[1] + dir[1] * L * 0.4, base[2] + dir[2] * L * 0.4];
      tri(a0, a1, b0, m, attr); tri(a1, b1, b0, m, attr);
    }
    const m = [base[0] + dir[0] * L * shoulder, base[1] + dir[1] * L * shoulder, base[2] + dir[2] * L * shoulder];
    if (broken) {
      // a snapped top: a flat, slightly tilted break with a bevel
      const cap = Array.from({ length: 6 }, (_, k) => at(0.9 + 0.05 * Math.sin(k + seed * 9), k, 0.82));
      const mid = [cap.reduce((s, p) => s + p[0], 0) / 6, cap.reduce((s, p) => s + p[1], 0) / 6, cap.reduce((s, p) => s + p[2], 0) / 6];
      for (let k = 0; k < 6; k++) { const s0 = at(shoulder, k, 0.97), s1 = at(shoulder, k + 1, 0.97); tri(s0, s1, cap[k], m, attr); tri(s1, cap[(k + 1) % 6], cap[k], m, attr); tri(cap[k], cap[(k + 1) % 6], mid, [mid[0] - dir[0], mid[1] - dir[1], mid[2] - dir[2]], attr); }
    } else {
      const off = [(r() - 0.5) * 0.7 * rad, (r() - 0.5) * 0.7 * rad], tip = [top[0] + e1[0] * off[0] + e2[0] * off[1], top[1] + e1[1] * off[0] + e2[1] * off[1], top[2] + e1[2] * off[0] + e2[2] * off[1]];
      for (let k = 0; k < 6; k++) tri(at(shoulder, k, 0.97), at(shoulder, k + 1, 0.97), tip, m, attr);
    }
    return true;
  };
  const lean = (out, t) => { const a = Math.atan2(out[1], out[0]); return [Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a)]; };
  for (const [cx, cz, hue, n, size] of sites) {
    for (let i = 0, tries = 0; i < n && tries < n * 40; tries++) {
      const first = i === 0, ang = r() * 6.2832, d = first ? r() * 0.12 : 0.12 + r() * 0.6 * size;
      const x = cx + Math.cos(ang) * d, z = cz + Math.sin(ang) * d;
      const L = (first ? 1.5 + r() * 0.9 : 0.45 + Math.pow(r(), 1.4) * 1.5) * size, rad = L * (0.085 + r() * 0.05);
      const t = first ? 0.12 + r() * 0.22 : 0.22 + r() * 0.53, wob = (r() - 0.5) * 1.1;
      const dir = lean([Math.cos(ang + wob), Math.sin(ang + wob)], t);
      const base = [x - dir[0] * 0.12 * L, H(x, z) - 0.05 - dir[1] * 0.12 * L, z - dir[2] * 0.12 * L];
      if (!crystal(base, dir, L, rad, clamp01(hue + (r() - 0.5) * 0.16))) continue;
      i++;
      // a child at the foot, leaning harder
      if (r() < 0.35) {
        const ca = ang + (r() - 0.5) * 2, cl = L * (0.3 + r() * 0.25), cd = lean([Math.cos(ca), Math.sin(ca)], t + 0.3 + r() * 0.35);
        const cx2 = x + Math.cos(ca) * rad * 1.6, cz2 = z + Math.sin(ca) * rad * 1.6;
        crystal([cx2 - cd[0] * 0.12 * cl, H(cx2, cz2) - 0.04 - cd[1] * 0.12 * cl, cz2 - cd[2] * 0.12 * cl], cd, cl, cl * (0.1 + r() * 0.04), clamp01(hue + (r() - 0.5) * 0.2));
      }
    }
  }
  return { pos: new Float32Array(W.pos), nor: new Float32Array(W.nor), c: new Float32Array(W.c), count: W.pos.length / 3, caps };
}

// ---------------------------------------------------------------- scatter
const STACK_GEO = rockMesh(9.31, 4, true, true), STACK_S = [3.6, 4.8, 3.0];
// terrain height and slope from the near mesh (fast, for a million blades)
function nearH(x, z) {
  const { S, half } = NEAR, st = 2 * half / S, fx = Math.min(S - 1e-3, Math.max(0, (x + half) / st)), fz = Math.min(S - 1e-3, Math.max(0, (z + half) / st));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j, P = near.pos, h = (a, b) => P[(b * (S + 1) + a) * 3 + 1];
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - w) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * w;
}
function nearNy(x, z) {
  const { S, half } = NEAR, st = 2 * half / S, i = Math.min(S, Math.max(0, Math.round((x + half) / st))), j = Math.min(S, Math.max(0, Math.round((z + half) / st)));
  return near.nor[(j * (S + 1) + i) * 3 + 1];
}
// blades per square metre where the meadow grows fully; distant tiles draw fewer (see Tiled)
const GRASS_DENSITY = touch ? 46 : TEST ? 56 : 104;
const START = [8, 30], SHORE_CAM = [19, 26];
const clearOf = (x, z, m = 3.5) => Math.hypot(x - START[0], z - START[1]) > m && Math.hypot(x - SHORE_CAM[0], z - SHORE_CAM[1]) > m;
const inMap = (x, z, m = 2) => Math.abs(x) < HALF - m && Math.abs(z) < HALF - m;
/** Within `m` metres of the trail, or of the river's running water. */
function onPath(x, z, m) {
  const t = TRAIL.near(x, z); if (t && t.d < m) return true;
  const n = RIVER.near(x, z); return !!n && riverWS(n.s) > WATER + 0.02 && n.d < riverW(n.s) + m;
}

function scatter() {
  const r = rng(1234);
  // grass: Corey's stratified jitter, kept where blades can grow. Nothing is cut at a hard line: the chance of a blade
  // and its height both fall off with slope, the shore, height and the outcrop, broken up by noise, so a meadow thins
  // out into its edges. Patches of tall grass ride a slow noise.
  const n = Math.ceil(Math.sqrt(4 * HALF * HALF * GRASS_DENSITY)), cellG = 2 * HALF / n;
  const G = [], R = [];
  for (let gz = 0; gz < n; gz++) for (let gx = 0; gx < n; gx++) {
    const x = (gx + r()) * cellG - HALF, z = (gz + r()) * cellG - HALF, y = nearH(x, z), ld = lakeD(x, z);
    let hm;
    const rn = RIVER.near(x, z), rw = rn ? riverW(rn.s) : 0, running = rn && riverWS(rn.s) > WATER + 0.02;
    if (running && rn.d < rw - 0.3) continue;                                                              // the river bed
    if (ld > 10.0 && ld < 12.6 && y > -0.38 && y < 0.55) { if (r() > 0.2) continue; hm = 1.9 + r() * 1.1; }   // reeds: the shoreline and the shallows
    else if (running && rn.d < rw + 1.3) { if (r() > 0.28) continue; hm = 1.7 + r() * 1.0; }              // and the river's banks
    else {
      const tn = TRAIL.near(x, z); if (tn && tn.d < 0.5 && r() < 0.85) continue;
      const ny = nearNy(x, z), ragged = 0.75 + 0.5 * vnoise(x * 0.9 + 7, z * 0.9 - 3);
      const grow = sm(0.2, 0.55, y) * (1 - sm(9, 14, y)) * sm(0.62, 0.84, ny) * (1 - 0.92 * rocky(x, z)) * Math.min(1, ragged);
      if (grow < 0.02 || r() > grow * 1.15) continue;
      const tall = sm(0.5, 0.78, fbm(x * 0.028 + 21, z * 0.028 - 9, 3));
      hm = (0.45 + 0.55 * Math.min(1, grow * 1.2)) * (0.7 + 0.75 * fbm(x * 0.06 + 11, z * 0.06 - 4, 3) + 0.2 * r()) * (1 + 0.65 * tall);
    }
    G.push(x, z, y - 0.015, r()); R.push(r(), r(), r(), hm);
  }

  // rocks: clusters with one big stone each, a broken field on the outcrop, monoliths on the rim, the sea stack, stones
  // in the shallows, pebbles on the shore
  const rv = [[], [], [], [], []], rs = [[], [], [], [], []];
  const add = (v, x, z, sx, sy, sz, sink) => { const y = H(x, z); rv[v].push(x, y - sink, z, r() * 6.28); rs[v].push(sx, sy, sz, r()); };
  const cluster = (cx, cz, big, m) => {
    for (let q = 0; q < m; q++) {
      const s0 = q === 0 ? big : big * (0.18 + 0.42 * r()), a = r() * 6.28, d = q === 0 ? 0 : big * (0.7 + r() * 0.9);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (!clearOf(x, z) || !inMap(x, z) || onPath(x, z, 1.4)) continue;
      add(q % 2, x, z, s0 * (0.8 + 0.5 * r()), s0 * (0.7 + 0.5 * r()), s0 * (0.8 + 0.5 * r()), 0.12 * s0);
    }
  };
  for (let c = 0; c < 56; c++) {
    let cx, cz, k = 0;
    do { cx = (r() * 2 - 1) * (HALF - 4); cz = (r() * 2 - 1) * (HALF - 4); k++; } while ((H(cx, cz) < -0.7 || !clearOf(cx, cz)) && k < 40);
    cluster(cx, cz, 0.8 + Math.pow(r(), 1.6) * 2.2, 3 + Math.floor(r() * 6));
  }
  for (let c = 0; c < 26; c++) {
    const a = r() * 6.28, d = Math.sqrt(r()) * 16;
    cluster(OUTCROP[0] + Math.cos(a) * d, OUTCROP[1] + Math.sin(a) * d / 1.25, 1.1 + Math.pow(r(), 1.3) * 2.6, 2 + Math.floor(r() * 5));
  }
  HILLS.forEach(([hx, hz, R, , rock, , asp, ang]) => {
    for (let c = 0, n = Math.round(5 + 9 * rock); c < n; c++) {
      const a = r() * 6.28, d = Math.sqrt(r()) * R * 0.55, u = Math.cos(a) * d * asp, v = Math.sin(a) * d;
      cluster(hx + u * Math.cos(ang) - v * Math.sin(ang), hz + u * Math.sin(ang) + v * Math.cos(ang), 0.7 + Math.pow(r(), 1.4) * 1.8 * rock, 2 + Math.floor(r() * 4));
    }
  });
  for (let c = 0; c < 38; c++) {
    const a = r() * 6.28, q = 0.24 + Math.sqrt(r()) * 0.62;
    cluster(SUMMIT.x + Math.cos(a) * q * SUMMIT.R / 0.92, SUMMIT.z + Math.sin(a) * q * SUMMIT.R / 1.08, 0.9 + Math.pow(r(), 1.3) * 2.4, 2 + Math.floor(r() * 5));
  }
  // the lookout: a slab to stand on at the crown's edge, a cairn, and a broken ring of standing stones
  { const th = LOOKOUT.th, lx = LOOKOUT.x, lz = LOOKOUT.z;
    add(0, lx, lz, 1.7, 0.42, 1.2, 0.2);
    let cy = H(lx - 1.1, lz - 1.4) + 0.08;
    for (const [w, h] of [[0.5, 0.32], [0.38, 0.26], [0.27, 0.2], [0.17, 0.16]]) { rv[1].push(lx - 1.1, cy, lz - 1.4, r() * 6.28); rs[1].push(w, h, w * 0.9, r()); cy += h * 1.3; }
    for (let k = 0; k < 7; k++) {
      const a = th + 0.75 + k * (6.2832 - 1.5) / 6.5, x = SUMMIT.x + Math.cos(a) * 5.3 / 0.92, z = SUMMIT.z + Math.sin(a) * 5.3 / 1.08;
      if (onPath(x, z, 1.2)) continue;
      add(2, x, z, 0.42 + r() * 0.15, 1.6 + r() * 1.0, 0.4 + r() * 0.12, 0.25);
    }
  }
  for (let m = 0; m < 16; m++) {
    let x, z, e, k = 0;
    do { const a = r() * 6.28; e = 46 + r() * 14; x = Math.cos(a) * e; z = Math.sin(a) * e / 1.05; k++; } while ((H(x, z) > 13 || !inMap(x, z)) && k < 20);
    const w = 0.6 + r() * 0.4;
    add(2, x, z, w, 2.4 + r() * 2.8, w * (0.8 + 0.3 * r()), 0.3);
  }
  { const y = H(ISLET[0], ISLET[1]); rv[4].push(ISLET[0], y - 0.2, ISLET[1], 0); rs[4].push(STACK_S[0], STACK_S[1], STACK_S[2], 0.42); }
  for (let q = 0; q < 26; q++) {
    let x, z, k = 0;
    do { x = LAKE[0] + (r() * 2 - 1) * 30; z = LAKE[1] + (r() * 2 - 1) * 24; k++; } while ((lakeD(x, z) < 8.6 || lakeD(x, z) > 10.6) && k < 60);
    const s0 = 0.4 + r() * 0.9; add(q % 2, x, z, s0, s0 * 0.8, s0 * 1.1, 0.1);
  }
  for (let q = 0; q < (touch ? 900 : 1600); q++) {
    let x, z, k = 0;
    if (q < 1000) do { x = LAKE[0] + (r() * 2 - 1) * 34; z = LAKE[1] + (r() * 2 - 1) * 28; k++; } while ((lakeD(x, z) < 9.6 || lakeD(x, z) > 12.4) && k < 60);
    else { x = (r() * 2 - 1) * (HALF - 2); z = (r() * 2 - 1) * (HALF - 2); }
    const s0 = 0.04 + Math.pow(r(), 2) * 0.18; add(3, x, z, s0, s0 * 0.7, s0 * (0.8 + 0.4 * r()), 0.01);
  }

  // crystal clusters along the shore, grown later (see growCrystals): [x, z, hue, crystals, size]
  const crystalSites = [];
  for (let c = 0; c < 17; c++) {
    let cx, cz, k = 0;
    do { cx = LAKE[0] + (r() * 2 - 1) * 36; cz = LAKE[1] + (r() * 2 - 1) * 30; k++; } while ((lakeD(cx, cz) < 11.2 || lakeD(cx, cz) > 13.8 || !clearOf(cx, cz)) && k < 80);
    crystalSites.push([cx, cz, r(), 5 + Math.floor(r() * 6), 0.8 + r() * 0.5]);
  }
  { const [x, z, tx, tz] = RIVER.at(1.5), w = riverW(1.5) + 1.2; crystalSites.push([x + tz * w, z - tx * w, 0.12, 7, 1.05], [x - tz * w, z + tx * w, 0.2, 5, 0.85]); }
  crystalSites.push([SUMMIT.x - 1.2, SUMMIT.z + 0.4, 0.55, 8, 1.3]);

  // junipers in three sizes of the one species: the common tree, saplings that gather round it and in groves of
  // their own, and a few old giants with room around them. [x, y, z, seed, height]
  const trees = [];
  const ground = (x, z) => { const y = H(x, z); return y > 0.3 && y < 11 && normalAt(x, z)[1] > 0.84 && lakeD(x, z) > 12.3 && clearOf(x, z, 7.5) && inMap(x, z, 4) && rocky(x, z) < 0.5 && !onPath(x, z, 2); };
  const room = (x, z, d) => { for (let q = 0; q < trees.length; q += 5) if (Math.hypot(trees[q] - x, trees[q + 2] - z) < d + (trees[q + 4] > 6 ? 3 : 0)) return false; return true; };
  for (let t = 0; trees.length / 5 < 7 && t < 4000; t++) {
    const x = (r() * 2 - 1) * (HALF - 6), z = (r() * 2 - 1) * (HALF - 6);
    if (ground(x, z) && room(x, z, 12)) trees.push(x, H(x, z) - 0.08, z, r(), 7.5 + r() * 2.8);
  }
  const common = trees.length;
  for (let t = 0; (trees.length - common) / 5 < 88 && t < 12000; t++) {
    const x = (r() * 2 - 1) * (HALF - 3), z = (r() * 2 - 1) * (HALF - 3);
    if (ground(x, z) && room(x, z, 3.8)) trees.push(x, H(x, z) - 0.05, z, r(), 3.4 + r() * 3.0);
  }
  const grown = trees.length;
  const sapling = (x, z) => { if (ground(x, z) && room(x, z, 1.3)) trees.push(x, H(x, z) - 0.03, z, r(), 1.1 + r() * 1.3); };
  for (let q = common; q < grown; q += 5) if (r() < 0.45) for (let k = 0, m = 2 + Math.floor(r() * 4); k < m; k++) { const a = r() * 6.28, d = 2 + r() * 2.8; sapling(trees[q] + Math.cos(a) * d, trees[q + 2] + Math.sin(a) * d); }
  for (let g = 0; g < 14; g++) {
    const cx = (r() * 2 - 1) * (HALF - 6), cz = (r() * 2 - 1) * (HALF - 6);
    for (let k = 0, m = 3 + Math.floor(r() * 5); k < m; k++) sapling(cx + (r() - 0.5) * 6, cz + (r() - 0.5) * 6);
  }
  return { G: new Float32Array(G), R: new Float32Array(R), rv: rv.map((a) => new Float32Array(a)), rs: rs.map((a) => new Float32Array(a)), crystalSites, trees: new Float32Array(trees) };
}

// ---------------------------------------------------------------- junipers
const LEAF_MULT = touch ? 0.55 : 1;
// a length of wood along pts. Its section is never a circle: two or three lobes and a few shallow flutes, drifting round
// as it grows, so a trunk reads as old, gnarled juniper rather than a pipe
function tube(W, pts, rad, sides, f0, f1, base, seed) {
  const n = pts.length, v0 = W.pos.length / 3, ph1 = seed * 37.1, ph2 = seed * 91.7, ph3 = seed * 13.3;
  const lobe = (ang, s) => 1 + 0.16 * Math.sin(2 * ang + ph1 + s * 0.9) + 0.09 * Math.sin(3 * ang + ph2 - s * 0.6) + 0.05 * Math.sin(7 * ang + ph3 + s * 1.7);
  const dLobe = (ang, s) => 0.32 * Math.cos(2 * ang + ph1 + s * 0.9) + 0.27 * Math.cos(3 * ang + ph2 - s * 0.6) + 0.35 * Math.cos(7 * ang + ph3 + s * 1.7);
  let T = null, Nn = null, along = 0;
  for (let k = 0; k < n; k++) {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
    T = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    if (!Nn) { const ref = Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; Nn = norm([ref[1] * T[2] - ref[2] * T[1], ref[2] * T[0] - ref[0] * T[2], ref[0] * T[1] - ref[1] * T[0]]); }
    else { const d = Nn[0] * T[0] + Nn[1] * T[1] + Nn[2] * T[2]; Nn = norm([Nn[0] - T[0] * d, Nn[1] - T[1] * d, Nn[2] - T[2] * d]); }
    const B = [T[1] * Nn[2] - T[2] * Nn[1], T[2] * Nn[0] - T[0] * Nn[2], T[0] * Nn[1] - T[1] * Nn[0]];
    if (k > 0) along += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1], pts[k][2] - pts[k - 1][2]);
    const fl = f0 + (f1 - f0) * k / (n - 1), sw = 1 + 0.1 * (vnoise(along * 1.3 + seed * 17, seed * 5) - 0.5);
    for (let q = 0; q <= sides; q++) {
      const ang = q / sides * 6.2832, c = Math.cos(ang), sn = Math.sin(ang), o = [Nn[0] * c + B[0] * sn, Nn[1] * c + B[1] * sn, Nn[2] * c + B[2] * sn];
      const t = [-Nn[0] * sn + B[0] * c, -Nn[1] * sn + B[1] * c, -Nn[2] * sn + B[2] * c], L = lobe(ang, along) * sw, dL = dLobe(ang, along) * sw, rr = rad[k];
      W.pos.push(pts[k][0] + o[0] * rr * L, pts[k][1] + o[1] * rr * L, pts[k][2] + o[2] * rr * L);
      W.nor.push(...norm([o[0] * L - t[0] * dL, o[1] * L - t[1] * dL, o[2] * L - t[2] * dL]));
      W.w.push(fl, along, ang, seed); W.b.push(...base);
    }
  }
  for (let k = 0; k < n - 1; k++) for (let q = 0; q < sides; q++) { const a = v0 + k * (sides + 1) + q, b2 = a + sides + 1; W.idx.push(a, b2, a + 1, a + 1, b2, b2 + 1); }
}
// one alien juniper from a seed: a leaning S-curved trunk with a flared root, 2-4 limbs that rise and reach, twigs, and
// cloud-like foliage pads on every tip, each pad a flattened dome of short blades. Every number is drawn from a range,
// so any seed gives a different tree that is still recognisably the same species.
function growJuniper(x, y, z, h, seed, W, Lf, leanTo) {
  const r = rng(Math.floor(seed * 1e9) ^ 0x5bd1), hue = r();
  const lean = leanTo ?? r() * 6.2832, leanAmt = 0.12 + 0.3 * r(), wob = 0.06 + 0.1 * r(), ph = r() * 6.28;
  const ld = [Math.cos(lean), Math.sin(lean)], lp = [-ld[1], ld[0]], trunkH = h * (0.5 + 0.2 * r()), base = [x, z, h, hue];
  const at = (t) => [x + (ld[0] * leanAmt * t * t + lp[0] * wob * Math.sin(t * 5 + ph)) * h, y + trunkH * t, z + (ld[1] * leanAmt * t * t + lp[1] * wob * Math.sin(t * 5 + ph)) * h];
  const r0 = h * (0.045 + 0.02 * r()), rad = (t) => r0 * (1 - 0.62 * t) + r0 * 0.9 * Math.exp(-t * 10);
  const tp = [], tr = [];
  for (let k = 0; k <= 12; k++) { tp.push(at(k / 12)); tr.push(rad(k / 12)); }
  tube(W, tp, tr, 14, 0, 0.55, base, seed);
  const pads = [{ c: at(1), R: h * (0.2 + 0.1 * r()), f: 0.6 }];
  const young = h < 2.6, nl = young ? 2 + Math.floor(r() * 2) : h > 7 ? 5 + Math.floor(r() * 3) : 3 + Math.floor(r() * 3);
  for (let i = 0; i < nl; i++) {
    const t0 = 0.38 + 0.55 * (i + r() * 0.7) / nl, P0 = at(t0), az = lean + (r() - 0.5) * 4.2, len = h * (0.26 + 0.3 * r()), rise = 0.12 + 0.45 * r(), dr = 0.2 + 0.3 * r();
    const dh = [Math.cos(az), Math.sin(az)], pts = [], rr = [], fA = 0.55 * t0, fB = fA + 0.45;
    for (let k = 0; k <= 6; k++) { const q = k / 6; pts.push([P0[0] + dh[0] * len * q + lp[0] * 0.05 * h * Math.sin(q * 4 + i), P0[1] + len * (rise * q - dr * q * q * 0.5), P0[2] + dh[1] * len * q + lp[1] * 0.05 * h * Math.sin(q * 4 + i)]); rr.push(rad(t0) * 0.62 * (1 - 0.62 * q)); }
    tube(W, pts, rr, 9, fA, fB, base, seed + i);
    pads.push({ c: [pts[6][0], pts[6][1] + 0.05 * h, pts[6][2]], R: h * (0.17 + 0.09 * r()), f: fB });
    for (let j = 0, nt = young ? Math.floor(r() * 2) : 2 + Math.floor(r() * 2); j < nt; j++) {
      const q0 = 0.45 + 0.35 * r(), Q = pts[Math.round(q0 * 6)], az2 = az + (r() < 0.5 ? -1 : 1) * (0.6 + 0.6 * r()), l2 = len * (0.3 + 0.25 * r()), tw = [], trr = [];
      for (let k = 0; k <= 4; k++) { const q = k / 4; tw.push([Q[0] + Math.cos(az2) * l2 * q, Q[1] + l2 * (0.35 * q), Q[2] + Math.sin(az2) * l2 * q]); trr.push(rad(t0) * 0.32 * (1 - 0.6 * q)); }
      tube(W, tw, trr, 5, fA + 0.3, fB + 0.1, base, seed + i + j * 7);
      pads.push({ c: [tw[4][0], tw[4][1] + 0.04 * h, tw[4][2]], R: h * (0.13 + 0.07 * r()), f: fB + 0.1 });
    }
  }
  for (const pd of pads) {
    const nb = Math.round(Math.min(240, Math.max(young ? 28 : 60, 520 * pd.R * pd.R)) * LEAF_MULT);
    for (let b = 0; b < nb; b++) {
      const a = r() * 6.2832, rf = Math.sqrt(r()), rd = rf * pd.R * 0.75;
      const root = [pd.c[0] + Math.cos(a) * rd, pd.c[1] - pd.R * 0.18 + r() * pd.R * 0.22, pd.c[2] + Math.sin(a) * rd];
      const dir = norm([Math.cos(a) * (0.35 + rf) + (r() - 0.5) * 0.5, 0.25 + 0.55 * r(), Math.sin(a) * (0.35 + rf) + (r() - 0.5) * 0.5]);
      Lf.R.push(...root, pd.f); Lf.D.push(...dir, 2 * pd.R * (0.55 + 0.5 * r()) * (1.15 - rf * 0.4)); Lf.M.push(0.08 + 0.1 * r(), 0.12 + 0.25 * r(), 0.08 + 0.07 * r(), r()); Lf.B.push(...base);
    }
  }
}
function growForest(sc) {
  const W = { pos: [], nor: [], w: [], b: [], idx: [] }, Lf = { R: [], D: [], M: [], B: [] };
  for (let q = 0; q < sc.trees.length; q += 5) growJuniper(sc.trees[q], sc.trees[q + 1], sc.trees[q + 2], sc.trees[q + 4], sc.trees[q + 3], W, Lf);
  // one small juniper clinging to the top of the sea stack, leaning out over the water
  let top = 0;
  for (let i = 1; i < STACK_GEO.pos.length; i += 3) if (STACK_GEO.pos[i] > STACK_GEO.pos[top * 3 + 1]) top = (i - 1) / 3;
  const sx = ISLET[0] + STACK_GEO.pos[top * 3] * STACK_S[0], sz = ISLET[1] + STACK_GEO.pos[top * 3 + 2] * STACK_S[2], sy = H(ISLET[0], ISLET[1]) - 0.2 + STACK_GEO.pos[top * 3 + 1] * STACK_S[1];
  growJuniper(sx, sy - 0.1, sz, 3.2, 0.7317, W, Lf, Math.atan2(LAKE[1] - sz, LAKE[0] - sx) + 2.4);
  // and one on the summit's crown, behind the lookout, bent by the wind off the lake
  { const a = LOOKOUT.th + 2.6, x = SUMMIT.x + Math.cos(a) * 3.4 / 0.92, z = SUMMIT.z + Math.sin(a) * 3.4 / 1.08; growJuniper(x, H(x, z) - 0.05, z, 4.4, 0.4131, W, Lf, LOOKOUT.th + 2.4); }
  return { pos: new Float32Array(W.pos), nor: new Float32Array(W.nor), w: new Float32Array(W.w), b: new Float32Array(W.b), idx: new Uint32Array(W.idx), R: new Float32Array(Lf.R), D: new Float32Array(Lf.D), M: new Float32Array(Lf.M), B: new Float32Array(Lf.B) };
}

// understory around tree bases and big stones, ferns along the shade and the shore, glow tubes by the water,
// coilferns curling in the shade of the junipers, and lantern bells nodding along the shore and the meadows
function plantScatter(sc) {
  const r = rng(555), P = [], F = [], S2 = [];
  const ok = (x, z) => { const y = H(x, z); return y > 0.32 && y < 10 && nearNy(x, z) > 0.8 && clearOf(x, z) && inMap(x, z) && rocky(x, z) < 0.6 && !onPath(x, z, 0.8); };
  const anchors = [];
  for (let q = 0; q < sc.trees.length; q += 5) anchors.push([sc.trees[q], sc.trees[q + 2]]);
  for (const v of [0, 1]) for (let q = 0; q < sc.rv[v].length; q += 4) if (sc.rs[v][q] > 0.9) anchors.push([sc.rv[v][q], sc.rv[v][q + 2]]);
  const nearA = (r0, r1) => { const a = anchors[Math.floor(r() * anchors.length)], t = r() * 6.2832, d = r0 + r() * (r1 - r0); return [a[0] + Math.cos(t) * d, a[1] + Math.sin(t) * d]; };
  const shoreP = (d0, d1) => { let x, z, k = 0; do { x = LAKE[0] + (r() * 2 - 1) * 38; z = LAKE[1] + (r() * 2 - 1) * 32; k++; } while ((lakeD(x, z) < d0 || lakeD(x, z) > d1) && k < 60); return [x, z]; };
  const anywhere = () => [(r() * 2 - 1) * (HALF - 2), (r() * 2 - 1) * (HALF - 2)];
  const riverP = () => { const t = r() * RIVER.length * 0.85, [x, z, tx, tz] = RIVER.at(t), o = (riverW(t) + 0.4 + r() * 1.4) * (r() < 0.5 ? -1 : 1); return [x - tz * o, z + tx * o]; };
  const place = (gen) => { for (let t = 0; t < 30; t++) { const [x, z] = gen(); if (ok(x, z)) return [x, z]; } return null; };
  const k = touch ? 0.65 : 1;
  for (let c = 0; c < 560 * k; c++) {
    const at = place(() => (r() < 0.7 ? nearA(1.2, 3.6) : anywhere())); if (!at) continue;
    const [x, z] = at, y = H(x, z), scl = 0.7 + r() * 0.8, n = 9 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) { P.push(x, y - 0.03, z, scl); F.push(i / n * 6.2832 + r() * 0.4, 0.5 + r() * 0.45, 0.11 + r() * 0.05, 0); S2.push(0.55 + r() * 0.25, 0.45, 0.25 + r() * 0.15, 0.45 + r() * 0.25); }
  }
  for (let c = 0; c < 480 * k; c++) {
    const at = place(() => (r() < 0.6 ? nearA(0.8, 3.2) : shoreP(12, 14.5))); if (!at) continue;
    const [x, z] = at, y = H(x, z), scl = 0.7 + r() * 0.6, n = 10 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) { P.push(x, y - 0.02, z, scl); F.push(i / n * 6.2832 + r() * 0.5, 0.75 + r() * 0.5, 0.24, 1); S2.push(0.8, 0.22, 0.5, 0.85 + r() * 0.2); }
  }
  for (let c = 0; c < 260 * k; c++) {
    const at = place(() => { const q = r(); return q < 0.42 ? shoreP(11, 13.2) : q < 0.62 ? riverP() : nearA(0.6, 1.8); }); if (!at) continue;
    const m = 8 + Math.floor(r() * 9);
    for (let i = 0; i < m; i++) {
      const x = at[0] + (r() - 0.5) * 0.7, z = at[1] + (r() - 0.5) * 0.7, y = H(x, z), L = 0.12 + r() * 0.28, W = 0.035 + r() * 0.02, phi = r() * 3.1416;
      for (const ph of [phi, phi + 1.5708]) { P.push(x, y - 0.02, z, 1); F.push(ph, L, W, 2); S2.push(0.06, 1, 0, 0); }
    }
  }
  // coilferns: a few stalks to a clump, each rising and rolling its tip into a spiral
  for (let c = 0; c < 300 * k; c++) {
    const at = place(() => nearA(0.9, 3.4)); if (!at) continue;
    const m = 3 + Math.floor(r() * 5);
    for (let i = 0; i < m; i++) {
      const x = at[0] + (r() - 0.5) * 0.5, z = at[1] + (r() - 0.5) * 0.5, y = H(x, z), sc0 = 0.9 + r() * 0.6, phi = r() * 6.2832, L = 0.42 + r() * 0.34, W = 0.05 + r() * 0.025, lean = 0.18 + r() * 0.2;
      // two ribbons crossed, so the stalk and its spiral read from every side
      for (const ph of [phi, phi + 1.5708]) { P.push(x, y - 0.02, z, sc0); F.push(ph, L, W, 3); S2.push(lean, 0.85, 0, 0); }
    }
  }
  // lantern bells: arching stems that nod a glowing bulb toward the ground
  for (let c = 0; c < 280 * k; c++) {
    const at = place(() => (r() < 0.5 ? shoreP(11.5, 15) : anywhere())); if (!at) continue;
    const m = 2 + Math.floor(r() * 4);
    for (let i = 0; i < m; i++) {
      const x = at[0] + (r() - 0.5) * 0.8, z = at[1] + (r() - 0.5) * 0.8, y = H(x, z), sc0 = 0.9 + r() * 0.4, phi = r() * 6.2832, L = 0.62 + r() * 0.4, W = 0.05 + r() * 0.02, arch = 0.45 + r() * 0.3;
      for (const ph of [phi, phi + 1.5708]) { P.push(x, y - 0.02, z, sc0); F.push(ph, L, W, 4); S2.push(arch, 0.95, 0, 0); }
    }
  }
  return { P: new Float32Array(P), F: new Float32Array(F), S2: new Float32Array(S2) };
}
const MOTE_N = touch ? 400 : 640;
function moteScatter() {
  const r = rng(808), m = new Float32Array(MOTE_N * 4);
  for (let i = 0; i < MOTE_N; i++) { const x = (r() * 2 - 1) * (HALF - 2), z = (r() * 2 - 1) * (HALF - 2), g = H(x, z); m.set([x, Math.max(g, 0) + 0.4 + r() * 2.4, z, r()], i * 4); }
  return m;
}

// ---------------------------------------------------------------- the night sky
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// the galaxy's frame in the sky's, rows toward its core, its pole and the third axis: the core rises in the west-north-
// west over the lake, and the band climbs from it past the zenith
const GAL = (() => {
  const C = norm([-0.874, 0.374, -0.308]), V0 = norm([-C[0] * C[1], 1 - C[1] * C[1], -C[2] * C[1]]), W = cross(C, V0), a = 0.45;
  const P = norm(cross(C, V0.map((v, i) => v * Math.cos(a) + W[i] * Math.sin(a))));
  return [...C, ...P, ...cross(C, P)];
})();
const STAR_N = touch ? 7000 : 12000;
function starScatter() {
  const r = rng(12345), S = new Float32Array(STAR_N * 4), C = new Float32Array(STAR_N * 4);
  const COLORS = [[0.68, 0.8, 1.0], [0.8, 0.88, 1.0], [0.95, 0.97, 1.0], [1.0, 0.96, 0.86], [1.0, 0.9, 0.7], [1.0, 0.8, 0.58], [1.0, 0.68, 0.5]];
  for (let k = 0; k < STAR_N;) {
    const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z), x = s * Math.cos(a), y = s * Math.sin(a);
    const b = Math.asin(x * GAL[3] + y * GAL[4] + z * GAL[5]);
    if (r() > 0.38 + 0.62 * Math.exp(-b * b / 0.18)) continue;
    const m = -0.4 + Math.log10(1 + r() * (Math.pow(10, 0.45 * 7.2) - 1)) / 0.45;
    const c = COLORS[Math.min(6, Math.floor(Math.pow(r(), 0.8) * 7))];
    S.set([x, y, z, m], k * 4); C.set([c[0], c[1], c[2], r()], k * 4); k++;
  }
  return { S, C };
}
// paint the band into a cube map once, at boot; the sky samples it in its own frame and it turns with the stars
const MILKY_SIZE = touch || TEST ? 512 : 1024;
function bakeMilkyWay() {
  const t = gl.createTexture(), f = gl.createFramebuffer();
  gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
  for (let i = 0; i < 6; i++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA8, MILKY_SIZE, MILKY_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_CUBE_MAP, k, v);
  gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.viewport(0, 0, MILKY_SIZE, MILKY_SIZE);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.bindVertexArray(null); gl.useProgram(MILKY);
  gl.uniform1f(MILKY.u('uSize'), MILKY_SIZE); gl.uniformMatrix3fv(MILKY.u('uGal'), false, GAL);
  for (let i = 0; i < 6; i++) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, t, 0);
    gl.uniform1i(MILKY.u('uFace'), i); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(f); gl.enable(gl.DEPTH_TEST);
  return t;
}

// ---------------------------------------------------------------- tiled instances
// Blades, leaves and plants are drawn tile by tile, 16 m to a tile. A tile outside the view is skipped, and one
// further than `near` metres draws only a prefix of its instances, shuffled so the prefix is an even thinning, with
// each survivor widened to hold the cover (Corey's adaptive density, per tile).
const TILE_M = 16, TILES = Math.ceil(2 * (HALF + TILE_M) / TILE_M);
class Tiled {
  constructor(prog, data, at, span, verts, near, least) {
    Object.assign(this, { prog, verts, near, least });
    const names = Object.keys(data), n = data[names[0]].length / 4, cell = new Int32Array(n), counts = new Int32Array(TILES * TILES + 1);
    const tileOf = (x, z) => Math.min(TILES - 1, Math.max(0, Math.floor((x + HALF + TILE_M) / TILE_M))) + TILES * Math.min(TILES - 1, Math.max(0, Math.floor((z + HALF + TILE_M) / TILE_M)));
    for (let i = 0; i < n; i++) { const [x, , z] = at(i); cell[i] = tileOf(x, z); counts[cell[i] + 1]++; }
    for (let t = 0; t < TILES * TILES; t++) counts[t + 1] += counts[t];
    const order = new Int32Array(n), fill = counts.slice(0, TILES * TILES);
    for (let i = 0; i < n; i++) order[fill[cell[i]]++] = i;
    const r = rng(9001);
    this.tiles = [];
    for (let t = 0; t < TILES * TILES; t++) {
      const a = counts[t], b = counts[t + 1];
      for (let k = b - 1; k > a; k--) { const m = a + Math.floor(r() * (k - a + 1)); [order[k], order[m]] = [order[m], order[k]]; }
      let y0 = 1e9, y1 = -1e9;
      for (let k = a; k < b; k++) { const y = at(order[k])[1]; y0 = Math.min(y0, y - span); y1 = Math.max(y1, y + span); }
      const x0 = (t % TILES) * TILE_M - HALF - TILE_M, z0 = Math.floor(t / TILES) * TILE_M - HALF - TILE_M;
      if (b > a) this.tiles.push({ start: a, count: b - a, x0, z0, y0, y1 });
    }
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.attrs = names.map((name) => {
      const src = data[name], dst = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) dst.set(src.subarray(order[k] * 4, order[k] * 4 + 4), k * 4);
      const buf = gl.createBuffer(), l = gl.getAttribLocation(prog, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, dst, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(l); gl.vertexAttribDivisor(l, 1);
      return { buf, loc: l };
    });
    gl.bindVertexArray(null);
    this.count = n;
  }
  /** Draw what the camera can see. Returns the instances drawn. */
  draw(VP, eye, mirror, density = 1) {
    gl.bindVertexArray(this.vao);
    const lodW = this.prog.u('uLodW');
    let drawn = 0;
    for (const t of this.tiles) {
      const dx = Math.max(t.x0 - eye[0], 0, eye[0] - t.x0 - TILE_M), dz = Math.max(t.z0 - eye[2], 0, eye[2] - t.z0 - TILE_M), d = Math.hypot(dx, dz);
      const f = d < this.near ? 1 : Math.max(this.least, Math.pow(this.near / d, 1.5)), n = Math.floor(t.count * f * density);
      if (n <= 0 || this.hidden(VP, t, mirror)) continue;
      for (const a of this.attrs) { gl.bindBuffer(gl.ARRAY_BUFFER, a.buf); gl.vertexAttribPointer(a.loc, 4, gl.FLOAT, false, 0, t.start * 16); }
      gl.uniform1f(lodW, Math.min(2.2, 1 / Math.sqrt(f * density)));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, this.verts, n);
      drawn += n;
    }
    gl.uniform1f(lodW, 1); gl.bindVertexArray(null);
    return drawn;
  }
  /** True when the tile's box lies wholly outside one plane of the view (the mirror pass flips it in the water). */
  hidden(M, t, mirror) {
    let left = 0, right = 0, low = 0, high = 0, behind = 0;
    for (let c = 0; c < 8; c++) {
      const x = t.x0 + (c & 1) * TILE_M, y = ((c & 2) ? t.y1 : t.y0) * mirror, z = t.z0 + ((c & 4) ? TILE_M : 0);
      const cx = M[0] * x + M[4] * y + M[8] * z + M[12], cy = M[1] * x + M[5] * y + M[9] * z + M[13], cw = M[3] * x + M[7] * y + M[11] * z + M[15];
      if (cw <= 0) { behind++; continue; }
      if (cx < -cw) left++; if (cx > cw) right++; if (cy < -cw) low++; if (cy > cw) high++;
    }
    return behind === 8 || left + behind === 8 && left > 0 || right + behind === 8 && right > 0 || low + behind === 8 && low > 0 || high + behind === 8 && high > 0;
  }
}

// ---------------------------------------------------------------- build the scene
const loc = (p, n) => gl.getAttribLocation(p, n);
const near = terrainNear(), far = terrainFar(), wm = waterMesh(), sc = scatter(), forest = growForest(sc), pl = plantScatter(sc), motes = moteScatter();
const rockGeos = [rockMesh(1.3, 3, false), rockMesh(4.1, 3, false), rockMesh(7.7, 3, true), rockMesh(2.2, 1, false), STACK_GEO], crystals = growCrystals(sc.crystalSites);
const vNear = vao([{ loc: loc(TERRAIN, 'aPos'), size: 3, data: near.pos }, { loc: loc(TERRAIN, 'aNor'), size: 3, data: near.nor }], near.idx);
const vFar = vao([{ loc: loc(TERRAIN, 'aPos'), size: 3, data: far.pos }, { loc: loc(TERRAIN, 'aNor'), size: 3, data: far.nor }], far.idx);
const vWater = vao([{ loc: loc(WATERP, 'aXZ'), size: 2, data: wm.xz }, { loc: loc(WATERP, 'aDepth'), size: 1, data: wm.dep }], wm.idx);
const rm = riverMesh(), vRiver = vao([{ loc: loc(RIVERP, 'aP'), size: 3, data: rm.P }, { loc: loc(RIVERP, 'aF'), size: 4, data: rm.F }, { loc: loc(RIVERP, 'aT'), size: 2, data: rm.T }], rm.idx);
{ const { S, m } = riverMask(), t = gl.createTexture(); gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, S, S, 0, gl.RG, gl.UNSIGNED_BYTE, m);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); }
const vRocks = rockGeos.map((g, k) => vao([{ loc: loc(ROCK, 'aPos'), size: 3, data: g.pos }, { loc: loc(ROCK, 'aNor'), size: 3, data: g.nor }, { loc: loc(ROCK, 'aI'), size: 4, data: sc.rv[k], div: 1 }, { loc: loc(ROCK, 'aS'), size: 4, data: sc.rs[k], div: 1 }], g.idx));
const vCrys = vao([{ loc: loc(CRYSTAL, 'aPos'), size: 3, data: crystals.pos }, { loc: loc(CRYSTAL, 'aNor'), size: 3, data: crystals.nor }, { loc: loc(CRYSTAL, 'aC'), size: 4, data: crystals.c }]);
const vWood = vao([{ loc: loc(WOOD, 'aPos'), size: 3, data: forest.pos }, { loc: loc(WOOD, 'aNor'), size: 3, data: forest.nor }, { loc: loc(WOOD, 'aW'), size: 4, data: forest.w }, { loc: loc(WOOD, 'aB'), size: 4, data: forest.b }], forest.idx);
const grass = new Tiled(GRASS, { aG: sc.G, aR: sc.R }, (i) => [sc.G[i * 4], sc.G[i * 4 + 2], sc.G[i * 4 + 1]], 1.4, 7, 18, 0.06);
const leaves = new Tiled(JLEAF, { aR: forest.R, aD: forest.D, aM: forest.M, aB: forest.B }, (i) => [forest.R[i * 4], forest.R[i * 4 + 1], forest.R[i * 4 + 2]], 3.5, 13, 40, 0.3);
const plants = new Tiled(PLANT, { aP: pl.P, aF: pl.F, aS2: pl.S2 }, (i) => [pl.P[i * 4], pl.P[i * 4 + 1], pl.P[i * 4 + 2]], 1.2, 25, 24, 0.12);
let grassDensity = 1;
const vMotes = vao([{ loc: loc(POINTS, 'aP'), size: 4, data: motes }]);
const stars = starScatter(), vStars = vao([{ loc: loc(STARS, 'aS'), size: 4, data: stars.S }, { loc: loc(STARS, 'aC'), size: 4, data: stars.C }]);
bakeMilkyWay();
const RAIN_N = 700, rainSeeds = new Float32Array(RAIN_N * 4); { const r = rng(9); for (let i = 0; i < RAIN_N; i++) rainSeeds.set([(r() * 2 - 1) * 34, r(), (r() * 2 - 1) * 34, r()], i * 4); }
const vRain = vao([{ loc: loc(POINTS, 'aP'), size: 4, data: rainSeeds }]);
const stoneBuf = new Float32Array(4 * 8);
const stoneAttr = { loc: loc(POINTS, 'aP'), size: 4, data: stoneBuf, usage: gl.DYNAMIC_DRAW };
const vStone = vao([stoneAttr]);
const stoneVbo = stoneAttr.buffer;
const PODS = 8, podBuf = new Float32Array(PODS * 4), podAttr = { loc: loc(POINTS, 'aP'), size: 4, data: podBuf, usage: gl.DYNAMIC_DRAW }, vPods = vao([podAttr]);

function fieldTex() {
  const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
const texGlow = fieldTex(), texGround = fieldTex(), texWear = fieldTex();
function clearTexture(tex) {
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(N * N));
}

let reflTex = null, reflFbo = null, reflDepth = null, reflW = 0, reflH = 0;
function ensureRefl(w, h) {
  if (reflW === w && reflH === h) return;
  reflW = w; reflH = h;
  if (!reflTex) { reflTex = gl.createTexture(); reflFbo = gl.createFramebuffer(); reflDepth = gl.createRenderbuffer(); }
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, reflTex); gl.texImage2D(gl.TEXTURE_2D, 0, CFMT, w, h, 0, gl.RGBA, CTYPE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindRenderbuffer(gl.RENDERBUFFER, reflDepth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, reflFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, reflTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, reflDepth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ---------------------------------------------------------------- post: Corey's frame pipeline (ceeboozwah/grass post.js),
// ported to raw WebGL2: MSAA scene target, dual-filter bloom, ACES, vibrance, vignette, dither; plus crepuscular rays
// marched toward the star through the sky mask the sky pass leaves in alpha
const P_PRE = program(FSQ, `uniform sampler2D tMap; uniform vec2 uTexel; uniform float uThr; in vec2 vUv; out vec4 o;
vec3 bp(vec2 off){ vec3 c = min(texture(tMap, vUv + off * uTexel).rgb, vec3(24.)); float l = max(c.r, max(c.g, c.b)); return c * smoothstep(uThr * 0.7, uThr * 1.5 + 0.3, l); }
void main(){ o = vec4((bp(vec2(-1., -1.)) + bp(vec2(1., -1.)) + bp(vec2(-1., 1.)) + bp(vec2(1., 1.))) * 0.25, 1.); }`);
const P_DOWN = program(FSQ, `uniform sampler2D tMap; uniform vec2 uTexel; in vec2 vUv; out vec4 o;
void main(){ vec3 c = texture(tMap, vUv + uTexel * vec2(-1., -1.)).rgb + texture(tMap, vUv + uTexel * vec2(1., -1.)).rgb + texture(tMap, vUv + uTexel * vec2(-1., 1.)).rgb + texture(tMap, vUv + uTexel * vec2(1., 1.)).rgb; o = vec4(c * 0.25, 1.); }`);
const P_UP = program(FSQ, `uniform sampler2D tMap; uniform vec2 uTexel; in vec2 vUv; out vec4 o;
void main(){
  vec3 c = texture(tMap, vUv).rgb * 4.;
  c += (texture(tMap, vUv + uTexel * vec2(1., 0.)).rgb + texture(tMap, vUv + uTexel * vec2(-1., 0.)).rgb + texture(tMap, vUv + uTexel * vec2(0., 1.)).rgb + texture(tMap, vUv + uTexel * vec2(0., -1.)).rgb) * 2.;
  c += texture(tMap, vUv + uTexel * vec2(1., 1.)).rgb + texture(tMap, vUv + uTexel * vec2(-1., 1.)).rgb + texture(tMap, vUv + uTexel * vec2(1., -1.)).rgb + texture(tMap, vUv + uTexel * vec2(-1., -1.)).rgb;
  o = vec4(c / 16. * 0.76, 1.); }`);
const P_RAYS = program(FSQ, `uniform sampler2D tMap; uniform vec2 uSunUV; uniform float uVis; uniform vec3 uRayCol; in vec2 vUv; out vec4 o;
void main(){
  vec2 st = (uSunUV - vUv) / 32.; vec2 q = vUv; float acc = 0., w = 1.;
  for (int i = 0; i < 32; i++) { q += st; vec4 c = texture(tMap, q); float lum = max(c.r, max(c.g, c.b)); acc += c.a * smoothstep(0.35, 1.6, lum) * exp(-length(q - uSunUV) * 5.) * w; w *= 0.965; }
  o = vec4(uRayCol * acc / 32. * uVis, 1.); }`);
const P_FINAL = program(FSQ, `uniform sampler2D tScene, tBloom, tRays; uniform float uBloom, uRays, uHDRf; in vec2 vUv; out vec4 o;
vec3 acesF(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0., 1.); }
void main(){
  vec3 c = texture(tScene, vUv).rgb, b = texture(tBloom, vUv).rgb, r = texture(tRays, vUv).rgb;
  if (uHDRf > 0.5) c = pow(acesF(c + b * uBloom + r * uRays), vec3(1. / 2.2));
  else c = clamp(c + b * uBloom * 0.7 + r * uRays * 0.6, 0., 1.);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, 1.15);
  vec2 q = vUv - 0.5; c *= 1. - dot(q, q) * 0.55;
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.;
  o = vec4(c, 1.); }`);

function colorTex(w, h) {
  const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, CFMT, w, h, 0, gl.RGBA, CTYPE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}
function fboFor(t, depthRb) {
  const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  if (depthRb) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); return f;
}
const post = { w: 0, h: 0, ms: null };
function ensurePost(w, h) {
  if (post.w === w && post.h === h) return;
  if (post.res) {
    for (const f of [post.ms, post.resF, ...post.mips.map((m) => m.f), post.rays.f]) if (f) gl.deleteFramebuffer(f);
    for (const t of [post.res, ...post.mips.map((m) => m.t), post.rays.t]) gl.deleteTexture(t);
    for (const rb of [post.msC, post.msD, post.dRb]) if (rb) gl.deleteRenderbuffer(rb);
  }
  post.w = w; post.h = h; post.ms = null;
  post.res = colorTex(w, h);
  if (SAMPLES > 1) {
    post.msC = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, post.msC); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, SAMPLES, CFMT, w, h);
    post.msD = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, post.msD); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, SAMPLES, gl.DEPTH_COMPONENT24, w, h);
    post.ms = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, post.ms);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, post.msC); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, post.msD);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { gl.deleteFramebuffer(post.ms); post.ms = null; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  post.dRb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, post.dRb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  post.resF = fboFor(post.res, post.ms ? null : post.dRb);
  post.mips = [];
  for (let i = 1; i <= 5; i++) { const mw = Math.max(2, w >> i), mh = Math.max(2, h >> i), t = colorTex(mw, mh); post.mips.push({ t, f: fboFor(t), w: mw, h: mh }); }
  const rw = Math.max(2, w >> 1), rh = Math.max(2, h >> 1), rt = colorTex(rw, rh); post.rays = { t: rt, f: fboFor(rt), w: rw, h: rh };
}
function pass(prog, fbo, w, h, tex) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h); gl.useProgram(prog);
  if (tex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.u('tMap'), 4); }
}
function postProcess(VP, eye, b, w, h) {
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.depthMask(false); gl.bindVertexArray(null);
  pass(P_PRE, post.mips[0].f, post.mips[0].w, post.mips[0].h, post.res);
  gl.uniform2f(P_PRE.u('uTexel'), 1 / w, 1 / h); gl.uniform1f(P_PRE.u('uThr'), HDR ? 1.35 - 0.2 * night : 0.8); gl.drawArrays(gl.TRIANGLES, 0, 3);
  for (let i = 1; i < post.mips.length; i++) { const s0 = post.mips[i - 1]; pass(P_DOWN, post.mips[i].f, post.mips[i].w, post.mips[i].h, s0.t); gl.uniform2f(P_DOWN.u('uTexel'), 1 / s0.w, 1 / s0.h); gl.drawArrays(gl.TRIANGLES, 0, 3); }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  for (let i = post.mips.length - 1; i > 0; i--) { const s0 = post.mips[i]; pass(P_UP, post.mips[i - 1].f, post.mips[i - 1].w, post.mips[i - 1].h, s0.t); gl.uniform2f(P_UP.u('uTexel'), 1 / s0.w, 1 / s0.h); gl.drawArrays(gl.TRIANGLES, 0, 3); }
  gl.disable(gl.BLEND);
  // rays toward the star by day, toward the giant by night
  const rd = norm(SUN.map((v, i) => v * (1 - night) + PLANET[i] * night));
  const P = [eye[0] + rd[0] * 1000, eye[1] + rd[1] * 1000, eye[2] + rd[2] * 1000, 1];
  const cx = VP[0] * P[0] + VP[4] * P[1] + VP[8] * P[2] + VP[12], cy = VP[1] * P[0] + VP[5] * P[1] + VP[9] * P[2] + VP[13], cw = VP[3] * P[0] + VP[7] * P[1] + VP[11] * P[2] + VP[15];
  const facing = b.f[0] * rd[0] + b.f[1] * rd[1] + b.f[2] * rd[2];
  const vis = cw > 0 ? Math.max(0, Math.min(1, (facing - 0.05) / 0.45)) : 0;
  pass(P_RAYS, post.rays.f, post.rays.w, post.rays.h, post.res);
  gl.uniform2f(P_RAYS.u('uSunUV'), cw > 0 ? cx / cw * 0.5 + 0.5 : 0.5, cw > 0 ? cy / cw * 0.5 + 0.5 : 0.5);
  gl.uniform1f(P_RAYS.u('uVis'), vis); gl.uniform3fv(P_RAYS.u('uRayCol'), [1.0 * (1 - night) + 0.25 * night, 0.62 * (1 - night) + 0.38 * night, 0.36 * (1 - night) + 0.8 * night]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  pass(P_FINAL, null, w, h, null);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, post.res); gl.uniform1i(P_FINAL.u('tScene'), 4);
  gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, post.mips[0].t); gl.uniform1i(P_FINAL.u('tBloom'), 5);
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, post.rays.t); gl.uniform1i(P_FINAL.u('tRays'), 6);
  gl.uniform1f(P_FINAL.u('uBloom'), 0.22 + 0.14 * night); gl.uniform1f(P_FINAL.u('uRays'), HDR ? 1.1 - 0.5 * night : 0.8); gl.uniform1f(P_FINAL.u('uHDRf'), HDR ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
}

// ---------------------------------------------------------------- engine state
let engine, glowF, groundF, wearF, mode = BOXEL;
const ripples = []; // [x, z, t0, strength]
let simT = 0;

function setMode(m) {
  mode = m; ripples.length = 0;
  for (const f of [glowF, groundF, wearF]) f.set(m);
  resetWorld();
}

// the world's own events. Things happen on Tarn when nobody is looking, and they go into the same fields, in boxel and
// dense alike: a pilgrim walks the summit trail up and back and keeps it worn, seed pods ride the river and leave light
// in the water behind them, and the rapids throw spray onto their banks.
const world = { r: rng(321), pilgrim: null, pods: [], spray: 0, rapids: [] };
for (let s = 2; s < RIVER.length; s += 0.5) if (riverSpeed(s) > 1.6) world.rapids.push(s);
function resetWorld() {
  const r = world.r = rng(321);
  world.pilgrim = { s: 0, dir: 1, stride: 0, foot: 1 };
  world.pods = Array.from({ length: PODS }, () => ({ s: r() * RIVER.length * 0.75, a: (r() - 0.5) * 1.2, acc: r(), seed: r() }));
  world.spray = 0;
  // the trail starts worn: years of feet before yours
  for (let s = 0; s < TRAIL.length; s += 0.3) { const [x, z] = TRAIL.at(s); wearF.deposit(x, z, 3, 0.45); }
}
function podAt(d) { const [x, z, tx, tz] = RIVER.at(d.s), o = d.a * riverW(d.s) * 0.7; return [x - tz * o, z + tx * o, riverWS(d.s)]; }
function worldStep(dt) {
  const P = world.pilgrim, sp = 1.4;
  P.s += P.dir * sp * dt;
  if (P.s >= TRAIL.length) { P.s = TRAIL.length; P.dir = -1; } else if (P.s <= 0) { P.s = 0; P.dir = 1; }
  if ((P.stride += sp * dt) > 0.55) {
    P.stride -= 0.55; P.foot = -P.foot;
    const [x, z, tx, tz] = TRAIL.at(P.s);
    wearF.deposit(x - tz * 0.13 * P.foot, z + tx * 0.13 * P.foot, 2, 0.24);
  }
  for (const d of world.pods) {
    d.s += riverSpeed(d.s) * 0.8 * dt;
    if (riverWS(d.s) <= WATER + 0.02) { d.s = world.r() * 5; d.a = (world.r() - 0.5) * 1.2; }
    if ((d.acc += dt * 5) >= 1) { d.acc -= 1; const [x, z] = podAt(d); glowF.deposit(x, z, 1, 0.2); }
  }
  if ((world.spray += dt) > 0.45 && world.rapids.length) {
    world.spray = 0;
    const s = world.rapids[Math.floor(world.r() * world.rapids.length)], [x, z, tx, tz] = RIVER.at(s), side = world.r() < 0.5 ? -1 : 1, w = riverW(s) + 0.5;
    groundF.deposit(x - tz * w * side, z + tx * w * side, 3, 0.22);
    glowF.deposit(x, z, 2, 0.12);
  }
}

// events: what the world does to the fields
function footstep(x, z, inWater, wetFeet, run) {
  glowF.deposit(x, z, 2, inWater ? 0.75 : 0.85);
  if (!inWater) { wearF.deposit(x, z, 0, run ? 0.3 : 0.2); if (wetFeet > 0) groundF.deposit(x, z, 2, 0.45 * wetFeet); }
  else ripple(x, z, 0.35);
}
function splash(x, z, water) {
  if (water) { glowF.deposit(x, z, 9, 1); ripple(x, z, 1.4); for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283; groundF.deposit(x + Math.cos(a) * 2.2, z + Math.sin(a) * 2.2, 5, 0.5); } }
  else { glowF.deposit(x, z, 6, 1); groundF.deposit(x, z, 4, 0.25); wearF.deposit(x, z, 0, 0.5); }
}
function ripple(x, z, s) { ripples.push([x, z, simT, s]); if (ripples.length > 12) ripples.shift(); }
function spore(r) {
  const x = (r() * 2 - 1) * (HALF - 2), z = (r() * 2 - 1) * (HALF - 2), y = H(x, z);
  glowF.deposit(x, z, 1 + Math.floor(r() * 3), 0.5);
  if (y < WATER && r() < 0.2) ripple(x, z, 0.25);
}

// ---------------------------------------------------------------- camera + player
const player = { x: START[0], z: START[1], y: 0, yaw: 0.05, pitch: 0.06, vy: 0, stride: 0, foot: 1, wet: 0 };
player.y = H(player.x, player.z);
const keys = {};
let rain = false, hudOn = true, started = false;
const stones = [];
let stick = { x: 0, y: 0, id: null }, lookId = null, lookLast = null;

function camBasis(yaw, pitch) {
  const f = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw)];
  const r = [Math.cos(yaw), 0, Math.sin(yaw)];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f, r, u };
}
function viewProj(eye, b, fov, aspect) {
  const { f, r, u } = b, n = 0.05, fr = 3000, t = 1 / Math.tan(fov / 2);
  const V = [r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0,
    -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]), -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]), f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2], 1];
  const P = [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (fr + n) / (n - fr), -1, 0, 0, 2 * fr * n / (n - fr), 0];
  const M = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) { let s = 0; for (let k = 0; k < 4; k++) s += P[k * 4 + rr] * V[c * 4 + k]; M[c * 4 + rr] = s; }
  return M;
}

function walkable(x, z) { return H(x, z) > -1.25 && inMap(x, z, 1); }

function stepPlayer(dt) {
  let mx = 0, mz = 0;
  if (keys.KeyW || keys.ArrowUp) mz += 1; if (keys.KeyS || keys.ArrowDown) mz -= 1;
  if (keys.KeyA || keys.ArrowLeft) mx -= 1; if (keys.KeyD || keys.ArrowRight) mx += 1;
  if (stick.id !== null) { mx += stick.x; mz += -stick.y; }
  const len = Math.hypot(mx, mz);
  const ground = H(player.x, player.z), water = waterAt(player.x, player.z), inWater = ground < water - 0.05, depth = Math.max(0, water - ground);
  const run = keys.ShiftLeft || keys.ShiftRight || (stick.id !== null && len > 0.92);
  if (len > 0.05) {
    const sp = (run ? 4.2 : 1.9) * (inWater ? 1 - Math.min(0.6, depth * 0.45) : 1) * Math.min(1, len);
    const fx = Math.sin(player.yaw), fz = -Math.cos(player.yaw), rx = Math.cos(player.yaw), rz = Math.sin(player.yaw);
    const dx = (fx * mz + rx * mx) / Math.max(1, len) * sp * dt, dz = (fz * mz + rz * mx) / Math.max(1, len) * sp * dt;
    if (walkable(player.x + dx, player.z)) player.x += dx;
    if (walkable(player.x, player.z + dz)) player.z += dz;
    player.stride += Math.hypot(dx, dz);
    const strideLen = run ? 0.75 : 0.55;
    if (player.stride > strideLen) {
      player.stride -= strideLen; player.foot = -player.foot;
      const ox = Math.cos(player.yaw) * 0.14 * player.foot, oz = Math.sin(player.yaw) * 0.14 * player.foot;
      footstep(player.x + ox, player.z + oz, inWater, player.wet, run);
    }
  }
  if (inWater) player.wet = 1; else player.wet = Math.max(0, player.wet - dt / 9);
  const target = Math.max(H(player.x, player.z), waterAt(player.x, player.z) - 1.3);
  player.y += (target - player.y) * Math.min(1, dt * 12);
}

function throwStone() {
  const b = camBasis(player.yaw, player.pitch);
  const eye = [player.x, player.y + 1.65, player.z];
  stones.push({ p: [eye[0] + b.f[0] * 0.4, eye[1] + b.f[1] * 0.4 - 0.1, eye[2] + b.f[2] * 0.4], v: [b.f[0] * 15, b.f[1] * 15 + 3.5, b.f[2] * 15], t: 0 });
}
function stepStones(dt) {
  for (let i = stones.length - 1; i >= 0; i--) {
    const s = stones[i]; s.t += dt;
    s.v[1] -= 9.8 * dt; for (let k = 0; k < 3; k++) s.p[k] += s.v[k] * dt;
    const g = H(s.p[0], s.p[2]);
    const wa = waterAt(s.p[0], s.p[2]), water = g < wa && s.p[1] < wa;
    if (s.p[1] < g || water || s.t > 6) { if (s.t <= 6) splash(s.p[0], s.p[2], water); stones.splice(i, 1); }
  }
}

// ---------------------------------------------------------------- render
const SUN = norm([-0.86, 0.14, -0.33]), SUNCOL = [2.7, 1.9, 1.35], PLANET = norm([0.2, 0.43, -0.88]), MOONCOL = [0.3, 0.42, 0.82];
let night = 0, nightTarget = 0, sheet = 0, grassDrawn = 0;
function norm(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }
// the night sky turns about a tilted pole, once in about fifteen minutes
const POLE = norm([0.25, 0.8, 0.55]), skyTurn = new Float32Array(9);
function turnSky(t) {
  const a = t * 0.007, c = Math.cos(a), s = Math.sin(a), k = 1 - c, [x, y, z] = POLE;
  skyTurn.set([c + x * x * k, y * x * k + z * s, z * x * k - y * s, x * y * k - z * s, c + y * y * k, z * y * k + x * s, x * z * k + y * s, y * z * k - x * s, c + z * z * k]);
}

function common(p, eye, VP, mirror, t) {
  gl.useProgram(p);
  gl.uniformMatrix4fv(p.u('uVP'), false, VP);
  gl.uniform1f(p.u('uMirror'), mirror);
  gl.uniform3fv(p.u('uCam'), eye); gl.uniform3fv(p.u('uSunDir'), norm(SUN.map((v, i) => v * (1 - night) + PLANET[i] * night))); gl.uniform3fv(p.u('uSunCol'), SUNCOL.map((v, i) => v * (1 - night) + MOONCOL[i] * night)); gl.uniform3fv(p.u('uPlanetDir'), PLANET);
  gl.uniform3fv(p.u('uStarDir'), SUN); gl.uniform1f(p.u('uNight'), night); gl.uniform1f(p.u('uBio'), 1 + 1.7 * night); gl.uniform1f(p.u('uHDR'), HDR ? 1 : 0);
  gl.uniform1f(p.u('uTime'), t); gl.uniform1f(p.u('uExposure'), 0.95 + 0.3 * night); gl.uniform1f(p.u('uExtent'), EXTENT); gl.uniform1f(p.u('uSheet'), sheet); gl.uniform1f(p.u('uWind'), TEST ? 0.7 : (rain ? 1.15 : 0.7) + 0.2 * Math.sin(t * 0.13));
  gl.uniform1i(p.u('uGlow'), 0); gl.uniform1i(p.u('uGround'), 1); gl.uniform1i(p.u('uWear'), 7); gl.uniform1i(p.u('uRiver'), 9); gl.uniformMatrix3fv(p.u('uSky'), false, skyTurn);
  gl.uniform1f(p.u('uClip'), mirror < 0 ? WATER - 0.02 : -1e9);
}
function drawScene(eye, b, VP, mirror, t, opts) {
  gl.depthMask(false); gl.disable(gl.DEPTH_TEST); gl.bindVertexArray(null);
  common(SKY, eye, VP, mirror, t);
  gl.uniform3fv(SKY.u('uR'), b.r); gl.uniform3fv(SKY.u('uU'), b.u); gl.uniform3fv(SKY.u('uF'), b.f); gl.uniform2f(SKY.u('uTan'), opts.tanX, opts.tanY);
  gl.uniform1f(SKY.u('uPix'), opts.pix); gl.uniform1i(SKY.u('uMilky'), 8);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // the stars, added over the sky; the sky's alpha, the mask the rays march through, is left alone
  common(STARS, eye, VP, mirror, t); gl.uniform1f(STARS.u('uPx'), opts.px);
  gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
  gl.bindVertexArray(vStars); gl.drawArrays(gl.POINTS, 0, STAR_N); gl.disable(gl.BLEND);
  gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE); gl.frontFace(mirror < 0 ? gl.CW : gl.CCW);
  common(TERRAIN, eye, VP, mirror, t);
  gl.bindVertexArray(vNear); gl.drawElements(gl.TRIANGLES, near.idx.length, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(vFar); gl.drawElements(gl.TRIANGLES, far.idx.length, gl.UNSIGNED_INT, 0);
  common(ROCK, eye, VP, mirror, t);
  for (let k = 0; k < rockGeos.length; k++) { if (!sc.rv[k].length || (k === 3 && mirror < 0)) continue; gl.bindVertexArray(vRocks[k]); gl.drawElementsInstanced(gl.TRIANGLES, rockGeos[k].idx.length, gl.UNSIGNED_INT, 0, sc.rv[k].length / 4); }
  common(CRYSTAL, eye, VP, mirror, t); gl.bindVertexArray(vCrys); gl.drawArrays(gl.TRIANGLES, 0, crystals.count);
  gl.disable(gl.CULL_FACE);
  common(WOOD, eye, VP, mirror, t); gl.bindVertexArray(vWood); gl.drawElements(gl.TRIANGLES, forest.idx.length, gl.UNSIGNED_INT, 0);
  common(JLEAF, eye, VP, mirror, t); leaves.draw(VP, eye, mirror);
  common(PLANT, eye, VP, mirror, t); plants.draw(VP, eye, mirror);
  if (opts.grass) { common(GRASS, eye, VP, mirror, t); grassDrawn = grass.draw(VP, eye, mirror, grassDensity); }
}

function render(t, camOverride) {
  const dpr = Math.min(devicePixelRatio || 1, touch ? 1.5 : 2) * renderScale;
  const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const fov = 1.15, aspect = w / h, tanY = Math.tan(fov / 2), tanX = tanY * aspect;
  const cam = camOverride || { eye: [player.x, player.y + 1.65 + Math.sin(player.stride / 0.55 * Math.PI) * 0.025, player.z], yaw: player.yaw, pitch: player.pitch };
  const b = camBasis(cam.yaw, cam.pitch);
  const VP = viewProj(cam.eye, b, fov, aspect);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texGlow);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texGround);
  gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, texWear);
  sheet = groundF ? groundF.sheet : 0;
  turnSky(t);
  // reflection: the same scene mirrored in the lake plane, half resolution, no grass
  const rw = Math.max(1, w >> 1), rh = Math.max(1, h >> 1);
  ensureRefl(rw, rh);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, reflFbo); gl.viewport(0, 0, rw, rh);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawScene([cam.eye[0], 2 * WATER - cam.eye[1], cam.eye[2]], b, VP, -1, t, { tanX, tanY, grass: false, pix: 2 * tanY / rh, px: rh / 800 });
  ensurePost(w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, post.ms || post.resF); gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawScene(cam.eye, b, VP, 1, t, { tanX, tanY, grass: true, pix: 2 * tanY / h, px: h / 800 });
  gl.colorMask(true, true, true, false);
  // water
  common(WATERP, cam.eye, VP, 1, t);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, reflTex);
  gl.uniform1i(WATERP.u('uRefl'), 2); gl.uniform2f(WATERP.u('uRes'), w, h);
  const rip = new Float32Array(48); ripples.forEach((r, i) => rip.set(r, i * 4)); gl.uniform4fv(WATERP.u('uRip'), rip);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  gl.bindVertexArray(vWater); gl.drawElements(gl.TRIANGLES, wm.idx.length, gl.UNSIGNED_INT, 0);
  common(RIVERP, cam.eye, VP, 1, t); gl.bindVertexArray(vRiver); gl.drawElements(gl.TRIANGLES, rm.idx.length, gl.UNSIGNED_INT, 0);
  // particles: additive colour, and they cut themselves out of the sky mask so the rays never streak them
  gl.colorMask(true, true, true, true); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
  common(POINTS, cam.eye, VP, 1, t); gl.uniform1f(POINTS.u('uScale'), h * 0.9); gl.uniform2f(POINTS.u('uCamXZ'), cam.eye[0], cam.eye[2]);
  if (!camOverride || camOverride.motes) { gl.uniform1i(POINTS.u('uRain'), 2); gl.bindVertexArray(vMotes); gl.drawArrays(gl.POINTS, 0, MOTE_N); }
  world.pods.forEach((d, i) => { const [x, z, y] = podAt(d); podBuf.set([x, y + 0.04, z, d.seed], i * 4); });
  gl.bindBuffer(gl.ARRAY_BUFFER, podAttr.buffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, podBuf);
  gl.uniform1i(POINTS.u('uRain'), 3); gl.bindVertexArray(vPods); gl.drawArrays(gl.POINTS, 0, world.pods.length);
  if (!camOverride) {
    if (rain) { gl.uniform1i(POINTS.u('uRain'), 1); gl.bindVertexArray(vRain); gl.drawArrays(gl.POINTS, 0, RAIN_N); }
    if (stones.length) {
      stones.slice(0, 8).forEach((s, i) => stoneBuf.set([s.p[0], s.p[1], s.p[2], 0.9], i * 4));
      gl.bindBuffer(gl.ARRAY_BUFFER, stoneVbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, stoneBuf);
      gl.uniform1i(POINTS.u('uRain'), 0); gl.bindVertexArray(vStone); gl.drawArrays(gl.POINTS, 0, Math.min(8, stones.length));
    }
  }
  gl.depthMask(true); gl.disable(gl.BLEND); gl.bindVertexArray(null); gl.colorMask(true, true, true, true);
  if (post.ms) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, post.ms); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, post.resF);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
  postProcess(VP, cam.eye, b, w, h);
}

// ---------------------------------------------------------------- loop
const hud = Object.fromEntries(['hMode', 'hFps', 'hBar', 'hStep', 'hDense', 'hAwake', 'hMs', 'hMem', 'hUp', 'hPromise', 'hNote'].map((id) => [id.slice(1).toLowerCase(), document.getElementById(id)]));
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const time = (ms) => ms < 0.1 ? Math.round(ms * 1000) + ' µs' : ms.toFixed(2) + ' ms';
const bytes = (n) => n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
let last = 0, wall = 0, acc = { frames: 0, t: 0, ms: 0, up: 0 }, sporeR = rng(77), sporeAcc = 0;
const layers = () => [glowF, groundF, wearF];

function simulate(dt) {
  stepPlayer(dt); stepStones(dt); worldStep(dt);
  if (rain) { sporeAcc += dt * 30; while (sporeAcc >= 1) { spore(sporeR); sporeAcc -= 1; } if (groundF.sheet < 0.45) groundF.rain(dt * 0.025); }
  const t0 = performance.now();
  for (const f of layers()) f.advance(dt);
  acc.ms += performance.now() - t0;
  for (const f of layers()) acc.up += f.upload();
  acc.frames++;
}

// frame-time governor: ignore the first seconds (shader compiles), thin grass a little, then pixels, and climb back
// when there is headroom; a cool-down after each cut stops it see-sawing at the vsync edge
let perfT = [], renderScale = 1, warm = 0, coolUntil = 0;
function adaptDensity(rawDt) {
  if (TEST || !started) return;
  if ((warm += rawDt) < 4) return;
  perfT.push(rawDt);
  if (perfT.length < 60) return;
  const ts = perfT.sort((a, b) => a - b), med = ts[30], p90 = ts[54]; perfT = [];
  const slow = med > 1 / 50 || p90 > 1 / 33;
  if (slow) {
    if (grassDensity > 0.6) grassDensity *= 0.85;
    else if (renderScale > 0.72) renderScale = Math.max(0.72, renderScale * 0.9);
    else if (grassDensity > 0.3) grassDensity *= 0.85;
    coolUntil = warm + 6;
  } else if (med < 1 / 57 && warm > coolUntil) {
    if (renderScale < 1) renderScale = Math.min(1, renderScale * 1.06);
    else if (grassDensity < 1) grassDensity = Math.min(1, grassDensity * 1.08);
  }
}
function frame(now) {
  requestAnimationFrame(frame);
  adaptDensity(Math.max(0, (now - last) / 1000));
  const dt = Math.min(1 / 30, Math.max(0.001, (now - last) / 1000)); last = now;
  night += (nightTarget - night) * Math.min(1, dt * 0.7);
  simT += dt;
  if (started) simulate(dt);
  render(simT);
  acc.t += dt;
  if (!wall) wall = now;
  if (acc.t > 0.33 && acc.frames > 0) {
    const f = acc.frames, stepped = layers().reduce((n, l) => n + l.stepped, 0), st = layers().map((l) => l.stats());
    for (const l of layers()) l.stepped = 0;
    hud.fps.textContent = Math.round(f / Math.max(1e-3, (now - wall) / 1000)) + ' fps'; wall = now;
    hud.step.textContent = fmt(stepped / f);
    hud.dense.textContent = fmt(N * N * (60 + 15 + 15) / 60);
    hud.bar.style.width = Math.max(0.6, Math.min(100, stepped / f / (N * N * 1.5) * 100)) + '%';
    hud.awake.textContent = st.map((s) => fmt(s.blocks)).join(' · ');
    hud.ms.textContent = time(acc.ms / f);
    hud.mem.textContent = bytes(st.reduce((n, s) => n + s.bytes, 0)) + (mode === BOXEL ? ' of ' + bytes(3 * N * N * 8) : '');
    hud.up.textContent = bytes(acc.up / f);
    const bound = Math.max(...st.map((s) => s.bound)), broken = st.reduce((n, s) => n + s.violations, 0);
    hud.promise.textContent = mode === BOXEL ? `within ${(bound * 255).toFixed(2)}/255 · ${broken} broken` : 'is the reference';
    acc = { frames: 0, t: 0, ms: 0, up: 0 };
  }
}

function refreshModeUI() {
  hud.mode.firstElementChild.textContent = MODE_NAME[mode];
  hud.mode.className = 'mode' + (mode === DENSE ? ' dense' : '');
  document.getElementById('bMode').textContent = MODE_NAME[mode];
  hud.note.textContent = mode === BOXEL
    ? 'Every cell boxel skips is proven to sit within 1/255 of the full computation, rounding included, on a plane with no edge. Walk, throw, call spore rain: the cost follows what happens, not the size of the world.'
    : 'Dense steps every cell of the map, every step: the full computation boxel promises to match. It costs the whole map whether anything happens or not, and nothing past the map exists for it.';
}
function cycleMode() { setMode(mode === BOXEL ? DENSE : BOXEL); refreshModeUI(); }

// ---------------------------------------------------------------- input
function bindInput() {
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (!started) return;
    if (e.code === 'KeyF') throwStone();
    if (e.code === 'KeyR') toggleRain();
    if (e.code === 'KeyM') cycleMode();
    if (e.code === 'KeyH') toggleHud();
    if (e.code === 'KeyN') toggleNight();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  canvas.addEventListener('mousedown', (e) => {
    if (!started || touch) return;
    if (document.pointerLockElement !== canvas) { canvas.requestPointerLock?.()?.catch?.(() => {}); lookLast = [e.clientX, e.clientY]; }
    else throwStone();
  });
  addEventListener('mouseup', () => { lookLast = null; });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) look(e.movementX, e.movementY, 0.0022);
    else if (lookLast && e.buttons) { look(e.clientX - lookLast[0], e.clientY - lookLast[1], 0.004); lookLast = [e.clientX, e.clientY]; }
  });
  const stickEl = document.getElementById('stick'), knob = document.getElementById('knob');
  canvas.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      const sr = stickEl.getBoundingClientRect();
      if (stick.id === null && t.clientX < innerWidth * 0.45 && t.clientY > innerHeight * 0.35) { stick.id = t.identifier; stick.cx = sr.left + sr.width / 2; stick.cy = sr.top + sr.height / 2; moveStick(t); }
      else if (lookId === null) { lookId = t.identifier; lookLast = [t.clientX, t.clientY]; }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) moveStick(t);
      else if (t.identifier === lookId) { look(t.clientX - lookLast[0], t.clientY - lookLast[1], 0.006); lookLast = [t.clientX, t.clientY]; }
    }
    e.preventDefault();
  }, { passive: false });
  const end = (e) => { for (const t of e.changedTouches) { if (t.identifier === stick.id) { stick = { x: 0, y: 0, id: null }; knob.style.transform = ''; } if (t.identifier === lookId) lookId = null; } };
  canvas.addEventListener('touchend', end); canvas.addEventListener('touchcancel', end);
  function moveStick(t) {
    let dx = (t.clientX - stick.cx) / 50, dy = (t.clientY - stick.cy) / 50; const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    stick.x = dx; stick.y = dy; knob.style.transform = `translate(${dx * 38}px, ${dy * 38}px)`;
  }
  document.getElementById('bThrow').onclick = () => started && throwStone();
  document.getElementById('bRain').onclick = () => started && toggleRain();
  document.getElementById('bMode').onclick = () => started && cycleMode();
  document.getElementById('bHud').onclick = toggleHud;
  document.getElementById('bNight').onclick = () => started && toggleNight();
}
function look(dx, dy, s) { player.yaw += dx * s; player.pitch = Math.max(-1.35, Math.min(1.35, player.pitch - dy * s)); }
function toggleRain() { rain = !rain; document.getElementById('bRain').setAttribute('aria-pressed', String(rain)); }
function toggleNight() { nightTarget = nightTarget > 0.5 ? 0 : 1; document.getElementById('bNight').setAttribute('aria-pressed', String(nightTarget > 0.5)); }
function toggleHud() { hudOn = !hudOn; document.getElementById('hud').hidden = !hudOn; document.getElementById('bHud').setAttribute('aria-pressed', String(hudOn)); }

// ---------------------------------------------------------------- test hooks (?test): deterministic scripted session, fixed camera
const VIEWS = {
  shore: { eye: [SHORE_CAM[0], H(...SHORE_CAM) + 2.6, SHORE_CAM[1]], yaw: -0.95, pitch: -0.24, motes: true },
  planet: { eye: [START[0], H(...START) + 1.7, START[1]], yaw: 0.05, pitch: 0.12, motes: true },
  sunset: { eye: [12, H(12, 4) + 1.7, 4], yaw: -1.5, pitch: 0.08, motes: true },
  outcrop: { eye: [12, H(12, -14) + 1.7, -14], yaw: 0.9, pitch: 0.05, motes: true },
  beach: { eye: [12.5, H(12.5, 28) + 1.5, 28], yaw: -1.9, pitch: -0.32, motes: false },
  stack: { eye: [ISLET[0] + 9, 1.4, ISLET[1] + 6], yaw: -0.98, pitch: -0.08, motes: false },
  galaxy: { eye: [SHORE_CAM[0], H(...SHORE_CAM) + 1.7, SHORE_CAM[1]], yaw: -1.23, pitch: 0.42, motes: true },
  giants: { eye: [START[0], H(...START) + 1.7, START[1]], yaw: 3.35, pitch: 0.36, motes: false },
  rose: { eye: [START[0], H(...START) + 1.7, START[1]], yaw: 2.763, pitch: 0.49, motes: false },
  ocean: { eye: [START[0], H(...START) + 1.7, START[1]], yaw: -2.356, pitch: 0.5, motes: false },
  get coil() { return plantView(3); },
  get summit() { const ex = 4, ez = -13; return { eye: [ex, H(ex, ez) + 1.7, ez], yaw: Math.atan2(SUMMIT.x - ex, -(SUMMIT.z - ez)), pitch: 0.2, motes: false }; },
  get lookout() { return { eye: [LOOKOUT.x, H(LOOKOUT.x, LOOKOUT.z) + 2.1, LOOKOUT.z], yaw: Math.atan2(LAKE[0] - LOOKOUT.x, -(LAKE[1] - LOOKOUT.z)), pitch: -0.22, motes: false }; },
  get river() { const ex = -1.5, ez = -21; return { eye: [ex, H(ex, ez) + 1.7, ez], yaw: Math.atan2(-9 - ex, -(-56 - ez)), pitch: 0.02, motes: false }; },
  get trail() { const ex = -9, ez = -19; return { eye: [ex, H(ex, ez) + 1.7, ez], yaw: Math.atan2(SUMMIT.x + 6 - ex, -(SUMMIT.z + 12 - ez)), pitch: 0.32, motes: false }; },
  get crystals() { const [x, z] = sc.crystalSites[3], ex = x + 2.4, ez = z + 2.4; return { eye: [ex, H(ex, ez) + 1.4, ez], yaw: -0.785, pitch: -0.28, motes: false }; },
  get lantern() { return plantView(4); },
  get grove() { const x = sc.trees[7 * 5] + 2.2, z = sc.trees[7 * 5 + 2] + 2.2; return { eye: [x, H(x, z) + 1.1, z], yaw: -0.785, pitch: -0.3, motes: false }; },
};
/** A close look at the first plant of a species, from a metre and a half away. */
function plantView(type) {
  let i = 0; while (i < pl.F.length / 4 && pl.F[i * 4 + 3] !== type) i++;
  const x = pl.P[i * 4] + 1.0, z = pl.P[i * 4 + 2] + 1.0;
  return { eye: [x, Math.max(H(x, z), pl.P[i * 4 + 1]) + 1.2, z], yaw: -0.785, pitch: -0.62, motes: false };
}
function scripted(m, frames = 900, view = 'shore') {
  setMode(m); started = false; rain = false; stones.length = 0;
  const r = rng(4242); simT = 0;
  if (view === 'render') { for (let f = 0; f < 120; f++) { worldStep(1 / 60); for (const l of layers()) l.advance(1 / 60); } for (const l of layers()) l.upload(); render(12.0, VIEWS[frames]); return {}; }
  const t0 = performance.now();
  let stride = 0, foot = 1, px = 9, pz = 9;
  for (let f = 0; f < frames; f++) {
    const dt = 1 / 60; simT += dt;
    // a hiker along the south-east shore and into the shallows, then back out with wet feet
    const a = 0.9 + f / frames * 1.6, R = 20.4 + 4.8 * Math.sin(f / frames * Math.PI);
    const nx = LAKE[0] + Math.cos(a) * R * 1.2, nz = LAKE[1] + Math.sin(a) * R * 0.95;
    if (f < 760) stride += Math.hypot(nx - px, nz - pz); px = nx; pz = nz;
    const wetNow = H(px, pz) < WATER;
    if (f < 760 && stride > 0.55) { stride -= 0.55; foot = -foot; footstep(px + 0.14 * foot, pz, wetNow, wetNow ? 1 : 0.6, false); }
    if (f === 380 || f === 800) splash(LAKE[0] + (f === 380 ? 4 : -2), LAKE[1] + (f === 380 ? 2 : 10), true);
    if (f >= 760) { const q = (f - 760) / 140, wx = 17.2 - 7.6 * q, wz = 26.8 - 3.2 * q; stride += 0.03; if (stride > 0.55) { stride = 0; foot = -foot; footstep(wx + 0.14 * foot, wz, false, 1, false); } }
    if (f === 850) splash(10.4, 21.2, false);
    if (f > 300 && f < 600) { if (r() < 0.5) spore(r); groundF.rain(0.0004); }
    worldStep(dt);
    for (const l of layers()) l.advance(dt);
  }
  const ms = performance.now() - t0;
  const stepped = layers().reduce((n, l) => n + l.stepped, 0);
  for (const l of layers()) { l.upload(); l.stepped = 0; }
  ripples.length = 0;
  render(12.0, { ...(VIEWS[view] || VIEWS.shore), motes: view === 'planet' });
  const st = layers().map((l) => l.stats());
  return { mode: MODE_NAME[m], frames, ms, stepped, violations: st.reduce((n, s) => n + s.violations, 0), blocks: st.map((s) => s.blocks), bytes: st.reduce((n, s) => n + s.bytes, 0) };
}

// ---------------------------------------------------------------- boot
(async () => {
  engine = await loadEngine();
  const t0 = performance.now();
  glowF = new Layer(engine.boxel, SPECS.glow, texGlow);
  groundF = new Layer(engine.boxel, SPECS.moist, texGround);
  wearF = new Layer(engine.boxel, SPECS.wear, texWear);
  setMode(BOXEL);
  refreshModeUI();
  document.getElementById('status').textContent = `boxel ready: three certified fields on an unbounded plane, cones computed in ${Math.round(performance.now() - t0)} ms`;
  if (touch) { document.getElementById('go').textContent = 'Tap to step onto the shore'; document.getElementById('keys').innerHTML = '<b>left thumb</b><span>walk (push far to run)</span><b>right thumb</b><span>look</span><b>buttons</b><span>throw, spore rain, night, switch engine, readout</span>'; }
  window.__game = { setNight: (v) => { night = nightTarget = v; }, hdr: HDR, samples: SAMPLES, scripted, setMode, H, ready: true, engine: engine.kind, state: () => ({ player: { ...player }, started, blocks: layers().map((l) => l.stats().blocks), instances: { grass: grass.count, leaves: leaves.count, plants: plants.count, grassDrawn } }) };
  if (TEST) { document.documentElement.classList.remove('intro'); document.getElementById('intro').hidden = true; document.getElementById('pad').hidden = true; document.getElementById('cross').hidden = true; return; }
  bindInput();
  document.getElementById('intro').addEventListener('click', () => {
    document.getElementById('intro').hidden = true; document.documentElement.classList.remove('intro'); started = true;
    if (!touch) canvas.requestPointerLock?.()?.catch?.(() => {});
  });
  requestAnimationFrame((t) => { last = t; frame(t); });
})().catch((e) => fail('The field engine did not start: ' + e.message));
