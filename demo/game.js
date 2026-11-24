import { FieldTexture } from './field-texture.js';
import { BrushField } from './brush.js';
import { highCanopyMesh, highCanopySites } from './high-canopy.js';
import { createSailwings } from './fauna.js';
import { bakeClouds, bakeCanopy, valleyAir, canopyShelter } from './atmosphere.js';
import { bakeShadows } from './shadows.js';
// Tarnished Promise: four acres of lake shore on Tarn, under a ringed giant.
//
// The world remembers you through three boxel fields on the unbounded plane of 12.5 cm cells:
//   glow      bioluminescence in the moss and the water   D 8 cells²/s, k 0.3/s, 60 steps/s
//   moisture  wet feet, splashes, spore rain               D 3 cells²/s, k 0.04/s, 15 steps/s
//   wear      trails packed into the soil                  no spread, k 0.008/s, 15 steps/s
// Each is certified to stay within 1/255 of computing every cell, and only the 16 × 16 blocks
// that can still matter exist. The renderer sees the map through one R8 texture per field and
// re-uploads exactly the blocks the engine holds, clearing the ones it lets go.

import { summit, trail, valleyWalks, terrainHeight, trailCover, trailDistance, riverX, waterLevel } from './landmarks.js';
import { companionWorlds, skyBodies } from './worlds.js';
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
function H(x, z) {
  // meadow: small undulation on rolling swells
  const meadow = 0.7 + 1.1 * fbm(x * 0.045 + 3, z * 0.045 - 1) + 0.25 * fbm(x * 0.22, z * 0.22, 3) + 3.2 * (fbm(x * 0.017 - 7, z * 0.017 + 5, 3) - 0.4);
  const d = lakeD(x, z);
  // a wadeable shelf all round the shore, then a drop into the basin
  const bowl = -0.6 * (1 - sm(8.5, 10.8, d)) - 4.4 * (1 - sm(1, 8.5, d)) - 0.35;
  const t = sm(9.6, 14, d);
  let h = bowl * (1 - t) + meadow * t;
  const ri = Math.hypot(x - ISLET[0], z - ISLET[1]) * 0.5;
  if (ri < 7) h += 2.6 * Math.exp(-ri * ri / 5) * (1 - t);
  // A continuous stone shoulder carries the trail. Fractured rock emerges on its flanks.
  const o = outcrop(x, z);
  if (o > 0) {
    const shoulder = 4.3 + 1.35 * vnoise(x * 0.065 + 4, z * 0.065 - 2);
    const rough = sm(0.9, 4, trailDistance(x, z));
    h += o * (shoulder + rough * 3.8 * (ridged(x * 0.05 + 4, z * 0.05 - 2) - 0.44)) * t;
  }
  const e = Math.hypot(x, z * 1.05);
  h += sm(40, 76, e) * (4 + 8 * fbm(x * 0.04 + 9, z * 0.04 + 2));
  // Sample the same mountain profile at twice the distance travelled beyond the square map.
  // A ridge previously 200 m past the boundary now rises 100 m past it, at its original height.
  const edgeDistance = Math.max(Math.abs(x), Math.abs(z));
  const scale = edgeDistance > HALF ? 2 - HALF / edgeDistance : 1;
  const range = e * scale, m = sm(84, 520, range);
  if (m > 0) {
    const mx = x * scale, mz = z * scale;
    const drainage = Math.abs(2 * fbm(mx * 0.011 + 8, mz * 0.006 - 3, 3) - 0.85);
    h -= 9 * m * m * (1 - sm(0.02, 0.16, drainage));
    // broad ridges, and on their crests a second, sharper set: crags, horns and notches
    const rg = ridged(mx * 0.0035 + 2, mz * 0.0035 - 4), crag = ridged(mx * 0.013 + 7, mz * 0.013 - 3);
    h += m * m * (18 + 115 * rg + 18 * crag * crag * rg) + sm(84, 170, range) * 6 * fbm(mx * 0.02, mz * 0.02);
  }
  return terrainHeight(x, z, h);
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

/** The sparse field covers the whole plane. Its display uploads changed R8 regions inside the map.
 *  The dense reference steps the finite map and uploads its full image. */
class Layer {
  constructor(boxel, spec, tex) { Object.assign(this, { boxel, spec, tex, acc: 0, textureCache: new FieldTexture(N) }); }
  set(mode) {
    this.f?.free(); this.g?.free(); this.f = this.g = null; this.acc = 0; this.steps = 0; this.lastStepped = 0; this.lastSteps = 0;
    if (mode === BOXEL) this.f = this.boxel.field({ spread: this.spec.spread, fade: this.spec.fade, tolerance: TOLERANCE, events: this.spec.events });
    else this.g = this.boxel.grid(this.spec, -N / 2, -N / 2, N);
    this.textureCache.bytes.fill(0);
    clearTexture(this.tex, this.textureCache.bytes);
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
    this.steps += n;
    (this.f || this.g).step(n);
    this.changed = true;
  }
  /** Send what changed to the texture. Returns bytes uploaded. */
  upload() {
    if (!this.changed) return 0;
    this.changed = false;
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    return this.g ? this.textureCache.uploadDense(gl, this.g) : this.textureCache.uploadSparse(gl, this.f);
  }
  stats() { return this.f ? this.f.stats() : { stepped: this.steps * N * N, blocks: N * N / 256, bytes: N * N * 8, live: 0, violations: 0, bound: 0 }; }
}

async function loadEngine() {
  return { kind: 'boxel · Rust → wasm', boxel: await load(fetch(new URL('./boxel.wasm', import.meta.url))) };
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
function uploadBuffer(target, data, usage = gl.STATIC_DRAW) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(target, buffer);
  gl.bufferData(target, data, usage);
  return buffer;
}

// Shared attributes and index buffers can be reused by static instance batches.
function vao(attribs, index, firstInstance = 0) {
  const v = gl.createVertexArray(); gl.bindVertexArray(v);
  for (const a of attribs) {
    if (a.buffer) gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer);
    else a.buffer = uploadBuffer(gl.ARRAY_BUFFER, a.data, a.usage);
    gl.enableVertexAttribArray(a.loc);
    const stride = a.stride || 0, offset = (a.offset || 0) + (a.div ? firstInstance * (stride || a.size * 4) : 0);
    gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, stride, offset);
    if (a.div) gl.vertexAttribDivisor(a.loc, a.div);
  }
  if (ArrayBuffer.isView(index)) uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  else if (index) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  gl.bindVertexArray(null);
  return v;
}

// HDR when the device can render to float (Corey's pipeline); otherwise the same passes in 8 bits
const HDR = !!(gl && gl.getExtension('EXT_color_buffer_float'));
const CFMT = HDR ? gl.RGBA16F : gl.RGBA8, CTYPE = HDR ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
// The HDR colour and depth formats must both support the chosen sample count.
const colorSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, CFMT, gl.SAMPLES);
const depthSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES);
const SAMPLES = Math.max(0, ...colorSamples.filter(n => n <= 4 && depthSamples.includes(n)));

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
uniform vec4 uRip[12]; // centre xz, wavefront radius, decaying amplitude
uniform int uRipCount;
vec3 impactWave(vec2 p){
  vec3 wave = vec3(0.);
  for (int i = 0; i < 12; i++) {
    if (i >= uRipCount) break;
    vec4 r = uRip[i];
    vec2 d = p - r.xy;
    float dist2 = dot(d, d) + 0.0025, outer = r.z + 1.85, inner = max(0., r.z - 1.85);
    if (dist2 > outer * outer || dist2 < inner * inner) continue;
    float dist = sqrt(dist2), offset = dist - r.z, spread = 1. / (1. + 0.52 * dist);
    float env = r.w * spread * exp(-2.35 * offset * offset), phase = 6.5 * offset;
    float height = env * cos(phase);
    float gradient = height * (-4.7 * offset - 0.52 * spread) - env * 6.5 * sin(phase);
    wave += vec3(height, gradient * d / dist);
  }
  // Soft-limit overlapping crests, applying the derivative of the same limiter to the normal.
  float scale = 1. / (1. + abs(wave.x) / 0.13);
  return vec3(wave.x * scale, wave.yz * scale * scale);
}
`;
const COMMON = WAVES + valleyAir + `
uniform vec3 uSunDir, uSunCol;
uniform mat3 uSky;
uniform samplerCube uMilky;
uniform float uTime, uExposure, uExtent, uSheet, uWind, uHDR;
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
// Ease in across the lowest R8 levels so a one-level field change stays subtle in the dark.
float glowI(float g){ return (1. - exp(-g * 5.)) * smoothstep(0., 0.045, g); }
vec2 fieldUV(vec2 xz){ return xz / uExtent + 0.5; }
const vec2 WIND_DIR = vec2(0.87, 0.5);
// Corey's gusts: two sine waves travelling across the world, so the wind visibly rolls over grass, leaves and water together
float windWave(vec2 p){ return sin(dot(p, vec2(0.31, 0.18)) + uTime * 1.25) * 0.55 + sin(dot(p, vec2(-0.23, 0.41)) * 1.7 + uTime * 2.3) * 0.3; }
float inField(vec2 uv){ return step(0., uv.x) * step(0., uv.y) * step(uv.x, 1.) * step(uv.y, 1.); }

${companionWorlds}
uniform sampler2D uClouds;
vec2 cloudUV(vec3 origin, vec3 ray) {
  // The same thin cloud deck drifts over the camera and the terrain beneath it.
  const float deck = 120.;
  vec2 p = origin.xz / deck + ray.xz * max(0., 1. - origin.y / deck) / (max(0., ray.y) + 0.07);
  return p / 9. + vec2(0.37, 0.62) + WIND_DIR * (uTime * 0.00054);
}
vec3 skyColor(vec3 d){
  vec3 c = skyBase(d);
  gBehind = c;
  starTransmission = 1.;
  nearestMoonDepth = -100.;
  if (uNight > 0. && d.y > -0.02) {
    // the galaxy's band, baked once into a cube map in the sky's own frame, which turns about the pole
    vec3 mw = texture(uMilky, uSky * d).rgb;
    c += mw * mw * uNight * smoothstep(-0.02, 0.22, d.y) * 0.5;
  }
  c += STAR_COL * (1. - uNight) * 3. * smoothstep(0.99935, 0.99965, dot(d, uStarDir));
  vec3 P = uPlanetDir; vec3 T = normalize(cross(P, vec3(0., 1., 0.))); vec3 B = cross(T, P);
  float dp = dot(d, P);
  if (dp > 0.7) {
    vec2 q = vec2(dot(d, T), dot(d, B)) / dp;
    c = amberMoons(d, c, P, T, B, true);
    float R = 0.17, tilt = 0.38;
    vec2 rq = vec2(q.x * cos(tilt) + q.y * sin(tilt), -q.x * sin(tilt) + q.y * cos(tilt));
    float rr = length(vec2(rq.x, rq.y / 0.2));
    float band = amberRingDensity(rr / R);
    float aa = clamp(1. - fwidth(rr) * 90., 0., 1.);
    float ringDepth = -rq.y * sqrt(1. - 0.2 * 0.2) / 0.2;
    vec3 ring = vec3(0.70, 0.75, 0.84) * mix(0.60, 0.60 + 0.24 * sin(rr * 395.) + 0.10 * sin(rr * 613.), aa);
    ring *= ringSun((q.x * T + q.y * B - ringDepth * P) / R);
    ring += gBehind * 0.42;
    float pr = length(q);
    if (pr < R) {
      vec3 nw = normalize(q.x / R * T + q.y / R * B - sqrt(max(0., 1. - pr * pr / (R * R))) * P);
      vec3 axis = normalize(B * cos(tilt) - T * sin(tilt));
      vec3 pole = axis * sqrt(1. - 0.2 * 0.2) - 0.2 * P;
      float lat = dot(nw, pole);
      // a storm eye: the bands swirl round an oval vortex in the southern belt
      vec2 dv = (rq - vec2(0.05, -0.045)) * vec2(0.62, 1.); float rs = length(dv), sw = exp(-rs * rs / 0.0011);
      float ang = sw * 5.5; vec2 dvr = vec2(dv.x * cos(ang) - dv.y * sin(ang), dv.x * sin(ang) + dv.y * cos(ang));
      lat += (dvr.y - dv.y) * 2.2 * sw;
      float bands = sin(lat * 19. + sin(lat * 6. + q.x * 8.) * 1.6 + vnoise(q * 30. + dvr * 40. * sw) * 0.8);
      // an amber giant: cream and ochre bands, rust belts, a red storm; nothing like the world under it
      vec3 pc = mix(vec3(0.74, 0.47, 0.26), vec3(0.95, 0.84, 0.66), 0.5 + 0.5 * bands);
      pc = mix(pc, vec3(0.50, 0.22, 0.14), smoothstep(0.75, 0.95, abs(sin(lat * 7. + 1.3))) * 0.45);
      pc = mix(pc, vec3(0.92, 0.42, 0.28), (1. - smoothstep(0.012, 0.03, rs)) * 0.6);
      pc = mix(pc, vec3(0.34, 0.1, 0.06), (1. - smoothstep(0., 0.009, rs)) * 0.6);
      float viewCos = max(0., -dot(nw, P));
      starTransmission = 0.;
      // Intersect the surface-to-sun ray with the same tilted ring plane.
      float cosSun = dot(uStarDir, pole), shade = 0.;
      if (abs(cosSun) > 0.0001) {
        float travel = -dot(nw, pole) / cosSun;
        if (travel > 0.) shade = 0.74 * amberRingDensity(length(nw + travel * uStarDir));
      }
      c = mix(bodyLight(pc, nw, viewCos, 0.12), pc * nightFill + gBehind * 0.42, shade);
      band *= step(R * viewCos, ringDepth);
    } else {
      c += vec3(0.6, 0.42, 0.28) * exp(-(pr - R) * 95.) * 0.065 * max(dot(normalize(q.x * T + q.y * B), uStarDir), 0.);
    }
    c = mix(c, ring, band * 0.74);
    starTransmission *= 1. - band * 0.74;
    c = amberMoons(d, c, P, T, B, false);
  }
  // a small ice world, like Europa: frost plains crossed by long rust-brown cracks, mottled chaos terrain and a
  // blue-white cap, turning slowly
  vec3 S = ICE_DIR, ST = normalize(cross(S, vec3(0., 1., 0.))), SB = cross(ST, S);
  float ds = dot(d, S);
  if (ds > 0.99) {
    vec2 sq = vec2(dot(d, ST), dot(d, SB)) / ds; float Rs = 0.046, sr = length(sq), cov = 1. - smoothstep(Rs * 0.95, Rs, sr);
    if (cov > 0.) {
      vec2 u = sq / Rs; float z = sqrt(max(0., 1. - dot(u, u)));
      vec3 ns = normalize(u.x * ST + u.y * SB - z * S), ax = normalize(vec3(0.25, 0.95, 0.15));
      vec3 sp = spin(vec3(u, z), ax, uTime * 0.01);
      float m1 = vnoise(sp.xy * 3.2 + 4.) * 0.6 + vnoise(sp.yz * 6.5) * 0.4;
      vec3 ic = mix(vec3(0.78, 0.8, 0.82), vec3(0.88, 0.87, 0.83), m1);
      ic = mix(ic, vec3(0.6, 0.44, 0.32), smoothstep(0.6, 0.8, vnoise(sp.zx * 4. - 1.)) * 0.55);
      float cracks = 0.;
      for (int i = 0; i < 5; i++) {
        float fi = float(i);
        vec3 k = normalize(vec3(sin(fi * 2.4 + 0.3), cos(fi * 1.7), sin(fi * 3.1 + 1.)));
        float a = abs(dot(sp, k) + 0.05 * sin(dot(sp, k.yzx) * 9. + fi));
        cracks = max(cracks, (1. - smoothstep(0.015, 0.05, a)) * (0.5 + 0.5 * vnoise(sp.xy * 5. + fi)));
      }
      ic = mix(ic, vec3(0.45, 0.27, 0.18), cracks * 0.8);
      ic = mix(ic, vec3(0.74, 0.86, 1.0), smoothstep(0.65, 0.88, dot(sp, ax)) * 0.7);
      c = mix(c, bodyLight(ic, ns, z, 0.06), cov);
      starTransmission *= 1. - cov;
    }
  }
  c = companions(d, c);
  if (d.y > 0.015) {
    vec2 cu = cloudUV(uCam, d);
    float body = texture(uClouds, cu).r;
    float curls = texture(uClouds, cu * 4. + vec2(0.17, 0.63)).g - 0.5;
    float density = clamp(body + 1.75 * curls * smoothstep(0., 0.14, body) * (1. - 0.65 * body), 0., 1.);
    float cov = density * smoothstep(0.015, 0.18, d.y) * mix(0.82, 0.44, uNight);
    if (cov > 0.001) {
      // A short second sample along the light direction distinguishes a bright lip from the shaded column.
      float towardLight = texture(uClouds, cu + uSunDir.xz * 0.009).r;
      float rim = clamp((density - towardLight) * 1.8 + 0.18 + 0.32 * (1. - density) + 0.45 * curls, 0., 1.);
      vec3 cc = mix(vec3(0.16, 0.22, 0.34), vec3(1.20, 1.12, 0.95), rim);
      cc += vec3(0.58, 0.33, 0.15) * pow(max(dot(d, uStarDir), 0.), 8.) * (1. - density);
      cc = mix(cc, vec3(0.008, 0.013, 0.032) + vec3(0.045, 0.07, 0.13) * rim, uNight);
      c = mix(c, cc, cov);
      starTransmission *= 1. - cov;
    }
  }
  return c;
}
${canopyShelter}
vec3 ambient(vec3 n){
  vec3 day = mix(vec3(0.028, 0.030, 0.035), vec3(0.095, 0.143, 0.177), n.y * 0.5 + 0.5);
  vec3 nite = mix(vec3(0.004, 0.007, 0.015), vec3(0.015, 0.026, 0.060), n.y * 0.5 + 0.5);
  return mix(day, nite, uNight);
}
// A ground-space irradiance map transfers a little of each colony's pigment onto
// nearby diffuse surfaces. Height falloff keeps the crowns above it dark.
uniform sampler2D uFloraSpill;
vec3 floraSpill(vec3 wp){
  if (uNight < 0.01) return vec3(0.);
  vec2 uv = fieldUV(wp.xz);
  if (inField(uv) < 0.5) return vec3(0.);
  vec4 sampleLight = texture(uFloraSpill, uv);
  // Height is stored as a light-weighted moment; empty texels carry no height.
  float weight = dot(sampleLight.rgb, vec3(1. / 3.));
  float height = 32. * sampleLight.a / max(weight, 0.004) - 4.;
  return sampleLight.rgb * (1. - smoothstep(0.25, 2.4, abs(wp.y - height))) * uNight * uNight;
}
uniform highp sampler2DArrayShadow uShadows;
uniform mat4 uLightVP[2];
float shadowAt(vec3 wp, int layer){
  vec3 uv = (uLightVP[layer] * vec4(wp, 1.)).xyz * 0.5 + 0.5;
  if (any(lessThan(uv, vec3(0.))) || any(greaterThan(uv, vec3(1.)))) return 1.;
  vec2 edge = min(uv.xy, 1. - uv.xy);
  vec2 px = 1.25 / vec2(textureSize(uShadows, 0).xy);
  vec4 q = vec4(uv.xy, float(layer), uv.z - 0.00046);
  float light = 0.25 * (texture(uShadows, q + vec4(px.x, px.y * 0.35, 0., 0.)) +
                         texture(uShadows, q - vec4(px.x, px.y * 0.35, 0., 0.)) +
                         texture(uShadows, q + vec4(-px.x * 0.35, px.y, 0., 0.)) +
                         texture(uShadows, q - vec4(-px.x * 0.35, px.y, 0., 0.)));
  return mix(1., light, smoothstep(0., 0.025, min(edge.x, edge.y)));
}
float directLight(vec3 wp){
  float day = 1., moon = 1.;
  if (uNight < 0.999) day = mix(0.13, 1., shadowAt(wp, 0));
  if (uNight > 0.001) moon = mix(0.32, 1., shadowAt(wp, 1));
  float light = mix(day, moon, uNight);
  if (wp.y >= 120.) return light;
  float cloud = textureLod(uClouds, cloudUV(wp, uSunDir), 2.).r;
  return light * (1. - cloud * (0.62 - 0.33 * uNight) * (1. - smoothstep(70., 120., wp.y)));
}
vec3 pbr(vec3 albedo, float rough, float metal, vec3 N, vec3 V, vec3 wp, float sun, float cover){
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
  vec3 col = (kd * albedo / PI + spec) * uSunCol * NdL * sun;
  vec3 R = reflect(-V, N);
  vec3 skyLight = ambient(N) * mix(vec3(1.), vec3(0.40, 0.53, 0.55), cover);
  vec3 env = mix(skyBase(R), skyLight * 1.4, rough);
  vec3 Fa = F0 + (max(vec3(1. - rough), F0) - F0) * pow(1. - NdV, 5.);
  return col + kd * albedo * (skyLight * 2.4 + floraSpill(wp)) + env * Fa * (1. - rough * 0.6);
}
vec3 pbr(vec3 albedo, float rough, float metal, vec3 N, vec3 V, vec3 wp){
  float sun = dot(N, uSunDir) > 0. ? directLight(wp) : 0.;
  return pbr(albedo, rough, metal, N, V, wp, sun, canopyCover(wp));
}
vec3 fogged(vec3 col, vec3 wp){
  vec4 air = airAt(wp);
  return col * air.a + air.rgb;
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
// The midrib forks outward toward the tip. Fade the finest veins as a leaf becomes subpixel.
float leafVeins(float u, float side, float seed){
  float v = abs(side);
  float rib = 1. - smoothstep(0.018, 0.068 + fwidth(side), v);
  float row = u * (6. + seed * 2.) - v * (0.36 + 0.65 * v);
  row += sign(side) * 0.17 + 0.075 * sin(17. * u + 3. * v + 6. * seed);
  float footprint = max(fwidth(row), 0.012);
  float veins = 1. - smoothstep(0.022, 0.065 + footprint, abs(fract(row + 0.5) - 0.5));
  veins *= (1. - smoothstep(0.12, 0.50, footprint)) * (1. - v * v);
  return max(rib * (1. - smoothstep(0.35, 1.1, fwidth(side))), veins * 0.64) * smoothstep(0.05, 0.23, u);
}
vec3 floraLight(vec3 gc, vec3 wp, vec3 N, vec3 V, float u, float self, float stir){
  // Both sides share diffuse light from the upper surface as the camera passes a leaf.
  if (N.y < 0.) N = -N;
  float ndl = max(dot(N, uSunDir), 0.) * 0.72 + 0.28;
  vec3 sunlight = uSunCol * directLight(wp);
  float cover = canopyCover(wp);
  vec3 skyLight = ambient(N) * mix(vec3(1.), vec3(0.38, 0.54, 0.54), cover);
  vec3 lit = gc * (skyLight * 2.35 + sunlight * ndl * 0.3 + floraSpill(wp));
  lit += sunlight * gc * pow(clamp(dot(-V, uSunDir), 0., 1.), 3.) * u * 0.4;
  // Pigment also supplies the emission hue. Sunlit leaves read by diffuse light alone.
  lit += gc * smoothstep(0.1, 0.94, uNight) * (self + 0.42 * stir) * u * u;
  return lit;
}
// Ripples leave irregular flecks of froth. The same noise breaks up the swash on rocks and open water.
float shoreFroth(vec2 p){
  vec2 drift = vec2(0.16, -0.09) * uTime;
  float crest = vnoise(p * vec2(2.4, 4.) + drift + vnoise(p * 1.1 - drift));
  return smoothstep(0.54, 0.84, crest) * smoothstep(0.23, 0.66, vnoise(p * 1.7 - drift));
}
vec3 waterline(vec3 alb, vec3 wp, float level, out float wet){
  wet = 0.;
  if (wp.y - level > 0.42) return alb;
  if (wp.y - level < -0.46) return alb * vec3(0.62, 0.78, 0.8);
  float wl = wp.y - (level + waterWave(wp.xz, uTime).x + impactWave(wp.xz).x);
  wet = smoothstep(-0.06, 0.0, wl) * (1. - smoothstep(0.0, 0.22, wl));
  alb = mix(alb * (1. - 0.45 * wet), alb * vec3(0.62, 0.78, 0.8), 1. - smoothstep(-0.25, 0., wl));
  float swash = 1. - smoothstep(0.015, 0.085, abs(wl));
  return mix(alb, vec3(0.63, 0.74, 0.78), 0.32 * swash * shoreFroth(wp.xz));
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
`in vec3 vDir; out vec4 o; void main(){ vec3 sky = skyColor(normalize(vDir)); o = vec4(tonemap(sky), starTransmission); }`);

const HIGH_CANOPY = program(WORLD_VS + `
in vec3 aPos, aNor; in float aTissue; in vec4 aSite;
out vec3 vWP, vNormal; out float vTissue, vHue;
void main(){
  float seed = fract(dot(aSite.xz, vec2(0.75488, 0.56984)));
  float a = seed * 6.2832, c = cos(a), s = sin(a);
  mat2 rot = mat2(c, s, -s, c);
  vec3 p = aPos;
  p.xz = rot * p.xz;
  float breeze = windWave(aSite.xz + 3.0 * p.xz) * uWind;
  p.xz += WIND_DIR * 0.012 * breeze * p.y * p.y;
  p.y += 0.055 * breeze * dot(p.xz - rot * vec2(0.13, 0.), WIND_DIR) * step(0., aTissue);
  vWP = aSite.xyz + p * aSite.w;
  vNormal = aNor; vNormal.xz = rot * aNor.xz;
  vHue = seed; vTissue = aTissue;
  gl_Position = project(vWP);
}`, `uniform float uClip;
in vec3 vWP, vNormal; in float vTissue, vHue; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 n = normalize(vNormal);
  vec3 leaf = mix(vec3(0.036, 0.205, 0.124), vec3(0.068, 0.27, 0.245), vHue);
  leaf = mix(leaf, vec3(0.18, 0.085, 0.21), smoothstep(0.68, 0.98, vHue));
  vec3 pigment = leaf * (0.45 + vTissue);
  if (vTissue < 0.) {
    float height = -vTissue - 1.;
    float bands = height * 21. + 0.29 * sin(height * 19. + vHue) + dot(n.xz, vec2(0.14, 0.11));
    float scar = (1. - smoothstep(0.025, 0.12, abs(fract(bands) - 0.5))) * (1. - smoothstep(0.12, 0.48, fwidth(bands)));
    float ribs = dot(n.xz, vec2(17., 29.)) + 1.8 * sin(9. * height + vHue);
    float fibre = 0.05 * cos(ribs) * (1. - smoothstep(0.6, 2.2, fwidth(ribs)));
    vec3 bark = vec3(0.088, 0.064, 0.064) * (1. + 0.34 * scar + fibre);
    pigment = mix(bark, leaf * 0.65, smoothstep(0.78, 0.96, height));
  }
  float incidence = dot(n, uSunDir);
  float backlight = step(0., vTissue) * max(-incidence, 0.);
  vec3 light = ambient(n) * 2.5 + uSunCol * (0.045 + 0.59 * max(incidence, 0.) + 0.20 * backlight) * directLight(vWP);
  o = vec4(tonemap(fogged(pigment * light, vWP)), 0.);
}`);

// Air and overhead shelter change slowly across the terrain mesh. Keep the
// fine shadow comparisons, material normals and field filaments at each pixel.
const TERRAIN = program(WORLD_VS + valleyAir + canopyShelter + `
in vec3 aPos; in vec3 aNor; in vec2 aGround; out vec4 vAir; out float vCover; out vec2 vGround; out vec3 vWP; out vec3 vN;
void main(){
  vCover = canopyCover(aPos); vAir = airAt(aPos);
  vGround = aGround; vWP = aPos; vN = aNor; gl_Position = project(aPos);
}`,
`uniform float uClip; in vec4 vAir; in float vCover; in vec2 vGround; in vec3 vWP; in vec3 vN; out vec4 o;
// The value and both partial derivatives come from the same four corners.
// Alpine rock relief and snow deposition can then follow the same folds.
vec3 rockFold(vec2 p){
  vec2 cell = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  float a = hash12(cell), b = hash12(cell + vec2(1., 0.));
  float c = hash12(cell + vec2(0., 1.)), d = hash12(cell + 1.);
  float crossTerm = a - b - c + d;
  return vec3(a + dot(vec2(b-a, c-a), u) + crossTerm * u.x * u.y,
              6. * f * (1. - f) * (vec2(b-a, c-a) + crossTerm * u.yx));
}
void main(){
  if (vWP.y < uClip) discard;
  vec2 p = vWP.xz; vec2 uv = fieldUV(p); float inf = inField(uv);
  vec2 gr = vec2(0.); float glow = 0.;
  if (inf > 0.) {
    gr = vec2(texture(uGround, uv).r, texture(uWear, uv).r);
    glow = texture(uGlow, uv).r;
  }
  float moist = min(1., gr.r + uSheet * inf), wear = gr.g;
  // the strip the lake keeps wet, breathing with the lapping
  float lap = 0.05 * sin(uTime * 0.9 + dot(vWP.xz, vec2(0.7, 0.4)) * 0.8) + 0.035 * sin(uTime * 1.7 + vWP.x * 1.3);
  float bank = vWP.y - vGround.y;
  float wetBand = (1. - smoothstep(0.04, 0.25 + lap, bank)) * smoothstep(-0.16, -0.035, bank);
  moist = max(moist, wetBand * 0.85);
  float dist = length(vWP - uCam);
  vec3 N = normalize(vN);
  float dn = 1. - smoothstep(8., 45., dist);
  if (dn > 0.) {
    float e = 0.06, s = 2.6; float h0 = fbm3(p * s), hx = fbm3((p + vec2(e, 0.)) * s), hz = fbm3((p + vec2(0., e)) * s);
    N = normalize(N + dn * (1. - 0.7 * wear) * (1. - 0.6 * moist) * vec3(-(hx - h0), 0., -(hz - h0)) / e * 0.22);
  }
  // Split the distant cliffs along two intersecting families of joints. Stretched
  // folds produce long rock ribs with snow chutes between them, even on the phone mesh.
  float far = smoothstep(55., 130., dist), slopeG = 1. - normalize(vN).y;
  float crag = 0.5, seam = 0.5, chute = 0.5;
  // Include elevation in both projections so steep faces keep their texture.
  const vec3 strike = vec3(0.092, 0.014, -0.071), dip = vec3(0.018, 0.064, 0.025);
  const vec3 crossJoint = vec3(0.084, -0.029, 0.174), slip = vec3(-0.016, 0.093, 0.034);
  const vec3 cleft = vec3(0.47, 0.035, -0.31), plunge = vec3(0.055, 0.13, 0.05);
  vec2 narrow = vec2(dot(vWP, crossJoint), dot(vWP, slip));
  float foldFilter = 1. - smoothstep(0.16, 0.64, max(fwidth(narrow.x), fwidth(narrow.y)));
  vec2 fissure = vec2(dot(vWP, cleft), dot(vWP, plunge));
  float chuteFilter = 1. - smoothstep(0.25, 0.85, max(fwidth(fissure.x), fwidth(fissure.y)));
  if (far > 0.) {
    vec3 broad = rockFold(vec2(dot(vWP, strike), dot(vWP, dip)));
    vec3 joint = rockFold(narrow + vec2(1.2 * broad.x, 5.7));
    crag = broad.x;
    seam = mix(0.5, joint.x, foldFilter);
    vec3 broadSlope = broad.y * strike + broad.z * dip;
    vec3 jointSlope = joint.y * (crossJoint + 1.2 * broadSlope) + joint.z * slip;
    vec3 grad = 6.2 * broadSlope + 3.1 * foldFilter * jointSlope;
    vec3 flute = rockFold(fissure + vec2(1.7 * seam, crag));
    chute = mix(0.5, flute.x, chuteFilter);
    grad += 0.95 * chuteFilter * (flute.y * (cleft + 1.7 * foldFilter * jointSlope) + flute.z * (plunge + broadSlope));
    N = normalize(N - far * (grad - N * dot(N, grad)));
  }
  float slope = 1. - N.y, y = vWP.y;
  // fine noise only where it can be seen; past that it just shimmers into grain
  float fine = 1. - smoothstep(30., 90., dist);
  float n1 = mix(crag, seam, 0.35);
  if (far < 1.) n1 = mix(fbm3(p * 0.3), n1, far);
  float n2 = 0.5, n3 = 0.45;
  if (fine > 0.) { n2 = mix(n2, vnoise(p * 2.7), fine); n3 = mix(n3, vnoise(p * 9.), fine * fine); }
  float hummocks = smoothstep(0.24, 0.68, n1 + (n2 - 0.5) * 0.36);
  vec3 moss = mix(vec3(0.034, 0.047, 0.041), vec3(0.088, 0.18, 0.092), hummocks) * (0.74 + 0.55 * n3);
  vec3 sand = mix(vec3(0.16, 0.12, 0.083), vec3(0.41, 0.34, 0.22), n1) * (0.75 + 0.42 * n2);
  vec3 bed = mix(vec3(0.060, 0.096, 0.082), vec3(0.24, 0.23, 0.16), n2) * (0.74 + 0.48 * n3);
  vec3 rock = mix(vec3(0.095, 0.103, 0.117), vec3(0.33, 0.28, 0.25), n2 * 0.65 + n1 * 0.35);
  vec3 alb = moss; float rough = 0.88, metal = 0.;
  float shore = 1. - smoothstep(0.12, 0.52 + 0.35 * n1, bank);
  alb = mix(alb, sand, shore); rough = mix(rough, 0.72, shore);
  float under = 1. - smoothstep(-0.35, -0.05, bank);
  alb = mix(alb, bed, under);
  float rk = max(smoothstep(0.23, 0.53, mix(slopeG, slope, 0.22) + 0.13 * n2), smoothstep(6., 12., y) * 0.8);
  alb = mix(alb, rock, rk); rough = mix(rough, 0.62, rk);
  // Discontinuous beds and runoff flutes break up the exposed valley cliffs at the scale
  // visible across the lake. The height coordinate keeps detail on near-vertical faces.
  float cliff = smoothstep(0.10, 0.46, slopeG) * smoothstep(3., 11., y) * (1. - smoothstep(34., 55., y)) * (1. - vGround.x);
  if (cliff > 0.001) {
    float lateral = dot(p, vec2(0.78, 0.62));
    float bedHeight = y + dot(p, vec2(0.15, -0.09)) + 1.65 * n1;
    float lithology = fbm3(vec2(lateral * 0.16, bedHeight * 0.72));
    float flutes = vnoise(p * vec2(0.34, 0.23) + vec2(bedHeight * 0.10, n1));
    float ledge = smoothstep(0.31, 0.69, lithology + (n1 - 0.5) * 0.33);
    float runnel = smoothstep(0.44, 0.80, flutes) * (1. - 0.66 * ledge);
    vec3 face = mix(vec3(0.078, 0.092, 0.103), vec3(0.38, 0.29, 0.20), ledge);
    face = mix(face, vec3(0.050, 0.074, 0.065), runnel * 0.80);
    alb = mix(alb, face * (0.78 + 0.38 * n1), cliff);
    N = normalize(N + cliff * (vec3(0., 1., 0.) - N * N.y) * (0.68 * ledge - 0.26 - runnel * 0.20));
  }
  if (vGround.x > 0.001) {
    vec3 tread = mix(vec3(0.32, 0.20, 0.16), vec3(0.20, 0.15, 0.095), smoothstep(-4., 8., p.y));
    vec3 mineral = mix(vec3(0.25, 0.32, 0.32), vec3(0.39, 0.25, 0.14), smoothstep(-4., 8., p.y));
    tread = mix(tread, mineral, smoothstep(9., 20., p.x));
    alb = mix(alb, tread * (0.68 + 0.42 * n2 + 0.12 * n3), vGround.x * 0.90);
  }
  float vein = rk * smoothstep(0.74, 0.8, n3) * (1. - smoothstep(12., 28., dist));
  // Pale seams are silica in the bedrock, so they keep a broad dielectric highlight.
  rough = mix(rough, 0.48, vein);
  alb = mix(alb, vec3(0.33, 0.30, 0.29), vein * 0.44);
  // forest under the snow line on the far slopes, rock laid down in strata, and snow that settles on ledges and in
  // gullies while steep faces and the sharpest crests stay bare
  float treeline = far * smoothstep(9., 15., y) * (1. - smoothstep(24., 36., y + n1 * 8.)) * (1. - smoothstep(0.45, 0.7, slope));
  alb = mix(alb, vec3(0.045, 0.075, 0.085) * (0.75 + 0.5 * vnoise(p * 0.7)), treeline * 0.7);
  // Broad, tilted beds cut across the relief. Narrow benches weather to a lighter colour.
  float bedding = y * 0.45 + dot(p, vec2(0.048, -0.033)) + 3.4 * n1;
  float bench = smoothstep(0.55, 0.95, sin(bedding + 0.65 * sin(bedding * 0.37)));
  alb = mix(alb, mix(alb * vec3(0.74, 0.78, 0.90), alb * vec3(1.24, 1.14, 0.96), bench), rk * far);
  float alpine = smoothstep(31., 52., y + (0.5 - crag) * 13.);
  // Wind scours rock ribs bare. The lee and the shallow gullies hold snow
  // much farther downslope. Resolved flakes would crawl at this distance.
  float shelter = 0.42 * (0.5 - crag) + 0.30 * (0.5 - seam) + 0.28 * (0.5 - chute) - 0.065 * dot(vN.xz, vec2(0.8, 0.6));
  float mantle = mix(1. - slopeG, N.y, 0.5) - 0.56 + shelter;
  float snow = alpine * smoothstep(-0.024, 0.034 + min(0.07, fwidth(mantle)), mantle);
  vec3 schist = mix(vec3(0.052, 0.069, 0.095), vec3(0.37, 0.33, 0.30), 0.12 * bench + 0.30 * crag + 0.58 * chute);
  alb = mix(alb, schist, alpine);
  vec3 frost = mix(vec3(0.50, 0.64, 0.78), vec3(0.86, 0.86, 0.92), smoothstep(-0.01, 0.22, mantle));
  alb = mix(alb, frost, snow); rough = mix(rough, 0.60, snow);
  // cobbles on the beach and under the shallows, pebbles between them; wet ones go dark and glossy
  float cobZ = (1. - smoothstep(0.30, 0.83, bank)) * smoothstep(-1.6, -0.9, bank) * (1. - smoothstep(14., 32., dist)) * (1. - 0.6 * rk);
  // Only exposed faces need surface light. Caustics also tint indirect light
  // in the shallows, so they share the same visibility sample here.
  float sun = 0.;
  if (dot(N, uSunDir) > 0. || (cobZ > 0.01 && under > 0. && uNight < 1.)) sun = directLight(vWP);
  if (cobZ > 0.01) {
    vec2 gravel = mat2(0.91, 0.41, -0.41, 0.91) * p * vec2(2.9, 3.8);
    vec3 cb = cobble(gravel), pb = cobble(p * vec2(7.2, 9.3) + 3.7);
    float stone = (1. - smoothstep(0.20, 0.33, cb.x)) * smoothstep(0.02, 0.17, cb.y);
    float peb = (1. - smoothstep(0.15, 0.31, pb.x)) * smoothstep(0.02, 0.13, pb.y);
    vec3 sc = mix(mix(vec3(0.09, 0.105, 0.11), vec3(0.38, 0.34, 0.28), cb.z), vec3(0.10, 0.18, 0.16), step(0.76, cb.z));
    sc *= 0.75 + 0.4 * (1. - cb.x * 1.3);
    vec3 pc2 = mix(vec3(0.14, 0.12, 0.17), vec3(0.28, 0.25, 0.3), pb.z) * mix(0.55, 1., peb);
    vec3 cobA = mix(mix(alb, pc2, peb), sc, stone * smoothstep(0.35, 0.6, vnoise(p * 0.7) + 0.3));
    float wcob = cobZ * (0.6 + 0.4 * vnoise(p * 0.45));
    alb = mix(alb, cobA, wcob); rough = mix(rough, 0.55, wcob);
    // Soft moving caustic patches break across the sand and gravel in sunlit shallows.
    float drift = dot(p, vec2(1.6, 1.0)) + uTime * 0.70 + 4.0 * n1;
    float focus = 0.5 + 0.5 * sin(drift * 2.6 + sin(p.y * 1.7 - uTime * 0.43) * 2.8);
    alb *= 1. + 0.48 * under * (1. - uNight) * sun * wcob * focus * focus * n2;
  }
  alb = mix(alb, vec3(0.21, 0.15, 0.19), smoothstep(0.03, 0.6, wear) * 0.75); rough = mix(rough, 0.75, wear);
  // Keep wet sand granular; only a film of standing water gives a tight sky highlight.
  alb *= 1. - 0.44 * moist;
  rough = mix(rough, 0.30, smoothstep(0.04, 0.65, moist) * 0.87);
  vec3 V = normalize(uCam - vWP);
  vec3 col = pbr(alb, rough, metal, N, V, vWP, sun, vCover);
  // the last of the low sun catching the snowy peaks
  col += vec3(1., 0.52, 0.58) * 0.14 * snow * smoothstep(40., 110., y) * max(dot(N, uSunDir), 0.) * (1. - uNight);
  col += moss * uNight * 0.16 * (1. - rk) * (1. - shore);
  float wake = glowI(glow) * uNight;
  float pixelSize = max(length(dFdx(p)), length(dFdy(p)));
  if (wake > 0.0001 && bank > -0.12) {
    // Filaments live in the substrate. The stored field reveals their fixed
    // branches where a foot or glowstone disturbed them; wear breaks the mat.
    vec2 hypha = mat2(0.87, -0.5, 0.5, 0.87) * p;
    float axis = hypha.y * 7.4 + 1.3 * sin(3.5 * hypha.x) + 2.6 * n1;
    float side = sin(axis), across = abs(side), aa = min(0.28, 8. * pixelSize);
    float feeder = hypha.x * 13.5 + 2.4 * across + 0.43 * side + 1.3 * n2;
    float gap = abs(sin(feeder));
    float stems = 1. - smoothstep(0.026, 0.095 + aa, across);
    float forks = (1. - smoothstep(0.022, 0.11 + aa, gap)) * (1. - smoothstep(0.33, 0.91, across));
    float twigs = abs(sin(feeder * 2.0 - 2.8 * gap + 3.1 * across));
    twigs = (1. - smoothstep(0.02, 0.10 + aa, twigs)) * (1. - smoothstep(0.04, 0.54, gap)) * (1. - smoothstep(0.42, 0.84, across));
    float filament = max(stems, max(0.70 * forks, 0.43 * twigs)) * (1. - smoothstep(0.025, 0.095, pixelSize));
    vec3 sap = mix(vec3(0.045, 0.53, 0.34), vec3(0.43, 0.12, 0.65), smoothstep(0.30, 0.63, n1));
    col += sap * wake * (0.045 + filament * (0.78 + 0.85 * n2)) * (1. - 0.68 * rk) * (1. - 0.42 * wear);
  }
  o = vec4(tonemap(col * vAir.a + vAir.rgb), 0.);
}`);

const ROCK = program(WORLD_VS + `
in vec3 aPos; in vec3 aNor; in vec4 aI; in vec4 aS; in float aLevel;
flat out float vLevel;
out vec3 vWP; out vec3 vN; out float vH; out vec3 vLoc; out vec3 vNl;
void main(){
  float c = cos(aI.w), s = sin(aI.w);
  vec3 p = aPos * aS.xyz; p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
  vec3 n = aNor / aS.xyz; n = normalize(vec3(c * n.x - s * n.z, n.y, s * n.x + c * n.z));
  vWP = p + aI.xyz; vLevel = aLevel; vN = n; vH = aS.w; vLoc = aPos * aS.xyz; vNl = aNor; gl_Position = project(vWP);
}`,
`uniform float uClip; flat in float vLevel; in vec3 vWP; in vec3 vN; in float vH; in vec3 vLoc; in vec3 vNl; out vec4 o;
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
    vec3 alb = mix(vec3(0.077, 0.09, 0.11), vec3(0.29, 0.27, 0.24), n1);
    alb = mix(alb, vec3(0.31, 0.28, 0.27), smoothstep(0.55, 0.8, n2) * 0.5);
    float grain = sin(dot(vLoc, vec3(1.9, 8.5, -1.1)) + n1 * 5.3 + n2 * 1.8);
    alb *= (0.84 + 0.28 * speck) * (0.86 + 0.14 * grain);
    alb += vec3(0.073, 0.061, 0.048) * smoothstep(0.78, 0.98, grain) * n2 * near;
    alb *= mix(0.72, 1.12, smoothstep(-0.4, 0.8, N.y));      // weathered tops pale, overhangs shadowed
    alb *= 1. - 0.62 * crack;
    float lich = smoothstep(0.7, 0.76, vnoise(lp.xz * 7. + lp.y * 5.)) * smoothstep(0.35, 0.6, vnoise(lp.zx * 1.1)) * (1. - crack);
    vec3 lichC = mix(vec3(0.38, 0.32, 0.16), vec3(0.16, 0.36, 0.34), step(0.5, fract(vH * 7.3)));
    alb = mix(alb, lichC * (0.7 + 0.3 * speck), lich * 0.5);
    float humus = vnoise(vWP.xz * 1.4 + vH * 5.);
    float moss = smoothstep(0.28, 0.72, N.y + 0.38 * (humus - 0.5)) * smoothstep(0.29, 0.63, humus + 0.15 * speck);
    vec3 mossTint = mix(vec3(0.027, 0.08, 0.052), vec3(0.12, 0.215, 0.103), n2);
    alb = mix(alb, mossTint * (0.68 + 0.6 * speck), moss);
    float shoreWet;
    alb = waterline(alb, vWP, vLevel, shoreWet);
    float wet = clamp(max(shoreWet, (texture(uGround, uv).r + uSheet) * inf), 0., 1.);
    alb *= (1. - 0.3 * wet) * mix(0.5, 1., smoothstep(-0.3, 0.4, vLoc.y));
    col = pbr(alb, mix(0.8 - 0.15 * lich, 0.14, wet * 0.9), 0., N, V, vWP);
    col += mossTint * moss * uNight * (0.28 + glowI(glow));
    col += lichC * lich * (0.075 * uNight) * (0.6 + 0.4 * sin(uTime * 0.8 + vH * 30.));
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
  vec3 col = pbr(waterline(body, vWP, 0., shoreWet), 0.08, 0., N, V, vWP);
  float inner = (0.025 + 0.22 * uNight * (0.45 + 0.7 * smoothstep(-0.7, 0.85, windWave(vWP.xz)))) * (smoothstep(0.3, 1., u) * 1.4 + 0.15) * (0.8 + 0.2 * bands);
  // and the star shining through it from behind
  float through = pow(clamp(dot(-V, uSunDir), 0., 1.), 2.) * (0.4 + 0.6 * u) * (1. - 0.7 * uNight);
  col += deep * (inner + (0.012 + 0.22 * fres) * (1. + uNight) + uSunCol * through * 0.14) + deep * glow * 2. * uNight * uNight * (0.4 + 0.6 * u);
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
  vec2 around = vec2(cos(vW.z), sin(vW.z));
  vec2 fiber = around * 8. + vW.w + vec2(0.6, -0.3) * vW.y;
  float grain = 2. * fbm3(fiber + 0.7 * vnoise(around * 3. + vW.y * 0.65)) - 0.85;
  float fine = vnoise(around * 27. + vec2(vW.y * 2., vW.w));
  float dead = smoothstep(0.48, 0.78, fbm3(around * 2. + vec2(vW.y * 0.7, vW.w * 5.)));
  vec3 bark = mix(vec3(0.07, 0.045, 0.06), vec3(0.15, 0.10, 0.12), smoothstep(-0.3, 0.7, grain)) * (0.8 + 0.4 * fine);
  bark = mix(bark, vec3(0.29, 0.24, 0.28) * (0.8 + 0.3 * fine), dead);
  N = normalize(N + vec3(0., 0.15 * grain, 0.) * (1. - dead));
  vec3 col = pbr(bark, mix(0.75, 0.5, dead), 0., N, V, vWP);
  vec3 tint = pigment(vHue * 0.55);
  float groove = smoothstep(0.23, 0.48, -grain) * (1. - dead);
  col += tint * groove * (uNight * (0.045 + 0.08 * glowI(vStir))) * (0.6 + 0.4 * sin(uTime * 0.7 + vW.y * 4. - vW.w * 9.));
  o = vec4(tonemap(fogged(col, vWP)), 0.);
}`);

// Interpolate at a covered sample on thin foliage. A pixel center can fall far outside a subpixel triangle.
const BRUSH_VS = `
uniform sampler2D uBendTex;
uniform vec3 uBrush; // player xz, enabled
vec3 brushBend(vec3 wp) {
  vec2 d = abs(wp.xz - uBrush.xy);
  if (uBrush.z == 0. || max(d.x, d.y) >= 3.75) return vec3(0.);
  vec4 cell = textureLod(uBendTex, wp.xz / 8., 0.);
  float aboveFeet = wp.y - (48. * cell.b / max(cell.a, 0.001) - 8.);
  float reach = smoothstep(-0.55, -0.12, aboveFeet) * (1. - smoothstep(1.35, 1.88, aboveFeet));
  vec2 bend = (cell.rg * 255. - 128.) / 127.;
  float press = max(0., (cell.a * 255. - 64.) / 191.);
  return vec3(bend.x, -max(0.42 * length(bend), 0.68 * press), bend.y) * reach;
}
`;
const JLEAF = program(WORLD_VS + BRUSH_VS + `
in vec4 aR; in vec4 aD; in vec4 aM; in vec4 aB;
centroid out vec3 vWP; centroid out float vU; centroid out vec3 vN; centroid out float vStir; centroid out float vHue; centroid out float vSeed; centroid out float vSide;
void main(){
  int vid = gl_VertexID;
  float u = vid >= 12 ? 1. : float(vid / 2) / 6.;
  float side = vid >= 12 ? 0. : ((vid % 2 == 0) ? -1. : 1.);
  vec3 up = vec3(0., 1., 0.), dir = normalize(aD.xyz);
  float L = aD.w, lift = aM.x, droop = aM.y, W = aM.z * uLodW, seed = aM.w;
  vec3 sd = cross(up, dir); sd = length(sd) < 1e-3 ? vec3(1., 0., 0.) : normalize(sd);
  vec3 p = aR.xyz + dir * L * u + up * L * (lift * sin(u * 3.1416) - droop * u * u);
  vec3 bend = brushBend(aR.xyz + L * (dir * 0.67 + up * (0.86 * lift - 0.45 * droop)));
  p += bend * (0.78 * L * u * u);
  float g = windWave(aB.xy) * uWind, flex = aR.w + 0.2 * u;
  p.xz += WIND_DIR * g * 0.05 * aB.z * flex * flex;
  p += sd * sin(uTime * 2.6 + seed * 40. + u * 3.) * 0.03 * u * L;
  float w = W * (0.08 + 0.92 * sin(3.1416 * pow(u, 0.85)));
  vec3 wd = normalize(sd + up * 0.4 * (seed - 0.5));
  p += wd * side * w * 0.5;
  vec3 tang = normalize(dir + up * (lift * 3.1416 * cos(u * 3.1416) - 2. * droop * u) + bend * (1.56 * u));
  vN = normalize(normalize(cross(wd, tang)) + wd * side * 0.8);
  vStir = texture(uGlow, fieldUV(aB.xy)).r;
  vWP = p; vU = u; vHue = aB.w; vSeed = seed; vSide = side;
  gl_Position = project(p);
}`,
`uniform float uClip; centroid in vec3 vWP; centroid in float vU; centroid in vec3 vN; centroid in float vStir; centroid in float vHue; centroid in float vSeed; centroid in float vSide; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 tint = pigment(vHue * 0.55);
  tint *= mix(vec3(1.), tint, 0.45);
  float u = clamp(vU, 0., 1.);
  vec3 gc = floraRamp(tint, pow(u, 1.15)) * (0.56 + 0.4 * clamp(vSeed, 0., 1.));
  float veins = leafVeins(u, clamp(vSide, -1., 1.), vSeed);
  gc *= 0.89 + 0.16 * veins;
  float pulse = 0.09 + 0.02 * sin(uTime * 0.6 + vHue * 9.);
  vec3 lit = floraLight(gc, vWP, normalize(vN), normalize(uCam - vWP), u, pulse, glowI(vStir));
  lit += tint * uNight * veins * (0.035 + smoothstep(0.41, 0.88, vSeed) * 0.16);
  o = vec4(tonemap(fogged(lit, vWP)), 0.);
}`);

// grass: Corey's blade (ceeboozwah/grass), ported. Three rows plus a tip, quadratic bend, width taper,
// rounded normals, rolling gust waves, a root-mid-tip ramp with patch noise and root AO, sun backlight through
// the tips. Wired to the certified fields: wear tramples it flat, moisture droops and darkens it, glow lights
// the tips you stirred. Instances are shuffled, so drawing a prefix is an even thinning (adaptive density).
const GRASS = program(WORLD_VS + BRUSH_VS + `
in vec4 aG; in vec4 aR;
centroid out vec3 vWP; centroid out vec3 vGA; centroid out float vGH; centroid out float vGlow; centroid out float vWet; centroid out vec3 vN; centroid out float vPatch;
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
  // A blade twists along its length. The taper and wind bend share the same rooted strip.
  float twist = (aG.w - 0.5) * by * (1. - 0.7 * reed);
  vec2 across = ax + twist * fd;
  vec3 p = vec3(aG.x, aG.z, aG.y)
         + vec3(across.x, 0., across.y) * side * wd
         + vec3(0., by * H * (1. - 0.18 * by * by) * (1. - 0.7 * trample), 0.)
         + by * by * (vec3(fd.x + twist * ax.x, 0., fd.y + twist * ax.y) * lean + vec3(WIND_DIR.x, 0., WIND_DIR.y) * sway);
  vec3 bend = brushBend(vec3(aG.x, aG.z + H * 0.5, aG.y));
  p += bend * (0.88 * H * by * by);
  vN = normalize(vec3(0., 1., 0.) + vec3(across.x, 0., across.y) * side * 0.9 + vec3(fd.x, 0., fd.y) * (0.15 + 0.35 * by) + bend * (0.62 * by));
  vGA = vec3(by, aR.z, 2. * side); vGH = H; vWP = p; vGlow = glow; vWet = wet; vPatch = aR.y;
  gl_Position = project(p);
}`,
`uniform float uClip; centroid in vec3 vWP; centroid in vec3 vGA; centroid in float vGH; centroid in float vGlow; centroid in float vWet; centroid in vec3 vN; centroid in float vPatch; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  float y = clamp(vGA.x, 0., 1.);
  float g = pow(y, 1.45);
  g *= mix(0.72, 1., smoothstep(0.03, 0.3, vGH));
  g = mix(0.45, g, 0.85);
  // The meadow grows in broad jade swaths with scattered plum heath.
  float heath = vnoise(vWP.xz * 0.03 + 3.) * 0.8 + vnoise(vWP.xz * 0.09 - 5.) * 0.2;
  float meadowVariation = vnoise(vWP.xz * 0.052 + 12.);
  vec3 jade = mix(vec3(0.042, 0.32, 0.13), vec3(0.10, 0.54, 0.37), meadowVariation);
  vec3 plum = mix(vec3(0.21, 0.13, 0.34), vec3(0.43, 0.22, 0.51), meadowVariation);
  vec3 tip = mix(jade, plum, smoothstep(0.49, 0.68, heath + (vPatch - 0.5) * 0.06));
  vec3 gc = floraRamp(tip, g);
  float pn = vnoise(vWP.xz * 0.28) * 0.6 + vnoise(vWP.xz * 1.1) * 0.4;
  gc *= mix(0.8, 1.2, pn);
  gc = mix(gc, tip, smoothstep(0.55, 0.95, pn) * 0.2 * y);
  gc *= (0.88 + 0.24 * vGA.y) * mix(0.42, 1., smoothstep(0., 0.55, y)) * (1. - 0.35 * vWet);
  // The central fold stays visible up close and blends out across subpixel blades.
  float footprint = max(fwidth(vGA.z), 0.012);
  float rib = (1. - smoothstep(0.035, 0.12 + footprint, abs(vGA.z))) * (1. - smoothstep(0.17, 0.72, footprint));
  gc *= 1. + 0.24 * rib * smoothstep(0.1, 0.45, y) * (1. - smoothstep(0.75, 1., y));
  vec3 lit = floraLight(gc, vWP, normalize(vN), normalize(uCam - vWP), y, 0.12, glowI(vGlow));
  o = vec4(tonemap(fogged(lit, vWP)), 0.);
}`);

// understory: one parametric strip shared by the meadow species. Rosettes (broad crimson leaves with a living midrib), ferns (fronds cut into
// leaflets in the fragment shader), glow tubes (capsules whose tips are lamps), coilferns (stalks that roll their tips
// into spirals) and lantern bells (arching stems that nod a glowing bulb). Each blade follows a centreline in its own
// plane; veins brighten at night and when you stir the ground beside them.
const PLANT = program(WORLD_VS + BRUSH_VS + `
in vec4 aP; in vec4 aF; in vec4 aS2;
centroid out vec3 vWP; centroid out float vU; centroid out float vSide; centroid out vec3 vN; centroid out float vType; centroid out float vStir; centroid out float vSeed; centroid out float vHue;
// the centreline at u in [0, 1]: x out along the ground, y up
vec2 path(float type, float u, float L, vec4 S){
  if (type < 2.5) return vec2(L * S.x * sin(u * 1.5708), L * (S.y * u + S.z * sin(u * 3.1416) - S.w * u * u));
  if (type < 3.5) {
    float c = 0.62;
    if (u < c) return vec2(L * S.x * u, L * S.y * u);
    float k = (u - c) / (1. - c), a = k * 5.2, rad = L * 0.15 * (1. - 0.72 * k);
    return vec2(L * S.x * c + L * 0.15, L * S.y * c) + rad * vec2(-cos(a), sin(a));
  }
  if (type < 4.5) return vec2(L * S.x * (1. - cos(u * 1.7)) * 1.25, L * S.y * sin(u * 2.5));
  // Radial lobes meet at a narrow throat, then flare into the scalloped rim of a waxy cup.
  float flare = smoothstep(0.31, 0.94, u);
  return L * vec2(S.x * (0.025 + 0.98 * flare), S.y * (u * 1.31 - 0.36 * flare) + S.z * sin(u * 3.1416));
}
void main(){
  int vid = gl_VertexID;
  float u = vid >= 24 ? 1. : float(vid / 2) / 12.;
  float side = vid >= 24 ? 0. : ((vid % 2 == 0) ? -1. : 1.);
  float sc = aP.w, phi = aF.x, L = aF.y * sc, W = aF.z * sc * uLodW, type = aF.w;
  float seed = fract(phi * 7.31 + aP.x * 0.13);
  vec3 up = vec3(0., 1., 0.), dir = vec3(cos(phi), 0., sin(phi)), sd = vec3(-sin(phi), 0., cos(phi));
  if (type > 5.5) {
    // One complete pleated fan per instance. Its short stem and ten membrane
    // panels share the same strip and stay together at every distance.
    float angle = clamp(floor(float(vid - 3) * 0.5) / 10., 0., 1.) * 2. - 1.;
    float outer = vid >= 3 && vid % 2 == 0 ? 1. : 0.;
    float arc = angle * aS2.x, radius = L * (0.78 + 0.028 * cos(15. * angle + 4. * seed) - 0.065 * exp(-34. * angle * angle)) * outer;
    float pleat = cos(15. * angle + 1.2 * seed);
    vec3 p = up * (L * 0.32) + sd * sin(arc) * radius
           + up * cos(arc) * radius * aS2.y + dir * radius * (aS2.z + 0.09 * pleat);
    if (vid < 3) p = sd * (float(vid % 2) - 0.5) * W + up * L * (vid == 2 ? 0.32 : 0.);
    else if (outer == 0.) p += sd * angle * W * 0.49;
    p.xz += WIND_DIR * windWave(aP.xz) * uWind * 0.10 * p.y * p.y;
    vec3 bend = brushBend(aP.xyz + up * (0.56 * L));
    p += bend * (0.47 / L * p.y * p.y);
    vN = normalize(dir + sd * (0.37 * sin(15. * angle + 1.2 * seed)) + up * (aS2.z - dot(bend.xz, dir.xz) * outer * 0.6));
    vWP = p + aP.xyz; vU = vid < 3 ? 0. : mix(0.16, 1., outer);
    vSide = outer * sin(arc); vType = type; vSeed = seed; vHue = aS2.w;
    vStir = texture(uGlow, fieldUV(aP.xz)).r;
    gl_Position = project(vWP); return;
  }
  vec2 c = path(type, u, L, aS2), t2 = normalize(path(type, min(u + 0.01, 1.), L, aS2) - path(type, max(u - 0.01, 0.), L, aS2));
  vec3 p = dir * c.x + up * c.y;
  float flex = type > 1.5 && type < 2.5 ? 0.3 : 1.;
  vec3 bend = brushBend(aP.xyz + L * (up * 0.40 + dir * (type < 1.5 ? 0.48 : 0.))) * flex;
  p += bend * (0.62 * L * u * u);
  float flutter = type > 4.5 ? 0.12 : 1.;
  p.xz += WIND_DIR * windWave(aP.xz + dir.xz * c.x * flutter) * uWind * 0.18 * u * u * L * flex;
  p += sd * sin(uTime * 2.3 + seed * 30. + u * 3.) * 0.02 * u * L * flex * flutter;
  float w;
  if (type < 0.5) w = W * sin(min(1., u * 2.4) * 1.5708) * (1. - 0.6 * u * u);
  else if (type < 1.5) w = W * (1. - 0.72 * u) * sin(min(1., u * 4.) * 1.5708);
  else if (type < 2.5) w = W * (u < 0.85 ? 1. : sqrt(max(0., 1. - pow((u - 0.85) / 0.15, 2.))));
  else if (type < 3.5) w = W * (1. - 0.55 * u);
  else if (type < 4.5) w = W * (0.28 + 1.2 * sin(clamp((u - 0.72) / 0.28, 0., 1.) * 3.1416));
  else {
    w = W * (0.05 + smoothstep(0.30, 0.77, u)) * (1. - 0.84 * smoothstep(0.79, 1., u));
    // Each lobe curls back at the lip; the joined bases form the fluted throat.
    p += dir * L * (0.055 * sin(3.1416 * u) + 0.07 * smoothstep(0.83, 1., u));
    p.y -= L * (0.10 + 0.025 * sin(phi * 3.)) * smoothstep(0.8, 1., u);
  }
  float tw = (seed - 0.5) * 1.6 * u * step(type, 1.5);
  vec3 wdir = normalize(sd * cos(tw) + up * sin(tw));
  p += wdir * side * w * 0.5;
  vec3 tang = normalize(dir * t2.x + up * t2.y + 1.24 * bend * u);
  vN = normalize(normalize(cross(wdir, tang)) + wdir * side * (type > 1.5 ? 1.6 : 0.7));
  vStir = texture(uGlow, fieldUV(aP.xz)).r;
  vWP = p + aP.xyz; vU = u; vSide = side; vType = type; vSeed = seed; vHue = type > 4.5 ? aS2.w : fract(aP.x * 0.21 + aP.z * 0.17);
  gl_Position = project(vWP);
}`,
`uniform float uClip; centroid in vec3 vWP; centroid in float vU; centroid in float vSide; centroid in vec3 vN; centroid in float vType; centroid in float vStir; centroid in float vSeed; centroid in float vHue; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  float u = clamp(vU, 0., 1.), s = clamp(vSide, -1., 1.);
  if (vType > 0.5 && vType < 1.5 && abs(s) > 0.16 + 0.84 * smoothstep(0.1, 0.65, abs(sin(u * 3.1416 * 15.)))) discard;
  // each species is a pigment and a vein; the ramp and the light are everyone's
  vec3 tip;
  if (vType < 0.5) tip = mix(CRIMSON, MAGENTA, vHue * 0.6);
  else if (vType < 1.5) tip = TEAL * 0.68;
  else if (vType < 2.5) tip = CYAN;
  else if (vType < 3.5) tip = mix(VIOLET, CYAN, vHue * 0.4);
  else if (vType < 4.5) tip = mix(MAGENTA, VIOLET, vHue * 0.5);
  else if (vType > 5.5) tip = mix(vec3(0.13, 0.69, 0.51), vec3(0.88, 0.32, 0.15), smoothstep(0.37, 0.70, vHue));
  else tip = mix(vec3(0.085, 0.72, 0.62), vec3(0.94, 0.22, 0.34), smoothstep(0.40, 0.57, vHue));
  vec3 gc = floraRamp(tip, pow(u, 1.1));
  float veins = leafVeins(u, s, vSeed);
  float tissue = veins * 0.52;
  if (vType > 1.5 && vType < 2.5) tissue = 0.65 * smoothstep(0.70, 0.97, u);
  if (vType > 2.5 && vType < 3.5) tissue = smoothstep(0.44, 0.78, u) * (1. - smoothstep(0.20, 0.67, abs(s)));
  if (vType > 3.5 && vType < 4.5) {
    float lobe = smoothstep(0.70, 0.88, u);
    float ribs = 0.5 + 0.5 * cos(9. * s + 1.7 * sin(u * 12. + vSeed));
    tissue = lobe * (0.17 + 0.34 * (1. - s * s) + 0.21 * ribs + 0.21 * veins);
    gc *= 1. - lobe * (0.15 + 0.23 * (1. - ribs));
  }
  if (vType > 5.5) {
    // Veins split halfway up the fan and carry its own jade or amber pigment.
    float web = smoothstep(0.15, 0.45, u), radial = clamp((u - 0.16) / 0.84, 0., 1.);
    float fanAngle = asin(clamp(s / max(radial, 0.03), -0.96, 0.96));
    float strand = fanAngle * (4.25 + 0.7 * vSeed) + 0.07 * sin(6. * u + 2. * fanAngle);
    float split = abs(fract(strand + 0.5) - 0.5), width = max(fwidth(strand), 0.008);
    float mainVein = 1. - smoothstep(0.014, 0.042 + width, split);
    float fork = 0.39 * smoothstep(0.30, 0.83, u);
    float branch = 1. - smoothstep(0.012, 0.035 + width, abs(split - fork));
    float strands = max(mainVein, branch * smoothstep(0.33, 0.62, u) * 0.80) * (1. - smoothstep(0.14, 0.55, width));
    // Thin windows follow the gaps between gills, like a lace membrane.
    vec2 pores = vec2(strand * 2.0, radial * 5.6 + 0.7 * split);
    vec2 cell = fract(pores) - 0.5;
    float hole = length(cell * vec2(1.6, 0.87));
    float holeSize = smoothstep(0.48, 0.88, radial) * (0.06 + 0.12 * hash12(floor(pores))) * (1. - smoothstep(0.12, 0.40, width));
    if (hole < holeSize) discard;
    float lace = (1. - smoothstep(holeSize + 0.015, holeSize + 0.07 + width, hole)) * smoothstep(0.025, 0.10, holeSize);
    float fold = cos(6.2832 * strand), margin = smoothstep(0.975, 1., radial);
    gc = tip * mix(0.033, 0.12 + 0.051 * fold + 0.06 * strands, web);
    tissue = web * (0.010 + 0.62 * strands + 0.23 * lace + 0.25 * margin);
  } else if (vType > 4.5) {
    float rim = smoothstep(0.83, 0.97, u);
    float striae = 0.5 + 0.5 * cos(s * 16. + u * 7. + vSeed);
    float throat = smoothstep(0.24, 0.43, u) * (1. - smoothstep(0.54, 0.73, u));
    tissue = (0.11 + 0.68 * veins) * throat + veins * 0.50 + rim * 0.72;
    gc = tip * (0.065 + 0.23 * u + 0.08 * veins + 0.10 * rim);
    gc *= (0.70 + 0.30 * striae) * (0.75 + 0.25 * abs(s));
  } else gc *= 0.86 + veins * 0.25;
  float stir = glowI(vStir);
  vec3 lit = floraLight(gc, vWP, normalize(vN), normalize(uCam - vWP), u, 0.04, stir);
  // The circulating pulse stays inside the living tissue and carries the leaf's own pigment.
  float breath = 0.92 + 0.08 * sin(uTime * 0.74 + vHue * 11. - 3.2 * u);
  lit += tip * smoothstep(0.10, 0.94, uNight) * tissue * breath * (0.56 + 0.68 * stir);
  o = vec4(tonemap(fogged(lit, vWP)), 0.);
}`);

const WATERP = program(WORLD_VS + `
in vec2 aXZ; in float aDepth; in float aLevel; out vec3 vWP; out float vDepth; out float vWave;
void main(){
  // the swell rides up and down the beach, so the waterline itself moves
  vWave = waterWave(aXZ, uTime).x + impactWave(aXZ).x;
  vWP = vec3(aXZ.x, aLevel + vWave, aXZ.y); vDepth = aDepth; gl_Position = project(vWP);
}`,
`uniform sampler2D uRefl; uniform vec2 uRes, uRightXZ; uniform float uMirrorLevel;
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
  return g + impactWave(p).yz;
}
void main(){
  float depth = vDepth + vWave;
  if (depth <= -0.02) discard; // Dry beach has zero water coverage.
  vec2 p = vWP.xz, uv = fieldUV(p);
  float glow = uNight > 0. ? texture(uGlow, uv).r * inField(uv) : 0.;
  float level = vWP.y - vWave;
  float stream = smoothstep(0.03, 0.7, level);
  vec2 g = waveGrad(p);
  float flow = p.y * 3.3 - uTime * 3.1 + vnoise(p * 1.3 - vec2(0., uTime * 0.21)) * 3.8;
  g += stream * vec2(0.012 * sin(flow * 0.71), 0.028 * cos(flow));
  vec3 N = normalize(vec3(-g.x, 1., -g.y));
  vec3 V = normalize(uCam - vWP); float NdV = clamp(dot(N, V), 0., 1.);
  float F = 0.022 + 0.978 * pow(1. - NdV, 5.);
  vec2 forward = vec2(uRightXZ.y, -uRightXZ.x);
  vec2 distortion = vec2(dot(N.xz, uRightXZ) * uRes.y / uRes.x, dot(N.xz, forward));
  vec2 suv = gl_FragCoord.xy / uRes;
  vec2 warped = suv + distortion * mix(0.065, 0.16, NdV);
  float edge = min(min(warped.x, warped.y), min(1. - warped.x, 1. - warped.y));
  float planar = (1. - smoothstep(0.08, 0.85, abs(level - uMirrorLevel))) * smoothstep(0., 0.025, edge);
  vec3 refl = mix(tonemap(skyBase(reflect(-V, N))), texture(uRefl, clamp(warped, 0., 1.)).rgb, planar);

  // At a grazing angle the ray travels farther through water. Alpha carries the
  // fraction blocked by reflection and extinction; the actual bed shows through the rest.
  float path = max(0., depth) / max(0.18, NdV);
  float absorb = 1. - exp(-path * 0.66);
  float scatter = (1. - F) * absorb;
  vec3 body = mix(vec3(0.045, 0.28, 0.19), vec3(0.010, 0.087, 0.115), absorb);
  float sun = directLight(vWP);
  body *= ambient(N) * 2.8 + uSunCol * sun * (0.12 + 0.14 * max(uSunDir.y, 0.));
  float alpha = F + scatter;
  vec3 col = (F * refl + scatter * tonemap(fogged(body, vWP))) / max(alpha, 0.022);
  vec3 Hh = normalize(uSunDir + V);
  float sunGlint = pow(clamp(dot(N, Hh), 0., 1.), 510.) * 3.5;
  col += tonemap(uSunCol * sun * sunGlint * F) * (1. - 0.85 * uNight);

  float swash = 1. - smoothstep(0.025, 0.21, abs(depth - 0.06));
  float foam = (swash + 0.38 * stream * smoothstep(0.7, 1., sin(flow))) * shoreFroth(p);
  float light = uNight * uNight * glowI(glow);
  col = mix(col, tonemap(vec3(0.68, 0.78, 0.81) * (ambient(N) * 2.4 + uSunCol * sun * 0.16)), foam * 0.48);
  col += tonemap(glowCol(p * 1.3 + 7.) * light * (0.5 + 1.3 * uNight));
  alpha = min(1., alpha + foam * 0.2 + light * 0.40) * smoothstep(-0.02, 0.035, depth);
  o = vec4(col, alpha);
}`);

const POINTS = program(WORLD_VS + `
in vec4 aP; uniform float uScale, uNight; uniform vec2 uCamXZ; uniform int uRain; out float vA; out vec3 vC;
void main(){
  vec3 p = aP.xyz; float s = aP.w;
  if (uRain == 1) { float t = fract(uTime * (0.08 + 0.05 * s) + aP.y); vec2 c = uCamXZ + mod(aP.xz - uCamXZ + 34., 68.) - 34.; p = vec3(c.x, 22. - t * 24., c.y); p.x += sin(uTime + s * 50.) * 0.6; p.z += cos(uTime * 0.7 + s * 31.) * 0.4; vA = smoothstep(0., 0.1, t) * (1. - smoothstep(0.85, 1., t)); s = 0.5; }
  else if (uRain == 2) {
    p += vec3(sin(uTime * 0.31 + s * 20.), sin(uTime * 0.47 + s * 13.) * 0.45, cos(uTime * 0.27 + s * 7.)) * 1.3 + vec3(WIND_DIR.x, 0., WIND_DIR.y) * sin(uTime * 0.11 + s * 3.) * 2.;
    vA = 0.48 * uNight * (0.55 + 0.45 * sin(uTime * (1.1 + s * 2.) + s * 50.)); s = 0.18 + 0.2 * fract(s * 31.);
  }
  else if (uRain == 3) vA = 0.30 + 0.37 * uNight;
  else vA = 1.;
  vC = mix(vec3(0.3, 1.0, 0.9), vec3(0.7, 0.45, 1.), fract(s * 7.));
  vec4 c = project(p); gl_Position = c; gl_PointSize = clamp(uScale * (0.06 + s * 0.12) / c.w, 1., uRain == 2 ? 9. : 48.);
  if (uRain == 2) vA *= smoothstep(1.2, 3.5, c.w);
}`,
`in float vA; in vec3 vC; out vec4 o; void main(){ vec2 q = gl_PointCoord - .5; float a = (1. - smoothstep(0., 0.5, length(q))) * vA; o = vec4(tonemap(vC * 3.) * a, a); }`);

// the night sky, after rawah's stars.js: thousands of point stars on the sphere of the sky's own frame, many faint and a
// few bright (counts rise as 10^0.45m), richer toward the galaxy's plane, in the colours of real stars; and the galaxy's
// band, painted once into a cube map. Both turn with the sky, and the bodies and the clouds hide the stars behind them.
const STARS = program(`
in vec4 aS; in vec4 aC;
uniform mat4 uVP; uniform mat3 uSky; uniform vec3 uCam; uniform float uMirror, uTime, uNight, uPx;
out vec3 vC; out float vI;
void main(){
  vec3 d = aS.xyz * uSky;
  vec4 c = uVP * vec4(uCam.x + d.x * 2000., (uCam.y + d.y * 2000.) * uMirror, uCam.z + d.z * 2000., 1.);
  gl_Position = vec4(c.xy, c.w, c.w);
  float bright = pow(10., -0.4 * (aS.w - 1.5));
  float tw = 1. - (0.12 + 0.3 * (1. - smoothstep(0., 0.5, d.y))) * (0.5 + 0.5 * sin(uTime * (2.5 + aC.w * 6.) + aC.w * 60.));
  vI = clamp(0.2 + 0.7 * pow(bright, 0.28), 0., 1.6) * tw * smoothstep(-0.03, 0.22, d.y) * (0.55 + 0.45 * smoothstep(0., 0.5, d.y)) * uNight * uNight;
  vC = aC.rgb;
  gl_PointSize = (2. + 2.6 * pow(min(bright, 8.), 0.3)) * uPx;
}`, `in vec3 vC; in float vI; out vec4 o;
void main(){
  vec2 q = gl_PointCoord - 0.5; float r2 = dot(q, q) * 4.;
  float a = (exp(-r2 * 7.) + exp(-r2 * 2.2) * 0.22) * vI;
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
  float width = mix(0.16, 0.085, smoothstep(0., 2.4, lr));
  float bb = b - (fbmv(g * 3. + 1.7, 3) - 0.5) * 0.11 - 0.03 * sin(l * 2. + 0.5);
  float disc = exp(-sq(bb / width)), broad = exp(-sq(bb / (width * 2.8))) * 0.22;
  float clouds = smoothstep(0.28, 0.78, fbmv(g * 7. + 11., 4)), fine = fbmv(g * 42., 4);
  float bulgeR = sqrt(l * l + sq(b * 1.8)), bulge = exp(-sq(bulgeR / 0.24)) * 1.1;
  float I = disc * (0.38 + clouds * (0.55 + 0.45 * fine)) + broad + bulge * (0.55 + 0.45 * fine);
  I *= mix(1., 0.42, smoothstep(1.4, 3., lr));
  float lane = exp(-sq((bb - 0.012 + (fbmv(g * 9. + 3.3, 3) - 0.5) * 0.07) / 0.034)) * smoothstep(-1.25, -0.15, l) * (1. - smoothstep(0.9, 1.6, l));
  float dpatch = smoothstep(0.56, 0.82, fbmv(g * 13. + 9., 4)) * smoothstep(0., 0.5, disc + bulge * 0.4);
  float coal = smoothstep(0.62, 0.9, fbmv(g * 30. + 4., 3)) * disc;
  float streak = bb + 0.065 + (fbmv(g * 11. + 7., 4) - 0.5) * 0.16;
  float threads = exp(-sq(streak / 0.013)) + 0.58 * exp(-sq((streak + 0.022) / 0.007));
  float dust = clamp(lane * 0.86 + dpatch * 0.56 + coal * 0.46 + threads * disc * 0.58, 0., 0.96);
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
// Keep each patch's indices adjacent so a row of visible patches takes one draw.
function terrainPatches(pos, cols, rows, radial) {
  const idx = new Uint32Array(cols * rows * 6), patches = [], stride = cols + 1;
  const corners = radial ? [0, 1, stride, 1, stride + 1, stride] : [0, stride, 1, 1, stride, stride + 1];
  let cursor = 0;
  for (let j0 = 0; j0 < rows; j0 += 32) for (let i0 = 0; i0 < cols; i0 += 32) {
    const j1 = Math.min(rows, j0 + 32), i1 = Math.min(cols, i0 + 32), first = cursor;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const a = j * stride + i, k = a * 3;
      x0 = Math.min(x0, pos[k]); y0 = Math.min(y0, pos[k + 1]); z0 = Math.min(z0, pos[k + 2]);
      x1 = Math.max(x1, pos[k]); y1 = Math.max(y1, pos[k + 1]); z1 = Math.max(z1, pos[k + 2]);
      if (i === i1 || j === j1) continue;
      for (const offset of corners) idx[cursor++] = a + offset;
    }
    patches.push({ first, end: cursor, x0, y0, z0, y1, width: x1 - x0, depth: z1 - z0, pad: 0 });
  }
  return { idx, patches, drawCounts: new Int32Array(patches.length), byteOffsets: new Int32Array(patches.length) };
}
function terrainNear() {
  const { S, half } = NEAR, st = 2 * half / S, hs = new Float32Array((S + 1) * (S + 1));
  const ground = new Float32Array(hs.length * 2), pos = new Float32Array(hs.length * 3), nor = new Float32Array(pos.length);
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) hs[j * (S + 1) + i] = H(-half + i * st, -half + j * st);
  const at = (i, j) => hs[Math.min(S, Math.max(0, j)) * (S + 1) + Math.min(S, Math.max(0, i))];
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
    const x = -half + i * st, z = -half + j * st, k = 2 * (j * (S + 1) + i);
    ground[k] = trailCover(x, z); ground[k + 1] = waterLevel(x, z);
    const vertex = 3 * (j * (S + 1) + i);
    pos[vertex] = x; pos[vertex + 1] = at(i, j); pos[vertex + 2] = z;
    const hx = at(i + 1, j) - at(i - 1, j), hz = at(i, j + 1) - at(i, j - 1), l = Math.hypot(hx, 2 * st, hz);
    nor[vertex] = -hx / l; nor[vertex + 1] = 2 * st / l; nor[vertex + 2] = -hz / l;
  }
  return { ground, pos, nor, ...terrainPatches(pos, S, S, false) };
}
function terrainFar() {
  const rings = touch ? 150 : 190, sectors = touch ? 320 : 512, stride = sectors + 1, edge = NEAR.half - 0.5;
  const pos = new Float32Array((rings + 1) * stride * 3), nor = new Float32Array(pos.length);
  for (let j = 0; j <= rings; j++) {
    const r = 72 * Math.pow(1500 / 72, j / rings);
    for (let i = 0; i <= sectors; i++) {
      const a = (i % sectors) / sectors * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
      const inside = Math.abs(x) < edge && Math.abs(z) < edge;
      pos.set([x, H(x, z) - (inside ? 4 : 0), z], 3 * (j * stride + i));
    }
  }
  // Take tangents from the actual mesh, wrapping at its angular seam; the skyline and its lighting
  // then resolve the same ridges. Each vertex needs only one terrain sample.
  for (let j = 0; j <= rings; j++) for (let i = 0; i <= sectors; i++) {
    const vertex = j * stride + i;
    const left = 3 * (j * stride + (i + sectors - 1) % sectors), right = 3 * (j * stride + (i + 1) % sectors);
    const inner = 3 * (Math.max(0, j - 1) * stride + i), outer = 3 * (Math.min(rings, j + 1) * stride + i);
    const ax = pos[right] - pos[left], ay = pos[right + 1] - pos[left + 1], az = pos[right + 2] - pos[left + 2];
    const bx = pos[outer] - pos[inner], by = pos[outer + 1] - pos[inner + 1], bz = pos[outer + 2] - pos[inner + 2];
    nor.set(norm([ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]), 3 * vertex);
  }
  return { pos, nor, ...terrainPatches(pos, sectors, rings, true) };
}
function waterMesh() {
  const S = 256, x0 = LAKE[0] - 46, z0 = -76, w = 92, d = LAKE[1] + 40 - z0, xz = [], levels = [], dep = [], idx = [];
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) { const x = x0 + i / S * w, z = z0 + j / S * d; const level = waterLevel(x, z); xz.push(x, z); levels.push(level); dep.push(level - H(x, z)); }
  const tileCells = 16, across = Math.ceil(S / tileCells), tiles = [];
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, e = c + 1;
    if (Math.max(dep[a], dep[b], dep[c], dep[e]) <= -0.4) continue;
    idx.push(a, c, b, b, c, e);
    const ti = Math.floor(i / tileCells), tj = Math.floor(j / tileCells), key = tj * across + ti;
    const tile = tiles[key] ??= { x0: x0 + ti * tileCells * w / S, z0: z0 + tj * tileCells * d / S,
      width: tileCells * w / S, depth: tileCells * d / S, y0: Infinity, y1: -Infinity, pad: 0 };
    // 6.3 cm of wind swell plus up to 13 cm from overlapping impacts.
    tile.y0 = Math.min(tile.y0, Math.min(levels[a], levels[b], levels[c], levels[e]) - 0.20);
    tile.y1 = Math.max(tile.y1, Math.max(levels[a], levels[b], levels[c], levels[e]) + 0.20);
  }
  return { xz: new Float32Array(xz), levels: new Float32Array(levels), dep: new Float32Array(dep), idx: new Uint32Array(idx), tiles: tiles.filter(Boolean) };
}
function rockMesh(seed, sub, tall, stack) {
  const rr = rng(Math.floor(seed * 100003));
  // fracture planes: the stone is cut flat where it broke, so lumps meet facets
  const planes = [];
  for (let q = 0, np = sub < 2 ? 3 : 7 + Math.floor(rr() * 4); q < np; q++) { const a = rr() * 6.2832, el = (rr() - 0.35) * 1.4; const n = [Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)]; planes.push([n, 0.5 + rr() * 0.3]); }
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((c) => c / l); });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  let coarseFaces = [];
  const detailEdges = [];
  for (let q = 0; q < sub; q++) {
    const cache = {}, nf = [];
    const lastLevel = sub >= 2 && q === sub - 1;
    if (lastLevel) coarseFaces = f;
    const mid = (a, b) => {
      const k = a < b ? a + '_' + b : b + '_' + a;
      if (k in cache) return cache[k];
      const p = v[a].map((c, i) => (c + v[b][i]) / 2);
      v.push(norm(p));
      const index = v.length - 1;
      if (lastLevel) detailEdges.push([a, b, index]);
      return (cache[k] = index);
    };
    for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  // big lumps, a ridge or two, ledged strata, a flat seat on the ground
  const pos = v.map(([x, y, z]) => {
    let k = 1 + 0.3 * (fbm(x * 1.3 + seed * 7, z * 1.3 + y * 1.7 - seed, 3) - 0.5) + 0.14 * (ridged(x * 0.9 + seed, z * 0.9 + y) - 0.45) + 0.06 * (vnoise(x * 6 + seed, z * 6 + y * 5) - 0.5);
    k *= 1 + (stack ? 0.08 : 0.045) * Math.round(Math.sin(y * (stack ? 6 : 9) + seed * 3) * 1.6) / 1.6;
    let px = x * k, py = y * k * (tall ? 1 : 0.72), pz = z * k;
    if (stack) {
      const tw = (py + 1) * 0.55, c = Math.cos(tw), sn = Math.sin(tw), taper = 1 - 0.12 * (py + 1) / 2;
      [px, pz] = [(c * px - sn * pz) * taper, (sn * px + c * pz) * taper];
      px += 0.28 * Math.max(0, py - 0.2) ** 2;
    }
    for (const [n, d] of planes) { const dp = px * n[0] + py * n[1] + pz * n[2]; if (dp > d) { const f = (dp - d) * 0.9; px -= n[0] * f; py -= n[1] * f; pz -= n[2] * f; } }
    if (stack) {
      // Round the shoulder into a broad, slightly tilted bedding plane. The lower
      // sides retain their original fractures and undercut at the waterline.
      py += 0.08 * sm(0.15, 0.75, py);
      const cap = 0.916 + 0.018 * px - 0.012 * pz;
      py -= 0.055 * Math.log1p(Math.exp((py - cap) / 0.055));
    }
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
  // Both levels share vertex normals. Measure the actual shape removed by the last subdivision.
  let detailError = 0;
  for (const [a, b, m] of detailEdges) {
    const delta = pos[m].map((c, i) => c - (pos[a][i] + pos[b][i]) / 2);
    detailError = Math.max(detailError, Math.hypot(...delta));
  }
  return { pos: new Float32Array(pos.flat()), nor: new Float32Array(nor.map(n => { const length = Math.hypot(...n) || 1; return n.map(v => v / length); }).flat()),
    idx: new Uint16Array(f.flat()), coarseIdx: new Uint16Array(coarseFaces.flat()), detailError };
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
  return { pos: new Float32Array(W.pos), nor: new Float32Array(W.nor), c: new Float32Array(W.c), count: W.pos.length / 3 };
}

// ---------------------------------------------------------------- scatter
const STACK_GEO = rockMesh(9.31, 4, true, true), STACK_S = [4.05, 4.8, 3.5];
// terrain height and slope from the near mesh (fast, for a million blades)
function nearH(near, x, z) {
  const { S, half } = NEAR, st = 2 * half / S, fx = Math.min(S - 1e-3, Math.max(0, (x + half) / st)), fz = Math.min(S - 1e-3, Math.max(0, (z + half) / st));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j, P = near.pos, h = (a, b) => P[(b * (S + 1) + a) * 3 + 1];
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - w) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * w;
}
function nearNy(near, x, z) {
  const { S, half } = NEAR, st = 2 * half / S, i = Math.min(S, Math.max(0, Math.round((x + half) / st))), j = Math.min(S, Math.max(0, Math.round((z + half) / st)));
  return near.nor[(j * (S + 1) + i) * 3 + 1];
}
// blades per square metre where the meadow grows fully; distant tiles draw fewer (see Tiled)
const GRASS_DENSITY = touch ? 46 : TEST ? 56 : 104;
const START = [8, 30], SHORE_CAM = [19, 26];
const clearOf = (x, z) => trailCover(x, z) < 0.02 && (waterLevel(x, z) === 0 || H(x, z) > waterLevel(x, z) + 0.2) && Math.hypot(x - START[0], z - START[1]) > 3.5 && Math.hypot(x - SHORE_CAM[0], z - SHORE_CAM[1]) > 3.5;
const inMap = (x, z, m = 2) => Math.abs(x) < HALF - m && Math.abs(z) < HALF - m;

function scatter(near) {
  const bladeRand = rng(1234);
  // grass: Corey's stratified jitter, kept where blades can grow. Nothing is cut at a hard line: the chance of a blade
  // and its height both fall off with slope, the shore, height and the outcrop, broken up by noise, so a meadow thins
  // out into its edges. Patches of tall grass ride a slow noise.
  const n = Math.ceil(Math.sqrt(4 * HALF * HALF * GRASS_DENSITY)), cellG = 2 * HALF / n;
  const G = [], R = [];
  for (let gz = 0; gz < n; gz++) for (let gx = 0; gx < n; gx++) {
    const x = (gx + bladeRand()) * cellG - HALF, z = (gz + bladeRand()) * cellG - HALF, y = nearH(near, x, z), ld = lakeD(x, z);
    const waterY = waterLevel(x, z);
    if (trailCover(x, z) > 0.18 || y < waterY - 0.12) continue;
    let hm;
    if (ld > 10.0 && ld < 12.6 && y > -0.38 && y < 0.55) { if (bladeRand() > 0.2) continue; hm = 1.9 + bladeRand() * 1.1; }   // reeds: the shoreline and the shallows
    else {
      const ny = nearNy(near, x, z), ragged = 0.75 + 0.5 * vnoise(x * 0.9 + 7, z * 0.9 - 3);
      const grow = sm(0.2, 0.55, y) * (1 - sm(9, 14, y)) * sm(0.62, 0.84, ny) * (1 - 0.92 * outcrop(x, z)) * Math.min(1, ragged);
      if (grow < 0.02 || bladeRand() > grow * 1.15) continue;
      const tall = sm(0.5, 0.78, fbm(x * 0.028 + 21, z * 0.028 - 9, 3));
      hm = (0.45 + 0.55 * Math.min(1, grow * 1.2)) * (0.7 + 0.75 * fbm(x * 0.06 + 11, z * 0.06 - 4, 3) + 0.2 * bladeRand()) * (1 + 0.65 * tall);
    }
    const seed = bladeRand(), angle = bladeRand(), height = bladeRand(), tint = bladeRand();
    if (waterY > 0.02 && y < waterY + 0.80) {
      const growth = sm(0.04, 0.80, y - waterY);
      if (hash2(gx, gz) > 0.035 + 0.965 * growth) continue;
      hm *= 0.20 + 0.80 * growth;
    }
    G.push(x, z, y - 0.015, seed); R.push(angle, height, tint, hm);
  }

  // rocks: clusters with one big stone each, a broken field on the outcrop, monoliths on the rim, the sea stack, stones
  // in the shallows, pebbles on the shore
  // Keep the established shoreline across grass densities and quality settings.
  let r = rng(1306441690);
  const rv = [[], [], [], [], []], rs = [[], [], [], [], []];
  const add = (v, x, z, sx, sy, sz, sink, rand = r) => {
    const yaw = rand() * 6.28, tint = rand();
    if (v !== 3 && trailDistance(x, z) < 0.85 + 1.2 * Math.max(sx, sz)) return;
    rv[v].push(x, H(x, z) - sink, z, yaw); rs[v].push(sx, sy, sz, tint);
  };
  const cluster = (cx, cz, big, m) => {
    for (let q = 0; q < m; q++) {
      const s0 = q === 0 ? big : big * (0.18 + 0.42 * r()), a = r() * 6.28, d = q === 0 ? 0 : big * (0.7 + r() * 0.9);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (!clearOf(x, z) || !inMap(x, z)) continue;
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

  // Exposed ribs on the lookout have a cap of blocky stone and a fan of smaller
  // fragments below. Keep the whole footprint of each slab off the switchbacks.
  const cliffRand = rng(45780);
  for (let group = 0; group < 65; group++) {
    const angle = cliffRand() * Math.PI * 2, radius = 6 + cliffRand() * 19;
    const cx = summit[0] + radius * Math.cos(angle), cz = summit[1] + radius * Math.sin(angle);
    const normal = normalAt(cx, cz);
    if (normal[1] > 0.89 || H(cx, cz) < 3.8) continue;
    const downhill = Math.hypot(normal[0], normal[2]), dx = normal[0] / downhill, dz = normal[2] / downhill;
    for (let j = 0; j < 6; j++) {
      const scale = j === 0 ? 1.25 + 1.3 * cliffRand() : 0.23 + 0.85 * cliffRand();
      const fall = j === 0 ? 0 : j * 0.82 + cliffRand(), spread = j === 0 ? 0 : (cliffRand() - 0.5) * 0.9 * fall;
      const x = cx + dx * fall - dz * spread, z = cz + dz * fall + dx * spread;
      const reach = scale * 1.15;
      if (Math.hypot(x - summit[0], z - summit[1]) < 3.5 + reach) continue;
      add(group % 2, x, z, scale * 1.10, scale * (0.57 + 0.17 * cliffRand()), scale * 0.83, scale * 0.30, cliffRand);
    }
  }

  // Low shingle bars follow the outside bends. Each has a few exposed slate slabs among the gravel.
  const gravelRand = rng(31527), extraGravel = rng(14276);
  for (let group = 0; group < 27; group++) {
    const cz = -67 + gravelRand() * 51, side = Math.sin(cz * 0.13) < 0 ? -1 : 1;
    for (let stone = 0; stone < (touch ? 9 : 15); stone++) {
      const gravel = stone < 9 ? gravelRand : extraGravel;
      const z = cz + (gravel() - 0.5) * 4.6, x = riverX(z) + side * (1.55 + 1.72 * gravel());
      const radius = stone === 0 ? 0.43 + gravel() * 0.42 : 0.07 + gravel() ** 2 * 0.27;
      add(stone === 0 ? group % 2 : 3, x, z, radius, radius * (0.47 + 0.26 * gravel()), radius * 1.24, radius * 0.12, gravel);
    }
  }

  // crystal clusters along the shore, grown later (see growCrystals): [x, z, hue, crystals, size]
  r = rng(636504159); // Pebble density must not move crystal beds or trees.
  const crystalSites = [];
  for (let c = 0; c < 17; c++) {
    let cx, cz, k = 0;
    do { cx = LAKE[0] + (r() * 2 - 1) * 36; cz = LAKE[1] + (r() * 2 - 1) * 30; k++; } while ((lakeD(cx, cz) < 11.2 || lakeD(cx, cz) > 13.8 || !clearOf(cx, cz)) && k < 80);
    crystalSites.push([cx, cz, r(), 5 + Math.floor(r() * 6), 0.8 + r() * 0.5]);
  }

  // Low turquoise seams line the bare stone shoulder just off the tread.
  for (const [x, z, hue, count, size] of [[25, -13, 0.28, 5, 0.66], [26, -20, 0.32, 6, 0.75],
    [31, -24, 0.23, 5, 0.71], [34, -33, 0.29, 8, 0.86], [40, -26, 0.34, 5, 0.72]]) {
    crystalSites.push([x, z, hue, count, size]);
  }
  // Common trees, saplings and a few old giants with space for their low branches.
  const trees = [];
  const ground = (x, z) => { const y = H(x, z); return y > 0.3 && y < 11 && normalAt(x, z)[1] > 0.84 && lakeD(x, z) > 12.3 && clearOf(x, z) && Math.hypot(x - START[0], z - START[1]) > 7 && Math.hypot(x - SHORE_CAM[0], z - SHORE_CAM[1]) > 7 && inMap(x, z, 4) && outcrop(x, z) < 0.5; };
  const room = (x, z, d) => {
    if (trailDistance(x, z) < (d > 10 ? 3.7 : d > 3 ? 2.8 : 1.65)) return false;
    for (let q = 0; q < trees.length; q += 5) if (Math.hypot(trees[q] - x, trees[q + 2] - z) < d + (trees[q + 4] > 6 ? 3 : 0)) return false;
    return true;
  };
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
const LEAF_MULT = touch ? 1.4 : 2;
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
      const lobe = 1 + 0.12 * Math.cos(3 * ang + along * 0.6 + seed) + 0.06 * Math.sin(5 * ang - along * 0.3), radius = rad[k] * lobe;
      const dLobe = -0.36 * Math.sin(3 * ang + along * 0.6 + seed) + 0.3 * Math.cos(5 * ang - along * 0.3), t = [-Nn[0] * sn + B[0] * c, -Nn[1] * sn + B[1] * c, -Nn[2] * sn + B[2] * c];
      W.pos.push(pts[k][0] + o[0] * radius, pts[k][1] + o[1] * radius, pts[k][2] + o[2] * radius); W.nor.push(...norm([o[0] * lobe - t[0] * dLobe, o[1] * lobe - t[1] * dLobe, o[2] * lobe - t[2] * dLobe]));
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
  const at = (t) => {
    const bend = wob * (Math.sin(t * 5 + ph) - Math.sin(ph) * (1 - t) ** 2);
    return [x + (ld[0] * leanAmt * t * t + lp[0] * bend) * h, y + trunkH * t, z + (ld[1] * leanAmt * t * t + lp[1] * bend) * h];
  };
  const r0 = h * (0.045 + 0.02 * r()), rad = (t) => r0 * (1 - 0.62 * t) + r0 * 0.9 * Math.exp(-t * 10);
  const tp = [], tr = [];
  for (let k = 0; k <= 12; k++) { tp.push(at(k / 12)); tr.push(rad(k / 12)); }
  tube(W, tp, tr, 9, 0, 0.55, base, seed);
  const pads = [{ c: at(1), R: h * (0.2 + 0.1 * r()), f: 0.6 }];
  const young = h < 2.6, nl = young ? 2 + Math.floor(r() * 2) : h > 7 ? 5 + Math.floor(r() * 3) : 3 + Math.floor(r() * 3);
  for (let i = 0; i < nl; i++) {
    const t0 = 0.38 + 0.55 * (i + r() * 0.7) / nl, P0 = at(t0), az = lean + (r() - 0.5) * 4.2, len = h * (0.26 + 0.3 * r()), rise = 0.12 + 0.45 * r(), dr = 0.2 + 0.3 * r();
    const dh = [Math.cos(az), Math.sin(az)], pts = [], rr = [], fA = 0.55 * t0, fB = fA + 0.45;
    for (let k = 0; k <= 6; k++) { const q = k / 6; pts.push([P0[0] + dh[0] * len * q + lp[0] * 0.05 * h * Math.sin(q * 4 + i), P0[1] + len * (rise * q - dr * q * q * 0.5), P0[2] + dh[1] * len * q + lp[1] * 0.05 * h * Math.sin(q * 4 + i)]); rr.push(rad(t0) * 0.62 * (1 - 0.62 * q)); }
    tube(W, pts, rr, 7, fA, fB, base, seed + i);
    pads.push({ c: [pts[6][0], pts[6][1] + 0.05 * h, pts[6][2]], R: h * (0.17 + 0.09 * r()), f: fB });
    for (let j = 0, nt = young ? Math.floor(r() * 2) : 2 + Math.floor(r() * 2); j < nt; j++) {
      const q0 = 0.45 + 0.35 * r(), Q = pts[Math.round(q0 * 6)], az2 = az + (r() < 0.5 ? -1 : 1) * (0.6 + 0.6 * r()), l2 = len * (0.3 + 0.25 * r()), tw = [], trr = [];
      for (let k = 0; k <= 4; k++) { const q = k / 4; tw.push([Q[0] + Math.cos(az2) * l2 * q, Q[1] + l2 * (0.35 * q), Q[2] + Math.sin(az2) * l2 * q]); trr.push(rad(t0) * 0.32 * (1 - 0.6 * q)); }
      tube(W, tw, trr, 5, fA + 0.3, fB + 0.1, base, seed + i + j * 7);
      pads.push({ c: [tw[4][0], tw[4][1] + 0.04 * h, tw[4][2]], R: h * (0.13 + 0.07 * r()), f: fB + 0.1 });
    }
  }
  for (const pd of pads) {
    const nb = Math.round(Math.min(120, Math.max(young ? 14 : 30, 260 * pd.R * pd.R)) * LEAF_MULT);
    for (let b = 0; b < nb; b++) {
      const a = r() * 6.2832, rf = Math.sqrt(r()), rd = rf * pd.R * 0.75;
      const root = [pd.c[0] + Math.cos(a) * rd, pd.c[1] - pd.R * 0.18 + r() * pd.R * 0.22, pd.c[2] + Math.sin(a) * rd];
      const dir = norm([Math.cos(a) * (0.35 + rf) + (r() - 0.5) * 0.5, 0.25 + 0.55 * r(), Math.sin(a) * (0.35 + rf) + (r() - 0.5) * 0.5]);
      Lf.R.push(...root, pd.f); Lf.D.push(...dir, 2 * pd.R * (0.55 + 0.5 * r()) * (1.15 - rf * 0.4)); Lf.M.push(0.08 + 0.1 * r(), 0.12 + 0.25 * r(), 0.08 + 0.07 * r(), r()); Lf.B.push(...base);
    }
  }
}
// Broadleaf groves have low, spreading forks and a windward slope to the whole crown.
function growBroadleaf(x, y, z, h, seed, wood, leaves) {
  const rand = rng(Math.floor(seed * 1e9) ^ 0x72ac);
  const angle = (rand() - 0.5) * 1.6 + 0.5;
  const dx = Math.cos(angle), dz = Math.sin(angle);
  // A teal or orchid grove, with variation inside each family.
  const hue = rand() < 0.5 ? 0.12 * rand() : 0.86 + 0.14 * rand();
  const base = [x, z, h, hue];
  const trunk = [[x, y, z], [x - dx * h * 0.025, y + h * 0.12, z - dz * h * 0.025],
    [x + dx * h * 0.05, y + h * 0.32, z + dz * h * 0.05],
    [x + dx * h * 0.25, y + h * 0.55, z + dz * h * 0.25],
    [x + dx * h * 0.60, y + h * 0.83, z + dz * h * 0.60]];
  tube(wood, trunk, [0.15, 0.092, 0.074, 0.046, 0.015].map(k => k * h), 10, 0, 0.76, base, seed);

  // Buttresses spread down the slope into the root flare; sample the land at each anchor.
  for (let i = 0; i < 5; i++) {
    const az = angle + i * 1.2566 + 0.16 * Math.sin(seed * 30 + i);
    const rx = Math.cos(az) * h, rz = Math.sin(az) * h;
    const toe = [x + rx * 0.36, H(x + rx * 0.36, z + rz * 0.36) - 0.04, z + rz * 0.36];
    const knee = [x + rx * 0.13, H(x + rx * 0.13, z + rz * 0.13) + h * 0.07, z + rz * 0.13];
    tube(wood, [[x, y + h * 0.25, z], knee, toe], [h * 0.058, h * 0.062, h * 0.016], 6, 0, 0, base, seed + i);
  }

  function crown(center, radius, flex) {
    // Stagger the leaves through the volume. Upper leaves catch more light, and the
    // lower tier hangs below the bough so each crown reads as a mass at a distance.
    const count = Math.ceil((touch ? 80 : 112) * (0.65 + Math.min(radius, 2) * 0.32));
    for (let i = 0; i < count; i++) {
      const az = i * 2.39996 + rand() * 0.35, cy = 2 * (i + rand()) / count - 1;
      const side = Math.sqrt(1 - cy * cy), cx = Math.cos(az) * side, cz = Math.sin(az) * side;
      const r = radius * (0.58 + 0.42 * rand()), len = radius * (0.49 + 0.32 * rand());
      leaves.R.push(center[0] + r * (cx + 0.35 * dx * cy), center[1] + r * (0.74 * cy + 0.22 * (cx * dx + cz * dz)), center[2] + r * (cz + 0.35 * dz * cy), flex);
      const heading = norm([cx + dx * 0.46, 0.28 + cy * 0.66, cz + dz * 0.46]);
      leaves.D.push(...heading, len);
      leaves.M.push(0.09 + 0.08 * rand(), 0.1 + 0.16 * rand(), len * (0.43 + 0.23 * rand()), 0.38 * rand() + 0.31 * (cy + 1));
      leaves.B.push(...base);
    }
  }

  crown(trunk[4], h * 0.30, 0.76);
  const branches = h > 7 ? 8 : 6;
  for (let i = 0; i < branches; i++) {
    const joint = 1 + i % 3, start = trunk[joint], flex = joint * 0.19;
    const az = angle + i * 2.39996 + rand() * 0.5;
    const reach = h * (0.28 + rand() * 0.14);
    const bx = reach * (Math.cos(az) + 0.38 * dx), bz = reach * (Math.sin(az) + 0.38 * dz);
    const lift = h * (0.20 + 0.12 * rand());
    const elbow = [start[0] + bx * 0.58, start[1] + lift * 0.27, start[2] + bz * 0.58];
    const end = [start[0] + bx, start[1] + lift, start[2] + bz];
    tube(wood, [start, elbow, end], [0.048 * h, 0.032 * h, 0.009 * h], 7, flex, flex + 0.26, base, seed + i);
    crown(end, h * (0.21 + rand() * 0.07), flex + 0.26);
    const fork = [elbow[0] + bx * 0.24 - bz * 0.32, elbow[1] + lift * 0.64, elbow[2] + bz * 0.24 + bx * 0.32];
    tube(wood, [elbow, fork], [0.025 * h, 0.007 * h], 6, flex + 0.13, flex + 0.24, base, seed + i + 9);
    crown(fork, h * 0.18, flex + 0.24);
    // Pendant epiphytes hang below the old crowns. Paired blades grow on the lower runner.
    if (h > 5 && joint > 1 && i % 2 === 0) {
      const root = end, drop = Math.min(h * (0.26 + 0.10 * rand()), root[1] - H(root[0], root[2]) - 0.35);
      if (drop < 0.55) continue;
      const runner = [];
      for (let k = 0; k <= 6; k++) {
        const u = k / 6;
        const pos = [root[0] + h * 0.048 * (Math.sin(u * 4.8 + az) - Math.sin(az)), root[1] - drop * u, root[2] + h * 0.035 * u * Math.cos(az + u * 3.)];
        runner.push(pos);
        if (k < 2) continue;
        const ph = az + k * 2.4;
        leaves.R.push(...pos, flex + 0.26);
        leaves.D.push(...norm([Math.cos(ph), -0.95, Math.sin(ph)]), h * (0.09 + 0.04 * u));
        leaves.M.push(0.08, 0.13, h * 0.028, 0.88);
        leaves.B.push(...base);
      }
      tube(wood, runner, runner.map((_, k) => h * (0.008 - 0.0007 * k)), 5, flex + 0.26, flex + 0.26, base, seed + i);
    }
  }
}
function growForest(sc) {
  const W = { pos: [], nor: [], w: [], b: [], idx: [] }, Lf = { R: [], D: [], M: [], B: [] };
  for (let q = 0; q < sc.trees.length; q += 5) {
    const [x, y, z, seed, height] = sc.trees.subarray(q, q + 5);
    const grow = height > 3 && seed < 0.54 ? growBroadleaf : growJuniper;
    grow(x, y, z, height, seed, W, Lf);
  }
  // Root the juniper at an actual vertex a little off-centre on the stone bench.
  const rock = STACK_GEO.pos;
  let root = 0, nearest = Infinity;
  for (let i = 0; i < rock.length; i += 3) {
    const d = (rock[i] + 0.13) ** 2 + (rock[i + 2] - 0.08) ** 2;
    if (rock[i + 1] > 0.82 && d < nearest) { root = i; nearest = d; }
  }
  const sx = ISLET[0] + rock[root] * STACK_S[0], sz = ISLET[1] + rock[root + 2] * STACK_S[2];
  const sy = H(...ISLET) - 0.2 + rock[root + 1] * STACK_S[1];
  growJuniper(sx, sy - 0.1, sz, 3.2, 0.7317, W, Lf, Math.atan2(LAKE[1] - sz, LAKE[0] - sx) + 2.4);
  return { pos: new Float32Array(W.pos), nor: new Float32Array(W.nor), w: new Float32Array(W.w), b: new Float32Array(W.b), idx: new Uint32Array(W.idx), R: new Float32Array(Lf.R), D: new Float32Array(Lf.D), M: new Float32Array(Lf.M), B: new Float32Array(Lf.B) };
}

// understory around tree bases and big stones, ferns along the shade and the shore, glow tubes by the water,
// coilferns curling in the shade of the junipers, and lantern bells nodding along the shore and the meadows
function plantScatter(sc, near) {
  const r = rng(555), P = [], F = [], S2 = [];
  const ok = (x, z) => { const y = H(x, z); return y > 0.32 && y < 10 && nearNy(near, x, z) > 0.8 && clearOf(x, z) && inMap(x, z) && outcrop(x, z) < 0.6; };
  const anchors = [];
  for (let q = 0; q < sc.trees.length; q += 5) anchors.push([sc.trees[q], sc.trees[q + 2]]);
  for (const v of [0, 1]) for (let q = 0; q < sc.rv[v].length; q += 4) if (sc.rs[v][q] > 0.9) anchors.push([sc.rv[v][q], sc.rv[v][q + 2]]);
  const nearA = (r0, r1) => { const a = anchors[Math.floor(r() * anchors.length)], t = r() * 6.2832, d = r0 + r() * (r1 - r0); return [a[0] + Math.cos(t) * d, a[1] + Math.sin(t) * d]; };
  const shoreP = (d0, d1) => { let x, z, k = 0; do { x = LAKE[0] + (r() * 2 - 1) * 38; z = LAKE[1] + (r() * 2 - 1) * 32; k++; } while ((lakeD(x, z) < d0 || lakeD(x, z) > d1) && k < 60); return [x, z]; };
  const anywhere = () => [(r() * 2 - 1) * (HALF - 2), (r() * 2 - 1) * (HALF - 2)];
  const place = (gen) => { for (let t = 0; t < 30; t++) { const [x, z] = gen(); if (ok(x, z)) return [x, z]; } return null; };
  const k = touch ? 0.65 : 1;
  function besideWalk(points, rand) {
    const i = Math.floor(rand() * (points.length - 1)), [x, z] = points[i];
    const dx = points[i + 1][0] - x, dz = points[i + 1][1] - z, along = rand();
    const offset = (rand() < 0.5 ? -1 : 1) * (1.8 + 2.2 * rand()) / Math.hypot(dx, dz);
    return [x + dx * along - dz * offset, z + dz * along + dx * offset];
  }
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
    const at = place(() => (r() < 0.55 ? shoreP(11, 13.2) : nearA(0.6, 1.8))); if (!at) continue;
    const m = 8 + Math.floor(r() * 9);
    for (let i = 0; i < m; i++) {
      const x = at[0] + (r() - 0.5) * 0.7, z = at[1] + (r() - 0.5) * 0.7, y = H(x, z), L = 0.12 + r() * 0.28, W = 0.035 + r() * 0.02, phi = r() * 3.1416;
      for (const ph of [phi, phi + 1.5708]) { P.push(x, y - 0.02, z, 1); F.push(ph, L, W, 2); S2.push(0.06, 1, 0, 0); }
    }
  }
  // coilferns: a few stalks to a clump, each rising and rolling its tip into a spiral
  for (let c = 0; c < 300 * k; c++) {
    const at = place(() => c % 5 === 0 ? besideWalk(valleyWalks.fern, r) : nearA(0.9, 3.4)); if (!at) continue;
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
  // Tidecups colonize the wet margin in small families. Sharing a strip mesh with the
  // ferns keeps them in the same instanced reflection and foliage draws.
  for (let colony = 0; colony < 100 * k; colony++) {
    const patch = place(() => r() < 0.70 ? shoreP(10.9, 14.1) : nearA(1.25, 3.2));
    if (!patch) continue;
    const count = 3 + Math.floor(r() * 4), tint = r();
    for (let n = 0; n < count; n++) {
      const x = patch[0] + (r() - 0.5) * 1.8, z = patch[1] + (r() - 0.5) * 1.8;
      if (!ok(x, z)) continue;
      const y = H(x,z) - 0.025, height = (n === 0 ? 0.9 : 0.32) + 0.43 * r();
      const yaw = r() * 6.2832, lobes = 12, radius = 0.50 + r() * 0.12;
      for (let j = 0; j < lobes; j++) {
        const phi = yaw + 6.2832 * j / lobes, wave = Math.cos(phi * 3. + yaw);
        P.push(x, y, z, 1);
        F.push(phi, height, 0.55 * height * radius, 5);
        S2.push(radius, 0.94 + 0.08 * wave, 0.045, tint);
      }
      // Slender pollen-bearing filaments rise from the center of the cup.
      for (let j = 0; j < 5; j++) {
        const phi = yaw + j * 2.39996;
        P.push(x, y, z, 1);
        F.push(phi, height * 0.92, height * 0.031, 2);
        S2.push(0.17, 1.04 + 0.08 * Math.sin(phi), 0.05, 0.04);
      }
    }
  }
  // The limestone shelves above the meadow carry tougher, wind-bent fans.
  // Groups grow beside the switchbacks and on rock benches around the rim.
  const ridgeRand = rng(71349);
  function ridgeFan(cx, cz, warm = false) {
    const family = warm ? 0.76 + 0.20 * ridgeRand() : ridgeRand(), yaw = ridgeRand() * 6.2832;
    for (let i = 0; i < 11; i++) {
      const a = i * 2.39996 + yaw, d = i === 0 ? 0. : 0.35 + 1.35 * ridgeRand();
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (!inMap(x, z) || trailCover(x, z) > 0.01 || nearNy(near, x, z) < 0.66) continue;
      const y = H(x, z);
      if (y < 4.3 || y > 26.) continue;
      const length = i === 0 ? 1.28 : 0.35 + 0.67 * ridgeRand();
      const hue = Math.min(1., Math.max(0., family + 0.10 * (ridgeRand() - 0.5)));
      P.push(x, y - 0.022, z, 1);
      F.push(a + 0.21 * ridgeRand(), length, 0.038 * length, 6);
      S2.push(0.89 + 0.29 * ridgeRand(), 0.83 + 0.16 * ridgeRand(), 0.14 + 0.22 * ridgeRand(), hue);
    }
  }
  for (let i = 2; i < trail.length - 3; i += 3) {
    const [x, z] = trail[i], dx = trail[i + 1][0] - x, dz = trail[i + 1][1] - z;
    const side = (i % 2 ? 1 : -1) * (2.4 + ridgeRand() * 0.8) / Math.hypot(dx, dz);
    ridgeFan(x - dz * side, z + dx * side);
  }
  for (let i = 0; i < 140; i++) {
    if (i % 6 === 0) { ridgeFan(...besideWalk(valleyWalks.fan, ridgeRand), true); continue; }
    const x = (ridgeRand() * 2 - 1) * (HALF - 3), z = (ridgeRand() * 2 - 1) * (HALF - 3);
    if (Math.hypot(x, z) > 35 && H(x, z) > 5.2) ridgeFan(x, z);
  }
  return { P: new Float32Array(P), F: new Float32Array(F), S2: new Float32Array(S2) };
}
const MOTE_N = touch ? 520 : 840;
function moteScatter() {
  const r = rng(808), m = new Float32Array(MOTE_N * 4);
  for (let i = 0; i < MOTE_N; i++) { const x = (r() * 2 - 1) * (HALF - 2), z = (r() * 2 - 1) * (HALF - 2), g = H(x, z); m.set([x, Math.max(g, 0) + 0.4 + r() * 2.4, z, r()], i * 4); }
  return m;
}

// ---------------------------------------------------------------- the night sky
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// the galaxy's frame in the sky's, rows toward its core, its pole and the third axis: the core stands low in the south,
// in the open sky between the rose giant and the ocean world, and the band climbs from it past the zenith
const GAL = (() => {
  const C = norm([0.24, 0.375, 0.896]), V0 = norm([-C[0] * C[1], 1 - C[1] * C[1], -C[2] * C[1]]), W = cross(C, V0), a = 0.45;
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
      let y0 = Infinity, y1 = -Infinity, pad = 0;
      for (let k = a; k < b; k++) {
        const i = order[k], y = at(i)[1], reach = typeof span === 'function' ? span(i) : span;
        y0 = Math.min(y0, y - reach); y1 = Math.max(y1, y + reach); pad = Math.max(pad, reach);
      }
      const x0 = (t % TILES) * TILE_M - HALF - TILE_M, z0 = Math.floor(t / TILES) * TILE_M - HALF - TILE_M;
      if (b > a) this.tiles.push({ start: a, count: b - a, x0, z0, y0, y1, pad });
    }
    const attributes = names.map((name) => {
      const src = data[name], dst = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) {
        const from = order[k] * 4, to = k * 4;
        dst[to] = src[from]; dst[to + 1] = src[from + 1];
        dst[to + 2] = src[from + 2]; dst[to + 3] = src[from + 3];
      }
      const buf = gl.createBuffer(), l = gl.getAttribLocation(prog, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, dst, gl.STATIC_DRAW);
      return { buf, loc: l };
    });
    // Each tile always starts at the same offset, including in its reflection.
    for (const tile of this.tiles) {
      tile.vao = gl.createVertexArray();
      gl.bindVertexArray(tile.vao);
      for (const a of attributes) {
        gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
        gl.enableVertexAttribArray(a.loc);
        gl.vertexAttribDivisor(a.loc, 1);
        gl.vertexAttribPointer(a.loc, 4, gl.FLOAT, false, 0, tile.start * 16);
      }
    }
    gl.bindVertexArray(null);
    this.count = n;
  }
  /** Draw what the camera can see. Returns the instances drawn. */
  draw(planes, eye, density = 1) {
    const lodW = this.prog.u('uLodW');
    let drawn = 0;
    for (const t of this.tiles) {
      if (outsideView(planes, t, TILE_M)) continue;
      const dx = Math.max(t.x0 - eye[0], 0, eye[0] - t.x0 - TILE_M), dz = Math.max(t.z0 - eye[2], 0, eye[2] - t.z0 - TILE_M), d = Math.hypot(dx, dz);
      const f = d < this.near ? 1 : Math.max(this.least, Math.pow(this.near / d, 1.5)), n = Math.floor(t.count * f * density);
      if (n <= 0) continue;
      gl.bindVertexArray(t.vao);
      gl.uniform1f(lodW, Math.min(2.2, 1 / Math.sqrt(f * density)));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, this.verts, n);
      drawn += n;
    }
    gl.uniform1f(lodW, 1);
    return drawn;
  }
}
// Pull the six clip planes into world space once per pass. Reflecting their Y
// coefficients lets all tile bounds stay in the original world coordinates.
const viewPlanes = new Float64Array(24);
function prepareViewPlanes(vp, mirror) {
  for (let plane = 0; plane < 6; plane++) {
    const axis = plane >> 1, sign = plane % 2 ? -1 : 1;
    for (let i = 0; i < 4; i++) {
      const k = i * 4;
      viewPlanes[plane * 4 + i] = (vp[k + 3] + sign * vp[k + axis]) * (i === 1 ? mirror : 1);
    }
  }
  return viewPlanes;
}
function outsideView(planes, tile, width, depth = width) {
  for (let i = 0; i < planes.length; i += 4) {
    const a = planes[i], b = planes[i + 1], c = planes[i + 2];
    // A whole box is outside only if even its furthest corner is outside.
    const x = a >= 0 ? tile.x0 + width + tile.pad : tile.x0 - tile.pad;
    const z = c >= 0 ? tile.z0 + depth + tile.pad : tile.z0 - tile.pad;
    if (a * x + b * (b >= 0 ? tile.y1 : tile.y0) + c * z + planes[i + 3] < -1e-7) return true;
  }
  return false;
}

// ---------------------------------------------------------------- build the scene
const loc = (p, n) => gl.getAttribLocation(p, n);
const { near, sc, vWood, woodIndices, leaves, grass, plants, coilView, lanternView, sailwings } = buildValley();
const far = uploadTerrain(terrainFar()), wm = uploadWater(waterMesh());
function uploadTerrain(mesh) {
  const attrs = [{ loc: loc(TERRAIN, 'aPos'), size: 3, data: mesh.pos }, { loc: loc(TERRAIN, 'aNor'), size: 3, data: mesh.nor }];
  if (mesh.ground) attrs.push({ loc: loc(TERRAIN, 'aGround'), size: 2, data: mesh.ground });
  return { vao: vao(attrs, mesh.idx), count: mesh.idx.length, patches: mesh.patches, drawCounts: mesh.drawCounts, byteOffsets: mesh.byteOffsets };
}
function uploadWater(mesh) {
  const attrs = [{ loc: loc(WATERP, 'aXZ'), size: 2, data: mesh.xz }, { loc: loc(WATERP, 'aLevel'), size: 1, data: mesh.levels }, { loc: loc(WATERP, 'aDepth'), size: 1, data: mesh.dep }];
  return { vao: vao(attrs, mesh.idx), count: mesh.idx.length, tiles: mesh.tiles };
}
function buildValley() {
  // Ground arrays are used to place vegetation and flight paths, then live only on the GPU.
  const near = terrainNear();
  const { G, R, ...sc } = scatter(near);
  // Include the tip's travel under contact when culling a tile at the edge of the view.
  const grass = new Tiled(GRASS, { aG: G, aR: R }, i => [G[i * 4], G[i * 4 + 2], G[i * 4 + 1]],
    i => 0.15 + 2.15 * 0.34 * (0.62 + 0.76 * R[i * 4 + 1]) * R[i * 4 + 3], 7, 18, 0.06);
  const forest = growForest(sc);
  const vWood = vao([
    { loc: loc(WOOD, 'aPos'), size: 3, data: forest.pos }, { loc: loc(WOOD, 'aNor'), size: 3, data: forest.nor },
    { loc: loc(WOOD, 'aW'), size: 4, data: forest.w }, { loc: loc(WOOD, 'aB'), size: 4, data: forest.b },
  ], forest.idx);
  const leaves = new Tiled(JLEAF, { aR: forest.R, aD: forest.D, aM: forest.M, aB: forest.B },
    i => [forest.R[i * 4], forest.R[i * 4 + 1], forest.R[i * 4 + 2]], i => 2.2 * forest.D[i * 4 + 3] + 0.75, 13, 40, 0.3);
  const pl = plantScatter(sc, near);
  const plants = new Tiled(PLANT, { aP: pl.P, aF: pl.F, aS2: pl.S2 },
    i => [pl.P[i * 4], pl.P[i * 4 + 1], pl.P[i * 4 + 2]], i => 0.2 + 1.8 * pl.P[i * 4 + 3] * pl.F[i * 4 + 1], 25, 24, 0.12);
  bakeCanopy(gl, forest, EXTENT);
  bakeFloraSpill(pl);
  const sailwings = createSailwings({ gl, program, vao, worldVertex: WORLD_VS, groundAt: (x, z) => nearH(near, x, z), waterLevel, riverX, sc, random: rng(971) });
  return { near: uploadTerrain(near), sailwings, sc, vWood, woodIndices: forest.idx.length, leaves, grass, plants, coilView: plantView(pl, 3), lanternView: plantView(pl, 4) };
}
const crystals = growCrystals(sc.crystalSites);
const highSites = highCanopySites(H, vnoise, rng(914), HALF, trailCover, waterLevel);
const highTrees = uploadHighCanopy(highCanopyMesh(rng(9942)), highSites);
function uploadHighCanopy(mesh, sites) {
  const attrs = [
    { loc: loc(HIGH_CANOPY, 'aPos'), size: 3, data: mesh.position },
    { loc: loc(HIGH_CANOPY, 'aNor'), size: 3, data: mesh.normal },
    { loc: loc(HIGH_CANOPY, 'aTissue'), size: 1, data: mesh.tissue },
    { loc: loc(HIGH_CANOPY, 'aSite'), size: 4, data: sites.instances, div: 1 },
  ];
  gl.bindVertexArray(null);
  const indices = uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
  for (const tile of sites.tiles) tile.vao = vao(attrs, indices, tile.start);
  return { nearCount: mesh.nearCount, farCount: mesh.farCount };
}
function drawHighCanopy(planes, mirror = 1, eye) {
  // The first tile starts at instance zero, so the bake can draw the whole grove.
  if (!highSites.tiles.length) return;
  if (!planes) {
    gl.bindVertexArray(highSites.tiles[0].vao);
    gl.drawElementsInstanced(gl.TRIANGLES, highTrees.nearCount, gl.UNSIGNED_SHORT, 0, highSites.instances.length / 4);
    return;
  }
  const width = highSites.width, distance = mirror < 0 ? 32 : 72;
  const farOffset = highTrees.nearCount * Uint16Array.BYTES_PER_ELEMENT;
  for (const tile of highSites.tiles) {
    if (outsideView(planes, tile, width)) continue;
    const dx = Math.max(tile.x0 - eye[0], 0, eye[0] - tile.x0 - width);
    const dz = Math.max(tile.z0 - eye[2], 0, eye[2] - tile.z0 - width);
    const folds = dx * dx + dz * dz < distance * distance;
    gl.bindVertexArray(tile.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, folds ? highTrees.nearCount : highTrees.farCount,
      gl.UNSIGNED_SHORT, folds ? 0 : farOffset, tile.count);
  }
}
const rocks = [rockMesh(1.3, 3, false), rockMesh(4.1, 3, false), rockMesh(7.7, 3, true), rockMesh(2.2, 1, false), STACK_GEO]
  .map((mesh, k) => rockBatches(mesh, sc.rv[k], sc.rs[k]));

function rockBatches(mesh, sites, sizes) {
  const width = 16, cells = new Map();
  let footprint = 0, bottom = Infinity, top = -Infinity;
  for (let k = 0; k < mesh.pos.length; k += 3) {
    footprint = Math.max(footprint, Math.hypot(mesh.pos[k], mesh.pos[k + 2]));
    bottom = Math.min(bottom, mesh.pos[k + 1]); top = Math.max(top, mesh.pos[k + 1]);
  }
  for (let k = 0; k < sites.length; k += 4) {
    const x = Math.floor(sites[k] / width), z = Math.floor(sites[k + 2] / width), key = x + ',' + z;
    if (!cells.has(key)) cells.set(key, { x0: x * width, z0: z * width, y0: Infinity, y1: -Infinity, pad: 0, detailError: 0, members: [] });
    const cell = cells.get(key);
    cell.detailError = Math.max(cell.detailError, mesh.detailError * Math.max(sizes[k], sizes[k + 1], sizes[k + 2]));
    cell.pad = Math.max(cell.pad, footprint * Math.max(sizes[k], sizes[k + 2]));
    cell.y0 = Math.min(cell.y0, sites[k + 1] + bottom * sizes[k + 1]);
    cell.y1 = Math.max(cell.y1, sites[k + 1] + top * sizes[k + 1]);
    cell.members.push(k);
  }
  const poses = new Float32Array(sites.length), scales = new Float32Array(sizes.length), levels = new Float32Array(sites.length / 4);
  const attrs = [
    { loc: loc(ROCK, 'aPos'), size: 3, data: mesh.pos }, { loc: loc(ROCK, 'aNor'), size: 3, data: mesh.nor },
    { loc: loc(ROCK, 'aI'), size: 4, data: poses, div: 1 }, { loc: loc(ROCK, 'aS'), size: 4, data: scales, div: 1 },
    { loc: loc(ROCK, 'aLevel'), size: 1, data: levels, div: 1 },
  ];
  const tiles = [];
  let count = 0;
  for (const { members, ...bounds } of cells.values()) {
    tiles.push({ ...bounds, first: count, count: members.length });
    for (const k of members) {
      poses.set(sites.subarray(k, k + 4), count * 4); scales.set(sizes.subarray(k, k + 4), count * 4);
      levels[count++] = waterLevel(sites[k], sites[k + 2]);
    }
  }
  gl.bindVertexArray(null);
  const indices = new Uint16Array(mesh.idx.length + mesh.coarseIdx.length);
  indices.set(mesh.idx); indices.set(mesh.coarseIdx, mesh.idx.length);
  const ib = uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  for (const tile of tiles) tile.vao = vao(attrs, ib, tile.first);
  return { tiles, count, width, indexCount: mesh.idx.length, coarseCount: mesh.coarseIdx.length };
}

function drawRocks(VP, mirror = 1, focalPixels, planes) {
  for (let k = 0; k < rocks.length; k++) {
    const batch = rocks[k];
    if (!batch.count || (k === 3 && mirror < 0)) continue;
    // Shadow maps capture the full set in one call per rock shape.
    if (!VP) {
      gl.bindVertexArray(batch.tiles[0].vao);
      gl.drawElementsInstanced(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_SHORT, 0, batch.count);
      continue;
    }
    for (const tile of batch.tiles) {
      if (outsideView(planes, tile, batch.width)) continue;
      // Nearest camera-space depth in the box, including boulders extending past its tile.
      const x = VP[3] >= 0 ? tile.x0 - tile.pad : tile.x0 + batch.width + tile.pad;
      const y = VP[7] * mirror >= 0 ? tile.y0 : tile.y1;
      const z = VP[11] >= 0 ? tile.z0 - tile.pad : tile.z0 + batch.width + tile.pad;
      const depth = VP[3] * x + VP[7] * mirror * y + VP[11] * z + VP[15];
      const coarse = batch.coarseCount && tile.detailError * focalPixels < 0.9 * depth;
      gl.bindVertexArray(tile.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, coarse ? batch.coarseCount : batch.indexCount,
        gl.UNSIGNED_SHORT, coarse ? batch.indexCount * Uint16Array.BYTES_PER_ELEMENT : 0, tile.count);
    }
  }
}
const vCrys = vao([{ loc: loc(CRYSTAL, 'aPos'), size: 3, data: crystals.pos }, { loc: loc(CRYSTAL, 'aNor'), size: 3, data: crystals.nor }, { loc: loc(CRYSTAL, 'aC'), size: 4, data: crystals.c }]);
let grassDensity = 1;
const stars = starScatter(), vStars = vao([{ loc: loc(STARS, 'aS'), size: 4, data: stars.S }, { loc: loc(STARS, 'aC'), size: 4, data: stars.C }]);
bakeClouds(gl, program, FSQ, touch ? 512 : 1024);
bakeMilkyWay();
const motes = moteScatter();
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
function clearTexture(tex, zeros) {
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RED, gl.UNSIGNED_BYTE, zeros);
}

let reflTex = null, reflFbo = null, reflDepth = null, reflW = 0, reflH = 0;
let reflectionLevel = WATER;
const reflectionVP = new Float32Array(16);
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
  o = vec4(c / 16. * 0.35, 1.); }`);
const P_RAYS = program(FSQ, `uniform sampler2D tMap; uniform vec2 uSunUV; uniform float uVis; uniform vec3 uRayCol; in vec2 vUv; out vec4 o;
void main(){
  const float steps = 24.;
  vec2 toSun = uSunUV - vUv, stepUV = toSun / steps;
  float distanceToSun = length(toSun), weight = exp(-5. * distanceToSun);
  float gain = exp(5. * distanceToSun / steps) * 0.954;
  vec2 q = vUv + stepUV * 0.5;
  float scattered = 0.;
  for (int i = 0; i < 24; i++) {
    // Clamping an offscreen shaft to the last screen pixel stretches a bright
    // streak across the land. Integrate only actual openings in the canopy.
    if (any(lessThan(q, vec2(0.))) || any(greaterThan(q, vec2(1.)))) break;
    vec4 c = texture(tMap, q);
    float sunlit = smoothstep(0.34, 1.45, max(c.r, max(c.g, c.b)));
    scattered += c.a * sunlit * weight;
    weight *= gain; q += stepUV;
  }
  float foreground = 1. - 0.72 * texture(tMap, vUv).a;
  o = vec4(uRayCol * scattered * (uVis / steps) * foreground, 1.); }`);
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
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(post.ms); gl.deleteRenderbuffer(post.msC); gl.deleteRenderbuffer(post.msD);
      post.ms = post.msC = post.msD = null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  post.dRb = null;
  if (!post.ms) {
    post.dRb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, post.dRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  }
  post.resF = fboFor(post.res, post.dRb);
  post.mips = [];
  for (let i = 1; i <= 2; i++) { const mw = Math.max(2, w >> i), mh = Math.max(2, h >> i), t = colorTex(mw, mh); post.mips.push({ t, f: fboFor(t), w: mw, h: mh }); }
  const rw = Math.max(2, w >> 1), rh = Math.max(2, h >> 1), rt = colorTex(rw, rh); post.rays = { t: rt, f: fboFor(rt), w: rw, h: rh };
}
function pass(prog, fbo, w, h, tex) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h); gl.useProgram(prog);
  if (tex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.u('tMap'), 4); }
}
function postProcess(VP, eye, b, w, h) {
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.depthMask(false); gl.bindVertexArray(null);
  pass(P_PRE, post.mips[0].f, post.mips[0].w, post.mips[0].h, post.res);
  gl.uniform2f(P_PRE.u('uTexel'), 1 / w, 1 / h); gl.uniform1f(P_PRE.u('uThr'), HDR ? 1.45 : 0.90); gl.drawArrays(gl.TRIANGLES, 0, 3);
  for (let i = 1; i < post.mips.length; i++) { const s0 = post.mips[i - 1]; pass(P_DOWN, post.mips[i].f, post.mips[i].w, post.mips[i].h, s0.t); gl.uniform2f(P_DOWN.u('uTexel'), 1 / s0.w, 1 / s0.h); gl.drawArrays(gl.TRIANGLES, 0, 3); }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  for (let i = post.mips.length - 1; i > 0; i--) { const s0 = post.mips[i]; pass(P_UP, post.mips[i - 1].f, post.mips[i - 1].w, post.mips[i - 1].h, s0.t); gl.uniform2f(P_UP.u('uTexel'), 1 / s0.w, 1 / s0.h); gl.drawArrays(gl.TRIANGLES, 0, 3); }
  gl.disable(gl.BLEND);
  // Shafts scatter daylight near the star and fade with it.
  const rd = lightDirection;
  const P = [eye[0] + rd[0] * 1000, eye[1] + rd[1] * 1000, eye[2] + rd[2] * 1000, 1];
  const cx = VP[0] * P[0] + VP[4] * P[1] + VP[8] * P[2] + VP[12], cy = VP[1] * P[0] + VP[5] * P[1] + VP[9] * P[2] + VP[13], cw = VP[3] * P[0] + VP[7] * P[1] + VP[11] * P[2] + VP[15];
  const facing = b.f[0] * rd[0] + b.f[1] * rd[1] + b.f[2] * rd[2];
  const vis = cw > 0 ? Math.max(0, Math.min(1, (facing - 0.05) / 0.45)) : 0;
  const rayStrength = vis > 0 ? (HDR ? 0.68 : 0.48) * (1 - night) : 0;
  if (rayStrength > 0) {
    pass(P_RAYS, post.rays.f, post.rays.w, post.rays.h, post.res);
    gl.uniform2f(P_RAYS.u('uSunUV'), cw > 0 ? cx / cw * 0.5 + 0.5 : 0.5, cw > 0 ? cy / cw * 0.5 + 0.5 : 0.5);
    gl.uniform1f(P_RAYS.u('uVis'), vis); gl.uniform3fv(P_RAYS.u('uRayCol'), [1.0 * (1 - night) + 0.25 * night, 0.62 * (1 - night) + 0.38 * night, 0.36 * (1 - night) + 0.8 * night]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  pass(P_FINAL, null, w, h, null);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, post.res); gl.uniform1i(P_FINAL.u('tScene'), 4);
  gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, post.mips[0].t); gl.uniform1i(P_FINAL.u('tBloom'), 5);
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, post.rays.t); gl.uniform1i(P_FINAL.u('tRays'), 6);
  gl.uniform1f(P_FINAL.u('uBloom'), 0.085); gl.uniform1f(P_FINAL.u('uRays'), rayStrength); gl.uniform1f(P_FINAL.u('uHDRf'), HDR ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
}

// ---------------------------------------------------------------- engine state
let engine, glowF, groundF, wearF, mode = BOXEL;
const brush = new BrushField();
const bendTex = gl.createTexture();
gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, bendTex);
gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, brush.size, brush.size);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
const rippleUniform = new Float32Array(48);
const ripples = []; // [x, z, impact time, strength, local downstream speed]
let rippleCount = 0;
let simT = 0;

function setMode(m) {
  mode = m; ripples.length = 0;
  acc = { frames: 0, t: 0, ms: 0, up: 0 }; wall = 0;
  for (const f of [glowF, groundF, wearF]) f.set(m);
}

// events: what the world does to the fields
function footstep(x, z, inWater, wetFeet, run, depth = 0.35, at = simT) {
  glowF.deposit(x, z, 2, inWater ? 0.75 : 0.85);
  if (!inWater) { wearF.deposit(x, z, 0, run ? 0.3 : 0.2); if (wetFeet > 0) groundF.deposit(x, z, 2, 0.45 * wetFeet); }
  else ripple(x, z, (run ? 0.85 : 0.55) * (0.55 + 0.45 * sm(0.02, 0.42, depth)), at);
}
function splash(x, z, water, strength = 1.4, at = simT) {
  if (water) { glowF.deposit(x, z, 9, 1); ripple(x, z, strength, at); for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283; groundF.deposit(x + Math.cos(a) * 2.2, z + Math.sin(a) * 2.2, 5, 0.5); } }
  else { glowF.deposit(x, z, 6, 1); groundF.deposit(x, z, 4, 0.25); wearF.deposit(x, z, 0, 0.5); }
}
function ripple(x, z, strength, at = simT) {
  const event = [x, z, at, strength, 0.34 * sm(0.02, 0.65, waterLevel(x, z))];
  if (ripples.length < 12) { ripples.push(event); return; }
  // A new spore may displace a fading ring. Preserve a nearby fresh footfall or stone.
  let replace = -1, weakest = strength;
  for (let i = 0; i < ripples.length; i++) {
    const r = ripples[i], remaining = r[3] * Math.exp(-0.65 * (simT - r[2]));
    if (remaining < weakest) { replace = i; weakest = remaining; }
  }
  if (replace >= 0) ripples[replace] = event;
}
function prepareRipples(t) {
  rippleCount = 0;
  for (let i = ripples.length - 1; i >= 0; i--) {
    const [x, z, at, strength, current] = ripples[i], age = t - at;
    if (age >= 6) { ripples.splice(i, 1); continue; }
    if (age < 0) continue;
    const drift = age * current, k = 4 * rippleCount++;
    rippleUniform[k] = drift ? x + riverX(z + drift) - riverX(z) : x;
    rippleUniform[k + 1] = z + drift;
    rippleUniform[k + 2] = age * (1.35 + strength * 0.21);
    rippleUniform[k + 3] = 0.105 * strength * Math.exp(-0.55 * age) * sm(0, 0.09, age) * (1 - sm(5, 6, age));
  }
}
function spore(r) {
  const x = (r() * 2 - 1) * (HALF - 2), z = (r() * 2 - 1) * (HALF - 2), y = H(x, z);
  glowF.deposit(x, z, 1 + Math.floor(r() * 3), 0.5);
  if (y < waterLevel(x, z) && r() < 0.2) ripple(x, z, 0.25);
}

// Pods drift downhill to the lake. Their draw and their 5 Hz field deposits use the same path.
const PODS = 8;
function podPosition(i, t) {
  const phase = (i / PODS + t / 70) % 1, z = -62 + 48 * phase;
  const x = riverX(z) + 0.64 * Math.sin(z * 0.47 + i * 1.8);
  return [x, waterLevel(x, z) + 0.07, z];
}
function skimWater(x, z) { glowF.deposit(x, z, 3, 0.42); ripple(x, z, 0.38); }
function riverEvents(t, dt) {
  sailwings.skim(t, dt, skimWater);
  if (Math.floor(t * 5) === Math.floor((t - dt) * 5)) return;
  for (let i = 0; i < PODS; i++) {
    const [x, , z] = podPosition(i, t);
    glowF.deposit(x, z, 1, 0.2);
  }
  glowF.deposit(riverX(-46), -46, 2, 0.12);
}

// ---------------------------------------------------------------- camera + player
const player = { x: START[0], z: START[1], y: 0, yaw: 0.05, pitch: 0.06, vx: 0, vz: 0, stride: 0, bob: 0, foot: 1, wet: 0 };
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

function walkable(x, z, ground = H(x, z)) { return ground > waterLevel(x, z) - 1.25 && inMap(x, z, 1); }

function crossSlope(dx, dz, ground) {
  const x = player.x, z = player.z;
  const edge = HALF - 1.001;
  dx = Math.min(edge, Math.max(-edge, x + dx)) - x;
  dz = Math.min(edge, Math.max(-edge, z + dz)) - z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-5) return ground;
  const maxGrade = 0.80;
  const ahead = H(x + dx, z + dz), grade = (ahead - ground) / length;
  if (grade > maxGrade || !walkable(x + dx, z + dz, ahead)) {
    // Keep the component along a steep face or the edge of deep water. Testing
    // the combined move prevents gaining height by alternating the X and Z axes.
    const n = normalAt(x, z, 0.2), horizontal = n[0] * n[0] + n[2] * n[2];
    if (horizontal < 1e-6) return ground;
    const across = (dx * n[0] + dz * n[2]) / horizontal;
    dx -= across * n[0]; dz -= across * n[2];
  } else {
    const pace = 1 / (Math.hypot(1, grade) * (1 + 0.27 * Math.max(0, grade)));
    dx *= pace; dz *= pace;
  }
  const to = H(x + dx, z + dz);
  if (!walkable(x + dx, z + dz, to) || to - ground > maxGrade * Math.hypot(dx, dz) + 1e-5) return ground;
  player.x = x + dx; player.z = z + dz;
  return to;
}

function stepPlayer(dt) {
  let mx = 0, mz = 0;
  if (keys.KeyW || keys.ArrowUp) mz += 1; if (keys.KeyS || keys.ArrowDown) mz -= 1;
  if (keys.KeyA || keys.ArrowLeft) mx -= 1; if (keys.KeyD || keys.ArrowRight) mx += 1;
  if (stick.id !== null) { mx += stick.x; mz += -stick.y; }
  const len = Math.hypot(mx, mz);
  const ground = H(player.x, player.z), level = waterLevel(player.x, player.z), inWater = ground < level - 0.05, depth = Math.max(0, level - ground);
  const run = keys.ShiftLeft || keys.ShiftRight || (stick.id !== null && len > 0.92);
  const pace = len > 0.05 ? (run ? 4.2 : 1.9) * (1 - Math.min(0.6, depth * 0.45)) / Math.max(1, len) : 0;
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  const vx = (sy * mz + cy * mx) * pace, vz = (-cy * mz + sy * mx) * pace;
  // Integrate the eased velocity over the frame, including the last fraction of a step on release.
  const rate = pace ? 10 : 17, blend = -Math.expm1(-rate * dt);
  const dx = vx * dt + (player.vx - vx) * blend / rate, dz = vz * dt + (player.vz - vz) * blend / rate;
  player.vx += (vx - player.vx) * blend; player.vz += (vz - player.vz) * blend;
  const oldX = player.x, oldZ = player.z, target = crossSlope(dx, dz, ground);
  const distance = Math.hypot(player.x - oldX, player.z - oldZ, target - ground);
  const speed = distance / dt, strideLen = 0.60 + 0.27 * sm(1.5, 4.2, speed);
  const phase = player.stride + distance / strideLen;
  if (phase >= 1) {
    player.foot = -player.foot;
    const u = (1 - player.stride) * strideLen / distance;
    const x = oldX + (player.x - oldX) * u + cy * 0.14 * player.foot;
    const z = oldZ + (player.z - oldZ) * u + sy * 0.14 * player.foot;
    const footDepth = waterLevel(x, z) - H(x, z);
    footstep(x, z, footDepth > 0.015, player.wet, speed > 2.6, footDepth, simT - (1 - u) * dt);
  }
  player.stride = phase % 1;
  const bob = (0.014 + 0.014 * sm(2, 4.2, speed)) * Math.min(1, speed) * Math.sin(player.stride * Math.PI) ** 2;
  player.bob += (bob - player.bob) * -Math.expm1(-24 * dt);
  player.wet = inWater ? 1 : Math.max(0, player.wet - dt / 9);
  player.y += (target - player.y) * -Math.expm1(-15 * dt);
  brush.advance(player.x, target, player.z, dt);
}

function throwStone() {
  const b = camBasis(player.yaw, player.pitch);
  const eye = [player.x, player.y + 1.65, player.z];
  stones.push({ p: [eye[0] + b.f[0] * 0.4, eye[1] + b.f[1] * 0.4 - 0.1, eye[2] + b.f[2] * 0.4], v: [b.f[0] * 15, b.f[1] * 15 + 3.5, b.f[2] * 15], t: 0 });
}
function stepStones(dt) {
  for (let i = stones.length - 1; i >= 0; i--) {
    const s = stones[i]; s.t += dt;
    const [x, y, z] = s.p, dx = s.v[0] * dt, dz = s.v[2] * dt, dy = (s.v[1] - 4.9 * dt) * dt;
    s.p[0] += dx; s.p[1] += dy; s.p[2] += dz; s.v[1] -= 9.8 * dt;
    if (s.t > 6) { stones.splice(i, 1); continue; }
    if (s.p[1] > Math.max(H(s.p[0], s.p[2]), waterLevel(s.p[0], s.p[2]))) continue;
    // Locate the first contact within this step, including the elevated river.
    let lo = 0, hi = 1;
    for (let j = 0; j < 8; j++) {
      const u = (lo + hi) / 2, px = x + dx * u, pz = z + dz * u;
      if (y + dy * u > Math.max(H(px, pz), waterLevel(px, pz))) lo = u; else hi = u;
    }
    const px = x + dx * hi, pz = z + dz * hi;
    const remaining = (1 - hi) * dt, impactY = s.v[1] + 9.8 * remaining;
    const strength = Math.min(1.65, 0.5 + 0.085 * Math.hypot(impactY, 0.5 * s.v[0], 0.5 * s.v[2]));
    splash(px, pz, H(px, pz) < waterLevel(px, pz), strength, simT - remaining);
    stones.splice(i, 1);
  }
}

// ---------------------------------------------------------------- render
const SUN = norm([-0.86, 0.40, -0.33]), SUNCOL = [3.65, 2.98, 2.13], PLANET = skyBodies.amber, MOONCOL = [0.19, 0.29, 0.55];
let night = 0, nightTarget = 0, sheet = 0, grassDrawn = 0;
function norm(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }
function bakeFloraSpill(plants) {
  const size = 256, perMetre = size / EXTENT;
  const energy = new Float32Array(size * size * 5);
  for (let i = 0; i < plants.P.length; i += 4) {
    const type = plants.F[i + 3];
    if (type < 4) continue;
    const [x, y, z] = plants.P.subarray(i, i + 3);
    // One source per cup or bell, irrespective of how many strips form its petals.
    if (i && x === plants.P[i - 4] && z === plants.P[i - 2]) continue;
    const extent = plants.F[i + 1] * plants.P[i + 3], radius = extent * (type === 4 ? 0.90 : 1.65);
    const hue = plants.S2[i + 3], warm = type === 6 ? sm(0.37, 0.70, hue) : sm(0.40, 0.57, hue);
    const bell = x * 0.21 + z * 0.17, bellHue = 0.5 * (bell - Math.floor(bell));
    const pigment = type === 6 ? [0.13 + 0.75 * warm, 0.69 - 0.37 * warm, 0.51 - 0.36 * warm]
      : type === 4 ? [0.88 - 0.16 * bellHue, 0.30 + 0.12 * bellHue, 0.70 + 0.28 * bellHue]
      : [0.085 + 0.855 * warm, 0.72 - 0.50 * warm, 0.62 - 0.28 * warm];
    const cx = (x + HALF) * perMetre - 0.5, cz = (z + HALF) * perMetre - 0.5, r = radius * perMetre;
    for (let j = Math.max(0, Math.ceil(cz - r)); j <= Math.min(size - 1, cz + r); j++) {
      for (let k = Math.max(0, Math.ceil(cx - r)); k <= Math.min(size - 1, cx + r); k++) {
        const weight = Math.max(0, 1 - ((cx-k)**2 + (cz-j)**2) / (r*r)) ** 2 * (type === 6 ? 0.23 : type === 5 ? 0.64 : 0.26);
        const q = (j * size + k) * 5;
        for (let channel = 0; channel < 3; channel++) energy[q + channel] += pigment[channel] * weight;
        energy[q + 3] += (y + extent * 0.65) * weight;
        energy[q + 4] += weight;
      }
    }
  }
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const k = 5 * i, w = energy[k + 4];
    for (let c = 0; c < 3; c++) rgba[4*i + c] = Math.round(255 * (1 - Math.exp(-energy[k+c])));
    if (w) {
      const weight = (rgba[4*i] + rgba[4*i + 1] + rgba[4*i + 2]) / 3;
      rgba[4*i + 3] = Math.round(weight * Math.min(1, Math.max(0, (energy[k + 3] / w + 4) / 32)));
    }
  }
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE10);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
const valleyShadows = bakeShadows(gl, touch ? 1024 : 2048, [SUN, PLANET], [
  { source: TERRAIN, draw() { gl.bindVertexArray(near.vao); gl.drawElements(gl.TRIANGLES, near.count, gl.UNSIGNED_INT, 0); } },
  { source: ROCK, draw: drawRocks },
  { source: HIGH_CANOPY, draw: drawHighCanopy },
  { source: WOOD, draw() { gl.bindVertexArray(vWood); gl.drawElements(gl.TRIANGLES, woodIndices, gl.UNSIGNED_INT, 0); } },
  { source: JLEAF, draw() {
    if (!leaves.count) return;
    // The first occupied tile starts at zero in the shared instance buffers.
    gl.bindVertexArray(leaves.tiles[0].vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, leaves.verts, leaves.count);
  } },
]);
// the night sky turns about a tilted pole, once in about fifteen minutes
const POLE = norm([0.25, 0.8, 0.55]), skyTurn = new Float32Array(9);
function turnSky(t) {
  const a = t * 0.007, c = Math.cos(a), s = Math.sin(a), k = 1 - c, [x, y, z] = POLE;
  skyTurn.set([c + x * x * k, y * x * k + z * s, z * x * k - y * s, x * y * k - z * s, c + y * y * k, z * y * k + x * s, x * z * k + y * s, y * z * k - x * s, c + z * z * k]);
}

let frameNumber = 0, lightDirection = SUN, lightColor = SUNCOL;
function common(p, eye, VP, mirror, t) {
  gl.useProgram(p);
  if (p.worldFrame === undefined) {
    gl.uniform1i(p.u('uShadows'), 9); gl.uniform1i(p.u('uFloraSpill'), 10);
    gl.uniform1i(p.u('uClouds'), 11); gl.uniform1i(p.u('uCanopy'), 12);
    gl.uniform1i(p.u('uBendTex'), 13);
    gl.uniform1i(p.u('uGlow'), 0); gl.uniform1i(p.u('uGround'), 1); gl.uniform1i(p.u('uWear'), 7);
    gl.uniform1i(p.u('uMilky'), 8); gl.uniform1i(p.u('uRefl'), 2);
    gl.uniformMatrix4fv(p.u('uLightVP[0]'), false, valleyShadows.matrices);
    gl.uniform3fv(p.u('uStarDir'), SUN); gl.uniform3fv(p.u('uPlanetDir'), PLANET);
    gl.uniform1f(p.u('uHDR'), HDR ? 1 : 0); gl.uniform1f(p.u('uExtent'), EXTENT);
  }
  if (p.worldFrame !== frameNumber) {
    p.worldFrame = frameNumber;
    gl.uniform3fv(p.u('uSunDir'), lightDirection); gl.uniform3fv(p.u('uSunCol'), lightColor);
    gl.uniform1f(p.u('uNight'), night);
    gl.uniform1f(p.u('uExposure'), 0.95 + 0.3 * night); gl.uniform1f(p.u('uTime'), t);
    gl.uniform1f(p.u('uSheet'), sheet); gl.uniformMatrix3fv(p.u('uSky'), false, skyTurn);
    gl.uniform1f(p.u('uWind'), TEST ? 0.7 : (rain ? 1.15 : 0.7) + 0.2 * Math.sin(t * 0.13));
    if (p === GRASS || p === JLEAF || p === PLANT) {
      gl.uniform3f(p.u('uBrush'), player.x, player.z, brush.cells.size ? 1 : 0);
    }
    if (p === WATERP || p === ROCK || p === CRYSTAL) {
      gl.uniform1i(p.u('uRipCount'), rippleCount);
      if (rippleCount) gl.uniform4fv(p.u('uRip[0]'), rippleUniform, 0, rippleCount * 4);
    }
  }
  gl.uniformMatrix4fv(p.u('uVP'), false, VP); gl.uniform3fv(p.u('uCam'), eye);
  gl.uniform1f(p.u('uMirror'), mirror); gl.uniform1f(p.u('uClip'), mirror < 0 ? reflectionLevel - 0.02 : -1e9);
}
const terrainMultiDraw = gl.getExtension('WEBGL_multi_draw');
function drawTerrain(mesh, planes) {
  const { drawCounts, byteOffsets } = mesh;
  let runs = 0, end = -1;
  for (const patch of mesh.patches) {
    if (outsideView(planes, patch, patch.width, patch.depth)) continue;
    if (end !== patch.first) {
      byteOffsets[runs] = patch.first * Uint32Array.BYTES_PER_ELEMENT;
      drawCounts[runs++] = 0;
    }
    drawCounts[runs - 1] += patch.end - patch.first;
    end = patch.end;
  }
  if (!runs) return;
  gl.bindVertexArray(mesh.vao);
  if (terrainMultiDraw && runs > 1) {
    terrainMultiDraw.multiDrawElementsWEBGL(gl.TRIANGLES, drawCounts, 0, gl.UNSIGNED_INT, byteOffsets, 0, runs);
  } else {
    for (let i = 0; i < runs; i++) gl.drawElements(gl.TRIANGLES, drawCounts[i], gl.UNSIGNED_INT, byteOffsets[i]);
  }
}
function drawScene(eye, b, VP, mirror, t, opts) {
  const planes = prepareViewPlanes(VP, mirror);
  gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE); gl.frontFace(mirror < 0 ? gl.CW : gl.CCW);
  common(TERRAIN, eye, VP, mirror, t);
  drawTerrain(near, planes);
  drawTerrain(far, planes);
  common(ROCK, eye, VP, mirror, t); drawRocks(VP, mirror, opts.px * 400 / opts.tanY, planes);
  common(CRYSTAL, eye, VP, mirror, t); gl.bindVertexArray(vCrys); gl.drawArrays(gl.TRIANGLES, 0, crystals.count);
  gl.disable(gl.CULL_FACE);
  common(HIGH_CANOPY, eye, VP, mirror, t); drawHighCanopy(planes, mirror, eye);
  common(sailwings.shader, eye, VP, mirror, t); sailwings.draw(t);
  common(WOOD, eye, VP, mirror, t); gl.bindVertexArray(vWood); gl.drawElements(gl.TRIANGLES, woodIndices, gl.UNSIGNED_INT, 0);
  // The half-resolution water image uses fewer, wider leaf strips to preserve canopy cover.
  common(JLEAF, eye, VP, mirror, t); leaves.draw(planes, eye, mirror < 0 ? 0.62 : 1);
  common(PLANT, eye, VP, mirror, t); plants.draw(planes, eye, mirror < 0 ? 0.72 : 1);
  if (opts.grass) { common(GRASS, eye, VP, mirror, t); grassDrawn = grass.draw(planes, eye, grassDensity); }
  // Shade the sky only through gaps left in the opaque scene.
  gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
  gl.bindVertexArray(null); // The sky only uses gl_VertexID.
  common(SKY, eye, VP, mirror, t);
  gl.uniform3fv(SKY.u('uR'), b.r); gl.uniform3fv(SKY.u('uU'), b.u); gl.uniform3fv(SKY.u('uF'), b.f); gl.uniform2f(SKY.u('uTan'), opts.tanX, opts.tanY);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // Each star pixel inherits the transmittance written by the actual globe, moon, ring and cloud shaders.
  if (night > 0) {
    common(STARS, eye, VP, mirror, t); gl.uniform1f(STARS.u('uPx'), opts.px);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
    gl.bindVertexArray(vStars); gl.drawArrays(gl.POINTS, 0, STAR_N); gl.disable(gl.BLEND); gl.bindVertexArray(null);
  }
  gl.depthMask(true); gl.depthFunc(gl.LESS);
}

function render(t, camOverride) {
  const dpr = Math.min(devicePixelRatio || 1, touch ? 1.5 : 2) * renderScale;
  const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const fov = 1.15, aspect = w / h, tanY = Math.tan(fov / 2), tanX = tanY * aspect;
  const cam = camOverride || { eye: [player.x, player.y + 1.65 + player.bob, player.z], yaw: player.yaw, pitch: player.pitch };
  const b = camBasis(cam.yaw, cam.pitch);
  const VP = viewProj(cam.eye, b, fov, aspect);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texGlow);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texGround);
  gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, texWear);
  if (brush.dirty) {
    gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, bendTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, brush.size, brush.size, gl.RGBA, gl.UNSIGNED_BYTE, brush.bytes);
    brush.dirty = false;
  }
  sheet = groundF ? groundF.sheet : 0;
  turnSky(t);
  prepareRipples(t);
  frameNumber++;
  lightDirection = norm(SUN.map((v, i) => v * (1 - night) + PLANET[i] * night));
  lightColor = SUNCOL.map((v, i) => v * (1 - night) + MOONCOL[i] * night);
  const waterPlanes = prepareViewPlanes(VP, 1);
  const waterInView = wm.tiles.some(tile => !outsideView(waterPlanes, tile, tile.width, tile.depth));
  if (waterInView) {
    // One planar reflection shared by the lake and the uphill river. Near the stream it
    // follows the local water elevation. Reaches at other heights blend into a sky reflection.
    const channelX = riverX(cam.eye[2]), channelLevel = waterLevel(channelX, cam.eye[2]);
    reflectionLevel = channelLevel * (1 - sm(5, 14, Math.abs(cam.eye[0] - channelX)));
    reflectionVP.set(VP);
    for (let i = 0; i < 4; i++) reflectionVP[12 + i] += 2 * reflectionLevel * VP[4 + i];
    const rw = Math.max(1, w >> 1), rh = Math.max(1, h >> 1);
    ensureRefl(rw, rh);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, reflFbo); gl.viewport(0, 0, rw, rh);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawScene([cam.eye[0], 2 * reflectionLevel - cam.eye[1], cam.eye[2]], b, reflectionVP, -1, t, { tanX, tanY, grass: false, px: rh / 800 });
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
  }
  ensurePost(w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, post.ms || post.resF); gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawScene(cam.eye, b, VP, 1, t, { tanX, tanY, grass: true, px: h / 800 });
  gl.enable(gl.BLEND); gl.depthMask(false);
  if (waterInView) {
    gl.colorMask(true, true, true, false);
    common(WATERP, cam.eye, VP, 1, t);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, reflTex);
    gl.uniform2f(WATERP.u('uRes'), w, h);
    gl.uniform2f(WATERP.u('uRightXZ'), b.r[0], b.r[2]); gl.uniform1f(WATERP.u('uMirrorLevel'), reflectionLevel);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(wm.vao); gl.drawElements(gl.TRIANGLES, wm.count, gl.UNSIGNED_INT, 0);
  }
  // particles: additive colour, and they cut themselves out of the sky mask so the rays never streak them
  gl.colorMask(true, true, true, true); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
  common(POINTS, cam.eye, VP, 1, t); gl.uniform1f(POINTS.u('uScale'), h * 0.9); gl.uniform2f(POINTS.u('uCamXZ'), cam.eye[0], cam.eye[2]);
  if (night > 0.001 && (!camOverride || camOverride.motes)) { gl.uniform1i(POINTS.u('uRain'), 2); gl.bindVertexArray(vMotes); gl.drawArrays(gl.POINTS, 0, MOTE_N); }
  for (let i = 0; i < PODS; i++) stoneBuf.set([...podPosition(i, t), 0.36], i * 4);
  gl.bindBuffer(gl.ARRAY_BUFFER, stoneVbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, stoneBuf);
  gl.uniform1i(POINTS.u('uRain'), 3); gl.bindVertexArray(vStone); gl.drawArrays(gl.POINTS, 0, PODS);
  if (!camOverride) {
    if (rain) { gl.uniform1i(POINTS.u('uRain'), 1); gl.bindVertexArray(vRain); gl.drawArrays(gl.POINTS, 0, RAIN_N); }
    if (stones.length) {
      stones.slice(0, 8).forEach((s, i) => stoneBuf.set([s.p[0], s.p[1], s.p[2], 0.9], i * 4));
      gl.bindBuffer(gl.ARRAY_BUFFER, stoneVbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, stoneBuf);
      gl.uniform1i(POINTS.u('uRain'), 0); gl.bindVertexArray(vStone); gl.drawArrays(gl.POINTS, 0, Math.min(8, stones.length));
    }
  }
  gl.depthMask(true); gl.disable(gl.BLEND); gl.bindVertexArray(null); gl.colorMask(true, true, true, true);
  gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
  if (post.ms) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, post.ms); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, post.resF);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
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

function advanceWorld(dt) {
  simT += dt;
  stepPlayer(dt); stepStones(dt); riverEvents(simT, dt);
  if (rain) { sporeAcc += dt * 30; while (sporeAcc >= 1) { spore(sporeR); sporeAcc -= 1; } if (groundF.sheet < 0.45) groundF.rain(dt * 0.025); }
  const t0 = performance.now();
  for (const f of layers()) f.advance(dt);
  acc.ms += performance.now() - t0;
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
  const elapsed = Math.max(0, (now - last) / 1000);
  last = now;
  if (elapsed < 0.25) adaptDensity(elapsed);
  const dt = Math.min(0.1, elapsed);
  night += (nightTarget - night) * Math.min(1, dt * 0.7);
  // Finish the crossfade so day-only and night-only passes can go idle again.
  if (Math.abs(nightTarget - night) < 0.0001) night = nightTarget;
  if (started && dt > 0) {
    // A 24 or 30 Hz display advances the same game clock as a 60 Hz display.
    // Bound physics steps, then send the final field textures just once per frame.
    const steps = Math.ceil(dt * 30);
    for (let i = 0; i < steps; i++) advanceWorld(dt / steps);
    for (const field of layers()) acc.up += field.upload();
    acc.frames++;
  } else simT += dt;
  render(simT);
  if (!started) return;
  acc.t += dt;
  if (!wall) wall = now - elapsed * 1000;
  if (acc.t > 0.33 && acc.frames > 0) {
    const f = acc.frames, st = layers().map((l) => l.stats());
    let stepped = 0, denseCells = 0;
    layers().forEach((l, i) => {
      stepped += st[i].stepped - l.lastStepped;
      denseCells += (l.steps - l.lastSteps) * N * N;
      l.lastStepped = st[i].stepped;
      l.lastSteps = l.steps;
    });
    hud.fps.textContent = Math.round(f / Math.max(1e-3, (now - wall) / 1000)) + ' fps'; wall = now;
    hud.step.textContent = fmt(stepped / f);
    hud.dense.textContent = fmt(denseCells / f);
    hud.bar.style.width = Math.max(0.6, Math.min(100, stepped / Math.max(1, denseCells) * 100)) + '%';
    hud.awake.textContent = st.map((s) => fmt(s.blocks)).join(' · ');
    hud.ms.textContent = time(acc.ms / f);
    hud.mem.textContent = bytes(st.reduce((n, s) => n + s.bytes, 0)) + (mode === BOXEL ? ' of ' + bytes(3 * N * N * 8) : '');
    hud.up.textContent = bytes(acc.up / f);
    const bound = Math.max(...st.map((s) => s.bound)), broken = st.reduce((n, s) => n + s.violations, 0);
    hud.promise.textContent = mode === BOXEL
      ? `${(bound * 255).toFixed(2)}/255${bound > TOLERANCE ? ' (over target)' : ''} · ${broken} audit failures`
      : 'dense reference';
    acc = { frames: 0, t: 0, ms: 0, up: 0 };
  }
}

function refreshModeUI() {
  hud.mode.firstElementChild.textContent = MODE_NAME[mode];
  hud.mode.className = 'mode' + (mode === DENSE ? ' dense' : '');
  document.getElementById('bMode').textContent = MODE_NAME[mode];
  hud.note.textContent = mode === BOXEL
    ? 'The bound tracks how far the sparse field can differ from the full calculation. The target is 1/255. Each retiring block is checked against its budget.'
    : 'Dense mode updates every cell on the map. Switch engines to restart the three fields and compare their cost.';
}
function cycleMode() { setMode(mode === BOXEL ? DENSE : BOXEL); refreshModeUI(); }

// ---------------------------------------------------------------- input
function bindInput() {
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (!started || e.repeat) return;
    if (e.code === 'KeyF') throwStone();
    if (e.code === 'KeyR') toggleRain();
    if (e.code === 'KeyM') cycleMode();
    if (e.code === 'KeyH') toggleHud();
    if (e.code === 'KeyN') toggleNight();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    player.vx = player.vz = player.bob = 0;
    stick = { x: 0, y: 0, id: null };
    lookId = lookLast = null;
    document.getElementById('knob').style.transform = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    last = performance.now();
    perfT.length = 0;
    wall = 0;
  });
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
function skyView(direction) {
  return { eye: [START[0], H(...START) + 1.7, START[1]], yaw: Math.atan2(direction[0], -direction[2]), pitch: Math.asin(direction[1]) };
}
const VIEWS = {
  amber: skyView(skyBodies.amber),
  rose: skyView(skyBodies.rose),
  ocean: skyView(skyBodies.ocean),
  ice: skyView(skyBodies.ice),
  summit: { eye: [summit[0], H(...summit) + 1.65, summit[1]], yaw: 2.48, pitch: -0.24 },
  trail: { eye: [trail[0][0], H(...trail[0]) + 1.65, trail[0][1]], yaw: Math.atan2(trail[1][0] - trail[0][0], trail[0][1] - trail[1][1]), pitch: 0.02 },
  river: { eye: [riverX(-47) + 4, H(riverX(-47) + 4, -47) + 1.65, -47], yaw: -1.05, pitch: -0.36 },
  shore: { eye: [SHORE_CAM[0], H(...SHORE_CAM) + 2.6, SHORE_CAM[1]], yaw: -0.95, pitch: -0.24, motes: true },
  planet: { eye: [START[0], H(...START) + 1.7, START[1]], yaw: 0.05, pitch: 0.12, motes: true },
  sunset: { eye: [12, H(12, 4) + 1.7, 4], yaw: -1.5, pitch: 0.08, motes: true },
  outcrop: { eye: [12, H(12, -14) + 1.7, -14], yaw: 0.9, pitch: 0.05, motes: true },
  beach: { eye: [12.5, H(12.5, 28) + 1.5, 28], yaw: -1.9, pitch: -0.32, motes: false },
  stack: { eye: [ISLET[0] + 9, 1.4, ISLET[1] + 6], yaw: -0.98, pitch: -0.08, motes: false },
  galaxy: { eye: [START[0], H(...START) + 1.7, START[1]], yaw: 2.6, pitch: 0.75, motes: false },
  coil: coilView,
  get crystals() { const [x, z] = sc.crystalSites[3], ex = x + 2.4, ez = z + 2.4; return { eye: [ex, H(ex, ez) + 1.4, ez], yaw: -0.785, pitch: -0.28, motes: false }; },
  lantern: lanternView,
  get grove() { const x = sc.trees[7 * 5] + 2.2, z = sc.trees[7 * 5 + 2] + 2.2; return { eye: [x, H(x, z) + 1.1, z], yaw: -0.785, pitch: -0.3, motes: false }; },
};
/** A close look at the first plant of a species, from a metre and a half away. */
function plantView(pl, type) {
  let i = 0; while (i < pl.F.length / 4 && pl.F[i * 4 + 3] !== type) i++;
  const x = pl.P[i * 4] + 1.0, z = pl.P[i * 4 + 2] + 1.0;
  return { eye: [x, Math.max(H(x, z), pl.P[i * 4 + 1]) + 1.2, z], yaw: -0.785, pitch: -0.62, motes: false };
}
function scripted(m, frames = 900, view = 'shore') {
  setMode(m); started = false; rain = false; stones.length = 0;
  brush.reset();
  const r = rng(4242); simT = 0;
  if (view === 'render') { render(12.0, VIEWS[frames]); return {}; }
  const t0 = performance.now();
  let stride = 0, foot = 1, px = 9, pz = 9;
  for (let f = 0; f < frames; f++) {
    const dt = 1 / 60; simT += dt; riverEvents(simT, dt);
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
    for (const l of layers()) l.advance(dt);
  }
  const ms = performance.now() - t0;
  for (const l of layers()) l.upload();
  ripples.length = 0;
  render(simT, { ...(VIEWS[view] || VIEWS.shore), motes: view === 'planet' });
  const st = layers().map((l) => l.stats());
  const stepped = st.reduce((sum, s) => sum + s.stepped, 0);
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
  if (TEST) {
    window.__game.verify = async (view) => {
      const { verify } = await import('./verify.js');
      return verify({ gl, layers, scripted, denseMode: DENSE, boxelMode: BOXEL, size: N, tolerance: TOLERANCE }, view);
    };
    document.documentElement.classList.remove('intro'); document.getElementById('intro').hidden = true; document.getElementById('pad').hidden = true; document.getElementById('cross').hidden = true; return; }
  bindInput();
  document.getElementById('intro').addEventListener('click', () => {
    document.getElementById('intro').hidden = true; document.documentElement.classList.remove('intro'); started = true;
    if (!touch) canvas.requestPointerLock?.()?.catch?.(() => {});
  });
  requestAnimationFrame((t) => { last = t; frame(t); });
})().catch((e) => fail('The field engine did not start: ' + e.message));
