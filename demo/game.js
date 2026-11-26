import { createWind, windShader } from './wind.js';
import { bakeTrailMaterial } from './trail-material.js';
import { loadRockSurface, uploadRockSurface } from './rock-material.js';
import { galaxyFragment } from './galaxy.js';
import { FieldTexture } from './field-texture.js';
import { bakeMeadow, BLADE_HEIGHT_RANGE, CLUMP, clumpGLSL } from './meadow.js';
import { BrushField } from './brush.js';
import { waterBounds } from './water-view.js';
import { stoneBed, stoneDrop, stoneSpacing } from './stone-bed.js';
import { coarsePatch } from './terrain-lod.js';
import { highCanopyMesh, highCanopySites } from './high-canopy.js';
import { createSailwings } from './fauna.js';
import { cloudSky, createClouds } from './clouds.js';
import { bakeCanopy, valleyAir, canopyShelter } from './atmosphere.js';
import { createAudio } from './audio.js';
import { bakeGroundLight, groundLight, mistFragment, viewRay } from './valley-light.js';
import { cameraJitter, depthRange, historyColor, temporalFragment } from './temporal.js';
import { bakeShadows } from './shadows.js';
// Tarnished Promise: sixteen acres of lake shore and highlands on Tarn, under a ringed giant.
//
// The world remembers you through three boxel fields on the unbounded plane of 12.5 cm cells:
//   glow      bioluminescence in the moss and the water   D 8 cells²/s, k 0.3/s, 60 steps/s
//   moisture  wet feet, splashes, spore rain               D 3 cells²/s, k 0.04/s, 15 steps/s
//   wear      trails packed into the soil                  no spread, k 0.008/s, 15 steps/s
// Each is certified to stay within 1/255 of computing every cell, and only the 16 × 16 blocks
// that can still matter exist. The renderer sees the map through one R8 texture per field and
// re-uploads exactly the blocks the engine holds, clearing the ones it lets go.

import { WORLD_HALF, VALLEY_HALF, spring, inRestArea, overlooks, rangeWalks, summit, trail, valleyWalks, terrainHeight, trailCover, trailDistance, riverX, riverFlow, waterLevel } from './landmarks.js';
import { companionWorlds, oceanAtlasFragment, skyBodies } from './worlds.js';
import { load } from '../ffi/boxel.js';

const EXTENT = 2 * WORLD_HALF, CELL = 0.125, N = EXTENT / CELL;
const LAKE = [-6, 8];                                     // lake centre (x, z)
const WATER = 0;                                          // water level
const BOXEL = 0, DENSE = 1;
const MODE_NAME = { 0: 'boxel', 1: 'dense' };
const rockSurfaceReady = loadRockSurface();
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
function ridged(x, y, footprint = 0) {
  let height = 0, weight = 0.55;
  for (let i = 0; i < 5; i++) {
    // The far mesh cannot resolve every mineral ridge. Fade each octave to
    // its mean energy as the vertex spacing approaches its wavelength.
    const detail = footprint ? 1 - sm(0.22, 0.72, footprint) : 1;
    const ridge = detail ? 1 - Math.abs(vnoise(x, y) * 2 - 1) : 0;
    height += weight * (detail * ridge * ridge + (1 - detail) * 0.48);
    x = x * 2.1 + 3; y = y * 2.1 + 9; footprint *= 2.1; weight *= 0.5;
  }
  return height;
}
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
function H(x, z, footprint = 0) {
  // meadow: small undulation on rolling swells
  const meadow = 0.7 + 1.1 * fbm(x * 0.045 + 3, z * 0.045 - 1) + 0.25 * fbm(x * 0.22, z * 0.22, 3) + 3.2 * (fbm(x * 0.017 - 7, z * 0.017 + 5, 3) - 0.4);
  // Beyond this box even the longest possible lobe lies outside the bank.
  const d = Math.abs(x - LAKE[0]) < 54 && Math.abs(z - LAKE[1]) < 43 ? lakeD(x, z) : 15;
  // a wadeable shelf all round the shore, then a drop into the basin
  const bowl = -0.6 * (1 - sm(8.5, 10.8, d)) - 4.4 * (1 - sm(1, 8.5, d)) - 0.35;
  const t = sm(9.6, 14, d);
  let h = bowl * (1 - t) + meadow * t;
  const ix = x - ISLET[0], iz = z - ISLET[1];
  if (Math.abs(ix) < 12 && Math.abs(iz) < 10) {
    // A bedding shelf with a low landing to the east and a scalloped western scarp.
    const a = Math.atan2(iz, ix), lip = 1 + 0.14*Math.sin(3*a+0.7) + 0.085*Math.sin(5*a-1.1);
    const weathering = vnoise(x*0.60+3.8, z*0.48-9) - 0.5;
    const r = Math.hypot((ix+iz*0.21)/7.0, iz/5.1) / (lip + 0.105*weathering);
    const apron = sm(-0.55,0.9,Math.cos(a-0.38));
    const crown = 2.05 - 0.035*ix + 0.13*(vnoise(x*0.65,z*0.65)-0.5);
    const shelf = crown - (0.32+0.85*apron)*sm(0.48,0.86+0.09*weathering,r)
      - (1.48-0.80*apron)*sm(0.72-0.14*weathering,1.05+0.16*apron,r);
    h += (shelf-h)*(1-sm(0.91,1.40,r));
  }
  // A continuous stone shoulder carries the trail. Fractured rock emerges on its flanks.
  const o = outcrop(x, z);
  if (o > 0) {
    const shoulder = 4.3 + 1.35 * vnoise(x * 0.065 + 4, z * 0.065 - 2);
    const rough = sm(0.9, 4, trailDistance(x, z));
    h += o * (shoulder + rough * 3.8 * (ridged(x * 0.05 + 4, z * 0.05 - 2) - 0.44)) * t;
  }
  const e = Math.hypot(x, z * 1.05);
  h += sm(40, 76, e) * (4 + 8 * fbm(x * 0.04 + 9, z * 0.04 + 2));
  // Keep the mountain skyline anchored to the original valley as the walks extend up its lower slopes.
  const edgeDistance = Math.max(Math.abs(x), Math.abs(z));
  const scale = edgeDistance > VALLEY_HALF ? 2 - VALLEY_HALF / edgeDistance : 1;
  const range = e * scale, m = sm(84, 520, range);
  if (m > 0) {
    const mx = x * scale, mz = z * scale;
    const drainage = Math.abs(2 * fbm(mx * 0.011 + 8, mz * 0.006 - 3, 3) - 0.85);
    h -= 9 * m * m * (1 - sm(0.02, 0.16, drainage));
    // broad ridges, and on their crests a second, sharper set: crags, horns and notches
    const rg = ridged(mx * 0.0035 + 2, mz * 0.0035 - 4, footprint * 0.007);
    const crag = ridged(mx * 0.013 + 7, mz * 0.013 - 3, footprint * 0.026);
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
    this.textureCache.reset();
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
    return this.g ? this.textureCache.uploadDense(gl, this.g, denseUpload) : this.textureCache.uploadSparse(gl, this.f);
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

// Shaders compile in the GPU process, on worker threads where the driver allows it. Every program is queued here
// without waiting on it, so the compiles run while the valley is built, and the results are read once, in boot.
gl.getExtension('KHR_parallel_shader_compile');
const queuedPrograms = [];
function shader(type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  return s;
}
function program(vs, fs) {
  const p = gl.createProgram(), stages = [shader(gl.VERTEX_SHADER, HEAD + vs), shader(gl.FRAGMENT_SHADER, HEAD + COMMON + fs)];
  for (const s of stages) gl.attachShader(p, s);
  gl.linkProgram(p);
  queuedPrograms.push([p, stages]);
  const cache = {};
  p.u = (n) => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(p, n)));
  return p;
}
/** Stop at the first program that failed to compile or link, with its numbered source. */
function checkPrograms() {
  for (const [p, stages] of queuedPrograms.splice(0)) {
    // a one-shot bake may already have used and deleted its program
    if (!gl.isProgram(p) || gl.getProgramParameter(p, gl.LINK_STATUS)) continue;
    for (const s of stages) {
      if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) continue;
      console.error(gl.getShaderSource(s).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
      fail('shader: ' + gl.getShaderInfoLog(s));
    }
    fail('link: ' + gl.getProgramInfoLog(p));
  }
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
uniform vec3 uSunDir, uSunCol, uCloudTint;
uniform mat3 uSky;
uniform samplerCube uMilky;
uniform float uTime, uExposure, uExtent, uSheet, uWind, uHDR;
uniform sampler2D uGlow, uGround, uWear;
#define PI 3.14159265
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
// The value and both partial derivatives come from the same four corners.
vec3 noiseSlope(vec2 p){
  vec2 cell = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  float a = hash12(cell), b = hash12(cell + vec2(1., 0.));
  float c = hash12(cell + vec2(0., 1.)), d = hash12(cell + 1.);
  float crossTerm = a - b - c + d;
  return vec3(a + dot(vec2(b-a, c-a), u) + crossTerm * u.x * u.y,
              6. * f * (1. - f) * (vec2(b-a, c-a) + crossTerm * u.yx));
}
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
${windShader}
float inField(vec2 uv){ return step(0., uv.x) * step(0., uv.y) * step(uv.x, 1.) * step(uv.y, 1.); }

${groundLight}
${companionWorlds}
${cloudSky}
vec3 skyColor(vec3 d){
  vec3 c = skyBase(d);
  gBehind = c;
  starTransmission = 1.;
  nearestMoonDepth = -100.;
  if (uNight > 0. && d.y > -0.02) {
    // the galaxy's band, baked once into a cube map in the sky's own frame, which turns about the pole
    vec3 mw = texture(uMilky, uSky * d).rgb;
    c += mw * mw * uNight * smoothstep(-0.02, 0.22, d.y) * 0.72;
  }
  c += STAR_COL * uStarTint * (1. - uNight) * (1. - uStorm) * 3. * smoothstep(0.99935, 0.99965, dot(d, uStarDir));
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
  if (d.y > 0.) {
    vec4 cloud = cloudColumn(uCam, d);
    c = cloudLight(c, d, cloud);
    starTransmission *= 1. - cloud.a;
  }
  return c;
}
${canopyShelter}
vec3 ambient(vec3 n){
  vec3 day = mix(vec3(0.028, 0.030, 0.035), vec3(0.095, 0.143, 0.177), n.y * 0.5 + 0.5);
  // the open sky gives less as the star sinks
  float low = 1. - smoothstep(0.03, 0.36, uStarDir.y);
  day *= mix(vec3(1.), vec3(0.66, 0.64, 0.8), low * low);
  vec3 nite = mix(vec3(0.004, 0.007, 0.015), vec3(0.015, 0.026, 0.060), n.y * 0.5 + 0.5);
  vec3 a = mix(day, nite, uNight);
  // under a storm deck the light goes flat and grey; lightning floods everything for an instant
  a = mix(a, vec3(dot(a, vec3(0.3333))) * vec3(0.9, 0.97, 1.06), uStorm * 0.55);
  return a + vec3(0.15, 0.17, 0.26) * uFlash * (0.55 + 0.45 * n.y);
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
uniform mat4 uLightVP[3];
// While the day runs, the star's shadow fades from the layer baked for where it was to the one for where it will be.
uniform ivec2 uSunLayers; uniform float uSunBlend;
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
  if (uNight < 0.999) {
    float lit = shadowAt(wp, uSunLayers.x);
    if (uSunBlend > 0.) lit = mix(lit, shadowAt(wp, uSunLayers.y), uSunBlend);
    day = mix(0.13, 1., lit);
  }
  if (uNight > 0.001) moon = mix(0.32, 1., shadowAt(wp, 1));
  float light = mix(day, moon, uNight) * (1. - 0.82 * uStorm);
  float cloudFloor = uCloudEye.y + uCloudEye.w - 165.;
  if (wp.y >= cloudFloor + 180.) return light;
  float cloud = cloudColumn(wp, uSunDir).a;
  return light * (1. - cloud * (0.62 - 0.33 * uNight) * (1. - smoothstep(cloudFloor, cloudFloor + 180., wp.y)));
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
  vec3 skyLight = contactLight(wp) * ambient(N) * mix(vec3(1.), vec3(0.40, 0.53, 0.55), cover);
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
// Common parent stone for loose shingle, buried flecks and wet gravel.
vec3 shale(float tone) {
  return mix(vec3(0.104,0.083,0.068),vec3(0.298,0.257,0.211),tone);
}
vec3 floraRamp(vec3 tip, float u){
  vec3 root = tip * 0.04 + vec3(0.008, 0.012, 0.02), body = tip * vec3(0.30, 0.31, 0.36);
  return u < 0.5 ? mix(root, body, u * 2.) : mix(body, tip * 0.9, (u - 0.5) * 2.);
}
// The meadow's colour at a place: broad jade swaths and scattered plum heath. The blades take their tips from it and
// the litter under them, last season's blades, takes it too, so the ground between stems is the stand's own colour.
vec3 meadowTip(vec2 p, float jitter){
  float heath = vnoise(p * 0.03 + 3.) * 0.8 + vnoise(p * 0.09 - 5.) * 0.2;
  float variation = vnoise(p * 0.052 + 12.);
  vec3 jade = mix(vec3(0.042, 0.32, 0.13), vec3(0.10, 0.54, 0.37), variation);
  vec3 plum = mix(vec3(0.21, 0.13, 0.34), vec3(0.43, 0.22, 0.51), variation);
  return mix(jade, plum, smoothstep(0.49, 0.68, heath + jitter));
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
  vec3 skyLight = contactLight(wp) * ambient(N) * mix(vec3(1.), vec3(0.38, 0.54, 0.54), cover);
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
${windShader}
vec4 project(vec3 w){ return uVP * vec4(w.x, w.y * uMirror, w.z, 1.); }
`;

const SKY = program(`
uniform vec3 uR, uU, uF; uniform vec2 uTan, uJitter; uniform float uMirror;
out vec3 vDir;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2. - 1.;
  vec3 d = uF + (p.x - uJitter.x) * uTan.x * uR + (p.y - uJitter.y) * uTan.y * uU; d.y *= uMirror; vDir = d; gl_Position = vec4(p, 1., 1.); }`,
`in vec3 vDir; out vec4 o; void main(){ vec3 sky = skyColor(normalize(vDir)); o = vec4(tonemap(sky), starTransmission); }`);

const OCEAN_ATLAS = program(FSQ,oceanAtlasFragment);
const HIGH_CANOPY = program(WORLD_VS + `
in vec3 aPos, aNor; in float aTissue; in vec4 aSite; in vec2 aBlade;
out vec2 vBlade; out vec3 vWP, vNormal, vRest; out float vTissue, vHue, vCrown;
void main(){
  float seed = fract(dot(aSite.xz, vec2(0.75488, 0.56984)));
  float a = seed * 6.2832, c = cos(a), s = sin(a);
  mat2 rot = mat2(c, s, -s, c);
  vec3 p=aPos;
  p.xz = rot * p.xz;
  vRest = p * aSite.w;
  float load = windWave(aSite.xz + vRest.xz * 0.72) * uWind;
  float flex = p.y * p.y, leaf = step(0.,aTissue);
  float tip = leaf * aBlade.x*aBlade.x;
  p.xz += WIND_DIR * load * (0.052*flex + 0.024*tip);
  p.y -= 0.074 * load * dot(vRest.xz/aSite.w,WIND_DIR) * flex + 0.025 * abs(load) * tip;
  vWP = aSite.xyz + p * aSite.w;
  vNormal=aNor; vNormal.xz=rot*aNor.xz-WIND_DIR*load*(0.085*flex+0.28*tip);
  vHue=seed; vTissue=aTissue; vBlade=aBlade;
  vCrown=clamp((aPos.y-0.50)*1.36+0.66*length(aPos.xz),0.,1.);
  gl_Position = project(vWP);
}`, `uniform float uClip;
in vec2 vBlade; in vec3 vWP, vNormal, vRest; in float vTissue, vHue, vCrown; out vec4 o;
// Long, offset scales open into soft fissures. Their size, grain and edges
// vary independently, and the material stays on the branch as it sways.
vec2 barkPlate(vec2 plane, float seed) {
  vec2 p=plane*vec2(6.8,1.33)+seed;
  float drift=vnoise(plane*vec2(1.85,0.55)+seed);
  p += vec2(1.27*drift+0.38*vnoise(plane*2.2-seed),0.72*vnoise(plane*0.84+seed));
  vec3 cell=cobble(p);
  float fissure=(1.-smoothstep(0.012,0.17+0.15*drift,cell.y))*(0.32+0.68*drift);
  float grain=vnoise(vec2(p.x*4.5+drift,p.y*1.52));
  float fibres=vnoise(vec2(9.*p.x+1.8*grain,1.8*p.y));
  return vec2(fissure,0.34*cell.z+0.40*grain+0.26*fibres);
}
void main(){
  if (vWP.y < uClip) discard;
  vec3 n=normalize(vNormal), view=normalize(uCam-vWP), colour;
  float sun=directLight(vWP);
  if(vTissue>=0.){
    vec3 tip=mix(vec3(0.14,0.54,0.32),vec3(0.21,0.52,0.53),smoothstep(0.04,0.69,vHue));
    tip=mix(tip,vec3(0.47,0.22,0.49),smoothstep(0.67,0.96,vHue));
    vec3 leaf=tip*(0.43+0.46*vTissue)*(0.43+0.55*vCrown)*(0.68+0.40*vBlade.x);
    float veins=leafVeins(vBlade.x,vBlade.y,vHue);
    leaf=mix(leaf,tip*vec3(1.09,1.02,0.80),veins*0.28);
    float facing=dot(n,uSunDir), translucence=max(-facing,0.);
    colour=leaf*(contactLight(vWP)*ambient(n)*(1.5+0.72*vCrown)
                + uSunCol*sun*(0.10+0.80*max(facing,0.)+0.43*translucence));
    colour+=uSunCol*sun*pow(max(0.,dot(n,normalize(uSunDir+view))),14.)*0.080*tip;
    colour+=tip*veins*smoothstep(0.18,0.96,uNight)*0.14;
  }else{
    float resolve=1.-smoothstep(22.,55.,length(uCam-vWP));
    vec2 plate=vec2(0.15,0.5);
    if(resolve>0.){
      vec2 w=pow(abs(n.xz),vec2(3.)); float weight=w.x/max(w.x+w.y,0.001);
      vec2 f=barkPlate(vRest.xy,17.*vHue);
      vec2 g=barkPlate(vRest.zy,23.*vHue+5.);
      plate=mix(plate,mix(f,g,weight),resolve);
    }
    vec3 wood=mix(vec3(0.086,0.050,0.044),vec3(0.242,0.139,0.086),plate.y);
    wood*=1.-0.51*plate.x;
    colour=wood*(contactLight(vWP)*ambient(n)*1.8 + uSunCol*sun*(0.07+0.91*max(0.,dot(n,uSunDir))));
  }
  o=vec4(tonemap(fogged(colour,vWP)),0.);
}`);

// Air and overhead shelter change slowly across the terrain mesh. Keep the
// fine shadow comparisons, material normals and field filaments at each pixel.
const TERRAIN = program(WORLD_VS + valleyAir + canopyShelter + `
in vec3 aPos; in vec3 aNor; in vec2 aGround; out vec4 vAir; out float vCover; out vec2 vGround; out vec3 vWP; out vec3 vN;
void main(){
  vCover = canopyCover(aPos); vAir = airAt(aPos);
  vGround = aGround; vWP = aPos; vN = aNor; gl_Position = project(aPos);
}`,
`uniform sampler2D uTrailMaterial; uniform float uClip; in vec4 vAir; in float vCover; in vec2 vGround; in vec3 vWP; in vec3 vN; out vec4 o;
// Project the same mineral grain onto the bank, floor and sidewalls.
vec3 bankWeights(vec3 n){
  vec3 w = abs(n); w *= w; w *= w; return w / (w.x + w.y + w.z);
}
vec3 bankRelief(vec3 p, vec3 w){
  vec2 x = noiseSlope(p.zy).yz, y = noiseSlope(p.xz).yz, z = noiseSlope(p.xy).yz;
  return vec3(0., x.y, x.x)*w.x + vec3(y.x, 0., y.y)*w.y + vec3(z, 0.)*w.z;
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
  float steep = smoothstep(0.19, 0.53, 1. - N.y);
  vec3 weights = bankWeights(N);
  if (dn > 0. && steep > 0.) {
    vec3 relief = bankRelief(vWP * 2.6, weights) + 0.35 * bankRelief(vWP * 6.2 + 17., weights);
    N = normalize(N - dn * (1. - 0.6 * moist) * 0.30 * steep * (relief - N * dot(relief, N)));
  }
  if (dn > 0. && steep < 1.) {
    vec2 q = p * 2.6, grad = 0.5 * noiseSlope(q).yz;
    q = 2.03 * q + 17.; grad += 0.5075 * noiseSlope(q).yz;
    q = 2.03 * q + 17.; grad += 0.5151 * noiseSlope(q).yz;
    N = normalize(N - dn * (1. - steep) * (1. - 0.7 * wear) * (1. - 0.6 * moist) * vec3(grad.x, 0., grad.y) * 0.48);
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
    vec3 broad = noiseSlope(vec2(dot(vWP, strike), dot(vWP, dip)));
    vec3 joint = noiseSlope(narrow + vec2(1.2 * broad.x, 5.7));
    crag = broad.x;
    seam = mix(0.5, joint.x, foldFilter);
    vec3 broadSlope = broad.y * strike + broad.z * dip;
    vec3 jointSlope = joint.y * (crossJoint + 1.2 * broadSlope) + joint.z * slip;
    vec3 grad = 6.2 * broadSlope + 3.1 * foldFilter * jointSlope;
    vec3 flute = noiseSlope(fissure + vec2(1.7 * seam, crag));
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
  if (fine > 0.) {
    vec2 grain = vec2(vnoise(p * 2.7), vnoise(p * 9.));
    if (steep > 0.) {
      vec2 side = vec2(vnoise(vWP.zy * 2.7), vnoise(vWP.zy * 9.));
      vec2 face = vec2(vnoise(vWP.xy * 2.7), vnoise(vWP.xy * 9.));
      grain = mix(grain, weights.x * side + weights.y * grain + weights.z * face, steep);
    }
    n2 = mix(n2, grain.x, fine); n3 = mix(n3, grain.y, fine * fine);
  }
  float hummocks = smoothstep(0.24, 0.68, n1 + (n2 - 0.5) * 0.36);
  // Under the meadow lies its own litter: last season's blades flat in fine strokes over dark soil, the colour of the
  // stand above it, so purple heath has purple ground and the jade swaths jade.
  vec3 stand = meadowTip(p, 0.);
  float thatch = 0.5, clump = vnoise(p * 2.3 + 4.1);
  if (fine > 0.) {
    // strokes of fallen blades lying every which way in tufts, and specks of bare soil between them
    vec2 q = mat2(0.8, 0.6, -0.6, 0.8) * p, r = mat2(0.34, -0.94, 0.94, 0.34) * p;
    float strokes = mix(vnoise(q * vec2(17., 2.6) + n1 * 2.), vnoise(r * vec2(19., 2.9) - 3.), smoothstep(0.3, 0.7, clump));
    float soil = smoothstep(0.62, 0.8, vnoise(p * 7.3 - 2.));
    thatch = mix(0.5, clamp(strokes * 1.25 - 0.12 - 0.45 * soil, 0., 1.), fine);
  }
  vec3 litter = stand * mix(0.16, 0.52, smoothstep(0.18, 0.85, thatch)) * (0.8 + 0.4 * clump) + vec3(0.012, 0.010, 0.009);
  vec3 moss = mix(litter * 0.78, litter * 1.12 + vec3(0.01, 0.02, 0.008), hummocks) * (0.82 + 0.36 * n3);
  vec3 sand = mix(vec3(0.16, 0.12, 0.083), vec3(0.41, 0.34, 0.22), n1) * (0.75 + 0.42 * n2);
  vec3 bed = mix(vec3(0.060, 0.096, 0.082), vec3(0.24, 0.23, 0.16), n2) * (0.74 + 0.48 * n3);
  vec3 rock = mix(vec3(0.095, 0.103, 0.117), vec3(0.33, 0.28, 0.25), n2 * 0.65 + n1 * 0.35);
  vec3 alb = moss; float rough = 0.88, metal = 0.;
  float shore = 1. - smoothstep(0.12, 0.52 + 0.35 * n1, bank);
  alb = mix(alb, sand, shore); rough = mix(rough, 0.72, shore);
  float under = 1. - smoothstep(-0.35, -0.05, bank);
  alb = mix(alb, bed, under);
  float upland = smoothstep(54., 79., max(abs(p.x), abs(p.y)));
  vec3 heath = mix(vec3(0.045, 0.12, 0.095), vec3(0.15, 0.13, 0.083), smoothstep(-50., 70., p.x + p.y * 0.35));
  alb = mix(alb, mix(heath, litter, 0.5) * (0.68 + 0.55 * hummocks + 0.15 * n3), upland * (1. - shore) * 0.64);
  float rk = max(smoothstep(0.34, 0.58, mix(slopeG, slope, 0.22) + 0.13 * n2), smoothstep(6. + 11. * upland, 12. + 16. * upland, y) * 0.8);
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
    // Water-dark runnels support cushions of moss on the shelves. Exposed ribs
    // stay bare and the hiking tread keeps its worn mineral surface.
    float shelf = smoothstep(0.21, 0.78, vN.y + 0.32 * flutes - 0.18 * ledge);
    float cushion = smoothstep(0.30, 0.68, 0.60 * flutes + 0.40 * n1 + 0.15 * (n2 - 0.5)) * shelf;
    vec3 lichen = mix(vec3(0.030, 0.081, 0.034), vec3(0.235, 0.295, 0.074), shelf * (0.23 + 0.60 * ledge + 0.17 * n2));
    face = mix(face, lichen * (0.65 + 0.66 * n3), cushion);
    alb = mix(alb, face * (0.73 + 0.46 * n1), cliff);
    N = normalize(N + cliff * (vec3(0., 1., 0.) - N * N.y) * (0.68 * ledge - 0.26 - runnel * 0.20));
  }
  vec2 isle=p-vec2(${ISLET[0].toFixed(3)},${ISLET[1].toFixed(3)});
  float islandDist=length(vec2((isle.x+0.21*isle.y)/7.,isle.y/5.1));
  float islandStone=(1.-smoothstep(1.07,1.50,islandDist))*smoothstep(-0.35,0.28,y);
  float mantleSoil = islandStone * smoothstep(0.42,0.93,vN.y);
  if (islandStone>0.) {
    // Short lenses of exposed shale interrupt the earth on eroded faces.
    float drift = (n1-0.5)*1.35 + (n2-0.5)*0.21;
    float lens = vnoise(vec2(dot(p,vec2(0.67,-0.41))+n1, y*2.3 + drift));
    float shale = smoothstep(0.31,0.74,lens + 0.19*(n3-0.5));
    vec3 face = mix(vec3(0.091,0.069,0.056),vec3(0.29,0.24,0.19),shale);
    alb = mix(alb, face*(0.80+0.40*n3), islandStone*(1.-0.7*mantleSoil));
  }
  // The smaller offset, rotated soil patch neither copies the chip pattern nor
  // inherits its slope direction. Use explicit derivatives across the verge.
  vec2 dx=dFdx(p), dy=dFdy(p);
  float pathMask=smoothstep(0.075,0.93,vGround.x+(n2-0.5)*0.43);
  float soilCover = max(pathMask, mantleSoil);
  // where the meadow's floor still shows through what has been laid over it
  float meadowFloor = fine * (1. - shore) * (1. - under) * (1. - rk) * (1. - cliff) * (1. - islandStone) * (1. - 0.6 * upland);
  if (vGround.x>0.01 || mantleSoil>0. || meadowFloor>0.01) {
    mat2 rot = mat2(0.80,0.60,-0.60,0.80);
    vec2 soilUV = p*0.30+vec2(0.34*n1,0.17*n2);
    vec4 coarse = textureGrad(uTrailMaterial,soilUV,0.30*dx,0.30*dy);
    vec4 detail = textureGrad(uTrailMaterial,1.21*(rot*p)+vec2(0.19,0.61),1.21*(rot*dx),1.21*(rot*dy));
    float grains = 0.56*coarse.a + 0.44*detail.a;
    float grit = max(coarse.b, 0.57*detail.b);
    vec3 clay=mix(vec3(0.102,0.069,0.051),vec3(0.38,0.239,0.151),0.19+0.48*n1+0.33*n2);
    float crumb = smoothstep(0.33,0.71,grains);
    vec3 tread = mix(clay*(0.52+0.97*crumb),shale(0.15+0.67*detail.a),grit);
    // One soil runs under everything. The tread is that soil packed bare. Under the meadow it is the same soil,
    // olive with old roots, and the stand's litter lies over it in drifts, thinnest toward the tread, so the path is
    // where the cover ends rather than a different ground.
    vec3 loam = mix(tread, vec3(0.185,0.158,0.096)*(0.72+0.62*crumb), 0.43);
    float drifts = 0.53*thatch + 0.30*clump + 0.17*hummocks;
    float cover = smoothstep(0.23,0.79,drifts - 0.48*pathMask);
    // Earth and embedded grit show between grass roots. Fallen material takes
    // on a little of the stand's pigment even where the live blades fan apart.
    vec3 duff = mix(loam*0.62, moss, 0.44 + 0.18*thatch);
    vec3 meadow = mix(loam, duff, cover);
    alb = mix(alb, meadow, meadowFloor);
    alb = mix(alb, mix(meadow, tread, smoothstep(0.03,0.91,soilCover)), soilCover);
    vec2 relief=(2.*coarse.rg-1.)*0.65 + transpose(rot)*(2.*detail.rg-1.)*0.53;
    N=normalize(N+vec3(relief.x,0.,relief.y)*max(soilCover,meadowFloor*(1.-0.65*cover))*0.78);
    rough=mix(rough,0.89-0.12*grit,soilCover);
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
  float bench = smoothstep(0.43, 0.78, vnoise(vec2(dot(p,vec2(0.021,0.032)), bedding*0.45 + seam*0.83)));
  alb = mix(alb, mix(alb * vec3(0.74, 0.78, 0.90), alb * vec3(1.24, 1.14, 0.96), bench), rk * far);
  float alpine = smoothstep(31., 52., y + (0.5 - crag) * 13.);
  // Wind scours rock ribs bare. The lee and the shallow gullies hold snow
  // much farther downslope. Resolved flakes would crawl at this distance.
  float shelter = 0.42 * (0.5 - crag) + 0.30 * (0.5 - seam) + 0.28 * (0.5 - chute) - 0.065 * dot(vN.xz, vec2(0.8, 0.6));
  float mantle = mix(1. - slopeG, N.y, 0.5) - 0.56 + shelter;
  float snow = alpine * smoothstep(-0.024, 0.034 + min(0.07, fwidth(mantle)), mantle);
  vec3 schist = mix(vec3(0.052, 0.069, 0.095), vec3(0.37, 0.33, 0.30), 0.12 * bench + 0.30 * crag + 0.58 * chute);
  // Broad cross-beds and displaced seams read from the opposite side of the lake.
  float fault=sin(0.69*bedding+3.8*chute+1.2*seam);
  float lamina=smoothstep(0.48,0.90,fault)*(0.40+0.6*crag);
  schist*=0.79+0.55*lamina;
  alb = mix(alb, schist, alpine);
  vec3 frost = mix(vec3(0.50, 0.64, 0.78), vec3(0.86, 0.86, 0.92), smoothstep(-0.01, 0.22, mantle));
  alb = mix(alb, frost, snow); rough = mix(rough, 0.60, snow);
  // Sand sorts into pockets of shingle. Loose cobbles here are actual settled meshes.
  float cobZ = smoothstep(0.34, 0.72, normalize(vN).y) * (1. - smoothstep(0.30, 0.83, bank)) * smoothstep(-1.6, -0.9, bank) * (1. - smoothstep(14., 32., dist)) * (1. - 0.6 * rk);
  // Only exposed faces need surface light. Caustics also tint indirect light
  // in the shallows, so they share the same visibility sample here.
  float sun = 0.;
  if (dot(N, uSunDir) > 0. || (cobZ > 0.01 && under > 0. && uNight < 1.)) sun = directLight(vWP);
  if (cobZ > 0.01) {
    mat2 driftDir = mat2(0.89, 0.46, -0.46, 0.89);
    vec2 stretch = vec2(0.57, 1.12);
    vec2 bedUV = (driftDir*p)*stretch + vec2(n1,n2)*0.51;
    vec4 grit = textureGrad(uTrailMaterial, bedUV, (driftDir*dx)*stretch, (driftDir*dy)*stretch);
    float deposit = smoothstep(0.25,0.74, 0.57*n1 + 0.43*n2 + 0.23*(grit.a-0.5));
    vec3 shingle = mix(alb * (0.74 + 0.45*grit.a), shale(0.17+0.61*grit.a), 0.50*grit.b);
    float wcob = cobZ * (0.26 + 0.74*deposit);
    alb = mix(alb, shingle, wcob);
    vec2 relief = transpose(driftDir)*((grit.rg*2.-1.)*stretch);
    N = normalize(N + vec3(relief.x,0.,relief.y)*wcob*0.36);
    rough = mix(rough, 0.65-0.12*under, wcob);
    // Soft moving caustic patches break across the sand and gravel in sunlit shallows.
    float drift = dot(p, vec2(1.6, 1.0)) + uTime * 0.70 + 4.0 * n1;
    float focus = 0.5 + 0.5 * sin(drift * 2.6 + sin(p.y * 1.7 - uTime * 0.43) * 2.8);
    alb *= 1. + 0.48 * under * (1. - uNight) * sun * wcob * focus * focus * n2 * (1. - 0.85*uStorm);
  }
  alb = mix(alb, vec3(0.21, 0.15, 0.19), smoothstep(0.03, 0.6, wear) * mix(0.70,0.22,pathMask)); rough = mix(rough, 0.75, wear);
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
in vec3 aPos, aPos1, aPos2, aNor, aNor1, aNor2; in vec4 aI, aS, aBed;
flat out vec3 vBed, vAlong, vUp;
out vec3 vWP, vLoc, vNl; out float vH, vToe, vCurv;
void main(){
  float form = min(aS.w * 3., 2.999999), w = fract(form);
  vec3 rp, rn;
  if (form < 1.) { rp = mix(aPos, aPos1, w); rn = mix(aNor, aNor1, w); }
  else if (form < 2.) { rp = mix(aPos1, aPos2, w); rn = mix(aNor1, aNor2, w); }
  else { rp = mix(aPos2, aPos, w); rn = mix(aNor2, aNor, w); }
  vCurv = (length(rn) - 1.) / 0.45;
  float c = cos(aI.w), s = sin(aI.w);
  vUp = normalize(vec3(-aBed.x, 1., -aBed.y));
  vAlong = normalize(vec3(c, dot(aBed.xy, vec2(c,s)), s));
  mat3 frame = mat3(vAlong, vUp, cross(vAlong,vUp));
  vLoc = rp * aS.xyz; vNl = normalize(rn / aS.xyz); vH = aS.w;
  vWP = aI.xyz + frame * vLoc;
  vBed = vec3(aBed.zw, max(aS.x,aS.z)); vToe = rp.y;
  gl_Position = project(vWP);
}`,
`uniform float uClip; uniform sampler2D uRockSurface;
flat in vec3 vBed, vAlong, vUp; in vec3 vWP, vLoc, vNl; in float vH, vToe, vCurv; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 V = normalize(uCam - vWP);
  vec2 uv = fieldUV(vWP.xz); float inf = inField(uv); float glow = texture(uGlow, uv).r * inf;
  float dist = length(uCam - vWP);
  vec3 col;
  {
    vec3 lp = vLoc * 1.6 + vec3(vH * 17.);
    // A metre of mineral grain has the same scale on a pebble and a boulder.
    // Each piece exposes another cut through the bed.
    vec3 Nl = normalize(vNl), aw = Nl*Nl; aw *= aw; aw /= aw.x + aw.y + aw.z;
    vec3 sp = vLoc * (0.56 + 0.17*vH) + vec3(7.9, 15.1, 8.7)*vH;
    vec4 sx = texture(uRockSurface, sp.zy), sy = texture(uRockSurface, sp.xz), sz = texture(uRockSurface, sp.xy);
    vec4 surf = sx*aw.x + sy*aw.y + sz*aw.z;
    vec3 grad = aw.x*vec3(0., sx.g-0.5, sx.r-0.5) + aw.y*vec3(sy.r-0.5, 0., sy.g-0.5) + aw.z*vec3(sz.r-0.5, sz.g-0.5, 0.);
    vec3 N = normalize(mat3(vAlong, vUp, cross(vAlong, vUp)) * (Nl + 1.45*(grad - Nl*dot(grad,Nl))));
    float near = 1. - smoothstep(10., 30., dist);
    float mineral = surf.b, crack = 1. - smoothstep(0.14, 0.36, mineral);
    float n1 = vnoise(lp.xz * 0.9 + lp.y), n2 = vnoise(lp.xy * 4. + lp.z * 2.);
    float speck = mineral;
    // One stone, the valley's own: the shale the trails are worn from, warm where it weathers toward the trail's clay.
    // Each stone keeps its own tone within it, so they differ as pieces of one bed do.
    vec3 alb = shale(0.2 + 0.62 * n1 + 0.18 * (fract(vH * 3.71) - 0.5));
    alb = mix(alb, vec3(0.33, 0.215, 0.14), 0.25 + 0.35 * smoothstep(0.3, 0.8, n2));
    alb *= 0.48 + 1.02 * mineral;
    alb = mix(alb, vec3(0.42,0.36,0.30), near * 0.38 * smoothstep(0.63,0.89,mineral));
    alb *= mix(0.72, 1.12, smoothstep(-0.4, 0.8, N.y));      // weathered tops pale, overhangs shadowed
    alb *= 1. - 0.38 * crack;
    // the baked curvature: edges worn pale, hollows dark where light and rain reach least
    float edgeWear = smoothstep(0.08, 0.5, -vCurv), hollow = smoothstep(0.05, 0.45, vCurv);
    alb *= (1. + 0.3 * edgeWear) * (1. - 0.42 * hollow);
    float colonised = (1.-smoothstep(0.03,0.55,vBed.x))*smoothstep(0.20,0.80,vBed.z);
    float rosette = mineral;
    float patches = smoothstep(0.5, 0.68, vnoise(lp.xz * 1.7 - lp.y * 2.3 + 5.));
    // only a pale grey crust of lichen here and there, close to the stone's own colour
    float lich = colonised * patches * smoothstep(0.58, 0.62, rosette) * smoothstep(0.05, 0.55, N.y + 0.15) * (1. - crack) * (1. - hollow);
    vec3 lichC = mix(alb, vec3(0.4, 0.39, 0.35), 0.6);
    alb = mix(alb, lichC * (0.85 + 0.25 * speck), lich * 0.35);
    float humus = vnoise(vWP.xz * 1.4 + vH * 5.);
    float moss = colonised * hollow * smoothstep(0.45, 0.85, N.y + 0.38 * (humus - 0.5)) * smoothstep(0.45, 0.7, humus + 0.15 * speck) * 0.5;
    vec3 mossTint = mix(vec3(0.027, 0.08, 0.052), vec3(0.12, 0.215, 0.103), n2);
    moss *= 0.28 + 0.52 * (1.-smoothstep(0.30,2.9,abs(vWP.y-vBed.y)));
    alb = mix(alb, mossTint * (0.68 + 0.6 * speck), moss);
    float shoreWet;
    alb = waterline(alb, vWP, vBed.y, shoreWet);
    float wet = clamp(max(shoreWet, (texture(uGround, uv).r + uSheet) * inf), 0., 1.);
    // soil splashed up the foot, and the foot darker where the ground hides it from the sky
    alb = mix(alb, vec3(0.15, 0.115, 0.085) * (0.8 + 0.4 * n2), (1. - smoothstep(-0.39, -0.16, vToe + 0.05 * (speck - 0.5))) * 0.32);
    alb *= (1. - 0.3 * wet) * mix(0.64, 1., smoothstep(-0.39, 0.03, vToe));
    col = pbr(alb, mix(0.8 - 0.15 * lich, 0.14, wet * 0.9), 0., N, V, vWP);
    // light the sunlit soil around the stone throws back up onto its lower faces, warm as the trail it lies by
    float below = clamp(0.55 - 0.65 * N.y, 0., 1.);
    col += alb * vec3(0.95, 0.66, 0.42) * below * smoothstep(-0.40,-0.08,vToe) * (0.12 + 0.3 * directLight(vWP + vec3(0., -0.3, 0.))) * (1. - uNight) * (1. - 0.7 * wet);
    col += mossTint * moss * uNight * (0.28 + glowI(glow));
    col += lichC * lich * (0.03 * uNight) * (0.6 + 0.4 * sin(uTime * 0.8 + vH * 30.));
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
  p.xz += WIND_DIR * g * 0.107 * aB.z * flex * flex;
  p.y -= abs(g) * 0.025 * aB.z * flex * flex;
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
uniform bool uSimpleLeaf; in vec4 aR; in vec4 aD; in vec4 aM; in vec4 aB;
centroid out vec3 vWP, vN;
centroid out vec2 vBlade; flat out vec4 vLeaf; flat out vec3 vAcross;
void main(){
  // Nearby leaves share a raised spine between two curved faces. The distant
  // strip and shadow caster use the same silhouette with three lengthwise spans.
  int id = gl_VertexID;
  float u = uSimpleLeaf ? float(id / 2) / 3. : float(id / 3) / 6.;
  float side = uSimpleLeaf ? (id == 6 ? 0. : float(id % 2) * 2. - 1.) : float(id % 3 - 1);
  float kind = floor(aM.w), seed = fract(aM.w), L = aD.w;
  vec3 up = vec3(0., 1., 0.), dir = normalize(aD.xyz);
  vec3 sd = cross(up, dir); sd = length(sd) < 1e-3 ? vec3(1., 0., 0.) : normalize(sd);
  float curve = sin(3.14159 * u), lift = aM.x, droop = aM.y;
  vec3 p = aR.xyz + L * (dir * u + up * (lift * curve - droop * u * u));
  vec3 bend = brushBend(aR.xyz + L * (dir * 0.67 + up * (0.86 * lift - 0.45 * droop)));
  p += bend * (0.78 * L * u * u);
  float gust = windWave(aB.xy) * uWind, flex = aR.w + 0.2 * u;
  p.xz += WIND_DIR * gust * 0.107 * aB.z * flex * flex;
  p.y -= abs(gust) * 0.025 * aB.z * flex * flex;
  p += sd * sin(uTime * 2.6 + seed * 40. + u * 3.) * 0.018 * (0.35+abs(gust)) * u * L;
  vec3 tang = normalize(dir + up * (lift * 3.14159 * cos(u * 3.14159) - 2. * droop * u) + bend * (1.56 * u));
  vec3 upper = normalize(cross(tang, sd));
  vec3 across = normalize(sd + upper * ((seed - 0.5) * (0.40 + 1.65 * u)));
  upper = normalize(cross(tang, across));
  float width = aM.z * uLodW * (0.045 * (1. - u) + sin(3.14159 * pow(u, 0.86))) * 0.5;
  float rim = 1. + min(kind, 1.) * 0.085 * sin(u * 16. + seed * 18. + side) * curve;
  width *= rim;
  p += sd * (seed - 0.5) * L * u * u * (0.09 + 0.34 * min(kind, 1.));
  float fold = 0.26 + 0.20 * min(kind, 1.) + 0.10 * curve;
  p += across * side * width;
  if (!uSimpleLeaf) p += upper * (1. - abs(side)) * width * fold;
  vN = normalize(upper + across * side * fold * 1.65);
  vec2 uv = fieldUV(aB.xy);
  vLeaf = vec4(aB.w, aM.w, textureLod(uGlow, uv, 0.).r, clamp(textureLod(uGround, uv, 0.).r + uSheet, 0., 1.));
  vAcross = sd; vWP = p; vBlade = vec2(u, side);
  gl_Position = project(p);
}`, `
uniform float uClip; centroid in vec3 vWP, vN; centroid in vec2 vBlade; flat in vec4 vLeaf; flat in vec3 vAcross; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  float u = clamp(vBlade.x, 0., 1.), side = clamp(vBlade.y, -1., 1.);
  float kind = floor(vLeaf.y), seed = fract(vLeaf.y), wet = vLeaf.w;
  vec3 tint = pigment(vLeaf.x * 0.55);
  tint *= mix(vec3(1.), tint, 0.45);
  if (kind > 1.5) {
    tint = mix(vec3(0.11, 0.30, 0.079), vec3(0.028, 0.33, 0.245), smoothstep(0.17, 0.76, seed));
    tint = mix(tint, vec3(0.35, 0.054, 0.22), smoothstep(0.57, 0.93, vLeaf.x));
  }
  vec3 N = normalize(vN), V = normalize(uCam - vWP);
  float thin = mix(0.75, 0.36, min(kind, 1.)), edge = abs(side);
  // Taper the midrib towards the point. Cross veins join it in staggered
  // pairs and fade as their spacing approaches a pixel.
  float spread = (0.42 * edge + 0.85 * edge * edge) * (1. - 0.27 * u);
  float row = u * (8. + 2. * seed) - spread + sign(side) * (0.18 + 0.07 * sin(u * 8.));
  float fp = max(0.006, fwidth(row)), sw = max(0.005, fwidth(side));
  float midWidth = mix(0.025, 0.006, u);
  float midrib = (1. - smoothstep(0., midWidth + 0.5 * sw, edge)) * min(1., 2. * midWidth / sw);
  float veinDist = abs(fract(row + 0.5) - 0.5);
  float sideVein = (1. - smoothstep(0.008, 0.042 + fp * 0.5, veinDist)) * min(1., 0.075 / fp);
  float veins = max(midrib, sideVein * (0.69 - 0.40 * edge)) * smoothstep(0.025, 0.17, u);
  // Thick leaves hold pigment through the belly. The thin, sheltered
  // edges transmit it. A wet cuticle darkens the surface between highlights.
  float belly = sin(3.14159 * u);
  vec3 albedo = floraRamp(tint, u) * (0.53 + 0.38 * seed);
  albedo += tint * min(kind, 1.) * belly * (0.16 + 0.10 * edge);
  albedo *= (0.89 + 0.19 * veins) * (1. - 0.19 * wet);
  float facing = dot(N, V);
  float furrow = 0.;
  float rib = u * (16. + seed * 6.) - 1.8 * edge - 1.45 * edge * edge + seed * 3.;
  float detail = 1. - smoothstep(0.12, 0.48, fwidth(rib));
  if (kind > 0.5 && detail > 0.) {
    // Fine pleats sweep forward from the spine. Their footprint fades them
    // continuously before they can sparkle on a distant or edge-on leaf.
    float grain = sin(6.2832 * rib) * detail;
    float fibre = vnoise(vec2(u * 31. + 3.8 * edge, side * 16. + seed * 37.));
    float spine = exp(-20. * edge);
    furrow = detail * (0.50 * grain + 0.50 * (2. * fibre - 1.));
    N = normalize(N + vAcross * (sign(side) * (0.18 * grain * edge + 0.33 * spine) + 0.09 * furrow));
    albedo *= 0.87 + 0.17 * furrow + 0.34 * spine;
    albedo += tint * vec3(0.42, 0.34, 0.13) * (veins * 0.38 + spine * 0.44);
  }
  vec3 face = facing >= 0. ? N : -N;
  vec3 sun = uSunCol * directLight(vWP);
  vec3 sky = ambient(face) * contactLight(vWP) * mix(vec3(1.), vec3(0.34, 0.48, 0.48), canopyCover(vWP));
  float direct = dot(face, uSunDir);
  vec3 light = albedo * (2.55 * sky + floraSpill(vWP) + sun * (0.06 + 0.55 * max(direct, 0.)));
  // Green laminae transmit more amber and green light at their thin edges.
  float teal = smoothstep(0.01, 0.21, tint.g - tint.r);
  vec3 transmitted = albedo * mix(vec3(1.), vec3(1.58, 1.23, 0.58), teal * (0.38 + 0.62 * edge));
  light += sun * transmitted * max(-direct, 0.) * (thin + 0.19 * edge) * (0.60 + 0.4 * u);
  float sheen = max(dot(face, normalize(V + uSunDir)), 0.);
  float broad = sheen * sheen; broad *= broad; broad *= broad;
  float gloss = broad * broad; gloss *= gloss;
  light += sun * max(direct, 0.) * (broad * 0.025 + gloss * (0.15 + 0.27 * wet)) * (0.76 + 0.24 * furrow);
  // A waxy leaf also catches a broad strip of open sky between the boughs.
  float skyFacing = max(0., reflect(-V, face).y);
  float rim = 1. - abs(dot(face, V)); rim *= rim;
  light += sky * (skyFacing * skyFacing) * (0.10 + 0.64 * rim) * (0.60 + wet) * min(kind, 1.);
  float night = smoothstep(0.12, 0.95, uNight), response = glowI(vLeaf.z);
  float branch = (1. - smoothstep(0.02, 0.10, abs(furrow))) * detail * 0.12 * edge * belly;
  float tissue = (veins + branch) * (0.23 + 0.43 * min(kind, 1.) + 0.33 * step(1.5, kind));
  float reached = smoothstep(0.01, 0.45 + 0.27 * u + 0.13 * edge, response);
  float tips = smoothstep(0.64, 0.97, u);
  vec3 luminous = kind > 1.5 ? mix(tint, sqrt(tint), 0.45) : tint;
  light += luminous * night * (tissue * (0.08 + 0.13 * seed + 1.47 * reached * response) + tips * (0.044 + 0.22 * response));
  o = vec4(tonemap(fogged(light, vWP)), 0.);
}`);

// grass: Corey's blade (ceeboozwah/grass), ported. Three rows plus a tip, quadratic bend, width taper,
// rounded normals, rolling gust waves, a root-mid-tip ramp with patch noise and root AO, sun backlight through
// the tips. Wired to the certified fields: wear tramples it flat, moisture droops and darkens it, glow lights
// the tips you stirred. Instances are shuffled, so drawing a prefix is an even thinning (adaptive density).
const GRASS = program(WORLD_VS + BRUSH_VS + clumpGLSL + `
in vec4 aRoot, aDetail; uniform vec3 uCam; uniform vec2 uGrassHeight; uniform int uBladeRows;
centroid out vec3 vWP; centroid out vec4 vGA; centroid out float vGlow; centroid out float vWet; centroid out vec3 vN; centroid out float vPatch;
centroid out float vDry; centroid out float vClump;
void main(){
  vec4 aG = vec4((aRoot.xy - 0.5) * uExtent, uGrassHeight.x + aRoot.z * uGrassHeight.y, aDetail.w);
  int packed = int(aRoot.w*65535. + 0.5), cell = packed & 15;
  float edge = float((packed >> 4) & 7)/7.;
  vec4 aR = vec4(aDetail.xyz, float(packed >> 7)/511. * ${BLADE_HEIGHT_RANGE.toFixed(1)});
  vec2 cq = aG.xy / ${CLUMP};
  ivec2 ci = ivec2(floor(cq)) + ivec2(cell % 3 - 1, cell / 3 - 1);
  uint th = clumpHash(ci);
  vec2 toTuft = vec2(ci) + clumpOffset(th) - cq;
  float tuftDist = length(toTuft), tuft = float((th * 747796405u) >> 8)/16777216.;
  // Two individual leaves share a sheath up close. Degenerate vertices join
  // their strips. Fade the second into the tuft before dropping its geometry.
  int vid = gl_VertexID, rows = uBladeRows;
  bool sister = rows == 4 && vid >= 10;
  if (sister) { vid = max(0, vid-11); rows = 3; }
  vid = min(vid, 2*rows);
  float by = float(vid/2)/float(rows);
  float side = vid == 2*rows ? 0. : float(vid % 2) - 0.5;
  uint bh = clumpHash(ivec2(floor(aG.xy*613.)) + (sister ? ivec2(31,-17) : ivec2(0)));
  float shape = float(bh & 0xffffu)/65536., deadRoll = float(bh >> 16)/65536.;
  float a = aR.x*6.2831853 + (sister ? 1.35 + 2.1*aG.w : 0.);
  vec2 ax = vec2(cos(a), sin(a)), fd = vec2(-ax.y, ax.x);
  vec2 uv = fieldUV(aG.xy); vec2 gr = vec2(texture(uGround, uv).r, texture(uWear, uv).r); float glow = texture(uGlow, uv).r;
  float wet = min(1., gr.r + uSheet), trample = smoothstep(0.04, 0.45, gr.g);
  float reed = step(1.6, aR.w);
  // Three blades: most are ordinary, a quarter slender and tall, a sixth broad and short. The tuft sets the height
  // around them, highest in its middle; by the tread they splay and stand a little lower.
  float slender = step(shape, 0.25), broad = step(0.83, shape);
  float H = 0.52 * (0.62 + 0.76 * aR.y) * aR.w * (1. - 0.55 * trample) * mix(1., 1.14, slender) * mix(1., 0.78, broad)
          * mix(0.8, 1.2, tuft) * (1. - 0.28 * smoothstep(0.22, 0.68, tuftDist)) * (1. - 0.1 * edge);
  float sisters = 1. - smoothstep(5.5, 8.8, length(aG.xy-uCam.xz));
  if (sister) H *= (0.63 + 0.24*shape)*sisters;
  float W0 = (0.030 + 0.022*aR.z)*mix(0.20, 1., smoothstep(0., 0.34, H))*mix(1.,0.48,reed)*uLodW
           * mix(1.,0.58,slender)*mix(1.,1.19,broad)*mix(1.32,1.,sisters);
  float wd = W0 * (0.48 + 0.52*smoothstep(0.,0.25,by)) * pow(1.-by,0.84);
  if (sister) wd *= 0.79*sisters;
  // Rain weighs the blades: water held along a blade bends it from the foot and lays its tip over, and the stand
  // rises again as the moisture field dries.
  float soak = smoothstep(0.05, 0.75, wet) * (1. - trample);
  float lean = (0.09 + 0.47 * aR.z + 0.8 * trample + 0.95 * soak + 0.21 * edge) * H * mix(1., 1.45, slender);
  vec2 away = tuftDist > 0.02 ? -toTuft / tuftDist : vec2(0.);
  float load = windWave(aG.xy) * uWind * (1. - 0.74 * trample);
  float flexibility = mix(0.56, 1.18, shape) * (sister ? 0.84 : 1.);
  float angle = by * clamp(load * flexibility, -0.4, 1.31);
  float bow = sin(angle), upright = cos(angle);
  // The arc turns the blade face into the sky and lowers its tip. Its foot stays planted.
  float twist = by * (aG.w - 0.5) * (1. - 0.7 * reed) + bow * dot(fd, WIND_DIR) * 0.32;
  vec2 across = normalize(ax + twist * fd);
  float curl = (aG.w - 0.5) * (0.21 + 0.24*slender);
  vec3 p = vec3(aG.x, aG.z, aG.y);
  vec2 leanDir = normalize(fd + twist * ax + away * 1.6 * smoothstep(0.08, 0.4, tuftDist));
  p.xz += across * (side*wd + curl*H*by*by*by) + by*by*leanDir*lean;
  p.xz += WIND_DIR * H * by * bow;
  p.y += by * H * (1. - 0.14 * by * by) * (1. - 0.7 * trample) * mix(upright,1.,0.20) * (1. - 0.55 * soak * by * by);
  vec3 bend = brushBend(vec3(aG.x, aG.z + H * 0.5, aG.y));
  p += bend * (0.88 * H * by * by);
  vN = normalize(vec3(fd.x, 0.56 + 0.58*by, fd.y) + vec3(across.x, 0., across.y) * side * 0.88
       + vec3(-WIND_DIR.x, 0.56, -WIND_DIR.y) * bow * 1.65 + bend * (0.62 * by));
  vGA = vec4(by, aR.z, 2. * side, bow); vWP = p; vGlow = glow; vWet = wet; vPatch = aR.y;
  // last season's blades still standing: a few everywhere, more in some tufts, many along the tread
  vDry = step(deadRoll, 0.05 + 0.3 * tuft * tuft * tuft + 0.24 * edge); vClump = tuft;
  gl_Position = project(p);
}`,
`uniform float uClip; centroid in vec3 vWP; centroid in vec4 vGA; centroid in float vGlow; centroid in float vWet; centroid in vec3 vN; centroid in float vPatch;
centroid in float vDry; centroid in float vClump; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  float y = clamp(vGA.x, 0., 1.);
  vec3 tip = meadowTip(vWP.xz, (vPatch - 0.5) * 0.06 + (vClump - 0.5) * 0.05) * mix(0.9, 1.12, vClump);
  // a dead blade keeps a ghost of its colour in the straw
  tip = mix(tip, mix(vec3(0.46, 0.38, 0.22), tip * 0.5 + vec3(0.2, 0.16, 0.11), 0.38), vDry);
  vec3 sheath = mix(vec3(0.091, 0.083, 0.051), tip*0.47, 0.54);
  vec3 gc = mix(sheath, tip * (0.63 + 0.31*y), smoothstep(0.,0.76,y));
  float pn = vnoise(vWP.xz * 0.28) * 0.6 + vnoise(vWP.xz * 1.1) * 0.4;
  gc *= mix(0.8, 1.2, pn);
  gc = mix(gc, tip, smoothstep(0.55, 0.95, pn) * 0.2 * y);
  float rootShade = mix(0.72, 1., smoothstep(0.,0.48,y));
  gc *= (0.89 + 0.22*vGA.y) * rootShade * (1.-0.32*vWet);
  // The central fold stays visible up close and blends out across subpixel blades.
  float footprint = max(fwidth(vGA.z), 0.012);
  float rib = (1. - smoothstep(0.035, 0.12 + footprint, abs(vGA.z))) * (1. - smoothstep(0.17, 0.72, footprint));
  float margin = smoothstep(0.62, 1., abs(vGA.z))*(1.-smoothstep(0.30,0.90,footprint));
  gc *= 1. + (0.24*rib + 0.11*margin) * smoothstep(0.05, 0.36, y);
  vec3 lit = floraLight(gc, vWP, normalize(vN), normalize(uCam - vWP), y, 0.12 * (1. - vDry), glowI(vGlow));
  // a wet blade is a mirror: the sun glints along its fold and the sky shows in its face
  if (vWet > 0.03) {
    vec3 V = normalize(uCam - vWP), Nw = normalize(vN);
    if (dot(Nw, V) < 0.) Nw = -Nw;
    float fres = 0.04 + 0.96 * pow(1. - max(dot(Nw, V), 0.), 5.);
    float glint = pow(max(dot(Nw, normalize(uSunDir + V)), 0.), 48.);
    lit += smoothstep(0.03, 0.6, vWet) * smoothstep(0.12, 0.5, y)
         * (uSunCol * directLight(vWP) * glint * 0.85 + ambient(reflect(-V, Nw)) * (0.40 + 2.1 * fres));
  }
  // Sky reflection on the exposed blade faces follows the crest across the stand.
  lit += tip * ambient(normalize(vN)) * (0.72 * max(vGA.w, 0.) * y * (1. - uNight));
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
    float blade = clamp((u-0.24)/0.76,0.,1.);
    float belly = pow(max(0.,sin(3.14159*pow(blade,0.77))),0.79);
    float width = W*(0.043*(1.-blade)+belly*(1.-0.22*blade));
    float fold = (0.36+0.24*seed)*belly;
    vec3 along = normalize(dir + sd*(seed-0.5)*blade*0.8);
    vec3 across = normalize(sd + up*(seed-0.48)*0.9*blade);
    vec3 p = along*L*(0.11*u+aS2.x*blade) + up*L*(aS2.y*u+aS2.z*sin(u*3.14159)-0.56*blade*blade)
      + across*width*side + up*fold*width*side*side;
    float gust = windWave(aP.xz+along.xz*blade*L)*uWind;
    p.xz += WIND_DIR * gust * L * 0.30*u*u;
    p += brushBend(aP.xyz+up*L*0.48)*L*0.57*u*u;
    vN = normalize(up*(0.35+0.8*blade) - along*(aS2.y-1.25*blade) - across*side*fold);
    vWP=p+aP.xyz; vU=u; vSide=side; vType=type; vSeed=seed; vHue=aS2.w;
    vStir=texture(uGlow,fieldUV(aP.xz)).r;
    gl_Position = project(vWP); return;
  }
  vec2 c = path(type, u, L, aS2), t2 = normalize(path(type, min(u + 0.01, 1.), L, aS2) - path(type, max(u - 0.01, 0.), L, aS2));
  vec3 p = dir * c.x + up * c.y;
  float flex = type > 1.5 && type < 2.5 ? 0.3 : 1.;
  vec3 bend = brushBend(aP.xyz + L * (up * 0.40 + dir * (type < 1.5 ? 0.48 : 0.))) * flex;
  p += bend * (0.62 * L * u * u);
  float flutter = type > 4.5 ? 0.12 : 1.;
  p.xz += WIND_DIR * windWave(aP.xz + dir.xz * c.x * flutter) * uWind * 0.24 * u * u * L * flex;
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
  else if (vType > 5.5) tip = mix(vec3(0.085, 0.47, 0.32), vec3(0.39, 0.17, 0.39), smoothstep(0.37, 0.70, vHue));
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
    float blade = clamp((u-0.24)/0.76,0.,1.);
    float midrib = 1.-smoothstep(0.025,0.08+fwidth(s),abs(s));
    float arch = blade*6.5 - abs(s)*(0.52+0.29*blade) + 0.13*s*s;
    float fillet = abs(fract(arch+0.5)-0.5);
    float laterals = (1.-smoothstep(0.014,0.045+fwidth(arch),fillet))*(1.-abs(s));
    float ribs = max(midrib,laterals*0.83)*smoothstep(0.03,0.15,blade);
    gc = tip*(0.27+0.35*blade+0.14*s+0.22*ribs);
    gc = mix(gc,vec3(0.23,0.34,0.16),0.39*midrib);
    tissue = ribs * 0.69;
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
in vec2 aXZ; in vec3 aWater; out vec3 vWP; out float vDepth, vWave, vFlow;
void main(){
  // the swell rides up and down the beach, so the waterline itself moves
  vWave = waterWave(aXZ, uTime).x + impactWave(aXZ).x;
  vWP = vec3(aXZ.x, aWater.x + vWave, aXZ.y); vDepth = aWater.y; vFlow = aWater.z; gl_Position = project(vWP);
}`,
`uniform sampler2D uRefl, uUnder; uniform vec2 uRes, uRightXZ; uniform float uMirrorLevel;
in vec3 vWP; in float vDepth, vWave, vFlow; out vec4 o;
// A cell schedules impacts. A new event can land anywhere in it, and its wave
// crosses the boundary. The largest wave travels less than half a cell, so only
// the current cell and the three neighbours in the nearest quadrant can reach p.
vec2 rainSlope(vec2 p, float pixelMetres){
  const float spacing = 0.44;
  vec2 q = p / spacing, cell = floor(q), f = fract(q);
  vec2 neighbour = step(vec2(0.5), f) * 2. - 1.;
  vec2 slope = vec2(0.);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 offset = vec2(i, j) * neighbour, id = cell + offset;
    vec2 clock = hash22(id + 17.13);
    float rate = mix(1.08, 1.91, clock.x);
    float tick = uTime * rate + clock.y;
    vec2 event = id + floor(tick) * vec2(19.73, -27.41);
    vec2 roll = hash22(event + 71.7);
    if (roll.x > uStorm * 0.93) continue;
    float age = (fract(tick) - 0.17 * roll.y) / rate;
    float life = 0.31 + 0.13 * roll.y;
    if (age <= 0. || age >= life) continue;
    vec2 delta = (f - offset - hash22(event + 0.351)) * spacing;
    float radius = length(delta);
    float crest = age * (0.26 + 0.12 * roll.y);
    float width = 0.006 + 0.018 * age;
    float fromCrest = radius - crest;
    if (fromCrest > 3. * width || fromCrest < -6. * width) continue;
    // A short capillary wave packet. Broaden and attenuate it as a pixel
    // covers more of the crest. Overlapping rings add their signed slopes.
    float filtered = sqrt(width * width + 0.17 * pixelMetres * pixelMetres);
    float d = fromCrest / filtered;
    float pulse = d * exp(-0.65 * d*d);
    float tail = d + 2.75;
    pulse += 0.36 * tail * exp(-0.75 * tail*tail);
    float fade = smoothstep(0., 0.035, age) * (1. - smoothstep(0.25, 1., age/life));
    float strength = (0.20 + 0.16 * roll.y) * fade * width * width / (filtered * filtered);
    float envelope = smoothstep(-6., -4., fromCrest/width) * (1. - smoothstep(2.,3.,fromCrest/width));
    slope += delta / max(radius, 0.002) * (pulse * envelope * strength);
  }
  return slope;
}
vec2 waveGrad(vec2 p){
  vec2 g = waterWave(p, uTime).yz;
  // Cross-winds shear the small surface trains into short, uneven crests.
  float shear = vnoise(p*0.31 + vec2(-0.12,0.09)*uTime) - 0.5;
  g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 1.3 + uTime * 1.1 + shear*2.6) * 0.016;
  g += vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 2.1 + uTime * 1.6 - shear*2.1) * 0.010;
  g += vec2(0.2, -0.98) * cos(dot(p, vec2(0.2, -0.98)) * 3.7 + uTime * 2.2 + shear*3.3) * 0.006;
  g += vec2(-0.9, -0.3) * cos(dot(p, vec2(-0.9, -0.3)) * 6.3 + uTime * 3.1 - shear*4.2) * 0.004;
  // wind gust patches ("cat's paws"): the same rolling waves that move the grass roughen the water as they pass
  float gw = max(0., windWave(p)) * uWind;
  g += WIND_DIR * cos(dot(p, WIND_DIR) * 9. - uTime * 5.3 + vnoise(p * 0.8) * 3.) * 0.023 * gw;
  g += vec2(-WIND_DIR.y, WIND_DIR.x) * cos(dot(p, vec2(-WIND_DIR.y, WIND_DIR.x)) * 13. + uTime * 6.1) * 0.006 * gw;
  return g + impactWave(p).yz;
}
void main(){
  float depth = vDepth + vWave;
  if (depth <= -0.02) discard; // Dry beach has zero water coverage.
  vec2 p = vWP.xz, uv = fieldUV(p);
  float glow = uNight > 0. ? texture(uGlow, uv).r * inField(uv) : 0.;
  float level = vWP.y - vWave;
  float stream = vFlow;
  float pixelMetres = max(length(dFdx(p)), length(dFdy(p)));
  vec2 rain = vec2(0.);
  if (uStorm > 0.005 && pixelMetres < 0.065)
    rain = rainSlope(p, pixelMetres) * (1. - smoothstep(0.025, 0.065, pixelMetres));
  vec2 g = waveGrad(p) + rain;
  float flow = p.y * 3.3 - uTime * 3.1 + vnoise(p * 1.3 - vec2(0., uTime * 0.21)) * 3.8;
  g += stream * vec2(0.012 * sin(flow * 0.71), 0.028 * cos(flow));
  vec3 N = normalize(vec3(-g.x, 1., -g.y));
  vec3 V = normalize(uCam - vWP); float NdV = clamp(dot(N, V), 0., 1.);
  float F = 0.022 + 0.978 * pow(1. - NdV, 5.);
  vec2 forward = vec2(uRightXZ.y, -uRightXZ.x);
  vec2 distortion = vec2(dot(N.xz, uRightXZ) * uRes.y / uRes.x, dot(N.xz, forward));
  // the waves bend the mirrored picture less toward the frame's edges, so nothing is ever read from outside it
  vec2 suv = gl_FragCoord.xy / uRes;
  float frame = smoothstep(0., 0.06, min(min(suv.x, suv.y), min(1. - suv.x, 1. - suv.y)));
  vec2 warped = suv + distortion * mix(0.065, 0.16, NdV) * frame;
  float planar = 1. - smoothstep(0.08, 0.85, abs(level - uMirrorLevel));
  vec3 refl = texture(uRefl, clamp(warped, 0., 1.)).rgb;
  if (planar < 1.) {
    vec3 ray = reflect(-V, N), sky = skyBase(ray);
    if (ray.y > 0.) sky = cloudLight(sky, ray, cloudColumn(vWP, ray));
    refl = mix(tonemap(sky), refl, planar);
  }

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

  // A tilted crest reflects a brighter or darker part of the overcast sky.
  if (uStorm > 0.005) {
    vec2 skyDirection = uSunDir.xz - 0.45*V.xz;
    float tilt = dot(rain, skyDirection);
    col += tilt * (0.70 + 0.45*NdV) * (0.39*refl + 0.71*ambient(vec3(0.,1.,0.)));
  }
  float swash = 1. - smoothstep(0.025, 0.21, abs(depth - 0.06));
  float foam = (swash + 0.38 * stream * smoothstep(0.7, 1., sin(flow))) * shoreFroth(p);
  float light = uNight * uNight * glowI(glow);
  col = mix(col, tonemap(vec3(0.68, 0.78, 0.81) * (ambient(N) * 2.4 + uSunCol * sun * 0.16)), foam * 0.48);
  col += tonemap(glowCol(p * 1.3 + 7.) * light * (0.5 + 1.3 * uNight));
  alpha = min(1., alpha + foam * 0.2 + light * 0.40);
  // the bed and whatever stands in the water, seen through the surface: bent by the same waves, more as it deepens,
  // and tinted by the water it passes through. At the very edge the true bed shows, unbent.
  vec2 bend = suv - distortion * clamp(depth * 0.25, 0., 0.09) * frame;
  vec3 under = texture(uUnder, clamp(bend, 0.002, 0.998)).rgb * mix(vec3(1.), vec3(0.78, 0.95, 0.92), absorb);
  o = vec4(mix(under, col, alpha), smoothstep(-0.02, 0.035, depth));
}`);

const POINTS = program(WORLD_VS + `
in vec4 aP; uniform float uScale, uNight; uniform vec3 uCam; uniform int uRain; out float vA; out vec3 vC;
void main(){
  vec3 p = aP.xyz; float s = aP.w;
  if (uRain == 1) { float t = fract(uTime * (0.08 + 0.05 * s) + aP.y); vec2 c = uCam.xz + mod(aP.xz - uCam.xz + 34., 68.) - 34.; p = vec3(c.x, uCam.y + 16. - t * 27., c.y); p.x += sin(uTime + s * 50.) * 0.6; p.z += cos(uTime * 0.7 + s * 31.) * 0.4; vA = smoothstep(0., 0.1, t) * (1. - smoothstep(0.85, 1., t)); s = 0.5; }
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

// rain: streaks falling past the camera in a box that travels with it, slanted by the wind, faint against the sky and
// bright in a flash. Where they land on water, the water itself draws the rings.
const RAIN_STREAKS = touch ? 1400 : 2600;
const RAINP = program(WORLD_VS + `
uniform vec3 uCam; uniform float uStorm;
in vec4 aDrop; in float aEnd; out float vA;
void main(){
  float t = fract(uTime * (0.32 + 0.12 * aDrop.w) + aDrop.z);
  vec2 c = uCam.xz + mod(aDrop.xy - uCam.xz + 26., 52.) - 26.;
  vec3 slant = vec3(WIND_DIR.x, 0., WIND_DIR.y) * uWind;
  vec3 head = vec3(c.x, uCam.y + 18. - t * 26., c.y) + slant * t * 2.5;
  vec3 p = head + (vec3(0., -1., 0.) + slant * 0.16) * aEnd * (0.5 + 0.4 * aDrop.w);
  vA = uStorm * smoothstep(0., 0.06, t) * (1. - smoothstep(0.92, 1., t)) * (0.35 + 0.65 * aEnd);
  gl_Position = project(p);
}`,
`in float vA; out vec4 o;
void main(){ vec3 c = vec3(0.6, 0.66, 0.76) * (ambient(vec3(0., 1., 0.)) * 3.5 + 0.9 * uFlash); o = vec4(tonemap(c) * vA * 0.42, 0.); }`);
// a lightning bolt: a jagged line from the storm deck to the ground, white-hot for a fraction of a second
const BOLTP = program(WORLD_VS + `in vec3 aPos; void main(){ gl_Position = project(aPos); }`,
`uniform float uBolt; out vec4 o; void main(){ o = vec4(tonemap(vec3(5.5, 6., 9.) * uBolt), 0.); }`);

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
const MILKY = program(FSQ, galaxyFragment);

// ---------------------------------------------------------------- geometry
// Preserve the lake's original triangles. The surrounding highlands use wider
// intervals on each axis, meeting the inner grid at shared vertices.
const INNER_RADIUS = 80, INNER_STEPS = 192, INNER_STEP = INNER_RADIUS / INNER_STEPS;
const OUTER_STEP = 2 * INNER_STEP, outerSteps = Math.ceil((WORLD_HALF + 12 - INNER_RADIUS) / OUTER_STEP);
const NEAR = { S: 2 * (INNER_STEPS + outerSteps), half: INNER_RADIUS + outerSteps * OUTER_STEP };
function terrainCoord(m) {
  const a = Math.abs(m);
  return NEAR.S / 2 + Math.sign(m) * (Math.min(a, INNER_RADIUS) / INNER_STEP + Math.max(0, a - INNER_RADIUS) / OUTER_STEP);
}
// Keep each patch's indices adjacent so a row of visible patches takes one draw.
function terrainPatches(pos, cols, rows, radial, pinned) {
  const fullCount = cols * rows * 6, stride = cols + 1, patches = [];
  // Each split border edge adds at most three triangles over a regular coarse quad.
  const borderEdges = cols * Math.ceil(rows / 32) + rows * Math.ceil(cols / 32);
  const pinnedCount = pinned ? pinned.reduce((sum, cell) => sum + cell, 0) : 0;
  const coarseCapacity = Math.min(fullCount, fullCount / 4 + 9 * borderEdges + 54 * pinnedCount);
  const idx = new Uint32Array(fullCount + (radial ? 0 : coarseCapacity));
  let coarseCursor = fullCount;
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
    const patch = { first, end: cursor, x0, y0, z0, y1, width: x1 - x0, depth: z1 - z0, pad: 0 };
    if (!radial) {
      const level = coarsePatch(idx, coarseCursor, pos, stride, i0, j0, i1, j1, pinned);
      patch.coarseFirst = coarseCursor; patch.coarseEnd = level.cursor; patch.error = level.error;
      coarseCursor = level.cursor;
    }
    patches.push(patch);
  }
  return { idx: idx.subarray(0, coarseCursor), fullCount, patches, drawCounts: new Int32Array(patches.length), byteOffsets: new Int32Array(patches.length) };
}
function terrainNear() {
  const { S } = NEAR, stride = S + 1, hs = new Float32Array(stride * stride);
  const ground = new Float32Array(hs.length * 2), pos = new Float32Array(hs.length * 3), nor = new Float32Array(pos.length);
  const axis = Float64Array.from({ length: stride }, (_, i) => {
    const t = i - S / 2, a = Math.abs(t);
    return Math.sign(t) * (Math.min(a, INNER_STEPS) * INNER_STEP + Math.max(0, a - INNER_STEPS) * OUTER_STEP);
  });
  let low = Infinity, high = -Infinity;
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
    const h = H(axis[i], axis[j]);
    hs[j * stride + i] = h;
    low = Math.min(low, h); high = Math.max(high, h);
  }
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
    const x = axis[i], z = axis[j], k = j * stride + i, vertex = 3 * k;
    ground[2 * k] = trailCover(x, z); ground[2 * k + 1] = waterLevel(x, z);
    pos[vertex] = x; pos[vertex + 1] = hs[k]; pos[vertex + 2] = z;
    const il = Math.max(0, i - 1), ir = Math.min(S, i + 1), jl = Math.max(0, j - 1), jr = Math.min(S, j + 1);
    const hx = (hs[j * stride + ir] - hs[j * stride + il]) / (axis[ir] - axis[il]);
    const hz = (hs[jr * stride + i] - hs[jl * stride + i]) / (axis[jr] - axis[jl]);
    const l = Math.hypot(hx, 1, hz);
    nor[vertex] = -hx / l; nor[vertex + 1] = 1 / l; nor[vertex + 2] = -hz / l;
  }
  return { ground, pos, nor, heightRange: [low - 0.05, high - low + 0.1] };
}
function terrainFar() {
  const rings = touch ? 150 : 190, sectors = touch ? 320 : 512, stride = sectors + 1, edge = NEAR.half - 0.5;
  const pos = new Float32Array((rings + 1) * stride * 3), nor = new Float32Array(pos.length);
  const innerRadius = NEAR.half - 10;
  const spacing = Math.max(2 * Math.PI / sectors, Math.expm1(Math.log(1500 / innerRadius) / rings));
  for (let j = 0; j <= rings; j++) {
    const r = innerRadius * Math.pow(1500 / innerRadius, j / rings);
    const footprint = r * spacing * sm(115, 240, r);
    for (let i = 0; i <= sectors; i++) {
      const a = (i % sectors) / sectors * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
      const inside = Math.abs(x) < edge && Math.abs(z) < edge;
      pos.set([x, H(x, z, footprint) - (inside ? 4 : 0), z], 3 * (j * stride + i));
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
function waterMesh(terrain) {
  const cols = 256, rows = 352, stride = cols + 1, tileCells = 16;
  const x0 = LAKE[0] - 46, z0 = spring.z - 23, w = 92, d = LAKE[1] + 40 - z0;
  const xz = new Float32Array(2 * stride * (rows + 1)), water = new Float32Array(3 * stride * (rows + 1));
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const v = j * stride + i, x = x0 + i * w / cols, z = z0 + j * d / rows, level = waterLevel(x, z);
    xz[v * 2] = x; xz[v * 2 + 1] = z;
    water[v * 3] = level; water[v * 3 + 1] = level - nearH(terrain, x, z); water[v * 3 + 2] = riverFlow(z, level);
  }
  const idx = [], patches = [];
  for (let j0 = 0; j0 < rows; j0 += tileCells) for (let i0 = 0; i0 < cols; i0 += tileCells) {
    const first = idx.length, endX = Math.min(i0 + tileCells, cols), endZ = Math.min(j0 + tileCells, rows);
    let low = Infinity, high = -Infinity;
    for (let j = j0; j < endZ; j++) for (let i = i0; i < endX; i++) {
      const a = j * stride + i, b = a + 1, c = a + stride, e = c + 1;
      if (Math.max(water[3 * a + 1], water[3 * b + 1], water[3 * c + 1], water[3 * e + 1]) <= -0.4) continue;
      idx.push(a, c, b, b, c, e);
      low = Math.min(low, water[3 * a], water[3 * b], water[3 * c], water[3 * e]);
      high = Math.max(high, water[3 * a], water[3 * b], water[3 * c], water[3 * e]);
    }
    // Include wind swell and overlapping impacts at the edges of the view.
    if (first < idx.length) patches.push({ first, end: idx.length, x0: x0 + i0 * w / cols, z0: z0 + j0 * d / rows,
      width: (endX - i0) * w / cols, depth: (endZ - j0) * d / rows, y0: low - 0.20, y1: high + 0.20, pad: 0 });
  }
  return { xz, water, idx: new Uint32Array(idx), patches };
}
// Each family shares its topology. A stone's seed interpolates two different
// silhouettes before the rigid pose is applied, including in the shadow pass.
const ROCK_STYLES = {
  round: { power: 2.6, squash: 0.79, breaks: 4, bevel: 0.17, reach: 0.79 },
  block: { power: 4.2, squash: 0.91, breaks: 7, bevel: 0.08, reach: 0.61 },
  slab:  { power: 4.8, squash: 0.48, breaks: 5, bevel: 0.05, reach: 0.66 },
  tall:  { power: 3.3, squash: 1.02, breaks: 6, bevel: 0.09, reach: 0.68 },
};
function rockMesh(seed, sub, style) {
  const kind = ROCK_STYLES[style], rr = rng(Math.floor(seed * 100003));
  const lean = (rr() - 0.5) * 0.58, rake = (rr() - 0.5) * 0.47, bedTilt = (rr() - 0.5) * 0.44;
  const planes = Array.from({ length: kind.breaks }, () => {
    const a = rr() * Math.PI * 2, el = (rr() - 0.34) * 1.95;
    return [Math.cos(a)*Math.cos(el), Math.sin(el), Math.sin(a)*Math.cos(el), kind.reach + 0.30*rr()];
  });
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((c) => c / l); });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const levels = [], edges = [];
  for (let q = 0; q < sub; q++) {
    const cache = {}, nf = [];
    levels.push(f);
    const midpoints = [];
    edges.push(midpoints);
    const mid = (a, b) => {
      const k = a < b ? a + '_' + b : b + '_' + a;
      if (k in cache) return cache[k];
      const p = v[a].map((c, i) => (c + v[b][i]) / 2);
      v.push(norm(p));
      const index = v.length - 1;
      midpoints.push([a, b, index]);
      return (cache[k] = index);
    };
    for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  // Worn corners between a few old fracture planes. Both the inclined bedding
  // and the offset shoulders run through the volume, including its outline.
  const pos = v.map(([x, y, z]) => {
    const power = kind.power;
    let radius = (Math.abs(x)**power + Math.abs(y)**power + Math.abs(z)**power) ** (-1 / power);
    const relief = fbm(x*1.7 + seed, z*1.4 - y*1.6 + seed, 3) - 0.45;
    radius *= 0.93 + 0.36 * relief;
    for (const [nx, ny, nz, reach] of planes) {
      const dot = nx*x + ny*y + nz*z;
      if (dot <= 0.25) continue;
      const cut = reach / dot, overlap = Math.max(0, kind.bevel - Math.abs(radius - cut));
      radius = Math.min(radius, cut) - overlap*overlap / (4 * kind.bevel);
    }
    const bedding = y + bedTilt*x + 0.09*relief;
    const ledge = sm(-0.07,0.03,bedding) * (1 - sm(0.03,0.22,bedding));
    const scar = sm(0.04,0.82, x*Math.cos(seed) + z*Math.sin(seed));
    const edge = radius - (style === 'round' ? 0.018 : 0.054)*ledge*scar;
    const px = x*edge*(0.95 + 0.13*z) + lean*y;
    const pz = z*edge*(0.92 - 0.12*x) + rake*y;
    let py = (y*radius + 0.13*x - 0.09*z + 0.11*relief)*kind.squash;
    if (py < -0.15) py = -0.15 + (py + 0.15)*0.58;
    // A broad bearing face with rounded shoulders out to the visible toe.
    py = Math.max(py, -0.41*kind.squash + 0.018*px - 0.012*pz);
    return [px, py, pz];
  });
  // Subdivision adds detail to the exposed faces. Keep the underside shared
  // by all three levels so changing distance cannot lift a rock off its bed.
  for (const midpoints of edges.slice(-2)) for (const [a, b, m] of midpoints) {
    if (v[m][1] < -0.10) pos[m] = pos[a].map((x, j) => 0.5 * (x + pos[b][j]));
  }
  const nor = pos.map(() => [0, 0, 0]), around = pos.map(() => new Set());
  for (const [a, b, c] of f) {
    const A = pos[a], B = pos[b], C = pos[c];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const q of [a, b, c]) { nor[q][0] += n[0]; nor[q][1] += n[1]; nor[q][2] += n[2]; }
    around[a].add(b).add(c); around[b].add(a).add(c); around[c].add(a).add(b);
  }
  // Curvature from each vertex to the middle of its neighbours, along the normal: hollows positive, edges negative.
  // It rides in the normal's length (1 + 0.45 c), so the shader gets worn edges and dark crevices for nothing.
  const unit = nor.map(n => { const length = Math.hypot(...n) || 1; return n.map(v => v / length); });
  const curvature = pos.map((p, i) => {
    let mx = 0, my = 0, mz = 0, reach = 0;
    for (const j of around[i]) { mx += pos[j][0]; my += pos[j][1]; mz += pos[j][2]; reach += Math.hypot(pos[j][0] - p[0], pos[j][1] - p[1], pos[j][2] - p[2]); }
    const n = around[i].size || 1, d = [mx / n - p[0], my / n - p[1], mz / n - p[2]];
    return Math.max(-1, Math.min(1, 6 * (d[0] * unit[i][0] + d[1] * unit[i][1] + d[2] * unit[i][2]) / (reach / n || 1)));
  });
  const levelsDrawn = [f, levels[sub-1], levels[sub-2]];
  let cumulative = 0;
  const errors = edges.slice(-2).reverse().map(midpoints => {
    let error = 0;
    for (const [a, b, m] of midpoints) {
      const delta = pos[m].map((c, i) => c - (pos[a][i] + pos[b][i]) / 2);
      error = Math.max(error, Math.hypot(...delta));
    }
    cumulative += error;
    return cumulative;
  });
  return { pos: new Float32Array(pos.flat()), nor: new Float32Array(unit.map((n, i) => n.map(v => v * (1 + 0.45 * curvature[i]))).flat()),
    levels: levelsDrawn.map(faces => new Uint16Array(faces.flat())), errors };
}
function rockSet(sub, shapes) {
  const meshes = shapes.map(([seed, style]) => rockMesh(seed, sub, style));
  return { pos: meshes.map(m => m.pos), nor: meshes.map(m => m.nor), levels: meshes[0].levels,
    errors: meshes[0].errors.map((_, i) => Math.max(...meshes.map(m => m.errors[i]))) };
}
// ---------------------------------------------------------------- scatter
// terrain height and slope from the near mesh (fast, for a million blades)
function nearH(near, x, z) {
  const { S } = NEAR, fx = Math.min(S - 1e-6, Math.max(0, terrainCoord(x))), fz = Math.min(S - 1e-6, Math.max(0, terrainCoord(z)));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j;
  const stride = 3 * (S + 1), k = j * stride + 3 * i + 1, P = near.pos;
  const right = P[k + 3], up = P[k + stride];
  if (u + w <= 1) return P[k] * (1 - u - w) + right * u + up * w;
  return P[k + stride + 3] * (u + w - 1) + right * (1 - w) + up * (1 - u);
}
function nearNy(near, x, z) {
  const { S } = NEAR, i = Math.min(S, Math.max(0, Math.round(terrainCoord(x)))), j = Math.min(S, Math.max(0, Math.round(terrainCoord(z))));
  return near.nor[(j * (S + 1) + i) * 3 + 1];
}
// Blades per square metre in a full stand. bakeMeadow thins distant tiles.
const GRASS_DENSITY = touch ? 60 : TEST ? 64 : 140;
const START = [8, 30], SHORE_CAM = [19, 26];
const clearOf = (x, z) => trailCover(x, z) < 0.02 && (waterLevel(x, z) === 0 || H(x, z) > waterLevel(x, z) + 0.2) && Math.hypot(x - START[0], z - START[1]) > 3.5 && Math.hypot(x - SHORE_CAM[0], z - SHORE_CAM[1]) > 3.5;
const inMap = (x, z, m = 2) => Math.abs(x) < WORLD_HALF - m && Math.abs(z) < WORLD_HALF - m;

function besideWalk(points, rand, inner = 1.8, width = 2.2) {
  const i = Math.floor(rand() * (points.length - 1)), [x, z] = points[i];
  const dx = points[i + 1][0] - x, dz = points[i + 1][1] - z, along = rand();
  const offset = (rand() < 0.5 ? -1 : 1) * (inner + width * rand()) / Math.hypot(dx, dz);
  return [x + dx * along - dz * offset, z + dz * along + dx * offset];
}

function scatter(near, fixed, meshes) {
  // rocks: clusters with one big stone each, a broken field on the outcrop, monoliths on the rim, stones
  // in the shallows, pebbles on the shore
  // Keep the established shoreline across grass densities and quality settings.
  let r = rng(1306441690);
  const rv = [[], [], [], []], rs = [[], [], [], []], beds = [[], [], [], []];
  const groundAt = (x, z) => nearH(near, x, z), reserve = stoneSpacing();
  const drop = stoneDrop(near.pos, NEAR.S + 1, terrainCoord, groundAt);
  const boulders = [], gravel = [];
  const fixedWidth = NEAR.S / 2;
  const macro = m => Math.max(0, Math.min(fixedWidth - 1, Math.floor(terrainCoord(m) / 2)));
  const add = (v, x, z, sx, sy, sz, rand = r) => {
    const yaw = rand() * 2 * Math.PI, tint = rand();
    // Shingle includes narrow shards and broad flakes even within one deposit.
    if (v === 3) {
      const aspect = 0.72 + 0.71*((tint*37.19)%1);
      sx *= aspect; sz /= Math.sqrt(aspect); sy *= 0.68 + 0.68*((tint*47.11)%1);
    }
    (v === 3 ? gravel : boulders).push([v,x,z,sx,sy,sz,yaw,tint]);
  };
  const place = ([v,x,z,sx,sy,sz,yaw,tint]) => {
    const reach = Math.max(sx, sz);
    if (v !== 3 && (trailDistance(x,z) < 0.85+1.2*reach || inRestArea(x,z,reach))) return;
    const iz = z - ISLET[1], ix = x - ISLET[0] + 0.21*iz;
    if (Math.hypot(ix/7, iz/5.1) < 1.28 + reach/5.1) return;
    const seat = stoneBed(groundAt, x, z, sx, sy, sz, yaw, v);
    if (!seat) return;
    const contact = drop(meshes[v], x, z, sx, sy, sz, yaw, tint, seat);
    if (!reserve(contact)) return;
    rv[v].push(x, contact.y, z, yaw); rs[v].push(sx, sy, sz, tint);
    beds[v].push(seat.gx, seat.gz, trailCover(x, z), waterLevel(x, z));
    // Coarsen the rest of the terrain, but keep the actual contact triangles at all distances.
    const x0 = macro(contact.x0), x1 = macro(contact.x1), z1 = macro(contact.z1);
    for (let j = macro(contact.z0); j <= z1; j++) fixed.fill(1, j*fixedWidth+x0, j*fixedWidth+x1+1);
  };
  const cluster = (cx, cz, big, m) => {
    for (let q = 0; q < m; q++) {
      const s0 = q === 0 ? big : big * (0.18 + 0.42 * r()), a = r() * 6.28, d = q === 0 ? 0 : big * (0.7 + r() * 0.9);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (!clearOf(x, z) || !inMap(x, z)) continue;
      add(q % 2, x, z, s0 * (0.8 + 0.5 * r()), s0 * (0.7 + 0.5 * r()), s0 * (0.8 + 0.5 * r()));
    }
  };
  for (let c = 0; c < 56; c++) {
    let cx, cz, k = 0;
    do { cx = (r() * 2 - 1) * (VALLEY_HALF - 4); cz = (r() * 2 - 1) * (VALLEY_HALF - 4); k++; } while ((H(cx, cz) < -0.7 || !clearOf(cx, cz)) && k < 40);
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
    add(2, x, z, w, 2.4 + r() * 2.8, w * (0.8 + 0.3 * r()));
  }

  for (let q = 0; q < 26; q++) {
    let x, z, k = 0;
    do { x = LAKE[0] + (r() * 2 - 1) * 30; z = LAKE[1] + (r() * 2 - 1) * 24; k++; } while ((lakeD(x, z) < 8.6 || lakeD(x, z) > 10.6) && k < 60);
    const s0 = 0.4 + r() * 0.9; add(q % 2, x, z, s0, s0 * 0.8, s0 * 1.1);
  }
  for (let q = 0; q < (touch ? 900 : 1600); q++) {
    let x, z, k = 0;
    if (q < 1000) do { x = LAKE[0] + (r() * 2 - 1) * 34; z = LAKE[1] + (r() * 2 - 1) * 28; k++; } while ((lakeD(x, z) < 9.6 || lakeD(x, z) > 12.4) && k < 60);
    else { x = (r() * 2 - 1) * (VALLEY_HALF - 2); z = (r() * 2 - 1) * (VALLEY_HALF - 2); }
    const s0 = 0.04 + Math.pow(r(), 2) * 0.18; add(3, x, z, s0, s0 * 0.7, s0 * (0.8 + 0.4 * r()));
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
      add(group % 2, x, z, scale * 1.10, scale * (0.57 + 0.17 * cliffRand()), scale * 0.83, cliffRand);
    }
  }

  // Fallen chips collect in discontinuous runs near the edges of a tread.
  const shingle = rng(89431);
  for (const walk of [trail, ...Object.values(valleyWalks), ...Object.values(rangeWalks)]) {
    for (let i = 1; i < walk.length; i++) {
      const [x,z] = walk[i-1], dx=walk[i][0]-x, dz=walk[i][1]-z, length=Math.hypot(dx,dz);
      for (let j=0; j<length*2.05; j++) {
        const u=shingle(), side=(shingle()<0.5?-1:1)*(0.14+1.32*shingle());
        const cx=x+u*dx-side*dz/length, cz=z+u*dz+side*dx/length;
        const size=0.036+0.19*shingle()**2*(0.4+Math.abs(side));
        if (nearH(near,cx,cz)>waterLevel(cx,cz)) add(3,cx,cz,size,0.48*size,0.74*size,shingle);
      }
    }
  }
  for (const [cx,cz,,rx,rz] of overlooks) {
    // A few knee-high stones on the uphill rim leave a clear view and room to stand.
    for (let i=0;i<7;i++) {
      const a=2.5+2.5*shingle(), size=0.30+0.71*shingle();
      add(i%2,cx+(rx+0.7)*Math.cos(a),cz+(rz+0.7)*Math.sin(a),size,size*0.68,size*0.77,shingle);
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
      add(stone === 0 ? group % 2 : 3, x, z, radius, radius * (0.47 + 0.26 * gravel()), radius * 1.24, gravel);
    }
  }

  // Common trees, saplings and a few old giants with space for their low branches.
  r = rng(2628268434); // The forest has its own seed, independent of the shoreline.
  const trees = [];
  const ground = (x, z) => { const y = H(x, z); return y > 0.3 && y < 11 && normalAt(x, z)[1] > 0.84 && lakeD(x, z) > 12.3 && clearOf(x, z) && Math.hypot(x - START[0], z - START[1]) > 7 && Math.hypot(x - SHORE_CAM[0], z - SHORE_CAM[1]) > 7 && inMap(x, z, 4) && outcrop(x, z) < 0.5; };
  const room = (x, z, d) => {
    if (inRestArea(x,z,0.9) || trailDistance(x, z) < (d > 10 ? 3.7 : d > 3 ? 2.8 : 1.65)) return false;
    for (let q = 0; q < trees.length; q += 5) if (Math.hypot(trees[q] - x, trees[q + 2] - z) < d + (trees[q + 4] > 6 ? 3 : 0)) return false;
    return true;
  };
  for (let t = 0; trees.length / 5 < 7 && t < 4000; t++) {
    const x = (r() * 2 - 1) * (VALLEY_HALF - 6), z = (r() * 2 - 1) * (VALLEY_HALF - 6);
    if (ground(x, z) && room(x, z, 12)) trees.push(x, H(x, z) - 0.08, z, r(), 7.5 + r() * 2.8);
  }
  const common = trees.length;
  for (let t = 0; (trees.length - common) / 5 < 88 && t < 12000; t++) {
    const x = (r() * 2 - 1) * (VALLEY_HALF - 3), z = (r() * 2 - 1) * (VALLEY_HALF - 3);
    if (ground(x, z) && room(x, z, 3.8)) trees.push(x, H(x, z) - 0.05, z, r(), 3.4 + r() * 3.0);
  }
  const grown = trees.length;
  const sapling = (x, z) => { if (ground(x, z) && room(x, z, 1.3)) trees.push(x, H(x, z) - 0.03, z, r(), 1.1 + r() * 1.3); };
  for (let q = common; q < grown; q += 5) if (r() < 0.45) for (let k = 0, m = 2 + Math.floor(r() * 4); k < m; k++) { const a = r() * 6.28, d = 2 + r() * 2.8; sapling(trees[q] + Math.cos(a) * d, trees[q + 2] + Math.sin(a) * d); }
  for (let g = 0; g < 14; g++) {
    const cx = (r() * 2 - 1) * (VALLEY_HALF - 6), cz = (r() * 2 - 1) * (VALLEY_HALF - 6);
    for (let k = 0, m = 3 + Math.floor(r() * 5); k < m; k++) sapling(cx + (r() - 0.5) * 6, cz + (r() - 0.5) * 6);
  }
  // Give each outer walk a different skyline. Preserve the original valley's placement seeds.
  const upland = rng(319375);
  for (const [habitat, points] of Object.entries(rangeWalks)) {
    for (let i = 0; i < 45; i++) {
      const [x, z] = besideWalk(points, upland, 3.4, 15);
      if (Math.max(Math.abs(x), Math.abs(z)) < VALLEY_HALF || !inMap(x, z, 5)) continue;
      const y = nearH(near, x, z);
      if (y < waterLevel(x, z) + 0.2 || nearNy(near, x, z) < 0.76) continue;
      if (habitat === 'east' && i % 3 === 0 && trailDistance(x, z) > 3.7) {
        const size = 0.42 + 0.5 * upland();
        add(0, x, z, 1.35 * size, 0.44 * size, size, upland);
      } else if (habitat === 'east' || i % 3 === 0) {
        const radius = 0.6 + upland() * 1.45;
        add(i % 2, x, z, radius * 1.1, radius * (habitat === 'east' ? 1.65 : 0.71), radius, upland);
        for (let j = 0; j < 3; j++) {
          const scale = 0.25 + upland() * 0.45;
          add(1, x + (upland() - 0.5) * 5, z + (upland() - 0.5) * 5, scale, scale * 0.7, scale, upland);
        }
      } else if (room(x, z, 4.5)) {
        const broadleaf = habitat === 'west' || (habitat === 'headwaters' && i % 2);
        const seed = broadleaf ? 0.54 * upland() : 0.55 + 0.45 * upland();
        trees.push(x, y - 0.07, z, seed, (habitat === 'west' ? 4.5 : 3.2) + 2.8 * upland());
      }
    }
  }
  // A few wind-shaped trees frame the uphill lip of each inner terrace.
  for (const [x,z,h] of [[-51,-21,3.8],[-25,-35,3.2],[-47,-41,4.4],[-50,13,3.3],
    [47,41,3.8],[39,-35,3.4],[10,-49,3.1],[-23,53,3.6]]) {
    if (room(x,z,1.85) && nearNy(near,x,z)>0.60)
      trees.push(x,nearH(near,x,z)-0.12,z,0.59+0.33*upland(),h);
  }
  // Flat shoals around the new spring leave gaps for wading and the outlet.
  for (let i = 0; i < 160; i++) {
    const angle = upland() * Math.PI * 2, radius = 0.68 + 0.52 * upland();
    const x = spring.x + Math.cos(angle) * 17.5 * radius, z = spring.z + Math.sin(angle) * 12 * radius;
    const scale = i % 19 === 0 ? 0.65 + 0.52 * upland() : 0.07 + 0.19 * upland();
    add(i % 19 === 0 ? 0 : 3, x, z, scale * 1.3, scale * 0.55, scale, upland);
  }
  // Roots keep their space. Reserve the larger stone landmarks before scattering
  // extra desktop gravel, so quality settings agree on where the boulders sit.
  for (let i = 0; i < trees.length; i += 5) {
    const radius = 0.10*trees[i+4];
    reserve(trees[i], trees[i+2], radius, radius, 0);
  }
  const tall = highSites.instances;
  for (let i = 0; i < tall.length; i += 4) {
    const radius = 0.073*tall[i+3];
    reserve(tall[i], tall[i+2], radius, radius, 0);
  }
  boulders.sort((a,b) => Math.max(b[3],b[5])-Math.max(a[3],a[5]));
  boulders.forEach(place);
  gravel.forEach(place);
  return { rv: rv.map((a) => new Float32Array(a)), rs: rs.map((a) => new Float32Array(a)), beds: beds.map(a => new Float32Array(a)), trees: new Float32Array(trees) };
}

// ---------------------------------------------------------------- junipers
const LEAF_MULT = touch ? 1.06 : 1.47;
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
      Lf.R.push(...root, pd.f); Lf.D.push(...dir, 2 * pd.R * (0.55 + 0.5 * r()) * (1.15 - rf * 0.4)); Lf.M.push(0.08 + 0.1 * r(), 0.12 + 0.25 * r(), 0.103 + 0.087 * r(), r()); Lf.B.push(...base);
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
    const count = Math.ceil((touch ? 66 : 88) * (0.65 + Math.min(radius, 2) * 0.32));
    for (let i = 0; i < count; i++) {
      const az = i * 2.39996 + rand() * 0.35, cy = 2 * (i + rand()) / count - 1;
      const side = Math.sqrt(1 - cy * cy), cx = Math.cos(az) * side, cz = Math.sin(az) * side;
      const r = radius * (0.58 + 0.42 * rand()), len = radius * (0.52 + 0.34 * rand());
      leaves.R.push(center[0] + r * (cx + 0.35 * dx * cy), center[1] + r * (0.74 * cy + 0.22 * (cx * dx + cz * dz)), center[2] + r * (cz + 0.35 * dz * cy), flex);
      const heading = norm([cx + dx * 0.46, 0.28 + cy * 0.66, cz + dz * 0.46]);
      leaves.D.push(...heading, len);
      leaves.M.push(0.09 + 0.08 * rand(), 0.1 + 0.16 * rand(), len * (0.49 + 0.27 * rand()), 1 + 0.37 * rand() + 0.31 * (cy + 1));
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
        leaves.M.push(0.08, 0.13, h * 0.028, 1.88);
        leaves.B.push(...base);
      }
      tube(wood, runner, runner.map((_, k) => h * (0.008 - 0.0007 * k)), 5, flex + 0.26, flex + 0.26, base, seed + i);
    }
  }
}
// Spiral crowns grow in small colonies at the margins of groves, treads and water.
function growRosettes(sc, near, leaves) {
  const r = rng(11497);
  const pockets = [[15, 27], [6, 32], [-28, 14], [-5, -39], [-25, -87], [-101, 5], [104, -18], [10, 102]];
  for (let i = 0; i < sc.trees.length; i += 10) pockets.push([sc.trees[i], sc.trees[i + 2]]);
  for (const walk of [trail, ...Object.values(valleyWalks), ...Object.values(rangeWalks)]) {
    for (let i = 1; i < walk.length; i += 3) pockets.push(walk[i]);
  }
  const obstacles = [];
  for (let i = 0; i < sc.trees.length; i += 5)
    obstacles.push([sc.trees[i], sc.trees[i + 2], 0.14 * sc.trees[i + 4]]);
  for (let g = 0; g < sc.rv.length; g++) {
    if (g === 3) continue;
    const sites = sc.rv[g], sizes = sc.rs[g];
    for (let i = 0; i < sites.length; i += 4)
      obstacles.push([sites[i], sites[i + 2], Math.max(sizes[i], sizes[i + 2])]);
  }
  for (const [cx, cz] of pockets) {
    const nearby = obstacles.filter(([x, z, radius]) => Math.abs(cx - x) < 7 + radius && Math.abs(cz - z) < 7 + radius);
    const warm = vnoise(cx * 0.06 + 2, cz * 0.06 + 3) > 0.65;
    for (let plant = 0; plant < 5; plant++) {
      const a = r() * 2 * Math.PI, offset = 1.7 + 4.5 * r();
      const x = cx + Math.cos(a) * offset, z = cz + Math.sin(a) * offset;
      const y = nearH(near, x, z), h = (0.63 + 0.99 * r()) * (plant ? 0.83 : 1.24);
      if (!inMap(x, z) || y < waterLevel(x, z) + 0.12 || nearNy(near, x, z) < 0.84 ||
          trailCover(x,z) > 0.12 || trailDistance(x, z) < 1.15 + h || Math.hypot(x - START[0], z - START[1]) < 1.9) continue;
      // Leave room around boulders and tree trunks for every crown to open.
      if (nearby.some(([bx, bz, radius]) => (x - bx) ** 2 + (z - bz) ** 2 < (radius + 0.32 * h) ** 2)) continue;
      const hue = warm ? 0.81 + 0.16 * r() : r() * 0.42, spin = r() * 6.2832;
      for (let j = 0; j < 21; j++) {
        const young = j / 20, az = spin + 2.39996 * j + 0.18 * r();
        const dx = Math.cos(az), dz = Math.sin(az), stalk = 0.12 * h * (1 - young);
        const length = h * (1.30 - 0.50 * young + 0.24 * r());
        leaves.R.push(x + dx * stalk, y - 0.055 + 0.20 * h * young, z + dz * stalk, 0.06);
        leaves.D.push(...norm([dx, 0.22 + 1.95 * young * young, dz]), length);
        leaves.M.push(0.26 + 0.15 * r(), 0.17 * (1 - young), length * (0.24 + 0.12 * Math.sin(Math.PI * young) + 0.055 * r()), 2.08 + 0.49 * young + 0.40 * r());
        leaves.B.push(x, z, h, hue);
      }
    }
  }
}
function growForest(sc, near) {
  const W = { pos: [], nor: [], w: [], b: [], idx: [] }, Lf = { R: [], D: [], M: [], B: [] };
  const stands = new Map(), patches = [];
  function addTree(x, y, z, height, seed, yaw) {
    const key = Math.floor(x / TILE_M) + TILES * Math.floor(z / TILE_M);
    if (!stands.has(key)) stands.set(key, []);
    stands.get(key).push({ x, y, z, height, seed, yaw });
  }
  for (let q = 0; q < sc.trees.length; q += 5) {
    const [x, y, z, seed, height] = sc.trees.subarray(q, q + 5);
    addTree(x, y, z, height, seed);
  }
  const sx = ISLET[0]-1.15, sz = ISLET[1]+0.55;
  addTree(sx, nearH(near,sx,sz)-0.08, sz, 4.35, 0.7317, Math.atan2(LAKE[1]-sz, LAKE[0]-sx)+2.4);

  // Pack neighbouring trunks into contiguous index ranges. The main view
  // and its water reflection can discard whole stands before drawing.
  for (const stand of stands.values()) {
    const start = W.pos.length, first = W.idx.length;
    for (const { x, y, z, height, seed, yaw } of stand) {
      const grow = height > 3 && seed < 0.54 ? growBroadleaf : growJuniper;
      grow(x, y, z, height, seed, W, Lf, yaw);
    }
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = start; i < W.pos.length; i += 3) {
      const x = W.pos[i], y = W.pos[i + 1], z = W.pos[i + 2];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
    }
    patches.push({ first, end: W.idx.length, x0, z0, y0: y0 - 1, y1: y1 + 1, width: x1 - x0, depth: z1 - z0, pad: 1 });
  }
  growRosettes(sc, near, Lf);
  return { patches, pos: new Float32Array(W.pos), nor: new Float32Array(W.nor), w: new Float32Array(W.w), b: new Float32Array(W.b), idx: new Uint32Array(W.idx), R: new Float32Array(Lf.R), D: new Float32Array(Lf.D), M: new Float32Array(Lf.M), B: new Float32Array(Lf.B) };
}

// understory around tree bases and big stones, ferns along the shade and the shore, glow tubes by the water,
// coilferns curling in the shade of the junipers, and lantern bells nodding along the shore and the meadows
function plantScatter(sc, near) {
  const r = rng(555), P = [], F = [], S2 = [];
  const ok = (x, z) => { const y = H(x, z); return y > 0.32 && y < 10 && nearNy(near, x, z) > 0.8 && clearOf(x, z) && inMap(x, z) && outcrop(x, z) < 0.6; };
  const anchors = [];
  const coreAnchor = (x, z) => { if (Math.max(Math.abs(x), Math.abs(z)) < VALLEY_HALF) anchors.push([x, z]); };
  for (let q = 0; q < sc.trees.length; q += 5) coreAnchor(sc.trees[q], sc.trees[q + 2]);
  for (const v of [0, 1]) for (let q = 0; q < sc.rv[v].length; q += 4) if (sc.rs[v][q] > 0.9) coreAnchor(sc.rv[v][q], sc.rv[v][q + 2]);
  const nearA = (r0, r1) => { const a = anchors[Math.floor(r() * anchors.length)], t = r() * 6.2832, d = r0 + r() * (r1 - r0); return [a[0] + Math.cos(t) * d, a[1] + Math.sin(t) * d]; };
  const shoreP = (d0, d1) => { let x, z, k = 0; do { x = LAKE[0] + (r() * 2 - 1) * 38; z = LAKE[1] + (r() * 2 - 1) * 32; k++; } while ((lakeD(x, z) < d0 || lakeD(x, z) > d1) && k < 60); return [x, z]; };
  const anywhere = () => [(r() * 2 - 1) * (VALLEY_HALF - 2), (r() * 2 - 1) * (VALLEY_HALF - 2)];
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
  // Offset clumps of arrowleaf grow from short rootstocks on the rock benches.
  const ridgeRand = rng(71349);
  function arrowleaf(cx,cz,warm=false) {
    const pigment = warm ? 0.64+0.25*ridgeRand() : ridgeRand();
    const yaw = ridgeRand()*6.283, stems = 2+Math.floor(ridgeRand()*3);
    for (let j=0;j<stems;j++) {
      const x=cx+(ridgeRand()-0.5)*1.9, z=cz+(ridgeRand()-0.5)*1.9;
      if (!inMap(x,z) || trailCover(x,z)>0.15 || nearNy(near,x,z)<0.66) continue;
      const y=nearH(near,x,z);
      if(y<3.1 || y>29) continue;
      const h=(j===0?1.09:0.55)+0.57*ridgeRand(), count=5+Math.floor(4*ridgeRand());
      for(let i=0;i<count;i++) {
        const angle=yaw+i*2.39996+0.54*ridgeRand(), leaf=h*(0.63+0.54*ridgeRand());
        P.push(x,y-0.025,z,1); F.push(angle,leaf,leaf*(0.12+0.085*ridgeRand()),6);
        S2.push(0.52+0.40*ridgeRand(),0.65+0.49*ridgeRand(),0.23+0.19*ridgeRand(),pigment);
      }
    }
  }
  for (let i = 2; i < trail.length - 3; i += 3) {
    const [x, z] = trail[i], dx = trail[i + 1][0] - x, dz = trail[i + 1][1] - z;
    const side = (i % 2 ? 1 : -1) * (2.4 + ridgeRand() * 0.8) / Math.hypot(dx, dz);
    arrowleaf(x - dz * side, z + dx * side);
  }
  for (let i = 0; i < 140; i++) {
    if (i % 6 === 0) { arrowleaf(...besideWalk(valleyWalks.terrace, ridgeRand), true); continue; }
    const x = (ridgeRand() * 2 - 1) * (VALLEY_HALF - 3), z = (ridgeRand() * 2 - 1) * (VALLEY_HALF - 3);
    if (Math.hypot(x, z) > 35 && H(x, z) > 5.2) arrowleaf(x, z);
  }
  const outer = rng(92381);
  for (const [habitat, points] of Object.entries(rangeWalks)) {
    for (let i = 0; i < 210 * k; i++) {
      const [cx, cz] = besideWalk(points, outer, 2.0, i % 3 === 0 ? 35 : 7.5);
      if (Math.max(Math.abs(cx), Math.abs(cz)) < VALLEY_HALF - 2 || !inMap(cx, cz)) continue;
      if (habitat === 'south' || (habitat === 'east' && i % 3)) { arrowleaf(cx, cz, true); continue; }
      const yaw = outer() * 6.2832, scale = 0.75 + 0.6 * outer();
      for (let j = 0; j < 6; j++) {
        const x = cx + (outer() - 0.5) * 1.6, z = cz + (outer() - 0.5) * 1.6;
        const y = nearH(near, x, z);
        if (y < waterLevel(x, z) - 0.04 || nearNy(near, x, z) < 0.72 || trailCover(x, z) > 0.02) continue;
        const kind = habitat === 'headwaters' && i % 3 ? 4 : 3, phi = yaw + j * 2.39996;
        const length = kind === 4 ? 0.64 + 0.5 * outer() : 0.45 + 0.41 * outer();
        for (const angle of [phi, phi + 1.5708]) {
          P.push(x, y - 0.02, z, scale); F.push(angle, length, 0.06, kind);
          S2.push(kind === 4 ? 0.56 : 0.29, 0.94, 0, 0);
        }
      }
    }
  }
  return { P: new Float32Array(P), F: new Float32Array(F), S2: new Float32Array(S2) };
}
const VALLEY_MOTES = touch ? 520 : 840, MOTE_N = VALLEY_MOTES * 3;
function moteScatter() {
  const r = rng(808), m = new Float32Array(MOTE_N * 4);
  for (let i = 0; i < MOTE_N; i++) {
    const radius = (i < VALLEY_MOTES ? VALLEY_HALF : WORLD_HALF) - 2;
    let x, z;
    do { x = (r() * 2 - 1) * radius; z = (r() * 2 - 1) * radius; }
    while (i >= VALLEY_MOTES && Math.max(Math.abs(x), Math.abs(z)) < VALLEY_HALF);
    m.set([x, Math.max(H(x, z), waterLevel(x, z)) + 0.4 + r() * 2.4, z, r()], i * 4);
  }
  return m;
}

// ---------------------------------------------------------------- the night sky
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Galactic coordinates in the sky frame, with rows toward the core, the galactic pole and their cross product.
const GAL = (() => {
  // the core stands 13 degrees from the pole, so it never sets and rides 40 to 65 degrees up all night
  const C = norm([0.192, 0.669, 0.718]), V0 = norm([-C[0] * C[1], 1 - C[1] * C[1], -C[2] * C[1]]), W = cross(C, V0), a = 0.45;
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
function bakeMilkyWay(bounded = true) {
  const t = gl.createTexture(), f = gl.createFramebuffer();
  gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
  gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 1, gl.RGBA8, MILKY_SIZE, MILKY_SIZE);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_CUBE_MAP, k, v);
  gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.viewport(0, 0, MILKY_SIZE, MILKY_SIZE);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.bindVertexArray(null); gl.useProgram(MILKY);
  // A deterministic RGBA8 write is part of the colour-range test in the sky shader.
  gl.disable(gl.DITHER);
  gl.uniform1i(MILKY.u('uBounded'), bounded);
  gl.uniform1f(MILKY.u('uSize'), MILKY_SIZE); gl.uniformMatrix3fv(MILKY.u('uGal'), false, GAL);
  for (let i = 0; i < 6; i++) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, t, 0);
    gl.uniform1i(MILKY.u('uFace'), i); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(f); gl.enable(gl.DITHER); gl.enable(gl.DEPTH_TEST);
  return t;
}

// ---------------------------------------------------------------- tiled instances
// Blades, leaves and plants are drawn tile by tile, 16 m to a tile. A tile outside the view is skipped, and one
// further than `near` metres draws only a prefix of its instances, shuffled so the prefix is an even thinning, with
// each survivor widened to hold the cover (Corey's adaptive density, per tile).
const TILE_M = 16, TILES = Math.ceil(2 * (WORLD_HALF + TILE_M) / TILE_M);
// Six intervals down each blade, with a central ridge shared by both faces.
function leafElements() {
  const triangles = [];
  for (let row = 0; row < 6; row++) for (let face = 0; face < 2; face++) {
    const k = row * 3 + face;
    triangles.push(k, k + 3, k + 1, k + 1, k + 3, k + 4);
  }
  gl.bindVertexArray(null);
  return uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, new Uint8Array(triangles));
}
class Tiled {
  constructor(prog, data, roots, span, verts, near, least) {
    Object.assign(this, { prog, verts, near, least });
    const names = Object.keys(data), n = data[names[0]].length / 4, cell = new Int32Array(n), counts = new Int32Array(TILES * TILES + 1);
    const tileOf = (x, z) => Math.min(TILES - 1, Math.max(0, Math.floor((x + WORLD_HALF + TILE_M) / TILE_M))) + TILES * Math.min(TILES - 1, Math.max(0, Math.floor((z + WORLD_HALF + TILE_M) / TILE_M)));
    for (let i = 0; i < n; i++) { cell[i] = tileOf(roots[4 * i], roots[4 * i + 2]); counts[cell[i] + 1]++; }
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
        const i = order[k], y = roots[i * 4 + 1], reach = typeof span === 'function' ? span(i) : span;
        y0 = Math.min(y0, y - reach); y1 = Math.max(y1, y + reach); pad = Math.max(pad, reach);
      }
      const x0 = (t % TILES) * TILE_M - WORLD_HALF - TILE_M, z0 = Math.floor(t / TILES) * TILE_M - WORLD_HALF - TILE_M;
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
    const bladeFaces = prog === JLEAF ? leafElements() : null;
    for (const tile of this.tiles) {
      tile.vao = gl.createVertexArray();
      gl.bindVertexArray(tile.vao);
      if (bladeFaces) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bladeFaces);
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
    const isLeaf = this.prog === JLEAF, simpleLeaf = isLeaf && this.prog.u('uSimpleLeaf');
    const detailDistance = density < 1 ? 8 : 17;
    let drawn = 0;
    for (const t of this.tiles) {
      if (outsideView(planes, t, TILE_M)) continue;
      const dx = Math.max(t.x0 - eye[0], 0, eye[0] - t.x0 - TILE_M), dz = Math.max(t.z0 - eye[2], 0, eye[2] - t.z0 - TILE_M), d = Math.hypot(dx, dz);
      const fade = isLeaf ? 1 : 1 - sm(60, 90, d);
      const f = Math.max(this.least, Math.min(1, Math.pow(this.near / Math.max(d, 1), 1.7)));
      const n = Math.floor(t.count * f * density * fade);
      if (n <= 0) continue;
      gl.bindVertexArray(t.vao);
      gl.uniform1f(lodW, Math.min(2.2, 1 / Math.sqrt(f * density)));
      const coarse = isLeaf && d > detailDistance;
      if (isLeaf) gl.uniform1i(simpleLeaf, Number(coarse));
      if (isLeaf && !coarse) gl.drawElementsInstanced(gl.TRIANGLES, 72, gl.UNSIGNED_BYTE, 0, n);
      else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, this.verts, n);
      drawn += n;
    }
    gl.uniform1f(lodW, 1);
    return drawn;
  }
}
// Pull the six clip planes into world space once per pass. Reflecting their Y
// coefficients lets all tile bounds stay in the original world coordinates.
const viewPlanes = new Float64Array(24);
function prepareViewPlanes(vp, mirror, crop) {
  for (let plane = 0; plane < 6; plane++) {
    const axis = plane >> 1, sign = plane % 2 ? -1 : 1;
    const bound = crop && axis < 2 ? (sign > 0 ? 1 - 2 * crop[axis] : 2 * crop[axis + 2] - 1) : 1;
    for (let i = 0; i < 4; i++) {
      const k = i * 4;
      viewPlanes[plane * 4 + i] = (bound * vp[k + 3] + sign * vp[k + axis]) * (i === 1 ? mirror : 1);
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
const highSites = highCanopySites(H, vnoise, rng(914), VALLEY_HALF, trailCover, waterLevel);
const { near, wm, sc, rocks, wood, leaves, grass, plants, coilView, lanternView, sailwings, heightRange } = buildValley();
const far = uploadTerrain(terrainFar());
function uploadTerrain(mesh) {
  const attrs = [{ loc: loc(TERRAIN, 'aPos'), size: 3, data: mesh.pos }, { loc: loc(TERRAIN, 'aNor'), size: 3, data: mesh.nor }];
  if (mesh.ground) attrs.push({ loc: loc(TERRAIN, 'aGround'), size: 2, data: mesh.ground });
  return { vao: vao(attrs, mesh.idx), count: mesh.fullCount, patches: mesh.patches, drawCounts: mesh.drawCounts, byteOffsets: mesh.byteOffsets };
}
function uploadWater(mesh) {
  const attrs = [{ loc: loc(WATERP, 'aXZ'), size: 2, data: mesh.xz }, { loc: loc(WATERP, 'aWater'), size: 3, data: mesh.water }];
  return { vao: vao(attrs, mesh.idx), patches: mesh.patches,
    drawCounts: new Int32Array(mesh.patches.length), byteOffsets: new Int32Array(mesh.patches.length) };
}
function buildValley() {
  // Ground arrays are used to place vegetation and flight paths, then live only on the GPU.
  const near = terrainNear();
  const fixed = new Uint8Array((NEAR.S / 2) ** 2);
  const stoneMeshes = [
    rockSet(4, [[1.3, 'round'], [5.9, 'block'], [3.3, 'slab']]),
    rockSet(4, [[4.1, 'block'], [8.6, 'round'], [6.2, 'slab']]),
    rockSet(4, [[7.7, 'tall'], [9.4, 'tall'], [2.8, 'block']]),
    rockSet(3, [[2.2, 'round'], [5.1, 'slab'], [7.3, 'block']]),
  ];
  const sc = scatter(near, fixed, stoneMeshes);
  const rocks = stoneMeshes.map((mesh, k) => rockBatches(mesh, sc.rv[k], sc.rs[k], sc.beds[k]));
  Object.assign(near, terrainPatches(near.pos, NEAR.S, NEAR.S, false, fixed));
  const grass = bakeMeadow({ gl, shader: GRASS, half: WORLD_HALF, density: GRASS_DENSITY, heightRange: near.heightRange,
    heightAt: (x, z) => nearH(near, x, z), outsideView, rng, touch,
    habitatAt(x, z, data, i) {
      const y = nearH(near, x, z), water = waterLevel(x, z);
      const tread = trailCover(x,z);
      if (y < water - 0.12 || tread >= 0.98) return;
      const island = Math.hypot((x-ISLET[0]+0.21*(z-ISLET[1]))/7, (z-ISLET[1])/5.1);
      if (island < 1.6) {
        data[i] = 0.36*(1-sm(0.43,0.87,island))*sm(0.8,1.6,y);
        data[i+1] = 0.52+0.28*vnoise(x*0.8,z*0.8);
        return;
      }
      const ld = y > -0.38 && y < 0.55 ? lakeD(x, z) : 0;
      if (ld > 10 && ld < 12.6 || water > 4.8 && y - water < 0.28) {
        data[i] = 0.23; data[i + 1] = 2.45; return;
      }
      const edge = Math.max(Math.abs(x), Math.abs(z)), upland = sm(51, 85, edge);
      const moisture = water > 0.02 ? sm(0.04, 0.80, y - water) : 1;
      const grow = sm(0.2, 0.55, y) * (1 - sm(16 + 12 * upland, 25 + 16 * upland, y)) * sm(0.53, 0.81, nearNy(near, x, z))
        * (1 - 0.65 * outcrop(x, z)) * Math.min(1, 0.75 + 0.5 * vnoise(x * 0.9 + 7, z * 0.9 - 3));
      const tall = sm(0.5, 0.78, fbm(x * 0.028 + 21, z * 0.028 - 9, 3));
      const heath = 1 - sm(WORLD_HALF - 5 - 10 * tall, WORLD_HALF, edge);
      data[i] = Math.min(1, grow * 1.24) * (0.035 + 0.965 * moisture) * heath * (1-sm(0.12,0.96,tread));
      data[i + 2] = 1 - sm(0.9, 2.7, trailDistance(x, z));
      data[i + 1] = (0.45 + 0.55 * Math.min(1, grow * 1.2)) * (0.8 + 0.75 * fbm(x * 0.06 + 11, z * 0.06 - 4, 3))
        * (1 + 0.65 * tall) * (0.82 + 0.18 * moisture) * (1 - 0.22 * tread);
    },
  });
  const forest = growForest(sc, near);
  const vWood = vao([
    { loc: loc(WOOD, 'aPos'), size: 3, data: forest.pos }, { loc: loc(WOOD, 'aNor'), size: 3, data: forest.nor },
    { loc: loc(WOOD, 'aW'), size: 4, data: forest.w }, { loc: loc(WOOD, 'aB'), size: 4, data: forest.b },
  ], forest.idx);
  const leaves = new Tiled(JLEAF, { aR: forest.R, aD: forest.D, aM: forest.M, aB: forest.B },
    forest.R, i => 2.2 * forest.D[i * 4 + 3] + 0.75, 7, 34, 0.075);
  const pl = plantScatter(sc, near);
  const plants = new Tiled(PLANT, { aP: pl.P, aF: pl.F, aS2: pl.S2 },
    pl.P, i => 0.2 + 1.8 * pl.P[i * 4 + 3] * pl.F[i * 4 + 1], 25, 24, 0.06);
  const heightRange = bakeGroundLight(gl, EXTENT, (x, z) => nearH(near, x, z), waterLevel, sc, highSites.instances, pl);
  bakeCanopy(gl, forest, EXTENT);
  bakeFloraSpill(pl);
  const sailwings = createSailwings({ gl, program, vao, worldVertex: WORLD_VS, groundAt: (x, z) => nearH(near, x, z), waterLevel, riverX, sc, random: rng(971), windAt: (x,z) => wind.sample(x,z)*windStrength(), outsideView });
  return { near: uploadTerrain(near), wm: uploadWater(waterMesh(near)), heightRange, sailwings, sc, rocks,
    wood: { vao: vWood, count: forest.idx.length, patches: forest.patches,
      drawCounts: new Int32Array(forest.patches.length), byteOffsets: new Int32Array(forest.patches.length) },
    leaves, grass, plants, coilView: plantView(pl, 3), lanternView: plantView(pl, 4) };
}
const highTrees = uploadHighCanopy(highSites);
function uploadHighCanopy(sites) {
  const siteAttr = { loc: loc(HIGH_CANOPY,'aSite'), size:4, data:sites.instances, div:1 };
  return [9942, 2113, 8605].map((seed, variant) => {
    const mesh = highCanopyMesh(rng(seed));
    const attrs = [
      { loc:loc(HIGH_CANOPY,'aPos'), size:3, data:mesh.position },
      { loc:loc(HIGH_CANOPY,'aNor'), size:3, data:mesh.normal },
      { loc:loc(HIGH_CANOPY,'aBlade'), size:2, data:mesh.blade },
      { loc:loc(HIGH_CANOPY,'aTissue'), size:1, data:mesh.tissue }, siteAttr,
    ];
    gl.bindVertexArray(null);
    const indices = uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
    const tiles = sites.tiles.filter(tile => tile.variant===variant);
    for (const tile of tiles) tile.vao = vao(attrs, indices, tile.start);
    return { tiles, count:tiles.reduce((sum,tile)=>sum+tile.count,0), near:mesh.nearCount, far:mesh.farCount };
  });
}
function drawHighCanopy(planes, mirror = 1, eye) {
  const width = highSites.width, distance = mirror < 0 ? 32 : 72;
  for (const group of highTrees) {
    if (!group.count) continue;
    const farOffset = group.near * Uint16Array.BYTES_PER_ELEMENT;
    if (!planes) {
      gl.bindVertexArray(group.tiles[0].vao);
      gl.drawElementsInstanced(gl.TRIANGLES, group.far, gl.UNSIGNED_SHORT, farOffset, group.count);
      continue;
    }
    for (const tile of group.tiles) {
      if (outsideView(planes, tile, width)) continue;
      const dx = Math.max(tile.x0-eye[0], 0, eye[0]-tile.x0-width);
      const dz = Math.max(tile.z0-eye[2], 0, eye[2]-tile.z0-width);
      const close = dx*dx+dz*dz < distance*distance;
      gl.bindVertexArray(tile.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, close ? group.near : group.far, gl.UNSIGNED_SHORT,
        close ? 0 : farOffset, tile.count);
    }
  }
}
function rockBatches(mesh, sites, sizes, beds) {
  const width = 16, cells = new Map();
  let footprint = 0, bottom = Infinity, top = -Infinity;
  for (const shape of mesh.pos) for (let k = 0; k < shape.length; k += 3) {
    footprint = Math.max(footprint, Math.hypot(shape[k], shape[k + 2]));
    bottom = Math.min(bottom, shape[k + 1]); top = Math.max(top, shape[k + 1]);
  }
  for (let k = 0; k < sites.length; k += 4) {
    const x = Math.floor(sites[k] / width), z = Math.floor(sites[k + 2] / width), key = x + ',' + z;
    if (!cells.has(key)) cells.set(key, { x0: x * width, z0: z * width, y0: Infinity, y1: -Infinity, pad: 0, maxScale: 0, members: [] });
    const cell = cells.get(key);
    cell.maxScale = Math.max(cell.maxScale, sizes[k], sizes[k + 1], sizes[k + 2]);
    const tilt = Math.hypot(beds[k], beds[k+1]), spread = footprint * Math.max(sizes[k], sizes[k+2]);
    cell.pad = Math.max(cell.pad, spread + tilt * sizes[k+1]);
    cell.y0 = Math.min(cell.y0, sites[k + 1] + bottom * sizes[k + 1] - tilt * spread);
    cell.y1 = Math.max(cell.y1, sites[k + 1] + top * sizes[k + 1] + tilt * spread);
    cell.members.push(k);
  }
  const poses = new Float32Array(sites.length), scales = new Float32Array(sizes.length), contacts = new Float32Array(beds.length);
  const attrs = [
    ...mesh.pos.map((data, i) => ({ loc: loc(ROCK, 'aPos' + (i || '')), size: 3, data })),
    ...mesh.nor.map((data, i) => ({ loc: loc(ROCK, 'aNor' + (i || '')), size: 3, data })),
    { loc: loc(ROCK, 'aI'), size: 4, data: poses, div: 1 }, { loc: loc(ROCK, 'aS'), size: 4, data: scales, div: 1 },
    { loc: loc(ROCK, 'aBed'), size: 4, data: contacts, div: 1 },
  ];
  const tiles = [];
  let count = 0;
  for (const { members, ...bounds } of cells.values()) {
    tiles.push({ ...bounds, first: count, count: members.length });
    for (const k of members) {
      poses.set(sites.subarray(k, k + 4), count * 4); scales.set(sizes.subarray(k, k + 4), count * 4);
      contacts.set(beds.subarray(k, k+4), count++ * 4);
    }
  }
  gl.bindVertexArray(null);
  const indices = new Uint16Array(mesh.levels.reduce((n, level) => n + level.length, 0));
  let offset = 0;
  const lods = mesh.levels.map(level => {
    const lod = { count: level.length, offset: offset * indices.BYTES_PER_ELEMENT };
    indices.set(level, offset); offset += level.length;
    return lod;
  });
  const ib = uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  for (const tile of tiles) tile.vao = vao(attrs, ib, tile.first);
  return { tiles, count, width, lods, errors: mesh.errors };
}

function drawRocks(VP, mirror = 1, focalPixels, planes) {
  for (let k = 0; k < rocks.length; k++) {
    const batch = rocks[k];
    if (!batch.count || (k === 3 && mirror < 0)) continue;
    // Shadow maps capture the full set in one call per rock shape.
    if (!VP) {
      gl.bindVertexArray(batch.tiles[0].vao);
      gl.drawElementsInstanced(gl.TRIANGLES, batch.lods[1].count, gl.UNSIGNED_SHORT, batch.lods[1].offset, batch.count);
      continue;
    }
    for (const tile of batch.tiles) {
      if (outsideView(planes, tile, batch.width)) continue;
      // Nearest camera-space depth in the box, including boulders extending past its tile.
      const x = VP[3] >= 0 ? tile.x0 - tile.pad : tile.x0 + batch.width + tile.pad;
      const y = VP[7] * mirror >= 0 ? tile.y0 : tile.y1;
      const z = VP[11] >= 0 ? tile.z0 - tile.pad : tile.z0 + batch.width + tile.pad;
      const depth = VP[3] * x + VP[7] * mirror * y + VP[11] * z + VP[15];
      const budget = 0.9 * depth / (focalPixels * tile.maxScale);
      const lod = batch.lods[batch.errors[1] < budget ? 2 : batch.errors[0] < budget ? 1 : 0];
      gl.bindVertexArray(tile.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, lod.count, gl.UNSIGNED_SHORT, lod.offset, tile.count);
    }
  }
}
let grassDensity = 1;
const stars = starScatter(), vStars = vao([{ loc: loc(STARS, 'aS'), size: 4, data: stars.S }, { loc: loc(STARS, 'aC'), size: 4, data: stars.C }]);
let clouds;
function bakeOceanAtlas() {
  const width=1024, height=512, f=gl.createFramebuffer();
  const atlas=gl.createTexture();
  gl.activeTexture(gl.TEXTURE0+18); gl.bindTexture(gl.TEXTURE_2D,atlas);

  gl.texStorage2D(gl.TEXTURE_2D,11,gl.RGBA8,width,height);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.bindFramebuffer(gl.FRAMEBUFFER,f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,atlas,0);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.DITHER);
  gl.bindVertexArray(null); gl.viewport(0,0,width,height); gl.useProgram(OCEAN_ATLAS);
  gl.drawArrays(gl.TRIANGLES,0,3);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.deleteFramebuffer(f);
  gl.generateMipmap(gl.TEXTURE_2D);
}
bakeOceanAtlas();
const milkyWay = bakeMilkyWay();
const motes = moteScatter();
const vMotes = vao([{ loc: loc(POINTS, 'aP'), size: 4, data: motes }]);
const RAIN_N = 700, rainSeeds = new Float32Array(RAIN_N * 4); { const r = rng(9); for (let i = 0; i < RAIN_N; i++) rainSeeds.set([(r() * 2 - 1) * 34, r(), (r() * 2 - 1) * 34, r()], i * 4); }
const vRain = vao([{ loc: loc(POINTS, 'aP'), size: 4, data: rainSeeds }]);
// each streak is two vertices, its top and its tail, sharing one drop
const vStreaks = (() => {
  const r = rng(31), drops = new Float32Array(RAIN_STREAKS * 8), ends = new Float32Array(RAIN_STREAKS * 2);
  for (let i = 0; i < RAIN_STREAKS; i++) {
    const d = [(r() * 2 - 1) * 26, (r() * 2 - 1) * 26, r(), r()];
    drops.set(d, i * 8); drops.set(d, i * 8 + 4); ends[i * 2 + 1] = 1;
  }
  return vao([{ loc: loc(RAINP, 'aDrop'), size: 4, data: drops }, { loc: loc(RAINP, 'aEnd'), size: 1, data: ends }]);
})();
const BOLT_VERTS = 512, boltBuf = new Float32Array(BOLT_VERTS * 3), boltAttr = { loc: loc(BOLTP, 'aPos'), size: 3, data: boltBuf, usage: gl.DYNAMIC_DRAW };
const vBolt = vao([boltAttr]);
let boltCount = 0;
const stoneBuf = new Float32Array(4 * 8);
const stoneAttr = { loc: loc(POINTS, 'aP'), size: 4, data: stoneBuf, usage: gl.DYNAMIC_DRAW };
const vStone = vao([stoneAttr]);
const stoneVbo = stoneAttr.buffer;

function fieldTex() {
  const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
const texGlow = fieldTex(), texGround = fieldTex(), texWear = fieldTex();
function clearTexture(tex) {
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, null);
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
const P_TEMPORAL = program(FSQ, temporalFragment), P_MIST = program(FSQ, mistFragment);
const P_FINAL = program(FSQ, viewRay + historyColor + `uniform sampler2D tScene, tBloom, tRays, tMist; uniform float uBloom, uRays; in vec2 vUv; out vec4 o;
vec3 acesF(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0., 1.); }
// Bilateral upsampling keeps air behind a nearby leaf or bank on its own side of the edge.
vec4 valleyMist(){
  vec2 size = vec2(textureSize(tMist, 0)), pixel = vUv * size - 0.5, f = fract(pixel);
  vec2 base = floor(pixel);
  float here = min(32., viewDepth(texture(tDepth, vUv).r)), sum = 0.;
  vec4 fog = vec4(0.);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 uv = (base + vec2(i,j) + 0.5) / size;
    float other = min(32., viewDepth(texture(tDepth, uv).r));
    float d = abs(other - here) / (0.18 + 0.08 * here);
    float w = (i == 0 ? 1.-f.x : f.x) * (j == 0 ? 1.-f.y : f.y) / (1. + d*d);
    vec4 sampleLight = texture(tMist, uv);
    if (uHDR < 0.5) sampleLight.rgb *= sampleLight.rgb;
    fog += sampleLight * w; sum += w;
  }
  return mix(vec4(0., 0., 0., 1.), fog / max(0.00001, sum), smoothstep(0.015, 0.17, sum));
}
void main(){
  vec3 c = unpackLight(texture(tScene, vUv).rgb), b = texture(tBloom, vUv).rgb, r = texture(tRays, vUv).rgb;
  vec4 fog = valleyMist();
  if (uHDR > 0.5) c = pow(acesF((c + b * uBloom + r * uRays) * fog.a + fog.rgb), vec3(1. / 2.2));
  else c = pow(clamp(pow(clamp(c + b * uBloom * 0.7 + r * uRays * 0.6, 0., 1.), vec3(2.2)) * fog.a + fog.rgb, 0., 1.), vec3(1./2.2));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, 1.15);
  vec2 q = vUv - 0.5; c *= 1. - dot(q, q) * 0.55;
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.;
  o = vec4(c, 1.); }`);

function colorTex(w, h, format = CFMT, type = CTYPE) {
  const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, format, w, h, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}
function fboFor(t, depth) {
  const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); return f;
}
const post = { w: 0, h: 0, ms: null, previous: null, write: 0 };
function ensurePost(w, h) {
  if (post.w === w && post.h === h) return;
  if (post.res) {
    for (const f of [post.ms, post.resF, ...post.mips.map((m) => m.f), post.rays.f, post.mist.f, post.under?.f, ...post.history.map(m => m.f)]) if (f) gl.deleteFramebuffer(f);
    for (const t of [post.res, ...post.mips.map((m) => m.t), post.rays.t, post.depth, post.mist.t, post.under?.t, ...post.history.map(m => m.t)]) if (t) gl.deleteTexture(t);
    for (const rb of [post.msC, post.msD]) if (rb) gl.deleteRenderbuffer(rb);
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
  gl.activeTexture(gl.TEXTURE3); post.depth = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, post.depth);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  post.resF = fboFor(post.res, post.depth);
  post.previous = null; post.write = 0;
  post.history = Array.from({ length: 2 }, () => {
    const t = colorTex(w, h, gl.RGBA8, gl.UNSIGNED_BYTE);
    return { t, f: fboFor(t) };
  });
  const mw = Math.max(1, Math.ceil(w / 4)), mh = Math.max(1, Math.ceil(h / 4));
  const mt = colorTex(mw, mh);
  post.mist = { t: mt, f: fboFor(mt), w: mw, h: mh };
  post.mips = [];
  for (let i = 1; i <= 2; i++) { const mw = Math.max(2, w >> i), mh = Math.max(2, h >> i), t = colorTex(mw, mh); post.mips.push({ t, f: fboFor(t), w: mw, h: mh }); }
  const rw = Math.max(2, w >> 1), rh = Math.max(2, h >> 1), rt = colorTex(rw, rh); post.rays = { t: rt, f: fboFor(rt), w: rw, h: rh };
  post.under = null;
  if (!post.ms) {
    const t = colorTex(rw, rh);
    post.under = { t, f: fboFor(t), w: rw, h: rh };
  }
}

function scissorWater(bounds, w, h) {
  const x = Math.floor(w * bounds[0]), y = Math.floor(h * bounds[1]);
  gl.scissor(x, y, Math.ceil(w * bounds[2]) - x, Math.ceil(h * bounds[3]) - y);
}

// On an MSAA target the resolved scene is already a separate, sampleable
// texture. Single-sample devices need a distinct copy to avoid feedback.
function copyUnderwater(w, h, bounds) {
  const source = post.ms || post.resF;
  const dest = post.ms ? post.resF : post.under.f;
  const dw = post.ms ? w : post.under.w, dh = post.ms ? h : post.under.h;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dest);
  gl.enable(gl.SCISSOR_TEST); scissorWater(bounds, dw, dh);
  gl.blitFramebuffer(0, 0, w, h, 0, 0, dw, dh, gl.COLOR_BUFFER_BIT, post.ms ? gl.NEAREST : gl.LINEAR);
  gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, source);
  gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, post.ms ? post.res : post.under.t);
}
function pass(prog, fbo, w, h, tex) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h); gl.useProgram(prog);
  if (tex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.u('tMap'), 4); }
}
function postProcess(VP, eye, b, w, h, t, tanX, tanY, jitter) {
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
    gl.uniform1f(P_RAYS.u('uVis'), vis); gl.uniform3fv(P_RAYS.u('uRayCol'), [1.0 * starTint[0] * (1 - night) + 0.25 * night, 0.62 * starTint[1] * (1 - night) + 0.38 * night, 0.36 * starTint[2] * (1 - night) + 0.8 * night]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const history = post.history[post.write];
  gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, post.depth);
  for (const p of [P_MIST, P_TEMPORAL]) {
    if (p === P_MIST) pass(p, post.mist.f, post.mist.w, post.mist.h);
    else pass(p, history.f, w, h, post.res);
    common(p, eye, VP, 1, t);
    gl.uniform1i(p.u('tDepth'), 15); gl.uniform2fv(p.u('uDepthRange'), depthRange);
    gl.uniform3f(p.u('uRayRight'), b.r[0]*tanX, b.r[1]*tanX, b.r[2]*tanX);
    gl.uniform3f(p.u('uRayUp'), b.u[0]*tanY, b.u[1]*tanY, b.u[2]*tanY);
    gl.uniform3fv(p.u('uForward'), b.f); gl.uniform2fv(p.u('uJitter'), jitter.offset);
    if (p === P_TEMPORAL) {
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, post.history[1-post.write].t); gl.uniform1i(p.u('tHistory'), 5);
      gl.uniform1i(p.u('uReuse'), jitter.phase >= 0);
      gl.uniformMatrix4fv(p.u('uPreviousVP'), false, post.previous?.vp || VP);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  post.write = 1 - post.write;
  pass(P_FINAL, null, w, h, null);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, post.mist.t); gl.uniform1i(P_FINAL.u('tMist'), 3);
  gl.uniform1i(P_FINAL.u('tDepth'), 15); gl.uniform2fv(P_FINAL.u('uDepthRange'), depthRange);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, history.t); gl.uniform1i(P_FINAL.u('tScene'), 4);
  gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, post.mips[0].t); gl.uniform1i(P_FINAL.u('tBloom'), 5);
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, post.rays.t); gl.uniform1i(P_FINAL.u('tRays'), 6);
  gl.uniform1f(P_FINAL.u('uBloom'), 0.085); gl.uniform1f(P_FINAL.u('uRays'), rayStrength); gl.uniform1f(P_FINAL.u('uHDR'), HDR ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
}

// ---------------------------------------------------------------- engine state
let wind, uploadedWind = -1;
const gustTexture = gl.createTexture();
bakeTrailMaterial(gl, rng(440951));
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
let simT = 0, denseUpload = null;

function setMode(m) {
  // Dense rows overwrite the whole image. All three layers can reuse the same staging buffer.
  denseUpload = m === DENSE ? (denseUpload ?? new Uint8Array(N * N)) : null;
  mode = m; sailwings.reset(); ripples.length = 0; post.previous = null;
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
  sailwings.startle(x, water ? waterLevel(x, z) : H(x, z), z, at, strength);
  if (water) { glowF.deposit(x, z, 9, 1); ripple(x, z, strength, at); for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283; groundF.deposit(x + Math.cos(a) * 2.2, z + Math.sin(a) * 2.2, 5, 0.5); } }
  else { glowF.deposit(x, z, 6, 1); groundF.deposit(x, z, 4, 0.25); wearF.deposit(x, z, 0, 0.5); }
}
function ripple(x, z, strength, at = simT) {
  const event = [x, z, at, strength, 0.34 * riverFlow(z, waterLevel(x, z))];
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
function spore(r, cx, cz) {
  // The moisture sheet covers the world. Individual impacts follow the shower
  // around the hiker at constant density as the playable area grows.
  const radius = VALLEY_HALF - 2, margin = WORLD_HALF - radius - 2;
  const x = Math.max(-margin, Math.min(margin, cx)) + (r() * 2 - 1) * radius;
  const z = Math.max(-margin, Math.min(margin, cz)) + (r() * 2 - 1) * radius, y = H(x, z);
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

// ---------------------------------------------------------------- storms
// A storm closes the sky, rains on the lake and wets the valley through the moisture field. Lightning strikes every
// few seconds: the flash lights everything at once, the bolt hangs for a moment, and where it lands it leaves a ring of
// light in the glow field that spreads and fades like any other, certified the same way. Thunder follows, late by the
// time sound takes to get here.
let storm = 0, stormTarget = 0, flash = 0, boltLight = 0, nextBolt = 0, reflash = -1, audio = null;
const stormRng = rng(2027);
function toggleStorm() {
  stormTarget = stormTarget > 0.5 ? 0 : 1;
  nextBolt = simT + 4;
  document.getElementById('bStorm').setAttribute('aria-pressed', String(stormTarget > 0.5));
}
/** The angle from where the player faces to (x, z): 0 ahead, positive to the right. */
function bearing(x, z) {
  const a = Math.atan2(x - player.x, player.z - z) - player.yaw;
  return Math.atan2(Math.sin(a), Math.cos(a));
}
function stepStorm(dt) {
  storm += (stormTarget - storm) * Math.min(1, dt * 0.3);
  if (Math.abs(stormTarget - storm) < 0.0005) storm = stormTarget;
  flash *= Math.exp(-dt * 7); boltLight *= Math.exp(-dt * 10);
  if (reflash > 0 && simT >= reflash) { flash = Math.max(flash, 0.8); boltLight = Math.max(boltLight, 0.85); reflash = -1; }
  if (storm > 0.65 && simT >= nextBolt) strike();
  if (storm > 0.05 && groundF.sheet < 0.6) groundF.rain(dt * 0.03 * storm);
}
/** A jagged path from a to b by midpoint displacement, kinked more at the top than near the ground. */
function boltPath(a, b, r, amp, levels) {
  let pts = [a, b];
  for (let level = 0; level < levels; level++, amp *= 0.55) {
    const next = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      next.push([(p[0] + q[0]) / 2 + (r() - 0.5) * amp, (p[1] + q[1]) / 2 + (r() - 0.5) * amp * 0.35, (p[2] + q[2]) / 2 + (r() - 0.5) * amp], q);
    }
    pts = next;
  }
  return pts;
}
function strike(r = stormRng, at = null) {
  nextBolt = simT + 5 + r() * 10;
  const a = r() * Math.PI * 2, d = at ? Math.hypot(at[0] - player.x, at[1] - player.z) : 30 + r() * 110;
  const x = at ? at[0] : player.x + Math.cos(a) * d, z = at ? at[1] : player.z + Math.sin(a) * d, y = H(x, z);
  // the bolt: three strands of the main channel, and one branch that dies in the air
  const main = boltPath([x + (r() - 0.5) * 30, 115, z + (r() - 0.5) * 30], [x, y, z], r, 16, 6);
  const fork = main[Math.floor(main.length * (0.25 + 0.2 * r()))];
  const branch = boltPath(fork, [fork[0] + (r() - 0.5) * 40, fork[1] * 0.45, fork[2] + (r() - 0.5) * 40], r, 8, 4);
  boltCount = 0;
  const line = (pts, dx, dz) => { for (let i = 0; i + 1 < pts.length && boltCount + 2 <= BOLT_VERTS; i++) for (const p of [pts[i], pts[i + 1]]) boltBuf.set([p[0] + dx, p[1], p[2] + dz], 3 * boltCount++); };
  line(main, 0, 0); line(main, 0.22, 0.1); line(main, -0.15, 0.2); line(branch, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, boltAttr.buffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, boltBuf, 0, boltCount * 3);
  flash = 1; boltLight = 1; reflash = simT + 0.08 + r() * 0.14;
  // where it lands, the ground lights up: a hot centre and a ring around it, in the glow field
  if (Math.abs(x) < EXTENT / 2 - 8 && Math.abs(z) < EXTENT / 2 - 8) {
    glowF.deposit(x, z, 24, 1);
    for (let k = 0; k < 10; k++) { const b = k / 10 * 6.2832; glowF.deposit(x + Math.cos(b) * 6, z + Math.sin(b) * 6, 10, 0.8); }
    groundF.deposit(x, z, 20, 0.6);
  }
  audio?.thunder(d, bearing(x, z));
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
  const { f, r, u } = b, [n, fr] = depthRange, t = 1 / Math.tan(fov / 2);
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
  const edge = WORLD_HALF - 1.001;
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
    audio?.footstep(footDepth > 0.015 ? 'water' : trailCover(x, z) > 0.3 || H(x, z) > 14 ? 'stone' : 'grass', speed > 2.6);
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
    audio?.splash(H(px, pz) < waterLevel(px, pz), Math.hypot(px - player.x, pz - player.z), bearing(px, pz));
    stones.splice(i, 1);
  }
}

// ---------------------------------------------------------------- render
const SUN = norm([-0.86, 0.40, -0.33]), SUNCOL = [3.65, 2.98, 2.13], PLANET = skyBodies.amber, MOONCOL = [0.19, 0.29, 0.55];
let night = 0, nightTarget = 0, sheet = 0, grassDrawn = 0;
function norm(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }
function bakeFloraSpill(plants) {
  const size = 2 * EXTENT, perMetre = size / EXTENT;
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
    const pigment = type === 6 ? [0.085 + 0.305 * warm, 0.47 - 0.30 * warm, 0.32 + 0.07 * warm]
      : type === 4 ? [0.88 - 0.16 * bellHue, 0.30 + 0.12 * bellHue, 0.70 + 0.28 * bellHue]
      : [0.085 + 0.855 * warm, 0.72 - 0.50 * warm, 0.62 - 0.28 * warm];
    const cx = (x + WORLD_HALF) * perMetre - 0.5, cz = (z + WORLD_HALF) * perMetre - 0.5, r = radius * perMetre;
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
const valleyShadows = bakeShadows(gl, touch ? 1536 : 2560, WORLD_HALF, [SUN, PLANET], [
  { source: TERRAIN, draw() { gl.bindVertexArray(near.vao); gl.drawElements(gl.TRIANGLES, near.count, gl.UNSIGNED_INT, 0); } },
  { source: ROCK, draw: () => drawRocks() },
  { source: HIGH_CANOPY, draw: () => drawHighCanopy() },
  { source: WOOD, draw() { gl.bindVertexArray(wood.vao); gl.drawElements(gl.TRIANGLES, wood.count, gl.UNSIGNED_INT, 0); } },
  { source: JLEAF, slices: 4, draw(i, slices) {
    // Each VAO starts at its tile in a contiguous buffer. Draw neighbouring
    // tiles together, spreading the forest across successive clock frames.
    const start = Math.floor(i * leaves.tiles.length / slices), end = Math.floor((i + 1) * leaves.tiles.length / slices);
    if (start === end) return;
    const first = leaves.tiles[start], last = leaves.tiles[end - 1];
    gl.bindVertexArray(first.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, leaves.verts, last.start + last.count - first.start);
  } },
], 1);
// the night sky turns about a tilted pole, once in about fifteen minutes
const POLE = norm([0.25, 0.8, 0.55]), skyTurn = new Float32Array(9);
function turnSky(t) {
  const a = t * 0.007 + skyOffset, c = Math.cos(a), s = Math.sin(a), k = 1 - c, [x, y, z] = POLE;
  skyTurn.set([c + x * x * k, y * x * k + z * s, z * x * k - y * s, x * y * k - z * s, c + y * y * k, z * y * k + x * s, x * z * k + y * s, y * z * k - x * s, c + z * z * k]);
}

// ---------------------------------------------------------------- the day
// Tarn's star crosses the sky about the same pole the stars turn on. Seen from this valley it never climbs past 33
// degrees: a long low afternoon, a sunset in the south-west, a night a little longer than the day, a sunrise in the
// north-east. The hand-set afternoon is where the clock stands until it is let run.
const DAY_RATE = 0.02, SHADOW_STEP = 0.012, EXTINCTION = [0.06, 0.12, 0.27];
// relative air mass toward a star `y` (the sine of its elevation) above the horizon (Kasten and Young, 1989)
const airMass = (y) => 1 / (Math.max(y, 0) + 0.50572 * Math.pow(96.07995 - Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI, -1.6364));
const SET_AIR = airMass(SUN[1]);
let day = 'still', dayAngle = 0, skyOffset = 0;
let starDirection = SUN, starColor = SUNCOL, starTint = [1, 1, 1], cloudTint = starTint;
// the two star layers in use (fading from, fading to), the clock angles they were baked for, and whether they must be
// baked afresh (the clock jumped) or the hand-set star restored to layer 0
const shadowKeys = { angles: [0, 0], layers: [0, 2], blend: 0, stale: true, moved: false, pending: null };
function starAt(a) {
  const c = Math.cos(a), s = Math.sin(a), [x, y, z] = POLE, [u, v, w] = SUN, d = (u * x + v * y + w * z) * (1 - c);
  return [u * c + (y * w - z * v) * s + x * d, v * c + (z * u - x * w) * s + y * d, w * c + (x * v - y * u) * s + z * d];
}
/** Put the star where the clock says, colour its light by the air it crosses, and keep its shadow up with it. */
function placeStar() {
  if (day === 'still') {
    starDirection = SUN; starColor = SUNCOL; starTint = cloudTint = [1, 1, 1];
    if (shadowKeys.moved) { valleyShadows.rebake(0, SUN); shadowKeys.layers = [0, 2]; shadowKeys.moved = false; }
    shadowKeys.blend = 0; shadowKeys.stale = true; shadowKeys.pending = null;
    return;
  }
  starDirection = starAt(dayAngle);
  const y = starDirection[1], air = airMass(y) - SET_AIR, up = sm(-0.035, 0.03, y);
  starTint = EXTINCTION.map((k) => Math.min(1.15, Math.exp(-k * air)) * up);
  starColor = SUNCOL.map((c, i) => c * starTint[i]);
  // the deck stands high enough to keep the star a little after the valley has lost it
  const high = airMass(y + 0.035) - SET_AIR, lit = sm(-0.09, -0.015, y);
  cloudTint = EXTINCTION.map((k) => Math.min(1.15, Math.exp(-k * high)) * lit);
  night = nightTarget = sm(0.035, -0.15, y);
  if (y < -0.04) return; // under the horizon its last shadow fades out with its light
  const [from, to] = shadowKeys.angles;
  if (shadowKeys.stale || dayAngle < from || dayAngle >= to + SHADOW_STEP) {
    if (shadowKeys.moved || dayAngle !== 0) valleyShadows.rebake(shadowKeys.layers[0], starDirection);
    shadowKeys.angles = [dayAngle, dayAngle + SHADOW_STEP];
    shadowKeys.pending = valleyShadows.prepare(shadowKeys.layers[1], starAt(dayAngle + SHADOW_STEP));
    shadowKeys.stale = false;
  } else if (dayAngle >= to) {
    // A long frame can cross the boundary. Finish the target before making it current.
    if (shadowKeys.pending) valleyShadows.advance(shadowKeys.pending, valleyShadows.passes);
    shadowKeys.layers.reverse();
    shadowKeys.angles = [to, to + SHADOW_STEP];
    shadowKeys.pending = valleyShadows.prepare(shadowKeys.layers[1], starAt(to + SHADOW_STEP));
  }
  shadowKeys.moved = true;
  const phase = Math.max(0, Math.min(1, (dayAngle - shadowKeys.angles[0]) / SHADOW_STEP));
  // Build ahead during the first quarter of the interval. No extra depth
  // layers are needed, including on a phone or after pausing the clock.
  if (shadowKeys.pending && (day === 'running' || phase > 0)) {
    const job = shadowKeys.pending;
    const due = Math.ceil(phase * 4 * valleyShadows.passes) - job.cursor;
    if (valleyShadows.advance(job, Math.max(1, due))) shadowKeys.pending = null;
  }
  shadowKeys.blend = shadowKeys.pending ? 0 : sm(0.25, 1., phase);
}
function advanceDay(dt) {
  if (day !== 'running') return;
  dayAngle += DAY_RATE * dt;
  if (dayAngle > Math.PI) { dayAngle -= 2 * Math.PI; shadowKeys.stale = true; }
  // the stars turn with the star, the same way
  skyOffset -= (DAY_RATE + 0.007) * dt;
}
function toggleDay() {
  if (day === 'still') {
    // from the hand-set afternoon toward sunset; from the hand-set night to a little before dawn
    dayAngle = night > 0.5 ? -2.55 : 0; day = 'running';
  } else day = day === 'running' ? 'paused' : 'running';
  document.getElementById('bDay').setAttribute('aria-pressed', String(day === 'running'));
}

let frameNumber = 0, lightDirection = SUN, lightColor = SUNCOL, exposure = 0.95;
function windStrength() { return (rain && !TEST ? 1.18 : 1.0) + 0.7 * storm; }
function common(p, eye, VP, mirror, t) {
  gl.useProgram(p);
  if (p.worldFrame === undefined) {
    gl.uniform1i(p.u('uOceanAtlas'),18); gl.uniform1i(p.u('uRockSurface'), 19); gl.uniform1i(p.u('uGusts'),16); gl.uniform1i(p.u('uTrailMaterial'),17);
    gl.uniform1i(p.u('uShadows'), 9); gl.uniform1i(p.u('uFloraSpill'), 10);
    gl.uniform1i(p.u('uClouds'), 11); gl.uniform1i(p.u('uCanopy'), 12);
    gl.uniform1i(p.u('uBendTex'), 13); gl.uniform1i(p.u('uValleyGround'), 14); gl.uniform2fv(p.u('uGroundRange'), heightRange);
    gl.uniform1i(p.u('uGlow'), 0); gl.uniform1i(p.u('uGround'), 1); gl.uniform1i(p.u('uWear'), 7);
    gl.uniform1i(p.u('uMilky'), 8); gl.uniform1i(p.u('uRefl'), 2); gl.uniform1i(p.u('uUnder'), 15);
    gl.uniform3fv(p.u('uPlanetDir'), PLANET);
    gl.uniform1f(p.u('uHDR'), HDR ? 1 : 0); gl.uniform1f(p.u('uExtent'), EXTENT);
  }
  if (p.worldFrame !== frameNumber) {
    p.worldFrame = frameNumber;
    gl.uniform4fv(p.u('uCloudEye'), clouds.eyeUniform); gl.uniform4fv(p.u('uLastCloudEye'), clouds.lastEyeUniform);
    gl.uniform2f(p.u('uCloudLayerMix'), clouds.front, clouds.blend);
    gl.uniform3fv(p.u('uSunDir'), lightDirection); gl.uniform3fv(p.u('uSunCol'), lightColor);
    gl.uniform3fv(p.u('uStarDir'), starDirection); gl.uniform3fv(p.u('uStarTint'), starTint); gl.uniform3fv(p.u('uCloudTint'), cloudTint);
    if (p.shadowVersion !== valleyShadows.version) {
      p.shadowVersion = valleyShadows.version;
      gl.uniformMatrix4fv(p.u('uLightVP[0]'), false, valleyShadows.matrices);
    }
    gl.uniform2i(p.u('uSunLayers'), shadowKeys.layers[0], shadowKeys.layers[1]); gl.uniform1f(p.u('uSunBlend'), shadowKeys.blend);
    gl.uniform2f(p.u('uWindFrame'),wind.travel,wind.mix);
    gl.uniform1f(p.u('uNight'), night);
    gl.uniform1f(p.u('uExposure'), exposure); gl.uniform1f(p.u('uTime'), t);
    gl.uniform1f(p.u('uStorm'), storm); gl.uniform1f(p.u('uFlash'), flash * storm * (0.3 + 0.7 * night));
    gl.uniform1f(p.u('uSheet'), sheet); gl.uniformMatrix3fv(p.u('uSky'), false, skyTurn);
    gl.uniform1f(p.u('uWind'), windStrength());
    if (p === GRASS || p === JLEAF || p === PLANT) {
      gl.uniform3f(p.u('uBrush'), player.x, player.z, brush.cells.size ? 1 : 0);
    }
    if (p === WATERP || p === ROCK) {
      gl.uniform1i(p.u('uRipCount'), rippleCount);
      if (rippleCount) gl.uniform4fv(p.u('uRip[0]'), rippleUniform, 0, rippleCount * 4);
    }
  }
  gl.uniformMatrix4fv(p.u('uVP'), false, VP); gl.uniform3fv(p.u('uCam'), eye);
  gl.uniform1f(p.u('uMirror'), mirror); gl.uniform1f(p.u('uClip'), mirror < 0 ? reflectionLevel - 0.02 : -1e9);
}
const indexedMultiDraw = gl.getExtension('WEBGL_multi_draw');
function drawIndexedPatches(mesh, planes, eye, focalPixels) {
  const { drawCounts, byteOffsets } = mesh;
  let runs = 0, end = -1;
  for (const patch of mesh.patches) {
    if (outsideView(planes, patch, patch.width, patch.depth)) continue;
    let first = patch.first, last = patch.end;
    if (eye) {
      const dx = Math.max(patch.x0 - eye[0], 0, eye[0] - patch.x0 - patch.width);
      const dz = Math.max(patch.z0 - eye[2], 0, eye[2] - patch.z0 - patch.depth);
      const threshold = Math.max(25, patch.error * focalPixels / 1.5);
      if (dx * dx + dz * dz > threshold * threshold) { first = patch.coarseFirst; last = patch.coarseEnd; }
    }
    if (end !== first) {
      byteOffsets[runs] = first * Uint32Array.BYTES_PER_ELEMENT;
      drawCounts[runs++] = 0;
    }
    drawCounts[runs - 1] += last - first;
    end = last;
  }
  if (!runs) return;
  gl.bindVertexArray(mesh.vao);
  if (indexedMultiDraw && runs > 1) {
    indexedMultiDraw.multiDrawElementsWEBGL(gl.TRIANGLES, drawCounts, 0, gl.UNSIGNED_INT, byteOffsets, 0, runs);
  } else {
    for (let i = 0; i < runs; i++) gl.drawElements(gl.TRIANGLES, drawCounts[i], gl.UNSIGNED_INT, byteOffsets[i]);
  }
}
function drawScene(eye, b, VP, mirror, t, opts) {
  const planes = prepareViewPlanes(VP, mirror, opts.crop);
  gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE); gl.frontFace(mirror < 0 ? gl.CW : gl.CCW);
  common(TERRAIN, eye, VP, mirror, t);
  drawIndexedPatches(near, planes, eye, opts.px * 400 / opts.tanY);
  drawIndexedPatches(far, planes);
  common(ROCK, eye, VP, mirror, t); drawRocks(VP, mirror, opts.px * 400 / opts.tanY, planes);
  gl.disable(gl.CULL_FACE);
  common(HIGH_CANOPY, eye, VP, mirror, t); drawHighCanopy(planes, mirror, eye);
  common(sailwings.shader, eye, VP, mirror, t); sailwings.draw(t, planes, eye, b.f, mirror);
  common(WOOD, eye, VP, mirror, t); drawIndexedPatches(wood, planes);
  // The half-resolution water image uses fewer, wider leaf strips to preserve canopy cover.
  common(JLEAF, eye, VP, mirror, t); leaves.draw(planes, eye, mirror < 0 ? 0.62 : 1);
  common(PLANT, eye, VP, mirror, t); plants.draw(planes, eye, mirror < 0 ? 0.72 : 1);
  if (opts.grass) { common(GRASS, eye, VP, mirror, t); grassDrawn = grass.draw(planes, eye, grassDensity); }
  // Shade the sky only through gaps left in the opaque scene.
  gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
  gl.bindVertexArray(null); // The sky only uses gl_VertexID.
  common(SKY, eye, VP, mirror, t);
  gl.uniform2fv(SKY.u('uJitter'), opts.jitter); gl.uniform3fv(SKY.u('uR'), b.r); gl.uniform3fv(SKY.u('uU'), b.u); gl.uniform3fv(SKY.u('uF'), b.f); gl.uniform2f(SKY.u('uTan'), opts.tanX, opts.tanY);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // Each star pixel inherits the transmittance written by the actual globe, moon, ring and cloud shaders.
  if (night > 0) {
    common(STARS, eye, VP, mirror, t); gl.uniform1f(STARS.u('uPx'), opts.px);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
    gl.bindVertexArray(vStars); gl.drawArrays(gl.POINTS, 0, STAR_N); gl.disable(gl.BLEND); gl.bindVertexArray(null);
  }
  if (mirror < 0) {
    gl.enable(gl.BLEND);
    drawWingGlass(eye, VP, mirror, t);
    gl.disable(gl.BLEND);
  }
  gl.depthMask(true); gl.depthFunc(gl.LESS);
}

function drawWingGlass(eye, VP, mirror, t) {
  common(sailwings.shader, eye, VP, mirror, t);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
  sailwings.drawWings();
}

function render(t, camOverride, glowTexture = texGlow) {
  const dpr = Math.min(devicePixelRatio || 1, touch ? 1.5 : 2) * renderScale;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const fov = 1.15, aspect = w / h, tanY = Math.tan(fov / 2), tanX = tanY * aspect;
  const cam = camOverride || { eye: [player.x, player.y + 1.65 + player.bob, player.z], yaw: player.yaw, pitch: player.pitch };
  const b = camBasis(cam.yaw, cam.pitch);
  ensurePost(w, h);
  const jitter = cameraJitter(post.previous, cam.eye, b.f, t, w, h);
  const stableVP = viewProj(cam.eye, b, fov, aspect), VP = stableVP.slice();
  for (let i = 0; i < 16; i += 4) {
    VP[i] += jitter.offset[0] * VP[i + 3]; VP[i + 1] += jitter.offset[1] * VP[i + 3];
  }
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glowTexture);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texGround);
  gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, texWear);
  if (uploadedWind !== wind.version) {
    gl.activeTexture(gl.TEXTURE0+16);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,wind.size,wind.size,gl.RGBA,gl.UNSIGNED_BYTE,wind.bytes);
    uploadedWind = wind.version;
  }
  if (brush.dirty) {
    gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, bendTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, brush.size, brush.size, gl.RGBA, gl.UNSIGNED_BYTE, brush.bytes);
    brush.dirty = false;
  }
  sheet = groundF ? groundF.sheet : 0;
  placeStar();
  // The eye opens a little while the sun slips behind the rim. Full night has
  // its own moonlit exposure, so the stars and vascular light keep their colour.
  const twilight = 1 - sm(0.01, 0.27, starDirection[1]);
  exposure = 0.95 + 0.3 * night + 0.3 * storm + 0.36 * twilight * (1 - night);
  turnSky(t);
  prepareRipples(t);
  frameNumber++;
  lightDirection = norm(starDirection.map((v, i) => v * (1 - night) + PLANET[i] * night));
  lightColor = starColor.map((v, i) => v * (1 - night) + MOONCOL[i] * night);
  clouds.update(t, cam.eye, lightDirection, sm(0, 0.41, starDirection[1]) * (1 - night), storm, Boolean(camOverride));
  const waterPlanes = prepareViewPlanes(VP, 1);
  const waterInView = waterBounds(wm.patches, VP, waterPlanes, outsideView, depthRange[0], w, h);
  if (waterInView) {
    // One planar reflection shared by the lake and the uphill river. Near the stream it
    // follows the local water elevation. Reaches at other heights blend into a sky reflection.
    const channelX = riverX(cam.eye[2]), channelLevel = waterLevel(channelX, cam.eye[2]);
    const basinDistance = Math.hypot((cam.eye[0] - spring.x) / 18, (cam.eye[2] - spring.z) / 12);
    reflectionLevel = Math.max(spring.level * (1 - sm(1.5, 2.4, basinDistance)),
      channelLevel * (1 - sm(5, 14, Math.abs(cam.eye[0] - channelX))));
    reflectionVP.set(VP);
    for (let i = 0; i < 4; i++) reflectionVP[12 + i] += 2 * reflectionLevel * VP[4 + i];
    const rw = Math.max(1, w >> 1), rh = Math.max(1, h >> 1);
    ensureRefl(rw, rh);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, reflFbo); gl.viewport(0, 0, rw, rh);
    gl.enable(gl.SCISSOR_TEST); scissorWater(waterInView, rw, rh);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawScene([cam.eye[0], 2 * reflectionLevel - cam.eye[1], cam.eye[2]], b, reflectionVP, -1, t, { tanX, tanY, grass: false, px: rh / 800, jitter: jitter.offset, crop: waterInView });
    gl.disable(gl.SCISSOR_TEST);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, post.ms || post.resF); gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawScene(cam.eye, b, VP, 1, t, { tanX, tanY, grass: true, px: h / 800, jitter: jitter.offset });
  gl.enable(gl.BLEND);
  if (waterInView) {
    copyUnderwater(w, h, waterInView);
    gl.colorMask(true, true, true, false);
    common(WATERP, cam.eye, VP, 1, t);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, reflTex);
    gl.uniform2f(WATERP.u('uRes'), w, h);
    gl.uniform2f(WATERP.u('uRightXZ'), b.r[0], b.r[2]); gl.uniform1f(WATERP.u('uMirrorLevel'), reflectionLevel);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    drawIndexedPatches(wm, waterPlanes);
  }
  gl.depthMask(false);
  gl.colorMask(true, true, true, true);
  drawWingGlass(cam.eye, VP, 1, t);
  // particles: additive colour, and they cut themselves out of the sky mask so the rays never streak them
  gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
  common(POINTS, cam.eye, VP, 1, t); gl.uniform1f(POINTS.u('uScale'), h * 0.9);
  if (night > 0.001 && (!camOverride || camOverride.motes)) { gl.uniform1i(POINTS.u('uRain'), 2); gl.bindVertexArray(vMotes); gl.drawArrays(gl.POINTS, 0, MOTE_N); }
  for (let i = 0; i < PODS; i++) stoneBuf.set([...podPosition(i, t), 0.36], i * 4);
  gl.bindBuffer(gl.ARRAY_BUFFER, stoneVbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, stoneBuf);
  gl.uniform1i(POINTS.u('uRain'), 3); gl.bindVertexArray(vStone); gl.drawArrays(gl.POINTS, 0, PODS);
  if (storm > 0.01) { common(RAINP, cam.eye, VP, 1, t); gl.bindVertexArray(vStreaks); gl.drawArrays(gl.LINES, 0, RAIN_STREAKS * 2); }
  if (boltLight > 0.02 && boltCount) { common(BOLTP, cam.eye, VP, 1, t); gl.uniform1f(BOLTP.u('uBolt'), boltLight); gl.bindVertexArray(vBolt); gl.drawArrays(gl.LINES, 0, boltCount); }
  common(POINTS, cam.eye, VP, 1, t);
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
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, [gl.COLOR_ATTACHMENT0, gl.DEPTH_ATTACHMENT]);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
  postProcess(VP, cam.eye, b, w, h, t, tanX, tanY, jitter);
  post.previous = { vp: stableVP, eye: cam.eye.slice(), forward: b.f, time: t, phase: jitter.phase };
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
  stepPlayer(dt); stepStones(dt); riverEvents(simT, dt); stepStorm(dt);
  if (rain) { sporeAcc += dt * 30; while (sporeAcc >= 1) { spore(sporeR, player.x, player.z); sporeAcc -= 1; } if (groundF.sheet < 0.45) groundF.rain(dt * 0.025); }
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
  if (started) advanceDay(dt);
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
  wind.update(dt, storm);
  clouds.advance(dt, sm(0, 0.41, starDirection[1]) * (1 - night), storm, simT, groundF.sheet);
  render(simT);
  if (!started) return;
  if (audio) {
    // what the ears get: the gust where you stand, how far the river and the lake are and which side they are on
    const gust = wind.sample(player.x,player.z);
    const rz = Math.max(spring.z, Math.min(-8, player.z)), rx = riverX(rz);
    const riverDistance = Math.hypot(player.x - rx, Math.max(0, spring.z - player.z, player.z + 8));
    audio.update({ wind: windStrength(), gust, height: player.y, night, storm,
      river: [riverDistance, bearing(rx, rz)], lake: [Math.max(0, (lakeD(player.x, player.z) - 10.5) * 2.2), bearing(LAKE[0], LAKE[1])] });
  }
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
    if (e.code === 'KeyT') toggleStorm();
    if (e.code === 'KeyV' && audio) audio.toggle();
    if (e.code === 'KeyM') cycleMode();
    if (e.code === 'KeyH') toggleHud();
    if (e.code === 'KeyN') toggleNight();
    if (e.code === 'KeyC') toggleDay();
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
  document.getElementById('bStorm').onclick = () => started && toggleStorm();
  document.getElementById('bMode').onclick = () => started && cycleMode();
  document.getElementById('bHud').onclick = toggleHud;
  document.getElementById('bNight').onclick = () => started && toggleNight();
  document.getElementById('bDay').onclick = () => started && toggleDay();
}
function look(dx, dy, s) { player.yaw += dx * s; player.pitch = Math.max(-1.35, Math.min(1.35, player.pitch - dy * s)); }
function toggleRain() { rain = !rain; document.getElementById('bRain').setAttribute('aria-pressed', String(rain)); }
function toggleNight() {
  // the hand-set day and night: stops the clock, and the star goes back to the afternoon
  if (day !== 'still') { day = 'still'; document.getElementById('bDay').setAttribute('aria-pressed', 'false'); }
  nightTarget = night > 0.5 ? 0 : 1; document.getElementById('bNight').setAttribute('aria-pressed', String(nightTarget > 0.5));
}
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
  // Eye height on the lake-facing edge of the summit clearing.
  summit: { eye: [-39.8, H(-39.8,-34.2)+1.65, -34.2], yaw: Math.atan2(LAKE[0]+39.8,-34.2-LAKE[1]), pitch: -0.2 },
  trail: { eye: [trail[0][0], H(...trail[0]) + 1.65, trail[0][1]], yaw: Math.atan2(trail[1][0] - trail[0][0], trail[0][1] - trail[1][1]), pitch: 0.02 },
  river: { eye: [riverX(-40) + 2.6, H(riverX(-40) + 2.6, -40) + 2.4, -40], yaw: -0.25, pitch: -0.32 },
  stones: { eye: [OUTCROP[0] - 7, H(OUTCROP[0] - 7, OUTCROP[1] + 6) + 1.7, OUTCROP[1] + 6], yaw: Math.atan2(7, 6), pitch: -0.3 },
  boulder: { eye: [OUTCROP[0] - 7, H(OUTCROP[0] - 7, OUTCROP[1] + 6) + 1.7, OUTCROP[1] + 6], yaw: Math.atan2(7, 6) - 0.62, pitch: -0.52 },
  verge: { eye: [trail[3][0] + 0.6, H(trail[3][0] + 0.6, trail[3][1]) + 1.65, trail[3][1]], yaw: Math.atan2(trail[4][0] - trail[3][0], trail[3][1] - trail[4][1]) + 0.35, pitch: -0.5 },
  shore: { eye: [SHORE_CAM[0], H(...SHORE_CAM) + 2.6, SHORE_CAM[1]], yaw: -0.95, pitch: -0.24, motes: true },
  planet: { eye: [START[0], H(...START) + 1.7, START[1]], yaw: 0.05, pitch: 0.12, motes: true },
  sunset: { eye: [12, H(12, 4) + 1.7, 4], yaw: -1.5, pitch: 0.08, motes: true },
  outcrop: { eye: [12, H(12, -14) + 1.7, -14], yaw: 0.9, pitch: 0.05, motes: true },
  beach: { eye: [12.5, H(12.5, 28) + 1.5, 28], yaw: -1.9, pitch: -0.32, motes: false },
  stack: { eye: [ISLET[0] + 9, 1.4, ISLET[1] + 6], yaw: -0.98, pitch: -0.08, motes: false },
  galaxy: { eye: [START[0], H(...START) + 1.7, START[1]], yaw: 2.75, pitch: 0.48, motes: false },
  coil: coilView,
  lantern: lanternView,
  get grove() { const x = sc.trees[7 * 5] + 2.2, z = sc.trees[7 * 5 + 2] + 2.2; return { eye: [x, H(x, z) + 1.1, z], yaw: -0.785, pitch: -0.3, motes: false }; },
};
/** A close look at the first plant of a species, from a metre and a half away. */
function plantView(pl, type) {
  let i = 0; while (i < pl.F.length / 4 && pl.F[i * 4 + 3] !== type) i++;
  const x = pl.P[i * 4] + 1.0, z = pl.P[i * 4 + 2] + 1.0;
  return { eye: [x, Math.max(H(x, z), pl.P[i * 4 + 1]) + 1.2, z], yaw: -0.785, pitch: -0.62, motes: false };
}
function renderFixture(view, t, glowTexture = texGlow) {
  post.previous = null;
  const cam = { ...(VIEWS[view] || VIEWS.shore), motes: view === 'planet' };
  // Start all three exposures at the same subpixel phase and frozen simulation tick.
  for (let sample = 0; sample < 5; sample++) render(t, cam, glowTexture);
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
    if (f === 210) splash(spring.x - 4, spring.z + 1, true);
    if (f === 865) splash(112, -5, false);
    if (f > 300 && f < 600) { if (r() < 0.5) spore(r, px, pz); groundF.rain(0.0004); }
    for (const l of layers()) l.advance(dt);
  }
  const ms = performance.now() - t0;
  for (const l of layers()) l.upload();
  ripples.length = 0;
  renderFixture(view, simT);
  const st = layers().map((l) => l.stats());
  const stepped = st.reduce((sum, s) => sum + s.stepped, 0);
  return { mode: MODE_NAME[m], frames, ms, stepped, violations: st.reduce((n, s) => n + s.violations, 0), blocks: st.map((s) => s.blocks), bytes: st.reduce((n, s) => n + s.bytes, 0) };
}

// ---------------------------------------------------------------- boot
(async () => {
  const [fieldEngine, rockSurface] = await Promise.all([loadEngine(), rockSurfaceReady]);
  engine = fieldEngine;
  uploadRockSurface(gl, rockSurface, 19);
  wind = createWind(engine.boxel, H);
  gl.activeTexture(gl.TEXTURE0+16); gl.bindTexture(gl.TEXTURE_2D,gustTexture);
  gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,wind.size,wind.size);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  clouds = createClouds(gl, program, FSQ, engine.boxel, { mobile: touch, test: TEST,
    sources: [[...LAKE, 1], [spring.x, spring.z, 0.55]] });
  checkPrograms();
  const t0 = performance.now();
  glowF = new Layer(engine.boxel, SPECS.glow, texGlow);
  groundF = new Layer(engine.boxel, SPECS.moist, texGround);
  wearF = new Layer(engine.boxel, SPECS.wear, texWear);
  setMode(BOXEL);
  refreshModeUI();
  document.getElementById('status').textContent = `boxel ready: three surface fields on an unbounded plane, cones computed in ${Math.round(performance.now() - t0)} ms`;
  if (touch) { document.getElementById('go').textContent = 'Tap to step onto the shore'; document.getElementById('keys').innerHTML = '<b>left thumb</b><span>walk (push far to run)</span><b>right thumb</b><span>look</span><b>buttons</b><span>throw, spore rain, storm, night, day cycle, switch engine, readout</span>'; }
  window.__game = { setNight: (v) => { night = nightTarget = v; }, setDay: (a) => { day = a === null ? 'still' : 'paused'; dayAngle = a ?? 0; shadowKeys.stale = true; },
    runDay: (seconds) => { day = 'running'; for (let s = 0; s < seconds; s += 1 / 30) { advanceDay(1 / 30); placeStar(); } day = 'paused'; }, setStorm: (v) => { storm = stormTarget = v; }, soak: (amount) => { groundF.rain(amount); sheet = groundF.sheet; }, strike: (x, z) => { strike(rng(7), [x, z]); flash = 1; boltLight = 1; }, hdr: HDR, samples: SAMPLES, scripted, setMode, H, ready: true, engine: engine.kind, state: () => ({ player: { ...player }, started, blocks: layers().map((l) => l.stats().blocks), instances: { grass: grass.count, leaves: leaves.count, plants: plants.count, grassDrawn } }) };
  if (TEST) {
    const darkField = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, darkField);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    window.__game.verifyClouds = async (rain = 0) => {
      const { compareClouds } = await import('./verify.js');
      return compareClouds(gl, clouds, rain);
    };
    window.__game.verifySky = async () => {
      const { compareSkyFaces } = await import('./verify.js');
      const full = bakeMilkyWay(false);
      try {
        return compareSkyFaces(gl, MILKY_SIZE, milkyWay, full);
      } finally {
        gl.deleteTexture(full);
        gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_CUBE_MAP, milkyWay);
      }
    };
    window.__game.verify = async (view = 'river', { night: lighting = 1 } = {}) => {
      const { verify } = await import('./verify.js');
      const savedNight = night, savedTarget = nightTarget;
      night = nightTarget = lighting;
      try {
        return verify({ gl, layers, scripted, darkControl: () => renderFixture(view, simT, darkField),
          denseMode: DENSE, boxelMode: BOXEL, size: N, tolerance: TOLERANCE }, view);
      } finally {
        night = savedNight; nightTarget = savedTarget; renderFixture(view, simT);
      }
    };
    document.documentElement.classList.remove('intro'); document.getElementById('intro').hidden = true; document.getElementById('pad').hidden = true; document.getElementById('cross').hidden = true; return; }
  bindInput();
  document.getElementById('intro').addEventListener('click', () => {
    document.getElementById('intro').hidden = true; document.documentElement.classList.remove('intro'); started = true;
    audio = createAudio(); audio?.resume();
    if (!touch) canvas.requestPointerLock?.()?.catch?.(() => {});
  });
  requestAnimationFrame((t) => { last = t; frame(t); });
})().catch((e) => fail('The field engine did not start: ' + e.message));
