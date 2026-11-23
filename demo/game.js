// Tarnished Promise: an acre of lake shore on Tarn, under a ringed giant.
//
// The world remembers you through three boxel fields on the unbounded plane of 12.5 cm cells:
//   glow      bioluminescence in the moss and the water   D 8 cells²/s, k 0.3/s, 60 steps/s
//   moisture  wet feet, splashes, spore rain               D 3 cells²/s, k 0.04/s, 15 steps/s
//   wear      trails packed into the soil                  no spread, k 0.008/s, 15 steps/s
// Each is certified to stay within 1/255 of computing every cell, and only the 16 × 16 blocks
// that can still matter exist. The renderer sees the acre through one R8 texture per field and
// re-uploads exactly the blocks the engine holds, clearing the ones it lets go.

import { load } from '../ffi/boxel.js';

const N = 512, CELL = 0.125, EXTENT = N * CELL;          // the acre the renderer sees: 64 m a side
const LAKE = [-3, 4];                                     // lake centre (x, z)
const WATER = 0;                                          // water level
const CERT = 0, DENSE = 1;
const MODE_NAME = { 0: 'Certified', 1: 'Dense' };
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

// the lake's outline: an ellipse pushed around by lobes, coves and noise, so no stretch of shore is a circle
function lakeD(x, z) {
  const dx = (x - LAKE[0]) / 1.2, dz = (z - LAKE[1]) / 0.95, th = Math.atan2(dz, dx);
  const wob = 1 + 0.17 * Math.sin(3 * th + 1.1) + 0.09 * Math.sin(5 * th - 0.4) + 0.05 * Math.sin(8 * th + 2.0)
    + 0.24 * (fbm(x * 0.07 + 31, z * 0.07 - 12, 3) - 0.5);
  return Math.hypot(dx, dz) / wob / 1.1;
}
const ISLET = [LAKE[0] + 3.4, LAKE[1] - 2.6];
function H(x, z) {
  const meadow = 0.7 + 1.1 * fbm(x * 0.045 + 3, z * 0.045 - 1) + 0.25 * fbm(x * 0.22, z * 0.22, 3);
  const d = lakeD(x, z);
  // a wadeable shelf all round the shore, then a drop into the basin
  const bowl = -0.6 * (1 - sm(8.5, 10.8, d)) - 3.4 * (1 - sm(1, 8.5, d)) - 0.35;
  const t = sm(9.6, 14, d);
  let h = bowl * (1 - t) + meadow * t;
  const ri = Math.hypot(x - ISLET[0], z - ISLET[1]);
  if (ri < 7) h += 2.0 * Math.exp(-ri * ri / 5) * (1 - t);
  const e = Math.hypot(x, z * 1.05);
  h += sm(19, 36, e) * (4 + 7 * fbm(x * 0.08 + 9, z * 0.08 + 2));
  const m = sm(40, 420, e);
  if (m > 0) h += m * m * (18 + 115 * ridged(x * 0.005 + 2, z * 0.005 - 4)) + sm(40, 90, e) * 6 * fbm(x * 0.03, z * 0.03);
  return h;
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
  glow: { spread: 8 / 60, fade: 0.3 / 60, hz: 60 },
  moist: { spread: 3 / 15, fade: 0.04 / 15, hz: 15 },
  wear: { spread: 0, fade: 0.008 / 15, hz: 15 },
};
const cellOf = (m) => Math.floor(m / CELL);

/** One field and the texture that shows it. Certified: a boxel field on the whole plane, uploaded block by
 *  block. Dense: the full computation over the acre alone, uploaded whole every step. */
class Layer {
  constructor(boxel, spec, tex) { Object.assign(this, { boxel, spec, tex, acc: 0, stepped: 0 }); }
  set(mode) {
    this.f?.free(); this.g?.free(); this.f = this.g = null; this.acc = 0;
    if (mode === CERT) this.f = this.boxel.field({ spread: this.spec.spread, fade: this.spec.fade, tolerance: TOLERANCE, events: 64 });
    else this.g = this.boxel.grid(this.spec, -N / 2, -N / 2, N);
    clearTexture(this.tex);
    this.changed = false;
  }
  deposit(x, z, r, a) { (this.f || this.g).deposit(cellOf(x), cellOf(z), r, a); this.changed = true; }
  rain(a) { (this.f || this.g).rain(a); }
  get sheet() { return this.f ? this.f.sheet : this.g.sheet; }
  /** Take the steps owed for `dt` seconds at this field's own rate, a few at most. */
  advance(dt) {
    this.acc = Math.min(this.acc + dt * this.spec.hz, 4);
    const n = Math.floor(this.acc);
    if (n === 0) return 0;
    this.acc -= n;
    this.stepped += n * (this.f ? this.f.awake * 256 : N * N);
    (this.f || this.g).step(n);
    this.changed = true;
    return n;
  }
  /** Send what changed to the texture. Returns bytes uploaded. */
  upload() {
    if (!this.changed) return 0;
    this.changed = false;
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this.g) {
      for (let y = 0; y < N; y++) quantise(this.g.row(y - N / 2), WHOLE, y * N);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RED, gl.UNSIGNED_BYTE, WHOLE);
      return N * N;
    }
    let bytes = 0;
    const inside = (bx, by) => bx >= -16 && bx < 16 && by >= -16 && by < 16;
    this.f.freed((bx, by) => {
      if (!inside(bx, by)) return;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, bx * 16 + N / 2, by * 16 + N / 2, 16, 16, gl.RED, gl.UNSIGNED_BYTE, ZERO);
      bytes += 256;
    });
    this.f.forgetFreed();
    this.f.blocks((bx, by, v) => {
      if (!inside(bx, by)) return;
      quantise(v, TILE, 0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, bx * 16 + N / 2, by * 16 + N / 2, 16, 16, gl.RED, gl.UNSIGNED_BYTE, TILE);
      bytes += 256;
    });
    return bytes;
  }
  stats() { return this.f ? this.f.stats() : { blocks: N * N / 256, bytes: N * N * 8, live: 0, violations: 0, bound: 0 }; }
}
const TILE = new Uint8Array(256), ZERO = new Uint8Array(256), WHOLE = new Uint8Array(N * N);
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
const COMMON = `
uniform vec3 uSunDir, uSunCol, uCam, uPlanetDir;
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
vec3 skyColor(vec3 d){
  vec3 c = skyBase(d);
  if (d.y > 0.) {
    vec3 q = d * 170.; vec3 id = floor(q); float hh = hash12(id.xz + id.y * 7.13);
    if (hh > 0.997 - 0.003 * uNight) { vec3 f = fract(q) - .5; c += vec3(0.8, 0.85, 1.) * (1. + 2.5 * uNight) * smoothstep(0.3, 0., length(f)) * smoothstep(0.08, 0.45, d.y) * (0.55 + 0.45 * sin(uTime * 1.7 + hh * 90.)); }
  }
  c += STAR_COL * (1. - uNight) * 3. * smoothstep(0.99935, 0.99965, dot(d, uStarDir));
  vec3 P = uPlanetDir; vec3 T = normalize(cross(P, vec3(0., 1., 0.))); vec3 B = cross(T, P);
  float dp = dot(d, P);
  if (dp > 0.7) {
    vec2 q = vec2(dot(d, T), dot(d, B)) / dp;
    float R = 0.17, tilt = 0.38;
    vec2 rq = vec2(q.x * cos(tilt) + q.y * sin(tilt), -q.x * sin(tilt) + q.y * cos(tilt));
    float rr = length(vec2(rq.x, rq.y / 0.2));
    float band = smoothstep(1.32 * R, 1.38 * R, rr) * (1. - smoothstep(2.2 * R, 2.28 * R, rr)) * (1. - 0.6 * smoothstep(1.7 * R, 1.75 * R, rr) * (1. - smoothstep(1.8 * R, 1.85 * R, rr)));
    float aa = clamp(1. - fwidth(rr) * 90., 0., 1.);
    vec3 ring = vec3(0.86, 0.70, 0.62) * band * mix(0.55, 0.55 + 0.45 * sin(rr * 95.) * sin(rr * 31.), aa) * 0.42;
    float pr = length(q);
    if (pr < R) {
      vec3 nw = normalize(q.x / R * T + q.y / R * B - sqrt(max(0., 1. - pr * pr / (R * R))) * P);
      vec3 axis = normalize(B * cos(tilt) - T * sin(tilt));
      float lat = dot(nw, axis);
      // a storm eye: the bands swirl round an oval vortex in the southern belt
      vec2 dv = (rq - vec2(0.05, -0.045)) * vec2(0.62, 1.); float rs = length(dv), sw = exp(-rs * rs / 0.0011);
      float ang = sw * 5.5; vec2 dvr = vec2(dv.x * cos(ang) - dv.y * sin(ang), dv.x * sin(ang) + dv.y * cos(ang));
      lat += (dvr.y - dv.y) * 2.2 * sw;
      float bands = sin(lat * 19. + sin(lat * 6. + q.x * 8.) * 1.6 + vnoise(q * 30. + dvr * 40. * sw) * 0.8);
      vec3 pc = mix(vec3(0.55, 0.26, 0.62), vec3(0.16, 0.58, 0.66), 0.5 + 0.5 * bands);
      pc = mix(pc, vec3(0.95, 0.72, 0.55), smoothstep(0.75, 0.95, abs(sin(lat * 7. + 1.3))) * 0.35);
      pc = mix(pc, vec3(0.92, 0.6, 0.62), smoothstep(0.03, 0.012, rs) * 0.55);
      pc = mix(pc, vec3(0.25, 0.12, 0.3), smoothstep(0.009, 0.0, rs) * 0.6);
      float lit = smoothstep(-0.15 - 0.55 * uNight, 0.35, dot(nw, uStarDir));
      c = pc * (lit * 1.1 + 0.02) + (rq.y > 0. ? vec3(0.) : ring);
      c += vec3(0.35, 0.55, 0.9) * pow(1. - abs(dot(nw, P)), 3.) * 0.35 * (lit + 0.1);
    } else {
      c += ring + vec3(0.25, 0.35, 0.6) * exp(-(pr - R) * 35.) * 0.18;
    }
  }
  vec3 M = normalize(vec3(-0.62, 0.42, -0.52)), M2 = normalize(vec3(-0.55, 0.47, -0.58));
  c = mix(c, vec3(0.72, 0.76, 0.84) * (0.55 + 0.45 * vnoise(d.xz * 500.)), smoothstep(0.99975, 0.99985, dot(d, M)));
  c = mix(c, vec3(0.66, 0.74, 0.88) * (0.6 + 0.4 * vnoise(d.xz * 700.)), smoothstep(0.99991, 0.99995, dot(d, M2)));
  // clouds: soft wisps drifting downwind, lit warm on the star's side, silver-blue under the giant at night
  if (d.y > 0.015) {
    vec2 cu = d.xz / (d.y + 0.07) * 0.8 + WIND_DIR * uTime * 0.006;
    float cl = fbm3(cu * 1.2) * 0.75 + fbm3(cu * 3.1 + 7.) * 0.25;
    float cov = smoothstep(0.56, 0.84, cl) * smoothstep(0.015, 0.2, d.y) * (1. - smoothstep(0.5, 0.9, d.y));
    float sunS = pow(max(dot(d, uStarDir), 0.), 4.);
    vec3 sb = skyBase(d);
    vec3 cc = mix(sb * 1.35 + STAR_COL * 0.05 * sunS + vec3(0.02, 0.012, 0.03), sb * 1.6 + vec3(0.05, 0.07, 0.14) * pow(max(dot(d, uPlanetDir), 0.), 2.), uNight);
    c = mix(c, cc, cov * 0.6);
  }
  return c;
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
  float mist = (1. - exp(-dist * 0.016)) * exp(-max(wp.y + 0.3, 0.) * 0.32) * (0.16 + 0.34 * uNight);
  vec3 vd = normalize(vec3(d.x, max(d.y, 0.02 * dist), d.z));
  vec3 fc = skyBase(vd) * 0.75;
  // the haze glows where it lies between you and the star
  fc += STAR_COL * pow(max(dot(normalize(d), uStarDir), 0.), 8.) * 0.07 * (1. - uNight);
  vec3 mc = mix(fc * 1.1 + vec3(0.03, 0.025, 0.05), vec3(0.025, 0.045, 0.11), uNight);
  return mix(mix(col, fc, clamp(f, 0., 1.)), mc, clamp(mist, 0., 0.85));
}
vec3 tonemap(vec3 c){ c *= uExposure; if (uHDR > 0.5) return min(c, vec3(48.)); c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14); return pow(clamp(c, 0., 1.), vec3(1. / 2.2)); }
`;

const WORLD_VS = `
uniform mat4 uVP; uniform float uMirror;
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
`uniform float uClip; in vec3 vWP; in vec3 vN; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec2 p = vWP.xz; vec2 uv = fieldUV(p); float inf = inField(uv);
  vec2 gr = vec2(texture(uGround, uv).r, texture(uWear, uv).r) * inf; float glow = texture(uGlow, uv).r * inf;
  float moist = min(1., gr.r + uSheet * inf), wear = gr.g;
  // the strip the lake keeps wet, breathing with the lapping
  float lap = 0.05 * sin(uTime * 0.9 + dot(vWP.xz, vec2(0.7, 0.4)) * 0.8) + 0.035 * sin(uTime * 1.7 + vWP.x * 1.3);
  float wetBand = (1. - smoothstep(0.02, 0.2 + lap, vWP.y)) * step(-0.05, vWP.y);
  moist = max(moist, wetBand * 0.85);
  float dist = length(vWP - uCam);
  vec3 N = normalize(vN);
  float dn = 1. - smoothstep(8., 45., dist);
  if (dn > 0.) {
    float e = 0.06, s = 2.6; float h0 = fbm3(p * s), hx = fbm3((p + vec2(e, 0.)) * s), hz = fbm3((p + vec2(0., e)) * s);
    N = normalize(N + dn * (1. - 0.7 * wear) * (1. - 0.6 * moist) * vec3(-(hx - h0), 0., -(hz - h0)) / e * 0.22);
  }
  float slope = 1. - N.y, y = vWP.y;
  float n1 = fbm3(p * 0.3), n2 = vnoise(p * 2.7), n3 = vnoise(p * 9.);
  vec3 moss = mix(vec3(0.045, 0.09, 0.12), vec3(0.15, 0.08, 0.22), smoothstep(0.3, 0.7, n1)) * (0.8 + 0.4 * n2);
  vec3 sand = vec3(0.30, 0.22, 0.26) * (0.85 + 0.3 * n2);
  vec3 bed = vec3(0.09, 0.11, 0.12) * (0.75 + 0.5 * n2);
  vec3 rock = mix(vec3(0.15, 0.13, 0.20), vec3(0.30, 0.26, 0.34), n2);
  vec3 alb = moss; float rough = 0.88, metal = 0.;
  float shore = 1. - smoothstep(0.12, 0.45 + 0.25 * n1, y);
  alb = mix(alb, sand, shore); rough = mix(rough, 0.72, shore);
  float under = 1. - smoothstep(-0.35, -0.05, y);
  alb = mix(alb, bed, under);
  float rk = max(smoothstep(0.3, 0.48, slope + 0.15 * n2), smoothstep(6., 12., y) * 0.8);
  alb = mix(alb, rock, rk); rough = mix(rough, 0.62, rk);
  float vein = rk * smoothstep(0.74, 0.8, n3) * (1. - smoothstep(12., 28., dist));
  metal = vein * 0.85; rough = mix(rough, 0.18, vein); alb = mix(alb, vec3(0.75, 0.62, 0.95), vein);
  float snow = smoothstep(45., 70., y + n1 * 18.) * (1. - smoothstep(0.5, 0.8, slope));
  alb = mix(alb, vec3(0.80, 0.76, 0.93), snow); rough = mix(rough, 0.5, snow);
  // cobbles on the beach and under the shallows, pebbles between them; wet ones go dark and glossy
  float cobZ = (1. - smoothstep(0.25, 0.7, y)) * smoothstep(-1.4, -0.9, y) * (1. - smoothstep(14., 32., dist)) * (1. - rk);
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
  col += glowCol(p) * (0.006 + 0.05 * uNight) * (1. - shore) * (1. - rk) * (1. - under) * smoothstep(0.55, 0.9, n3);
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
`uniform float uClip; uniform int uKind; in vec3 vWP; in vec3 vN; in float vH; in vec3 vLoc; in vec3 vNl; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 N = normalize(vN); vec3 V = normalize(uCam - vWP);
  vec2 uv = fieldUV(vWP.xz); float inf = inField(uv); float glow = texture(uGlow, uv).r * inf;
  float dist = length(uCam - vWP);
  vec3 col;
  if (uKind == 0) {
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
    float wet = clamp(max((1. - smoothstep(0.0, 0.3, vWP.y)) * step(-0.6, vWP.y), (texture(uGround, uv).r + uSheet) * inf), 0., 1.);
    alb *= (1. - 0.45 * wet) * mix(0.5, 1., smoothstep(-0.3, 0.4, vLoc.y / max(0.3, 1.)));
    col = pbr(alb, mix(0.8 - 0.15 * lich, 0.14, wet * 0.9), 0., N, V);
    col += glowCol(vWP.xz + vH * 13.) * (uBio * glowI(glow) * 2.3 * moss + (0.008 + 0.05 * uNight) * moss);
    col += lichC * lich * (0.002 + 0.18 * uNight) * (0.6 + 0.4 * sin(uTime * 0.8 + vH * 30.));
  } else {
    vec3 tint = mix(vec3(0.45, 0.95, 0.92), vec3(0.75, 0.48, 1.0), vH);
    float fres = pow(1. - max(dot(N, V), 0.), 3.);
    col = pbr(tint * 0.06, 0.07, 0.0, N, V) + tint * (0.012 + 0.22 * fres) * (1. + 2. * uNight) + tint * glow * 2.0 * uBio;
    col += tint * 0.05 * (0.6 + 0.4 * sin(uTime * 0.9 + vH * 20. + vWP.y * 3.));
  }
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
  float grain = sin(vW.z * 2. + vW.y * 7. + vW.w * 20.);                          // twisted grain spiralling up the wood
  float fine = vnoise(vec2(vW.z * 3. + vW.y * 9., vW.y * 30.));
  float dead = smoothstep(0.58, 0.85, vnoise(vec2(vW.z * 1.3 + vW.y * 2.5, vW.y * 1.1) + vW.w * 9.));   // silver deadwood
  vec3 bark = mix(vec3(0.07, 0.045, 0.06), vec3(0.15, 0.10, 0.12), smoothstep(-0.3, 0.7, grain)) * (0.8 + 0.4 * fine);
  bark = mix(bark, vec3(0.42, 0.40, 0.46) * (0.8 + 0.3 * fine), dead);
  N = normalize(N + vec3(0., 0.15 * grain, 0.) * (1. - dead));
  vec3 col = pbr(bark, mix(0.75, 0.5, dead), 0., N, V);
  vec3 tint = mix(vec3(0.2, 0.95, 0.8), vec3(0.75, 0.45, 1.0), step(0.55, vHue));
  float groove = smoothstep(0.86, 1., -grain) * (1. - dead);
  col += tint * groove * (0.015 + 0.3 * uNight + 0.6 * (1. - exp(-vStir * 6.)) * uBio) * (0.6 + 0.4 * sin(uTime * 0.7 + vW.y * 4. - vW.w * 9.));
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
  float L = aD.w, lift = aM.x, droop = aM.y, W = aM.z, seed = aM.w;
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
  vec3 tint = vHue < 0.38 ? vec3(0.22, 0.95, 0.78) : vHue < 0.7 ? vec3(0.45, 0.75, 1.0) : vec3(0.78, 0.45, 1.0);
  float g = pow(vU, 1.15);
  vec3 root = vec3(0.012, 0.03, 0.04), mid = tint * vec3(0.2, 0.27, 0.3);
  vec3 gc = g < 0.5 ? mix(root, mid, g * 2.) : mix(mid, tint * 0.9, (g - 0.5) * 2.);
  gc *= 0.75 + 0.5 * vSeed;
  vec3 N = normalize(vN), V = normalize(uCam - vWP); if (dot(N, V) < 0.) N = -N;
  float ndl = max(dot(N, uSunDir), 0.) * 0.7 + 0.3;
  vec3 lit = gc * (ambient(N) * 2.3 + uSunCol * ndl * 0.3);
  float stir = 1. - exp(-vStir * 6.), pulse = 0.6 + 0.4 * sin(uTime * 0.9 - vU * 5. + vSeed * 40.);
  lit += uSunCol * gc * pow(clamp(dot(-V, uSunDir), 0., 1.), 3.) * vU * 0.5;
  lit += gc * (0.04 + 0.28 * vU * vU * pulse) * (1. + 1.6 * uNight) + tint * tint * stir * uBio * (0.25 + 1.1 * vU * vU);
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
  float W0 = (0.05 + 0.03 * aR.z) * mix(1.9, 1.0, clamp(H / 0.2, 0., 1.)) * mix(1., 0.4, reed);
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
  // two alien ramps, teal-tipped and violet-tipped, laid out in meadow patches
  float patchN = smoothstep(0.38, 0.62, vnoise(vWP.xz * 0.085 + 3.) * 0.75 + vPatch * 0.25);
  vec3 root = mix(vec3(0.015, 0.05, 0.065), vec3(0.04, 0.02, 0.08), patchN);
  vec3 mid = mix(vec3(0.07, 0.30, 0.36), vec3(0.27, 0.11, 0.44), patchN);
  vec3 tip = mix(vec3(0.28, 0.88, 0.80), vec3(0.70, 0.40, 0.95), patchN);
  vec3 gc = g < 0.5 ? mix(root, mid, g * 2.) : mix(mid, tip, (g - 0.5) * 2.);
  float pn = vnoise(vWP.xz * 0.28) * 0.6 + vnoise(vWP.xz * 1.1) * 0.4;
  gc *= mix(0.8, 1.2, pn);
  gc = mix(gc, tip, smoothstep(0.55, 0.95, pn) * 0.2 * y);
  gc *= (0.88 + 0.24 * vGA.y) * mix(0.42, 1., smoothstep(0., 0.55, y)) * (1. - 0.35 * vWet);
  vec3 N = normalize(vN); vec3 V = normalize(uCam - vWP);
  if (dot(N, V) < 0.) N = -N;
  float ndl = max(dot(N, uSunDir), 0.) * 0.75 + 0.25;
  vec3 lit = gc * (ambient(N) * 2.4 + uSunCol * ndl * 0.3);
  float back = pow(clamp(dot(-V, uSunDir), 0., 1.), 3.);
  lit += gc * (0.16 + 0.3 * uNight) * (0.05 + 0.95 * y * y) + uSunCol * gc * back * y * 0.26;
  lit += glowCol(vWP.xz) * uBio * glowI(vGlow) * 2.6 * y * y;
  o = vec4(tonemap(fogged(lit, vWP)), 0.);
}`);

// understory: one blade, three plants. Rosettes (broad crimson leaves with a living midrib), ferns (fronds cut
// into leaflets in the fragment shader) and glow tubes (capsules whose tips are lamps). Veins brighten at night
// and when you stir the ground beside them.
const PLANT = program(WORLD_VS + `
in vec4 aP; in vec4 aF; in vec4 aS2;
out vec3 vWP; out float vU; out float vSide; out vec3 vN; out float vType; out float vStir; out float vSeed; out float vHue;
void main(){
  int vid = gl_VertexID;
  float u = vid >= 24 ? 1. : float(vid / 2) / 12.;
  float side = vid >= 24 ? 0. : ((vid % 2 == 0) ? -1. : 1.);
  float sc = aP.w, phi = aF.x, L = aF.y * sc, W = aF.z * sc, type = aF.w;
  float spread = aS2.x, rise = aS2.y, lift = aS2.z, droop = aS2.w;
  float seed = fract(phi * 7.31 + aP.x * 0.13);
  vec3 dir = vec3(cos(phi), 0., sin(phi)), sd = vec3(-sin(phi), 0., cos(phi));
  float hh = L * spread * sin(u * 1.5708);
  vec3 p = dir * hh + vec3(0., L * (rise * u + lift * sin(u * 3.1416) - droop * u * u), 0.);
  float flex = type > 1.5 ? 0.3 : 1.;
  p.xz += WIND_DIR * windWave(aP.xz + dir.xz * hh) * uWind * 0.18 * u * u * L * flex;
  p += sd * sin(uTime * 2.3 + seed * 30. + u * 3.) * 0.02 * u * L * flex;
  float w;
  if (type < 0.5) w = W * sin(min(1., u * 2.4) * 1.5708) * (1. - 0.6 * u * u);
  else if (type < 1.5) w = W * (1. - 0.72 * u) * sin(min(1., u * 4.) * 1.5708);
  else w = W * (u < 0.85 ? 1. : sqrt(max(0., 1. - pow((u - 0.85) / 0.15, 2.))));
  float tw = (seed - 0.5) * 1.6 * u * step(type, 1.5);
  vec3 wdir = normalize(sd * cos(tw) + vec3(0., 1., 0.) * sin(tw));
  p += wdir * side * w * 0.5;
  vec3 tang = normalize(dir * spread * cos(u * 1.5708) * 1.5708 + vec3(0., rise + lift * 3.1416 * cos(u * 3.1416) - 2. * droop * u, 0.));
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
  vec3 N = normalize(vN), V = normalize(uCam - vWP); if (dot(N, V) < 0.) N = -N;
  vec3 base, mid, tip, vein;
  if (vType < 0.5) { base = vec3(0.035, 0.006, 0.018); mid = mix(vec3(0.40, 0.03, 0.11), vec3(0.30, 0.04, 0.28), vHue); tip = mix(vec3(0.82, 0.16, 0.32), vec3(0.72, 0.26, 0.88), vHue); vein = vec3(0.25, 0.95, 1.0); }
  else if (vType < 1.5) { base = vec3(0.008, 0.026, 0.03); mid = vec3(0.045, 0.22, 0.25); tip = vec3(0.17, 0.58, 0.52); vein = vec3(0.35, 1.0, 0.8); }
  else { base = vec3(0.08, 0.2, 0.22); mid = vec3(0.3, 0.66, 0.7); tip = vec3(0.62, 0.95, 0.94); vein = vec3(0.45, 1.0, 0.95); }
  float g = pow(u, 1.1);
  vec3 gc = g < 0.5 ? mix(base, mid, g * 2.) : mix(mid, tip, (g - 0.5) * 2.);
  float ndl = max(dot(N, uSunDir), 0.) * 0.7 + 0.3;
  vec3 lit = gc * (ambient(N) * 2.3 + uSunCol * ndl * 0.3);
  lit += uSunCol * gc * pow(clamp(dot(-V, uSunDir), 0., 1.), 3.) * u * 0.45;
  float stir = 1. - exp(-vStir * 6.);
  float midrib = (1. - smoothstep(0.05, 0.15, abs(s))) * step(vType, 1.5);
  float edge = smoothstep(0.8, 0.98, abs(s)) * step(vType, 0.5);
  float pulse = 0.65 + 0.35 * sin(uTime * 1.3 - u * 6. + vSeed * 30.);
  float em = (midrib * 0.9 + edge * 0.45) * (0.03 + 0.45 * uNight) * pulse;
  if (vType > 1.5) em += smoothstep(0.7, 1., u) * (0.12 + 1.1 * uNight) * pulse + 0.03;
  lit += vein * (em + stir * uBio * (0.5 + midrib));
  o = vec4(tonemap(fogged(lit, vWP)), 0.);
}`);

const WATERP = program(WORLD_VS + `
in vec2 aXZ; in float aDepth; out vec3 vWP; out float vDepth;
void main(){ vWP = vec3(aXZ.x, ${WATER.toFixed(1)}, aXZ.y); vDepth = aDepth; gl_Position = project(vWP); }`,
`uniform sampler2D uRefl; uniform vec2 uRes; uniform vec4 uRip[12];
in vec3 vWP; in float vDepth; out vec4 o;
vec2 waveGrad(vec2 p){
  vec2 g = vec2(0.);
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
  float d = max(vDepth, 0.);
  vec3 body = mix(vec3(0.03, 0.15, 0.17), vec3(0.008, 0.025, 0.07), smoothstep(0., 3., d));
  vec3 Hh = normalize(uSunDir + V); float spec = pow(max(dot(N, Hh), 0.), 900.) * 25.;
  vec3 hdr = body * (ambient(N) * 3. + uSunCol * 0.12) + uSunCol * spec * F * 4. * (1. - 0.75 * uNight);
  vec3 gc = pow(glowCol(p * 1.3 + 7.), vec3(1.7));
  hdr += gc * uBio * glowI(glow) * 1.9;
  hdr += vec3(0.5, 0.45, 0.6) * smoothstep(0.12, 0.0, d) * 0.12;
  vec3 col = tonemap(fogged(hdr, vWP));
  col = mix(col, refl, clamp(F * 0.9 + 0.08, 0., 1.)) + tonemap(gc * uBio * glowI(glow)) * 0.25;
  // foam lines rolling into the shore, and the contact line where water meets sand
  float shoreF = 1. - smoothstep(0.0, 0.4, d);
  float bands = sin(d * 26. - uTime * 2.2 + vnoise(p * 1.4) * 4.);
  float foam = shoreF * smoothstep(0.6, 0.97, bands) * (0.45 + 0.55 * vnoise(p * 3. + uTime * 0.25)) + smoothstep(0.07, 0.0, d) * 0.7;
  col = mix(col, vec3(0.80, 0.82, 0.94), clamp(foam, 0., 1.) * 0.5);
  float alpha = clamp(max(F, smoothstep(0., 1.3, d) * 0.9 + 0.04) + glow * 0.5 + foam * 0.4, 0., 1.);
  alpha *= smoothstep(-0.02, 0.03, d);
  o = vec4(col, alpha);
}`);

const POINTS = program(WORLD_VS + `
in vec4 aP; uniform float uScale, uNight; uniform int uRain; out float vA; out vec3 vC;
void main(){
  vec3 p = aP.xyz; float s = aP.w;
  if (uRain == 1) { float t = fract(uTime * (0.08 + 0.05 * s) + aP.y); p = vec3(aP.x, 22. - t * 24., aP.z); p.x += sin(uTime + s * 50.) * 0.6; p.z += cos(uTime * 0.7 + s * 31.) * 0.4; vA = smoothstep(0., 0.1, t) * (1. - smoothstep(0.85, 1., t)); s = 0.5; }
  else if (uRain == 2) {
    p += vec3(sin(uTime * 0.31 + s * 20.), sin(uTime * 0.47 + s * 13.) * 0.45, cos(uTime * 0.27 + s * 7.)) * 1.3 + vec3(WIND_DIR.x, 0., WIND_DIR.y) * sin(uTime * 0.11 + s * 3.) * 2.;
    vA = (0.12 + 0.88 * uNight) * (0.45 + 0.55 * sin(uTime * (1.1 + s * 2.) + s * 50.)); s = 0.18 + 0.2 * fract(s * 31.);
  }
  else vA = 1.;
  vC = mix(vec3(0.3, 1.0, 0.9), vec3(0.7, 0.45, 1.), fract(s * 7.));
  vec4 c = project(p); gl_Position = c; gl_PointSize = clamp(uScale * (0.06 + s * 0.12) / c.w, 1., uRain == 2 ? 9. : 48.);
  if (uRain == 2) vA *= smoothstep(1.2, 3.5, c.w);
}`,
`in float vA; in vec3 vC; out vec4 o; void main(){ vec2 q = gl_PointCoord - .5; float a = smoothstep(0.5, 0., length(q)) * vA; o = vec4(tonemap(vC * 3.) * a, a); }`);

// ---------------------------------------------------------------- geometry
function terrainNear() {
  const S = 256, half = 40, step = 2 * half / S, pos = [], nor = [], idx = [];
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
    const x = -half + i * step, z = -half + j * step;
    pos.push(x, H(x, z), z); nor.push(...normalAt(x, z));
  }
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) };
}
function terrainFar() {
  const R = 110, A = 200, pos = [], nor = [], idx = [];
  for (let j = 0; j <= R; j++) {
    const r = 36 * Math.pow(1200 / 36, j / R);
    for (let i = 0; i <= A; i++) {
      const a = i / A * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
      const inside = Math.abs(x) < 39.5 && Math.abs(z) < 39.5;
      pos.push(x, H(x, z) - (inside ? 4 : 0), z); nor.push(...normalAt(x, z, Math.max(0.15, r * 0.02)));
    }
  }
  for (let j = 0; j < R; j++) for (let i = 0; i < A; i++) { const a = j * (A + 1) + i, b = a + 1, c = a + A + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) };
}
function waterMesh() {
  const S = 136, x0 = LAKE[0] - 23, z0 = LAKE[1] - 20, w = 46, d = 40, xz = [], dep = [], idx = [];
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) { const x = x0 + i / S * w, z = z0 + j / S * d; xz.push(x, z); dep.push(WATER - H(x, z)); }
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, e = c + 1;
    if (Math.max(dep[a], dep[b], dep[c], dep[e]) > -0.4) idx.push(a, c, b, b, c, e);
  }
  return { xz: new Float32Array(xz), dep: new Float32Array(dep), idx: new Uint32Array(idx) };
}
function icosphere(sub, warp) {
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((c) => c / l); });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const cache = {}, nf = [];
    const mid = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (k in cache) return cache[k]; const p = v[a].map((c, i) => (c + v[b][i]) / 2); const l = Math.hypot(...p); v.push(p.map((c) => c / l)); return (cache[k] = v.length - 1); };
    for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  const pos = [], nor = [], idx = [];
  if (warp) v = v.map(([x, y, z]) => { const k = 1 + 0.32 * (fbm(x * 1.6 + 5, z * 1.6 + y * 2.1) - 0.5) + 0.1 * (vnoise(x * 5 + y * 3, z * 5) - 0.5); return [x * k, Math.max(y * k, -0.35), z * k]; });
  // flat-ish shading for rocks: per-face normals
  for (const [a, b, c] of f) {
    const A = v[a], B = v[b], C = v[c];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; const l = Math.hypot(...n); n = n.map((x) => x / l);
    for (const P of [A, B, C]) { pos.push(...P); nor.push(...(warp ? n : P)); idx.push(idx.length); }
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) };
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
function crystalMesh() {
  const pos = [], nor = [], idx = [];
  const ring = (r, y) => Array.from({ length: 6 }, (_, i) => { const a = i / 6 * Math.PI * 2; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
  const lo = ring(0.16, -0.1), hi = ring(0.14, 0.78), tip = [0, 1.05, 0];
  const tri = (A, B, C) => { const u = B.map((c, i) => c - A[i]), w = C.map((c, i) => c - A[i]); let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; const l = Math.hypot(...n); n = n.map((x) => x / l); for (const P of [A, B, C]) { pos.push(...P); nor.push(...n); idx.push(idx.length); } };
  for (let i = 0; i < 6; i++) { const j = (i + 1) % 6; tri(lo[i], hi[i], lo[j]); tri(lo[j], hi[i], hi[j]); tri(hi[i], tip, hi[j]); }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) };
}

// ---------------------------------------------------------------- scatter
const STACK_GEO = rockMesh(9.31, 4, true, true), STACK_S = [2.4, 3.3, 2.0], STACK_SINK = 1.3;
// terrain height and slope from the near mesh (fast, for hundreds of thousands of blades)
function nearH(x, z) {
  const S = 256, st = 80 / S, fx = Math.min(S - 1e-3, Math.max(0, (x + 40) / st)), fz = Math.min(S - 1e-3, Math.max(0, (z + 40) / st));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j, P = near.pos, h = (a, b) => P[(b * (S + 1) + a) * 3 + 1];
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - w) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * w;
}
function nearNy(x, z) {
  const S = 256, st = 80 / S, i = Math.min(S, Math.max(0, Math.round((x + 40) / st))), j = Math.min(S, Math.max(0, Math.round((z + 40) / st)));
  return near.nor[(j * (S + 1) + i) * 3 + 1];
}
const GRASS_MAX = TEST ? 220000 : touch ? 210000 : 360000;
const clearOf = (x, z) => Math.hypot(x - 4, z - 15) > 3.5 && Math.hypot(x - 9.5, z - 13) > 3.5;

function scatter() {
  const r = rng(1234);
  // grass: Corey's stratified jitter over the acre, kept where blades can grow, then shuffled so any prefix is an even thinning
  const n = Math.ceil(Math.sqrt(GRASS_MAX / 0.6)), cellG = 64 / n;
  let G = new Float32Array(n * n * 4), R = new Float32Array(n * n * 4), cnt = 0;
  for (let gz = 0; gz < n && cnt < GRASS_MAX; gz++) for (let gx = 0; gx < n && cnt < GRASS_MAX; gx++) {
    const x = (gx + r()) * cellG - 32, z = (gz + r()) * cellG - 32, y = nearH(x, z), ld = lakeD(x, z);
    let hm;
    if (ld > 10.0 && ld < 12.6 && y > -0.38 && y < 0.55) { if (r() > 0.2) continue; hm = 1.9 + r() * 1.1; }   // reeds: the shoreline and the shallows
    else { if (y < 0.3 || y > 9 || nearNy(x, z) < 0.8) continue; hm = 0.7 + 0.75 * fbm(x * 0.06 + 11, z * 0.06 - 4, 3) + 0.2 * r(); }
    G.set([x, z, y - 0.015, r()], cnt * 4); R.set([r(), r(), r(), hm], cnt * 4); cnt++;
  }
  for (let k = cnt - 1; k > 0; k--) {
    const m = Math.floor(r() * (k + 1));
    for (let c = 0; c < 4; c++) { let t = G[k * 4 + c]; G[k * 4 + c] = G[m * 4 + c]; G[m * 4 + c] = t; t = R[k * 4 + c]; R[k * 4 + c] = R[m * 4 + c]; R[m * 4 + c] = t; }
  }
  G = G.slice(0, cnt * 4); R = R.slice(0, cnt * 4);

  // rocks: clusters with one big stone each, monoliths on the ridge, a standing stone on the islet, stones in the shallows, pebbles on the shore
  const rv = [[], [], [], [], []], rs = [[], [], [], [], []];
  const add = (v, x, z, sx, sy, sz, sink) => { const y = H(x, z); rv[v].push(x, y - sink, z, r() * 6.28); rs[v].push(sx, sy, sz, r()); };
  for (let c = 0; c < 26; c++) {
    let cx, cz, k = 0;
    do { cx = (r() * 2 - 1) * 33; cz = (r() * 2 - 1) * 33; k++; } while ((H(cx, cz) < -0.7 || !clearOf(cx, cz)) && k < 40);
    const big = 0.8 + Math.pow(r(), 1.6) * 2.2, m = 3 + Math.floor(r() * 6);
    for (let q = 0; q < m; q++) {
      const s0 = q === 0 ? big : big * (0.18 + 0.42 * r()), a = r() * 6.28, d = q === 0 ? 0 : big * (0.7 + r() * 0.9);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (!clearOf(x, z)) continue;
      add(q % 2, x, z, s0 * (0.8 + 0.5 * r()), s0 * (0.7 + 0.5 * r()), s0 * (0.8 + 0.5 * r()), 0.12 * s0);
    }
  }
  for (let m = 0; m < 8; m++) {
    let x, z, e, k = 0;
    do { const a = r() * 6.28; e = 22 + r() * 8; x = Math.cos(a) * e; z = Math.sin(a) * e / 1.05; k++; } while (H(x, z) > 9 && k < 20);
    const w = 0.55 + r() * 0.35;
    add(2, x, z, w, 2.2 + r() * 2.4, w * (0.8 + 0.3 * r()), 0.3);
  }
  { const y = H(ISLET[0], ISLET[1]); rv[4].push(ISLET[0], y + STACK_SINK * 0 - 0.15, ISLET[1], 0); rs[4].push(STACK_S[0], STACK_S[1], STACK_S[2], 0.42); }
  for (let q = 0; q < 12; q++) {
    let x, z, k = 0;
    do { x = LAKE[0] + (r() * 2 - 1) * 15; z = LAKE[1] + (r() * 2 - 1) * 12; k++; } while ((lakeD(x, z) < 8.6 || lakeD(x, z) > 10.6) && k < 60);
    const s0 = 0.4 + r() * 0.8; add(q % 2, x, z, s0, s0 * 0.8, s0 * 1.1, 0.1);
  }
  for (let q = 0; q < (touch ? 500 : 900); q++) {
    let x, z, k = 0;
    if (q < 600) do { x = LAKE[0] + (r() * 2 - 1) * 17; z = LAKE[1] + (r() * 2 - 1) * 14; k++; } while ((lakeD(x, z) < 9.6 || lakeD(x, z) > 12.4) && k < 60);
    else { x = (r() * 2 - 1) * 31; z = (r() * 2 - 1) * 31; }
    const s0 = 0.04 + Math.pow(r(), 2) * 0.18; add(3, x, z, s0, s0 * 0.7, s0 * (0.8 + 0.4 * r()), 0.01);
  }

  const crys = [], csc = [];
  for (let c = 0; c < 9; c++) {
    let cx, cz, k = 0;
    do { cx = LAKE[0] + (r() * 2 - 1) * 18; cz = LAKE[1] + (r() * 2 - 1) * 15; k++; } while ((lakeD(cx, cz) < 11.2 || lakeD(cx, cz) > 13.8 || !clearOf(cx, cz)) && k < 80);
    const hue = r();
    for (let i = 0; i < 6; i++) {
      const x = cx + (r() - 0.5) * 1.6, z = cz + (r() - 0.5) * 1.6, y = H(x, z);
      crys.push(x, y - 0.05, z, r() * 6.28); csc.push(0.6 + r() * 0.6, 0.5 + r() * 1.6, 0.6 + r() * 0.6, hue + (r() - 0.5) * 0.15);
    }
  }

  const trees = [];
  let tries2 = 0;
  while (trees.length / 4 < 46 && tries2++ < 6000) {
    const x = (r() * 2 - 1) * 30, z = (r() * 2 - 1) * 30, y = H(x, z);
    if (y < 0.3 || y > 7 || normalAt(x, z)[1] < 0.86 || lakeD(x, z) < 12.3 || Math.hypot(x - 4, z - 15) < 4 || Math.hypot(x - 9.5, z - 13) < 4.5) continue;
    let ok = true;
    for (let q = 0; q < trees.length; q += 4) if (Math.hypot(trees[q] - x, trees[q + 2] - z) < 3.6) { ok = false; break; }
    if (!ok) continue;
    trees.push(x, y - 0.05, z, r());
  }
  return { G, R, grassN: cnt, rv: rv.map((a) => new Float32Array(a)), rs: rs.map((a) => new Float32Array(a)), crys: new Float32Array(crys), csc: new Float32Array(csc), trees: new Float32Array(trees) };
}

// ---------------------------------------------------------------- junipers
const LEAF_MULT = touch ? 0.7 : 1;
function tube(W, pts, rad, sides, f0, f1, base, seed) {
  const n = pts.length, v0 = W.pos.length / 3;
  let T = null, Nn = null, along = 0;
  for (let k = 0; k < n; k++) {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
    T = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    if (!Nn) { const ref = Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; Nn = norm([ref[1] * T[2] - ref[2] * T[1], ref[2] * T[0] - ref[0] * T[2], ref[0] * T[1] - ref[1] * T[0]]); }
    else { const d = Nn[0] * T[0] + Nn[1] * T[1] + Nn[2] * T[2]; Nn = norm([Nn[0] - T[0] * d, Nn[1] - T[1] * d, Nn[2] - T[2] * d]); }
    const B = [T[1] * Nn[2] - T[2] * Nn[1], T[2] * Nn[0] - T[0] * Nn[2], T[0] * Nn[1] - T[1] * Nn[0]];
    if (k > 0) along += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1], pts[k][2] - pts[k - 1][2]);
    const fl = f0 + (f1 - f0) * k / (n - 1);
    for (let q = 0; q <= sides; q++) {
      const ang = q / sides * 6.2832, c = Math.cos(ang), sn = Math.sin(ang), o = [Nn[0] * c + B[0] * sn, Nn[1] * c + B[1] * sn, Nn[2] * c + B[2] * sn];
      W.pos.push(pts[k][0] + o[0] * rad[k], pts[k][1] + o[1] * rad[k], pts[k][2] + o[2] * rad[k]); W.nor.push(...o);
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
  tube(W, tp, tr, 9, 0, 0.55, base, seed);
  const pads = [{ c: at(1), R: h * (0.2 + 0.1 * r()), f: 0.6 }];
  const nl = 3 + Math.floor(r() * 3);
  for (let i = 0; i < nl; i++) {
    const t0 = 0.38 + 0.55 * (i + r() * 0.7) / nl, P0 = at(t0), az = lean + (r() - 0.5) * 4.2, len = h * (0.26 + 0.3 * r()), rise = 0.12 + 0.45 * r(), dr = 0.2 + 0.3 * r();
    const dh = [Math.cos(az), Math.sin(az)], pts = [], rr = [], fA = 0.55 * t0, fB = fA + 0.45;
    for (let k = 0; k <= 6; k++) { const q = k / 6; pts.push([P0[0] + dh[0] * len * q + lp[0] * 0.05 * h * Math.sin(q * 4 + i), P0[1] + len * (rise * q - dr * q * q * 0.5), P0[2] + dh[1] * len * q + lp[1] * 0.05 * h * Math.sin(q * 4 + i)]); rr.push(rad(t0) * 0.62 * (1 - 0.62 * q)); }
    tube(W, pts, rr, 7, fA, fB, base, seed + i);
    pads.push({ c: [pts[6][0], pts[6][1] + 0.05 * h, pts[6][2]], R: h * (0.17 + 0.09 * r()), f: fB });
    for (let j = 0, nt = 2 + Math.floor(r() * 2); j < nt; j++) {
      const q0 = 0.45 + 0.35 * r(), Q = pts[Math.round(q0 * 6)], az2 = az + (r() < 0.5 ? -1 : 1) * (0.6 + 0.6 * r()), l2 = len * (0.3 + 0.25 * r()), tw = [], trr = [];
      for (let k = 0; k <= 4; k++) { const q = k / 4; tw.push([Q[0] + Math.cos(az2) * l2 * q, Q[1] + l2 * (0.35 * q), Q[2] + Math.sin(az2) * l2 * q]); trr.push(rad(t0) * 0.32 * (1 - 0.6 * q)); }
      tube(W, tw, trr, 5, fA + 0.3, fB + 0.1, base, seed + i + j * 7);
      pads.push({ c: [tw[4][0], tw[4][1] + 0.04 * h, tw[4][2]], R: h * (0.13 + 0.07 * r()), f: fB + 0.1 });
    }
  }
  for (const pd of pads) {
    const nb = Math.round(Math.min(120, Math.max(30, 260 * pd.R * pd.R)) * LEAF_MULT);
    for (let b = 0; b < nb; b++) {
      const a = r() * 6.2832, rf = Math.sqrt(r()), rd = rf * pd.R * 0.75;
      const root = [pd.c[0] + Math.cos(a) * rd, pd.c[1] - pd.R * 0.18 + r() * pd.R * 0.22, pd.c[2] + Math.sin(a) * rd];
      const dir = norm([Math.cos(a) * (0.35 + rf) + (r() - 0.5) * 0.5, 0.25 + 0.55 * r(), Math.sin(a) * (0.35 + rf) + (r() - 0.5) * 0.5]);
      Lf.R.push(...root, pd.f); Lf.D.push(...dir, pd.R * (0.55 + 0.5 * r()) * (1.15 - rf * 0.4)); Lf.M.push(0.08 + 0.1 * r(), 0.12 + 0.25 * r(), 0.08 + 0.07 * r(), r()); Lf.B.push(...base);
    }
  }
}
function growForest(sc) {
  const W = { pos: [], nor: [], w: [], b: [], idx: [] }, Lf = { R: [], D: [], M: [], B: [] };
  const r = rng(4049);
  for (let q = 0; q < sc.trees.length; q += 4) growJuniper(sc.trees[q], sc.trees[q + 1], sc.trees[q + 2], 3.4 + r() * 3.0, sc.trees[q + 3], W, Lf);
  // one small juniper clinging to the top of the sea stack, leaning out over the water
  let top = 0;
  for (let i = 1; i < STACK_GEO.pos.length; i += 3) if (STACK_GEO.pos[i] > STACK_GEO.pos[top * 3 + 1]) top = (i - 1) / 3;
  const sx = ISLET[0] + STACK_GEO.pos[top * 3] * STACK_S[0], sz = ISLET[1] + STACK_GEO.pos[top * 3 + 2] * STACK_S[2], sy = H(ISLET[0], ISLET[1]) - 0.15 + STACK_GEO.pos[top * 3 + 1] * STACK_S[1];
  growJuniper(sx, sy - 0.1, sz, 2.6, 0.7317, W, Lf, Math.atan2(LAKE[1] - sz, LAKE[0] - sx) + 2.4);
  return { pos: new Float32Array(W.pos), nor: new Float32Array(W.nor), w: new Float32Array(W.w), b: new Float32Array(W.b), idx: new Uint32Array(W.idx), R: new Float32Array(Lf.R), D: new Float32Array(Lf.D), M: new Float32Array(Lf.M), B: new Float32Array(Lf.B) };
}

// understory around tree bases and big stones, ferns along the shade and the shore, glow tubes by the water
function plantScatter(sc) {
  const r = rng(555), P = [], F = [], S2 = [];
  const ok = (x, z) => { const y = H(x, z); return y > 0.32 && y < 8 && nearNy(x, z) > 0.8 && clearOf(x, z) && Math.abs(x) < 31 && Math.abs(z) < 31; };
  const anchors = [];
  for (let q = 0; q < sc.trees.length; q += 4) anchors.push([sc.trees[q], sc.trees[q + 2]]);
  for (const v of [0, 1]) for (let q = 0; q < sc.rv[v].length; q += 4) if (sc.rs[v][q] > 0.9) anchors.push([sc.rv[v][q], sc.rv[v][q + 2]]);
  const nearA = (r0, r1) => { const a = anchors[Math.floor(r() * anchors.length)], t = r() * 6.2832, d = r0 + r() * (r1 - r0); return [a[0] + Math.cos(t) * d, a[1] + Math.sin(t) * d]; };
  const shoreP = (d0, d1) => { let x, z, k = 0; do { x = LAKE[0] + (r() * 2 - 1) * 19; z = LAKE[1] + (r() * 2 - 1) * 16; k++; } while ((lakeD(x, z) < d0 || lakeD(x, z) > d1) && k < 60); return [x, z]; };
  const place = (gen) => { for (let t = 0; t < 30; t++) { const [x, z] = gen(); if (ok(x, z)) return [x, z]; } return null; };
  for (let k = 0; k < (touch ? 150 : 230); k++) {
    const at = place(() => (r() < 0.7 ? nearA(1.2, 3.6) : [(r() * 2 - 1) * 30, (r() * 2 - 1) * 30])); if (!at) continue;
    const [x, z] = at, y = H(x, z), scl = 0.7 + r() * 0.8, n = 9 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) { P.push(x, y - 0.03, z, scl); F.push(i / n * 6.2832 + r() * 0.4, 0.5 + r() * 0.45, 0.11 + r() * 0.05, 0); S2.push(0.55 + r() * 0.25, 0.45, 0.25 + r() * 0.15, 0.45 + r() * 0.25); }
  }
  for (let k = 0; k < (touch ? 130 : 200); k++) {
    const at = place(() => (r() < 0.6 ? nearA(0.8, 3.2) : shoreP(12, 14.5))); if (!at) continue;
    const [x, z] = at, y = H(x, z), scl = 0.7 + r() * 0.6, n = 10 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) { P.push(x, y - 0.02, z, scl); F.push(i / n * 6.2832 + r() * 0.5, 0.75 + r() * 0.5, 0.24, 1); S2.push(0.8, 0.22, 0.5, 0.85 + r() * 0.2); }
  }
  for (let c = 0; c < (touch ? 70 : 110); c++) {
    const at = place(() => (r() < 0.55 ? shoreP(11, 13.2) : nearA(0.6, 1.8))); if (!at) continue;
    const m = 8 + Math.floor(r() * 9);
    for (let i = 0; i < m; i++) {
      const x = at[0] + (r() - 0.5) * 0.7, z = at[1] + (r() - 0.5) * 0.7, y = H(x, z), L = 0.12 + r() * 0.28, W = 0.035 + r() * 0.02, phi = r() * 3.1416;
      for (const ph of [phi, phi + 1.5708]) { P.push(x, y - 0.02, z, 1); F.push(ph, L, W, 2); S2.push(0.06, 1, 0, 0); }
    }
  }
  return { P: new Float32Array(P), F: new Float32Array(F), S2: new Float32Array(S2) };
}
const MOTE_N = touch ? 260 : 420;
function moteScatter() {
  const r = rng(808), m = new Float32Array(MOTE_N * 4);
  for (let i = 0; i < MOTE_N; i++) { const x = (r() * 2 - 1) * 30, z = (r() * 2 - 1) * 30, g = H(x, z); m.set([x, Math.max(g, 0) + 0.4 + r() * 2.4, z, r()], i * 4); }
  return m;
}

// ---------------------------------------------------------------- build the scene
const loc = (p, n) => gl.getAttribLocation(p, n);
const near = terrainNear(), far = terrainFar(), wm = waterMesh(), sc = scatter(), forest = growForest(sc), pl = plantScatter(sc), motes = moteScatter();
const rockGeos = [rockMesh(1.3, 3, false), rockMesh(4.1, 3, false), rockMesh(7.7, 3, true), rockMesh(2.2, 1, false), STACK_GEO], crysGeo = crystalMesh();
const vNear = vao([{ loc: loc(TERRAIN, 'aPos'), size: 3, data: near.pos }, { loc: loc(TERRAIN, 'aNor'), size: 3, data: near.nor }], near.idx);
const vFar = vao([{ loc: loc(TERRAIN, 'aPos'), size: 3, data: far.pos }, { loc: loc(TERRAIN, 'aNor'), size: 3, data: far.nor }], far.idx);
const vWater = vao([{ loc: loc(WATERP, 'aXZ'), size: 2, data: wm.xz }, { loc: loc(WATERP, 'aDepth'), size: 1, data: wm.dep }], wm.idx);
const vRocks = rockGeos.map((g, k) => vao([{ loc: loc(ROCK, 'aPos'), size: 3, data: g.pos }, { loc: loc(ROCK, 'aNor'), size: 3, data: g.nor }, { loc: loc(ROCK, 'aI'), size: 4, data: sc.rv[k], div: 1 }, { loc: loc(ROCK, 'aS'), size: 4, data: sc.rs[k], div: 1 }], g.idx));
const vCrys = vao([{ loc: loc(ROCK, 'aPos'), size: 3, data: crysGeo.pos }, { loc: loc(ROCK, 'aNor'), size: 3, data: crysGeo.nor }, { loc: loc(ROCK, 'aI'), size: 4, data: sc.crys, div: 1 }, { loc: loc(ROCK, 'aS'), size: 4, data: sc.csc, div: 1 }], crysGeo.idx);
const vWood = vao([{ loc: loc(WOOD, 'aPos'), size: 3, data: forest.pos }, { loc: loc(WOOD, 'aNor'), size: 3, data: forest.nor }, { loc: loc(WOOD, 'aW'), size: 4, data: forest.w }, { loc: loc(WOOD, 'aB'), size: 4, data: forest.b }], forest.idx);
const vGrass = vao([{ loc: loc(GRASS, 'aG'), size: 4, data: sc.G, div: 1 }, { loc: loc(GRASS, 'aR'), size: 4, data: sc.R, div: 1 }]);
const vJLeaf = vao([{ loc: loc(JLEAF, 'aR'), size: 4, data: forest.R, div: 1 }, { loc: loc(JLEAF, 'aD'), size: 4, data: forest.D, div: 1 }, { loc: loc(JLEAF, 'aM'), size: 4, data: forest.M, div: 1 }, { loc: loc(JLEAF, 'aB'), size: 4, data: forest.B, div: 1 }]);
let grassDraw = sc.grassN;
const vPlant = vao([{ loc: loc(PLANT, 'aP'), size: 4, data: pl.P, div: 1 }, { loc: loc(PLANT, 'aF'), size: 4, data: pl.F, div: 1 }, { loc: loc(PLANT, 'aS2'), size: 4, data: pl.S2, div: 1 }]);
const vMotes = vao([{ loc: loc(POINTS, 'aP'), size: 4, data: motes }]);
const RAIN_N = 700, rainSeeds = new Float32Array(RAIN_N * 4); { const r = rng(9); for (let i = 0; i < RAIN_N; i++) rainSeeds.set([(r() * 2 - 1) * 34, r(), (r() * 2 - 1) * 34, r()], i * 4); }
const vRain = vao([{ loc: loc(POINTS, 'aP'), size: 4, data: rainSeeds }]);
const stoneBuf = new Float32Array(4 * 8);
const stoneAttr = { loc: loc(POINTS, 'aP'), size: 4, data: stoneBuf, usage: gl.DYNAMIC_DRAW };
const vStone = vao([stoneAttr]);
const stoneVbo = stoneAttr.buffer;

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
const FSQ = `out vec2 vUv; void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2. - 1., 0., 1.); }`;
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
  o = vec4(c / 16. * 0.85, 1.); }`);
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
  gl.uniform2f(P_PRE.u('uTexel'), 1 / w, 1 / h); gl.uniform1f(P_PRE.u('uThr'), HDR ? 1.3 - 0.5 * night : 0.78); gl.drawArrays(gl.TRIANGLES, 0, 3);
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
  gl.uniform1f(P_FINAL.u('uBloom'), 0.24 + 0.4 * night); gl.uniform1f(P_FINAL.u('uRays'), HDR ? 1.1 - 0.5 * night : 0.8); gl.uniform1f(P_FINAL.u('uHDRf'), HDR ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
}

// ---------------------------------------------------------------- engine state
let engine, glowF, groundF, wearF, mode = CERT;
const ripples = []; // [x, z, t0, strength]
let simT = 0;

function setMode(m) {
  mode = m; ripples.length = 0;
  for (const f of [glowF, groundF, wearF]) f.set(m);
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
  const x = (r() * 2 - 1) * 31, z = (r() * 2 - 1) * 31, y = H(x, z);
  glowF.deposit(x, z, 1 + Math.floor(r() * 3), 0.5);
  if (y < WATER && r() < 0.2) ripple(x, z, 0.25);
}

// ---------------------------------------------------------------- camera + player
const player = { x: 4, z: 15, y: 0, yaw: 0.05, pitch: 0.06, vy: 0, stride: 0, foot: 1, wet: 0 };
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

function walkable(x, z) { const h = H(x, z); return h > -1.25 && Math.abs(x) < 31 && Math.abs(z) < 31; }

function stepPlayer(dt) {
  let mx = 0, mz = 0;
  if (keys.KeyW || keys.ArrowUp) mz += 1; if (keys.KeyS || keys.ArrowDown) mz -= 1;
  if (keys.KeyA || keys.ArrowLeft) mx -= 1; if (keys.KeyD || keys.ArrowRight) mx += 1;
  if (stick.id !== null) { mx += stick.x; mz += -stick.y; }
  const len = Math.hypot(mx, mz);
  const ground = H(player.x, player.z), inWater = ground < WATER - 0.05, depth = Math.max(0, WATER - ground);
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
  const target = Math.max(H(player.x, player.z), WATER - 1.3);
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
    const water = g < WATER && s.p[1] < WATER;
    if (s.p[1] < g || water || s.t > 6) { if (s.t <= 6) splash(s.p[0], s.p[2], water); stones.splice(i, 1); }
  }
}

// ---------------------------------------------------------------- render
const SUN = norm([-0.86, 0.14, -0.33]), SUNCOL = [2.7, 1.9, 1.35], PLANET = norm([0.2, 0.43, -0.88]), MOONCOL = [0.3, 0.42, 0.82];
let night = 0, nightTarget = 0, sheet = 0;
function norm(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }

function common(p, eye, VP, mirror, t) {
  gl.useProgram(p);
  gl.uniformMatrix4fv(p.u('uVP'), false, VP);
  gl.uniform1f(p.u('uMirror'), mirror);
  gl.uniform3fv(p.u('uCam'), eye); gl.uniform3fv(p.u('uSunDir'), norm(SUN.map((v, i) => v * (1 - night) + PLANET[i] * night))); gl.uniform3fv(p.u('uSunCol'), SUNCOL.map((v, i) => v * (1 - night) + MOONCOL[i] * night)); gl.uniform3fv(p.u('uPlanetDir'), PLANET);
  gl.uniform3fv(p.u('uStarDir'), SUN); gl.uniform1f(p.u('uNight'), night); gl.uniform1f(p.u('uBio'), 1 + 2.4 * night); gl.uniform1f(p.u('uHDR'), HDR ? 1 : 0);
  gl.uniform1f(p.u('uTime'), t); gl.uniform1f(p.u('uExposure'), 0.95 + 0.3 * night); gl.uniform1f(p.u('uExtent'), EXTENT); gl.uniform1f(p.u('uSheet'), sheet); gl.uniform1f(p.u('uWind'), TEST ? 0.7 : (rain ? 1.15 : 0.7) + 0.2 * Math.sin(t * 0.13));
  gl.uniform1i(p.u('uGlow'), 0); gl.uniform1i(p.u('uGround'), 1); gl.uniform1i(p.u('uWear'), 7);
  gl.uniform1f(p.u('uClip'), mirror < 0 ? WATER - 0.02 : -1e9);
}
function drawScene(eye, b, VP, mirror, t, opts) {
  gl.depthMask(false); gl.disable(gl.DEPTH_TEST);
  common(SKY, eye, VP, mirror, t);
  gl.uniform3fv(SKY.u('uR'), b.r); gl.uniform3fv(SKY.u('uU'), b.u); gl.uniform3fv(SKY.u('uF'), b.f); gl.uniform2f(SKY.u('uTan'), opts.tanX, opts.tanY);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE); gl.frontFace(mirror < 0 ? gl.CW : gl.CCW);
  common(TERRAIN, eye, VP, mirror, t);
  gl.bindVertexArray(vNear); gl.drawElements(gl.TRIANGLES, near.idx.length, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(vFar); gl.drawElements(gl.TRIANGLES, far.idx.length, gl.UNSIGNED_INT, 0);
  common(ROCK, eye, VP, mirror, t);
  gl.uniform1i(ROCK.u('uKind'), 0);
  for (let k = 0; k < rockGeos.length; k++) { if (!sc.rv[k].length || (k === 3 && mirror < 0)) continue; gl.bindVertexArray(vRocks[k]); gl.drawElementsInstanced(gl.TRIANGLES, rockGeos[k].idx.length, gl.UNSIGNED_INT, 0, sc.rv[k].length / 4); }
  gl.uniform1i(ROCK.u('uKind'), 1); gl.bindVertexArray(vCrys); gl.drawElementsInstanced(gl.TRIANGLES, crysGeo.idx.length, gl.UNSIGNED_INT, 0, sc.crys.length / 4);
  gl.disable(gl.CULL_FACE);
  common(WOOD, eye, VP, mirror, t); gl.bindVertexArray(vWood); gl.drawElements(gl.TRIANGLES, forest.idx.length, gl.UNSIGNED_INT, 0);
  common(JLEAF, eye, VP, mirror, t); gl.bindVertexArray(vJLeaf); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 13, forest.R.length / 4);
  common(PLANT, eye, VP, mirror, t); gl.bindVertexArray(vPlant); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 25, pl.P.length / 4);
  if (opts.grass) { common(GRASS, eye, VP, mirror, t); gl.bindVertexArray(vGrass); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 7, grassDraw); }
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
  // reflection: the same scene mirrored in the lake plane, half resolution, no grass
  const rw = Math.max(1, w >> 1), rh = Math.max(1, h >> 1);
  ensureRefl(rw, rh);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, reflFbo); gl.viewport(0, 0, rw, rh);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawScene([cam.eye[0], 2 * WATER - cam.eye[1], cam.eye[2]], b, VP, -1, t, { tanX, tanY, grass: false });
  ensurePost(w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, post.ms || post.resF); gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawScene(cam.eye, b, VP, 1, t, { tanX, tanY, grass: true });
  gl.colorMask(true, true, true, false);
  // water
  common(WATERP, cam.eye, VP, 1, t);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, reflTex);
  gl.uniform1i(WATERP.u('uRefl'), 2); gl.uniform2f(WATERP.u('uRes'), w, h);
  const rip = new Float32Array(48); ripples.forEach((r, i) => rip.set(r, i * 4)); gl.uniform4fv(WATERP.u('uRip'), rip);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  gl.bindVertexArray(vWater); gl.drawElements(gl.TRIANGLES, wm.idx.length, gl.UNSIGNED_INT, 0);
  // particles: additive colour, and they cut themselves out of the sky mask so the rays never streak them
  gl.colorMask(true, true, true, true); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
  common(POINTS, cam.eye, VP, 1, t); gl.uniform1f(POINTS.u('uScale'), h * 0.9);
  if (!camOverride || camOverride.motes) { gl.uniform1i(POINTS.u('uRain'), 2); gl.bindVertexArray(vMotes); gl.drawArrays(gl.POINTS, 0, MOTE_N); }
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
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toLocaleString();
const bytes = (n) => n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
let last = 0, wall = 0, acc = { frames: 0, t: 0, dense: 0, ms: 0, up: 0 }, sporeR = rng(77), sporeAcc = 0;
const layers = () => [glowF, groundF, wearF];

function simulate(dt) {
  stepPlayer(dt); stepStones(dt);
  if (rain) { sporeAcc += dt * 30; while (sporeAcc >= 1) { spore(sporeR); sporeAcc -= 1; } if (groundF.sheet < 0.45) groundF.rain(dt * 0.025); }
  const t0 = performance.now();
  for (const f of layers()) acc.dense += f.advance(dt) * N * N;
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
    if (grassDraw > sc.grassN * 0.55) grassDraw = Math.floor(grassDraw * 0.85);
    else if (renderScale > 0.72) renderScale = Math.max(0.72, renderScale * 0.9);
    else if (grassDraw > 40000) grassDraw = Math.floor(grassDraw * 0.85);
    coolUntil = warm + 6;
  } else if (med < 1 / 57 && warm > coolUntil) {
    if (renderScale < 1) renderScale = Math.min(1, renderScale * 1.06);
    else if (grassDraw < sc.grassN) grassDraw = Math.min(sc.grassN, Math.floor(grassDraw * 1.08));
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
    hud.ms.textContent = (acc.ms / f).toFixed(2) + ' ms';
    hud.mem.textContent = bytes(st.reduce((n, s) => n + s.bytes, 0)) + (mode === CERT ? ' of ' + bytes(3 * N * N * 8) : '');
    hud.up.textContent = bytes(acc.up / f);
    const bound = Math.max(...st.map((s) => s.bound)), broken = st.reduce((n, s) => n + s.violations, 0);
    hud.promise.textContent = mode === CERT ? `${(bound * 255).toFixed(2)}/255 · ${broken} broken` : 'is the reference';
    acc = { frames: 0, t: 0, dense: 0, ms: 0, up: 0 };
  }
}

function refreshModeUI() {
  hud.mode.firstElementChild.textContent = MODE_NAME[mode];
  hud.mode.className = 'mode' + (mode === DENSE ? ' dense' : '');
  document.getElementById('bMode').textContent = MODE_NAME[mode];
  hud.note.textContent = mode === CERT
    ? 'Every cell the engine skips is proven to sit within 1/255 of the full computation, on a plane with no edge. Walk, throw, call spore rain: the cost follows what happens, not the size of the world.'
    : 'Dense steps every cell of the acre, every step: the full computation the certified engine promises to match. It costs the whole acre whether anything happens or not, and nothing outside the acre exists for it.';
}
function cycleMode() { setMode(mode === CERT ? DENSE : CERT); refreshModeUI(); }

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
function scripted(m, frames = 900, view = 'shore') {
  setMode(m); started = false; rain = false; stones.length = 0;
  const r = rng(4242); simT = 0;
  if (view === 'render') { render(12.0, { shore: { eye: [9.5, H(9.5, 13) + 2.6, 13], yaw: -0.95, pitch: -0.28, motes: true }, planet: { eye: [4, H(4, 15) + 1.7, 15], yaw: 0.05, pitch: 0.12, motes: true }, sunset: { eye: [6, H(6, 2) + 1.7, 2], yaw: -1.5, pitch: 0.08, motes: true } }[frames]); return {}; }
  const t0 = performance.now();
  let stride = 0, foot = 1, px = 9, pz = 9;
  for (let f = 0; f < frames; f++) {
    const dt = 1 / 60; simT += dt;
    // a hiker along the south-east shore and into the shallows, then back out with wet feet
    const a = 0.9 + f / frames * 1.6, R = 10.2 + 2.4 * Math.sin(f / frames * Math.PI);
    const nx = LAKE[0] + Math.cos(a) * R * 1.2, nz = LAKE[1] + Math.sin(a) * R * 0.95;
    if (f < 760) stride += Math.hypot(nx - px, nz - pz); px = nx; pz = nz;
    const wetNow = H(px, pz) < WATER;
    if (f < 760 && stride > 0.55) { stride -= 0.55; foot = -foot; footstep(px + 0.14 * foot, pz, wetNow, wetNow ? 1 : 0.6, false); }
    if (f === 380 || f === 800) splash(LAKE[0] + (f === 380 ? 2 : -1), LAKE[1] + (f === 380 ? 1 : 5), true);
    if (f >= 760) { const q = (f - 760) / 140, wx = 8.6 - 3.8 * q, wz = 13.4 - 1.6 * q; stride += 0.03; if (stride > 0.55) { stride = 0; foot = -foot; footstep(wx + 0.14 * foot, wz, false, 1, false); } }
    if (f === 850) splash(5.2, 10.6, false);
    if (f > 300 && f < 600) { if (r() < 0.5) spore(r); groundF.rain(0.0004); }
    for (const l of layers()) l.advance(dt);
  }
  const ms = performance.now() - t0;
  const stepped = layers().reduce((n, l) => n + l.stepped, 0);
  for (const l of layers()) { l.upload(); l.stepped = 0; }
  ripples.length = 0;
  const cams = { shore: { eye: [9.5, H(9.5, 13) + 2.6, 13], yaw: -0.95, pitch: -0.28 }, planet: { eye: [4, H(4, 15) + 1.7, 15], yaw: 0.05, pitch: 0.12, motes: true } };
  render(12.0, cams[view] || cams.shore);
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
  setMode(CERT);
  refreshModeUI();
  document.getElementById('status').textContent = `field engine ready: three certified fields on an unbounded plane, cones computed in ${Math.round(performance.now() - t0)} ms`;
  if (touch) { document.getElementById('go').textContent = 'Tap to step onto the shore'; document.getElementById('keys').innerHTML = '<b>left thumb</b><span>walk (push far to run)</span><b>right thumb</b><span>look</span><b>buttons</b><span>throw, spore rain, night, switch engine, readout</span>'; }
  window.__game = { setNight: (v) => { night = nightTarget = v; }, hdr: HDR, samples: SAMPLES, scripted, setMode, H, ready: true, engine: engine.kind, state: () => ({ player: { ...player }, started, blocks: layers().map((l) => l.stats().blocks) }) };
  if (TEST) { document.documentElement.classList.remove('intro'); document.getElementById('intro').hidden = true; document.getElementById('pad').hidden = true; document.getElementById('cross').hidden = true; return; }
  bindInput();
  document.getElementById('intro').addEventListener('click', () => {
    document.getElementById('intro').hidden = true; document.documentElement.classList.remove('intro'); started = true;
    if (!touch) canvas.requestPointerLock?.()?.catch?.(() => {});
  });
  requestAnimationFrame((t) => { last = t; frame(t); });
})().catch((e) => fail('The field engine did not start: ' + e.message));
