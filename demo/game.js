import { createWaterfall, crestGLSL, fallsBounds, landingAt, lipZ, plungeGLSL, swimmerWaterlineGLSL } from './waterfall.js';
import { basinGrid, createWaterSurface, waterTexture, waterSurfaceGLSL } from './water-surface.js';
import { createSwimWake, swimmerWakeGLSL } from './swim-wake.js';
import { advanceFlight, jumpDuration, requestJump, steerFox } from './fox-motion.js';
import { foxController } from './gamepad.js';
import { bladeStateGLSL, solveGLSL, stampGLSL, knotsFragment, stampFragment, createBladeContact } from './blade-contact.js';
import { contactVolume, contactGLSL } from './fox-contact.js';
import { createWildlife } from './wildlife.js';
import { animalProgram } from './animal-rig.js';
import { loadPlayerAnimal } from './fox.js';
import { animals, animalById } from './animal-catalog.js';
import { DAY_RATE, TIMELAPSE_SECONDS, timelapseTravel } from './sky-clock.js';
import { bindCapture } from './capture.js';
import { floraPalette, understoryPigment, writeMeadowColour } from './flora-palette.js';
import { createWind, windDirection, windShader } from './wind.js';
import { bakeTrailMaterial } from './trail-material.js';
import { loadLeafSprays, uploadLeafSprays, sprayGLSL, STRAP_ASPECT } from './leaf-spray.js';
import { barkTile, loadSurface, uploadSurface } from './surface-texture.js';
import { galaxyFragment } from './galaxy.js';
import { FieldTexture } from './field-texture.js';
import { bakeMeadow, MEADOW_TILE, BLADE_HEIGHT_RANGE, CLUMP, clumpGLSL, meadowLodGLSL, SISTER_ONE, SISTER_TWO, GrassPulses, grassPulseGLSL } from './meadow.js';
import { BrushField } from './brush.js';
import { waterBounds } from './water-view.js';
import { stoneBed, stoneDrop, stoneSpacing } from './stone-bed.js';
import { coarsePatch } from './terrain-lod.js';
import { matureHeight, matureTrunkScale, forestStands, highCanopySites, treeFieldMask, treeFieldTiles } from './high-canopy.js';
import { createSailwings } from './fauna.js';
import { cloudSky, createClouds } from './clouds.js';
import { bakeCanopy, valleyAir, canopyShelter } from './atmosphere.js';
import { createAudio } from './audio.js';
import { bakeGroundLight, groundLight, mistFragment, viewRay } from './valley-light.js';
import { cameraJitter, depthRange, historyColor, temporalFragment } from './temporal.js';
import { createShadows } from './shadows.js';
// Tarn: sixteen acres of lake shore and highlands on Tarn, under a ringed giant.
//
// The world remembers you through three boxel fields on the unbounded plane of 12.5 cm cells:
//   glow      bioluminescence in the moss and the water   D 3 cells²/s, k 0.45/s, 60 steps/s
//   moisture  wet feet, splashes, spore rain               D 3 cells²/s, k 0.04/s, 15 steps/s
//   wear      trails packed into the soil                  no spread, k 0.008/s, 15 steps/s
// Each is certified to stay within 1/255 of computing every cell, and only the 16 × 16 blocks
// that can still matter exist. The renderer sees the map through one R8 texture per field and
// re-uploads exactly the blocks the engine holds, clearing the ones it lets go.

import { WORLD_HALF, VALLEY_HALF, spring, falls, riverLevel, inRestArea, overlooks, rangeWalks, summit, trail, valleyWalks, terrainHeight, trailCover, trailDistance, riverX, riverFlow, waterLevel } from './landmarks.js';
import { companionWorlds, oceanAtlasFragment, skyBodies } from './worlds.js';
import { load } from '../ffi/boxel.js';

const EXTENT = 2 * WORLD_HALF, CELL = 0.125, N = EXTENT / CELL;
const LAKE = [-6, 8];                                     // lake centre (x, z)
const WATER = 0;                                          // water level
const BOXEL = 0, DENSE = 1;
const MODE_NAME = { 0: 'boxel', 1: 'dense' };
const qs = new URLSearchParams(location.search);
const TEST = qs.has('test');
const GRASS_LAB = !TEST && qs.has('grass-lab');
const PLOT = { x: 15, z: 42, half: 5 };
const plotDistance = (x, z) => Math.max(Math.abs(x-PLOT.x), Math.abs(z-PLOT.z));
const touch = matchMedia('(pointer: coarse)').matches;
const surfacesReady = Promise.all(['boulder-surface.jpg', 'bark-color.jpg', 'bark-normal.jpg'].map(loadSurface));
const leafSpraysReady = loadLeafSprays(touch);
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
function ridged(x, y, footprint = 0, rounding = 0) {
  let height = 0, weight = 0.55;
  for (let i = 0; i < 5; i++) {
    // The far mesh cannot resolve every mineral ridge. Fade each octave to
    // its mean energy as the vertex spacing approaches its wavelength.
    const detail = footprint ? 1 - sm(0.22, 0.72, footprint) : 1;
    const slope = detail ? Math.abs(vnoise(x, y) * 2 - 1) : 1;
    // Round the cusp at the crest before sampling it on the mesh.
    const crest = slope < rounding ? 0.5 * (rounding + slope * slope / rounding) : slope;
    const ridge = 1 - crest;
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
  const east = x - LAKE[0] * 0.5, north = z - LAKE[1] * 0.5;
  // Spread the basin widest away from the south entrance and the east trail.
  const dx = east / (east < 0 ? 1.40 : 1.32);
  const dz = north / (north < 0 ? 1.12 : 1.015);
  const th = Math.atan2(dz, dx);
  const wob = 1 + 0.17 * Math.sin(3 * th + 1.1) + 0.09 * Math.sin(5 * th - 0.4) + 0.05 * Math.sin(8 * th + 2.0)
    + 0.24 * (fbm(x * 0.07 + 31, z * 0.07 - 12, 3) - 0.5);
  return Math.hypot(dx, dz) / wob / 1.1;
}
const ISLET = [LAKE[0] + 6.8, LAKE[1] - 5.2], ISLET_WIDTH = 8.05, ISLET_DEPTH = 5.95;
const OUTCROP = [34, -30];                                // a rocky rise north-east of the lake
function outcrop(x, z) { return 1 - sm(9, 27, Math.hypot(x - OUTCROP[0], (z - OUTCROP[1]) * 1.25)); }
function H(x, z, footprint = 0, shapedBanks=true) {
  const plot = GRASS_LAB ? plotDistance(x, z) : Infinity;
  if (plot <= 5.6) return 1.8;
  // meadow: small undulation on rolling swells
  const meadow = 0.7 + 1.1 * fbm(x * 0.045 + 3, z * 0.045 - 1) + 0.25 * fbm(x * 0.22, z * 0.22, 3) + 3.2 * (fbm(x * 0.017 - 7, z * 0.017 + 5, 3) - 0.4);
  // Beyond this box even the longest possible lobe lies outside the bank.
  const d = Math.abs(x - LAKE[0]) < 54 && Math.abs(z - LAKE[1]) < 43 ? lakeD(x, z) : 15;
  // a wadeable shelf all round the shore, then a drop into the basin
  const bowl = shapedBanks ? -0.42*(1-sm(7.5,10.4,d))-4.70*(1-sm(1,8.2,d))-0.23
                           : -0.6*(1-sm(8.5,10.8,d))-4.4*(1-sm(1,8.5,d))-0.35;
  const t = shapedBanks ? sm(9.0,14.2,d) : sm(9.6,14,d);
  let h = bowl * (1 - t) + meadow * t;
  const ix = x - ISLET[0], iz = z - ISLET[1];
  if (Math.abs(ix) < 15 && Math.abs(iz) < 12) {
    // A bedding shelf with a low landing to the east and a scalloped western scarp.
    const a = Math.atan2(iz, ix), lip = 1 + 0.14*Math.sin(3*a+0.7) + 0.085*Math.sin(5*a-1.1);
    const weathering = vnoise(x*0.60+3.8, z*0.48-9) - 0.5;
    const r = Math.hypot((ix+iz*0.21)/ISLET_WIDTH, iz/ISLET_DEPTH) / (lip + 0.105*weathering);
    const apron = sm(-0.55,0.9,Math.cos(a-0.38));
    const crown = 2.05 - 0.035*ix + 0.13*(vnoise(x*0.65,z*0.65)-0.5);
    const shelf = crown - (0.32+0.85*apron)*sm(0.53,0.88+0.09*weathering,r)
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
    const rg = ridged(mx * 0.0035 + 2, mz * 0.0035 - 4, footprint * 0.009, 0.15);
    const crag = ridged(mx * 0.010 + 7, mz * 0.010 - 3, footprint * 0.032, 0.26);
    const foothills = sm(84, 170, range) * 5 * fbm(mx * 0.017, mz * 0.017, 3);
    const massif = vnoise(mx * 0.0027 - 2.1, mz * 0.0027 + 4.7);
    // Give each outer massif its own prominence and narrow its summit. The
    // lower saddles reveal the next ridge through the gap between peaks.
    const prominence = sm(145,270,edgeDistance)*rg*((massif-0.44)*76 + (rg-0.60)*55);
    h += m * m * (23 + 12*massif + 106 * rg + 11 * crag * crag * rg + prominence) + foothills;
  }
  const height = terrainHeight(x, z, h, shapedBanks);
  return plot < 8.0 ? height + (1.8-height)*(1-sm(5.6, 8.0, plot)) : height;
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
  glow: { spread: 3 / 60, fade: 0.45 / 60, hz: 60, events: 1024 },
  moist: { spread: 3 / 15, fade: 0.04 / 15, hz: 15, events: 64 },
  wear: { spread: 0, fade: 0.008 / 15, hz: 15, events: 1024 },
};
const cellOf = (m) => Math.floor(m / CELL);

/** The sparse field covers the whole plane. Its display uploads changed R8 regions inside the map.
 *  The dense reference steps the finite map and uploads its full image. */
class Layer {
  constructor(boxel, spec, tex) { Object.assign(this, { boxel, spec, tex, acc: 0, textureCache: new FieldTexture(N,MEADOW_TILE/CELL) }); }
  set(mode) {
    this.f?.free(); this.g?.free(); this.f = this.g = null; this.acc = 0; this.steps = 0; this.lastStepped = 0; this.lastSteps = 0;
    if (mode === BOXEL) this.f = this.boxel.field({ spread: this.spec.spread, fade: this.spec.fade, tolerance: TOLERANCE, events: this.spec.events });
    else this.g = this.boxel.grid(this.spec, -N / 2, -N / 2, N);
    this.textureCache.reset();
    clearTexture(this.tex);
    this.changed = false;
  }
  deposit(x, z, r, a) { (this.f || this.g).deposit(cellOf(x), cellOf(z), r, a); this.changed = true; }
  contact(x,z,energy) {
    const fx=x/CELL-0.5, fz=z/CELL-0.5, i=Math.floor(fx), j=Math.floor(fz);
    const u=fx-i, v=fz-j, field=this.f || this.g;
    field.deposit(i,j,0,energy*(1-u)*(1-v)); field.deposit(i+1,j,0,energy*u*(1-v));
    field.deposit(i,j+1,0,energy*(1-u)*v); field.deposit(i+1,j+1,0,energy*u*v);
    this.changed=true;
  }
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
    const live = gl.isProgram(p);
    if (live && !gl.getProgramParameter(p, gl.LINK_STATUS)) {
      for (const s of stages) {
        if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) continue;
        console.error(gl.getShaderSource(s).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
        fail('shader: ' + gl.getShaderInfoLog(s));
      }
      fail('link: ' + gl.getProgramInfoLog(p));
    }
    // The linked executable survives releasing its compiler inputs.
    for (const s of stages) {
      if (live) gl.detachShader(p, s);
      gl.deleteShader(s);
    }
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
    const stride = a.stride || 0, elementBytes = a.data?.BYTES_PER_ELEMENT ?? 4;
    const offset = (a.offset || 0) + (a.div ? firstInstance * (stride || a.size * elementBytes) : 0);
    gl.vertexAttribPointer(a.loc, a.size, a.type ?? gl.FLOAT, a.normalized ?? false, stride, offset);
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
const commonSamples = colorSamples.filter(n => n > 1 && n <= 4 && depthSamples.includes(n));
const lightSamples = Math.max(0, ...commonSamples.filter(n => n <= 2));
const preferredSamples = GRASS_LAB && lightSamples ? lightSamples : Math.max(0, ...commonSamples);
let sceneSamples = preferredSamples;

// ---------------------------------------------------------------- shaders
const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;
// a triangle that covers the screen
const FSQ = `out vec2 vUv; void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2. - 1., 0., 1.); }`;
// the lake's surface: a slow swell under two wind-driven wavetrains, a few centimetres high. x is the height, yz its gradient
const WAVES = waterSurfaceGLSL + crestGLSL + `
float planktonLight(float charge){
  return (charge/(0.045+charge)) * (charge/(0.65+charge));
}
vec3 waterWave(vec2 p, float t){
  vec2 k1 = vec2(0.21, 0.13), k2 = vec2(-0.27, 0.46), k3 = vec2(1.38, -0.8);
  vec2 curlK=vec2(-0.23,0.29);
  float curl=dot(p,curlK)-0.27*t;
  float a1=dot(p,k1)+t*0.7+0.57*sin(curl), a2=dot(p,k2)+t*1.1-0.83*cos(curl);
  float crossPhase=dot(p,vec2(0.41,0.26))+0.45*t;
  float a3=dot(p,k3)+t*1.9+1.17*sin(crossPhase);
  k1+=0.57*cos(curl)*curlK; k2+=0.83*sin(curl)*curlK; k3+=1.17*cos(crossPhase)*vec2(0.41,0.26);
  return vec3(0.035 * sin(a1) + 0.02 * sin(a2) + 0.008 * sin(a3), 0.035 * cos(a1) * k1 + 0.02 * cos(a2) * k2 + 0.008 * cos(a3) * k3);
}

`;
const valueNoiseGLSL = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
`;
const COMMON = WAVES + valleyAir + valueNoiseGLSL + `
uniform vec3 uSunDir, uSunCol, uCloudTint;
uniform mat3 uSky;
uniform samplerCube uMilky;
uniform float uTime, uExposure, uExtent, uSheet, uWind, uHDR;
uniform sampler2D uGlow, uGround, uWear;
#define PI 3.14159265
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
${floraPalette}
vec3 glowCol(vec2 p){ return meadowStand(p).rgb * 1.38; }
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
      vec2 weatherUV = vec2(lat*37.,dot(nw,T)*5.+dot(nw,P)*3.);
      float filaments = fbm3(weatherUV + 2.8*vnoise(weatherUV*0.47));
      float bands = sin(2.9*(filaments-0.45) + lat * 19. + sin(lat * 6. + q.x * 8.) * 1.6 + vnoise(q * 30. + dvr * 40. * sw) * 0.8);
      // an amber giant: cream and ochre bands, rust belts, a red storm; nothing like the world under it
      vec3 pc = mix(vec3(0.74, 0.47, 0.26), vec3(0.95, 0.84, 0.66), 0.5 + 0.5 * bands);
      pc = mix(pc, vec3(0.50, 0.22, 0.14), smoothstep(0.75, 0.95, abs(sin(lat * 7. + 1.3))) * 0.45);
      pc = mix(pc, vec3(0.92, 0.42, 0.28), (1. - smoothstep(0.012, 0.03, rs)) * 0.6);
      pc = mix(pc, vec3(0.34, 0.1, 0.06), (1. - smoothstep(0., 0.009, rs)) * 0.6);
      float ribbons = sin(lat*112.+filaments*8.);
      float fine = 1. - smoothstep(0.12,0.45,fwidth(lat*38.));
      vec2 clouds = vec2(lat * 64., dot(nw, T) * 18.) + filaments * 6.;
      pc *= 0.72 + 0.40 * filaments + 0.10 * ribbons + 0.20 * fine * vnoise(clouds + 11.);
      pc = mix(pc, vec3(0.94,0.85,0.75), fine * 0.19 * smoothstep(0.62,0.85, vnoise(clouds)));
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
      float chaos = fbm3(vec2(sp.x + sp.z * 0.77, sp.y - sp.z * 0.35) * 14. + 8.);
      float ridges = 1. - abs(2. * vnoise(vec2(sp.y - sp.z * 0.42, sp.x + sp.z * 0.24) * 24.) - 1.);
      float crust = (0.76 + 0.38 * chaos) * (0.82 + 0.21 * ridges);
      ic *= crust;
      ic = mix(ic, vec3(0.39, 0.19, 0.11), cracks * (0.45 + 0.52 * chaos));
      ic += vec3(0.13,0.20,0.26) * smoothstep(0.55,0.82,ridges) * cracks * 0.48;
      ic = mix(ic, vec3(0.72, 0.84, 1.0), smoothstep(0.65, 0.88, dot(sp, ax) + 0.054 * ridges) * 0.7);
      c = mix(c, bodyLight(ic, ns, z, 0.06), cov);
      starTransmission *= 1. - cov;
    }
  }
  c = companions(d, c);
  if (d.y > 0.) {
    vec4 cloud = cloudColumn(uCam, d);
    c = cloudLight(c, gBehind, d, cloud);
    starTransmission *= 1. - cloud.a;
  }
  return c;
}
${canopyShelter}
uniform mat3 uAmbientLight;
vec3 ambient(vec3 n){
  // Ground bounce, open sky and a broad sunward fill. The baked canopy and
  // contact maps attenuate this incident light at the receiving surface.
  return uAmbientLight[0] + n.y * uAmbientLight[1] + dot(n.xz, uStarDir.xz) * uAmbientLight[2];
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

// Common parent stone for loose shingle, buried flecks and wet gravel.
vec3 shale(float tone) {
  return mix(vec3(0.104,0.083,0.068),vec3(0.298,0.257,0.211),tone);
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
vec3 floraLight(vec3 gc, vec3 wp, vec3 N, vec3 V, float u, float self, vec3 sunlight){
  // Both sides share diffuse light from the upper surface as the camera passes a leaf.
  if (N.y < 0.) N = -N;
  float ndl = max(dot(N, uSunDir), 0.) * 0.72 + 0.28;
  float cover = canopyCover(wp);
  vec3 skyLight = contactLight(wp) * ambient(N) * mix(vec3(1.), vec3(0.38, 0.54, 0.54), cover);
  vec3 lit = gc * (skyLight * 2.35 + sunlight * ndl * 0.3 + floraSpill(wp));
  lit += sunlight * gc * pow(clamp(dot(-V, uSunDir), 0., 1.), 3.) * u * 0.4;
  // Pigment also supplies the emission hue. Sunlit leaves read by diffuse light alone.
  lit += gc * smoothstep(0.1, 0.94, uNight) * self * u * u;
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
  vec4 front = waterCrests(wp.xz, level-wp.y, vec2(0.), uTime, max(0.,windWave(wp.xz)*uWind));
  float wl = wp.y - (level + waterWave(wp.xz, uTime).x + front.x + surfaceAt(wp.xz).x);
  wet = smoothstep(-0.06, 0.0, wl) * (1. - smoothstep(0.0, 0.22, wl));
  alb = mix(alb * (1. - 0.45 * wet), alb * vec3(0.62, 0.78, 0.8), 1. - smoothstep(-0.25, 0., wl));
  float swash = 1. - smoothstep(0.015, 0.085, abs(wl));
  return mix(alb, vec3(0.63, 0.74, 0.78), (0.08+0.43*front.w) * swash * shoreFroth(wp.xz));
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
// Distant conifer crowns share one opaque silhouette and never enter the
// valley interaction fields. Air and daylight still match the terrain.
const RIDGE_TREES = program(WORLD_VS + valleyAir + `
in vec3 aCrown; in vec4 aSite;
out vec4 vAir; out float vLight;
void main(){
  vec3 wp=aSite.xyz+aCrown*aSite.w;
  vAir=airAt(wp);
  vLight=0.32+0.46*aCrown.y+0.19*aCrown.x;
  gl_Position=project(wp);
}`, `in vec4 vAir; in float vLight; out vec4 o;
void main(){
  vec3 leaf=mix(vec3(0.036,0.067,0.057),vec3(0.11,0.16,0.083),vLight);
  vec3 lit=leaf*(ambient(vec3(0.,1.,0.))*2.2+uSunCol*(0.13+0.42*vLight)*max(uSunDir.y,0.));
  o=vec4(tonemap(lit*vAir.a+vAir.rgb),0.);
}`);
const CANOPY = program(WORLD_VS + BRUSH_VS + valleyAir + canopyShelter + `
uniform int uTreeFields;
in vec3 aPos, aNor, aStalk, aBlade; in float aTissue; in vec4 aSite, aHabit; in float aGraft; in vec2 aSlope;
centroid out vec2 vBlade; centroid out vec3 vWP, vNormal, vAcross;
centroid out vec4 vBarkSpace;
flat out float vTissue, vHue; out float vCrown; out vec3 vField; out vec4 vAir;
vec2 barkUV(vec3 ring) {
  float repeats=max(1.,floor(ring.z*aSite.w*aHabit.z/0.74+0.5));
  return vec2(ring.x*repeats,ring.y*aSite.w/0.74)+fract(aSite.xz*vec2(0.75488,0.56984)+ring.z*13.3);
}
void main(){
  mat2 rot=mat2(aHabit.x,aHabit.y,-aHabit.y,aHabit.x);
  vec3 p=aPos, stalk=aStalk;
  // Vary the footprint in the tree's own frame. The compression eases to
  // zero below the first fork, leaving the crown and its bounds in place.
  float h=clamp(1.-p.y/0.18,0.,1.);
  float rib=0.23*fract(dot(aSite.xz,vec2(0.75488,0.56984)));
  float footWidth=1.-rib*h*h;
  vec3 n=aNor;
  n.x/=footWidth;
  n.y-=n.x*p.x*(2.*rib*h/0.18);
  p.x*=footWidth;
  // Negative wood tissue carries the trunk share across the fork. Scaling
  // instance space preserves the separate silhouettes of saplings and crowns.
  float bole=1.-step(${matureHeight.toFixed(1)},aSite.w)*${(1-matureTrunkScale).toFixed(2)}*max(0.,-1.-aTissue);
  p.xz*=bole;
  n.xz/=bole;
  p.xz = rot*p.xz*aHabit.z;
  stalk.xz = rot*stalk.xz*aHabit.z;
  vNormal=n; vNormal.xz=rot*n.xz/aHabit.z;
  vBlade=aBlade.xy;
  vBarkSpace=vec4(0.);
  float load=uWind>0. ? crownLoad(aSite.xz)*uWind : 0.;
  if (aTissue>=0.) {
    vec2 across=rot*vec2(-sin(aBlade.z),cos(aBlade.z));
    vAcross=vec3(across.x,0.,across.y);
    if (uWind>0.) {
      vec2 root=aSite.xz+stalk.xz*aSite.w;
      vec2 delta=root-uCam.xz;
      float local=1.-smoothstep(225.,1225.,dot(delta,delta));
      float gust=load, flutter=0.;
      if (local>0.) {
        gust=mix(load,windWave(root)*uWind,local);
        flutter=0.08*local*tipFlutter(root,uWindFrame.x,aTissue)*min(gust,1.);
      }
      float a=leafBend(gust*(0.30+0.26*aTissue))+flutter;
      vec2 swivel=vec2(cos(a),sin(a));
      vec3 hinge=vec3(WIND_DIR.y,0.,-WIND_DIR.x);
      p=stalk+rotateFoliage(p-stalk,hinge,swivel);
      vNormal=rotateFoliage(vNormal,hinge,swivel);
      vAcross=rotateFoliage(vAcross,hinge,swivel);
    }
    p+=brushBend(aSite.xyz+stalk*aSite.w)*(aBlade.x*aBlade.x*0.15);
  } else {
    // Wood shares the attribute layout. Its stalk is the longitudinal tangent,
    // and the third blade channel carries this limb's reference circumference.
    vAcross=stalk;
    stalk=p;
    vBlade=barkUV(aBlade);
    vBarkSpace=vec4(aSite.xyz+p*aSite.w,aGraft);
  }
  p+=boughOffset(load,stalk.y,1.)*min(1.,length(stalk.xz)*3.4);
  float foot=1.-smoothstep(0.,0.18,aPos.y);
  p.y += dot(p.xz,aSlope)*foot;
  vNormal.xz -= aSlope*(vNormal.y*foot);
  vWP=aSite.xyz+p*aSite.w;
  vTissue=aTissue; vHue=aHabit.w;
  vCrown=clamp((aPos.y-0.25)*0.64+1.04*length(aPos.xz),0.,1.);
  vec2 uv=fieldUV(aSite.xz);
  vAir=airAt(vWP);
  vField=vec3(0.,uSheet,aTissue>=0. ? canopyCover(vWP) : 0.);
  if (uTreeFields!=0 && all(lessThanEqual(abs(uv-0.5),vec2(0.5)))) {
    if ((uTreeFields&1)!=0) vField.x=textureLod(uGlow,uv,0.).r;
    float localWet=(uTreeFields&2)!=0 ? textureLod(uGround,uv,0.).r : 0.;
    vField.y=min(1.,localWet+uSheet);
  }
  gl_Position=project(vWP);
}`, sprayGLSL + `uniform float uClip; uniform bool uCoverage;
centroid in vec2 vBlade; centroid in vec3 vWP, vNormal, vAcross;
centroid in vec4 vBarkSpace;
flat in float vTissue, vHue; in float vCrown; in vec3 vField; in vec4 vAir; out vec4 o;
uniform sampler2D uBarkColor, uBarkNormal;
void main(){
  if (vWP.y < uClip) discard;
  vec3 n=normalize(vNormal), view=normalize(uCam-vWP), colour;
  float cover=1.;
  if(vTissue>=0.){
    vec4 spray=texture(uLeafSprays,sprayUV(vBlade.x,vBlade.y,0.,vTissue));
    cover=clamp((spray.a-0.5)/max(fwidth(spray.a),0.001)+0.5,0.,1.);
    if(uCoverage ? cover<0.02 : spray.a<0.5) discard;
    vec3 across=normalize(vAcross-n*dot(n,vAcross)), along=cross(n,across);
    n=normalize(n+across*(spray.r-0.5)*1.60+along*(spray.g-0.5)*1.60);
    float underside=1.-smoothstep(-0.22,0.22,dot(n,view));
    float tone=spray.b, wood=1.-smoothstep(0.02,0.08,tone);
    vec3 pigment=crownPigment(vHue);
    float newLeaf=smoothstep(0.32,0.96,0.51*vCrown+0.32*tone+0.17*vBlade.x);
    if(vHue>1.) {
      float flush=clamp(0.62*vCrown+0.26*vTissue+0.19*vBlade.x+vHue-1.24,0.,1.);
      pigment=mix(mix(MAPLE_WINE,MAPLE_COPPER,smoothstep(0.12,0.59,flush)),
                  mix(MAPLE_CORAL,MAPLE_ROSE,newLeaf),smoothstep(0.45,0.89,flush));
    } else if(vHue>=0.95) pigment=mix(pigment,mix(APRICOT,GOLD,newLeaf),0.52);
    else if(vHue>=0.91) pigment=mix(pigment,mix(PETAL_PINK,BLOSSOM_TIP,newLeaf),0.39);
    else if(vHue<0.78) pigment=mix(pigment,NEW_GROWTH,0.21*newLeaf*newLeaf);
    float lightness=0.47+0.42*vCrown+0.18*vTissue;
    vec3 leaf=mix(pigment*(0.48+0.64*tone)*lightness,vec3(0.14,0.095,0.058),wood)*(1.-0.16*vField.y);
    vec3 sun=uSunCol*directLight(vWP);
    float facing=dot(n,uSunDir);
    vec3 sky=mix(ambient(n),ambient(-n),0.55*underside)*contactLight(vWP)*(1.-0.43*vField.z);
    colour=leaf*(sky*2.25+floraSpill(vWP)+sun*(0.10+0.78*mix(max(0.,facing),max(0.,-facing),underside)));
    // The thinner outside leaves transmit warm sunlight when the viewer faces the star.
    float transmission=mix(max(-facing,0.),max(facing,0.),underside)*(0.40+0.29*newLeaf)+
      0.25*pow(max(0.,-dot(view,uSunDir)),4.)*newLeaf;
    colour+=leaf*sun*vec3(1.42,1.14,0.72)*transmission*(1.-wood);
    colour+=sun*pow(max(0.,dot(n,normalize(view+uSunDir))),18.)*(0.045+0.09*vField.y)*(1.-wood);
    float veins=smoothstep(0.78,0.98,tone);
    colour+=pigment*uNight*(0.035*veins+glowI(vField.x)*(veins+0.22*vBlade.x));
  }else{
    vec3 along=normalize(vAcross-n*dot(n,vAcross));
    vec3 across=cross(along,n);
    vec3 bark=vec3(0.), relief=vec3(0.);
    if(vBarkSpace.w<1.) {
      vec3 grain=texture(uBarkNormal,vBlade).xyz*2.-1.;
      bark=texture(uBarkColor,vBlade).rgb;
      relief=across*grain.x+along*grain.y;
    }
    // The trunk and collar share a metre-scaled solid projection. Even across
    // their intersection a pixel at the same position sees the same bark.
    if(vBarkSpace.w>0.001) {
      vec3 p=vBarkSpace.xyz/0.74;
      vec3 w=n*n; w/=max(0.0001,w.x+w.y+w.z);
      vec3 x=texture(uBarkNormal,p.zy).xyz*2.-1.;
      vec3 y=texture(uBarkNormal,p.xz).xyz*2.-1.;
      vec3 z=texture(uBarkNormal,p.xy).xyz*2.-1.;
      vec3 detail=w.x*vec3(0.,x.y,x.x)+w.y*vec3(y.x,0.,y.y)+w.z*vec3(z.x,z.y,0.);
      relief=mix(relief,detail-n*dot(n,detail),vBarkSpace.w);
      vec3 projected=w.x*texture(uBarkColor,p.zy).rgb+w.y*texture(uBarkColor,p.xz).rgb+w.z*texture(uBarkColor,p.xy).rgb;
      bark=mix(bark,projected,vBarkSpace.w);
    }
    if(vHue>1.) bark*=vec3(0.37,0.32,0.33);
    n=normalize(n+relief);
    float damp=vField.y;
    bark*=1.-0.29*damp;
    vec3 sun=uSunCol*directLight(vWP), sky=ambient(n)*contactLight(vWP);
    colour=bark*(sky*1.78+floraSpill(vWP)+sun*(0.075+0.94*max(0.,dot(n,uSunDir))));
    colour+=sun*damp*0.055*pow(max(0.,dot(n,normalize(view+uSunDir))),23.);
    float fissure=1.-smoothstep(0.045,0.16,dot(bark,vec3(0.3,0.6,0.1)));
    colour+=crownPigment(vHue)*fissure*uNight*(0.009+0.06*glowI(vField.x));
  }
  o=vec4(tonemap(colour*vAir.a+vAir.rgb),uCoverage ? cover : 0.);
}`);

// Air and overhead shelter change slowly across the terrain mesh. Keep the
// fine shadow comparisons, material normals and field filaments at each pixel.
const ANIMAL = TEST ? null : animalProgram(program, WORLD_VS + swimmerWaterlineGLSL);
const TERRAIN = program(WORLD_VS + valleyAir + canopyShelter + `
in vec3 aPos; in vec4 aNor; in vec2 aGround; out vec4 vAir; out float vCover; out vec3 vGround; out vec3 vWP; out vec3 vN;
void main(){
  vCover = canopyCover(aPos); vAir = airAt(aPos);
  vGround = vec3(aGround,aNor.w); vWP = aPos; vN = aNor.xyz; gl_Position = project(aPos);
}`,
`uniform sampler2D uTrailMaterial, uRockSurface; uniform vec4 uFoxShadow; uniform float uClip; in vec4 vAir; in float vCover; in vec3 vGround; in vec3 vWP; in vec3 vN; out vec4 o;
// Project the same mineral grain onto the bank, floor and sidewalls.
vec3 bankWeights(vec3 n){
  vec3 w = abs(n); w *= w; w *= w; return w / (w.x + w.y + w.z);
}
vec3 bankRelief(vec3 p, vec3 w){
  vec2 x = noiseSlope(p.zy).yz, y = noiseSlope(p.xz).yz, z = noiseSlope(p.xy).yz;
  return vec3(0., x.y, x.x)*w.x + vec3(y.x, 0., y.y)*w.y + vec3(z, 0.)*w.z;
}
// Exposed rock, talus and snow on the distant range. One oblique scan carries
// the bedrock onto vertical walls. A second tile supplies individual angular
// blocks and their relief on scree fans, then fades into open, low shrub cover.
vec4 mountainSurface(vec3 dx, vec3 dy, float crag, float seam, float chute, inout vec3 normal, out float snow){
  vec3 geom = normalize(vN);
  const vec3 strike = vec3(0.038,0.017,-0.025), dip = vec3(0.012,0.067,0.029);
  vec2 scanUV = vec2(dot(vWP,strike),dot(vWP,dip)) + vec2(0.16*seam,0.27*crag);
  vec3 scan = textureGrad(uRockSurface,scanUV,vec2(dot(dx,strike),dot(dx,dip)),vec2(dot(dy,strike),dot(dy,dip))).rgb;
  vec3 bedding = (scan.r-0.5)*normalize(strike) + (scan.g-0.5)*normalize(dip);
  vec3 face = normalize(normal + 0.60 * (bedding - normal * dot(bedding,normal)));
  float bowl = vGround.z, altitude = vWP.y;
  // Long-lived snow tongues follow the hollows below a cirque. Convex ribs
  // stay exposed well above the first snow in a neighbouring gully.
  float lee = dot(geom.xz,WIND_DIR);
  float catchment = clamp(2.7*bowl+0.44*lee,-1.,1.);
  float snowHeight = altitude+17.*catchment+11.*(0.5-crag)+4.*(0.5-seam);
  float shelter = 0.28*(0.5-crag)+0.18*(0.5-seam)+0.08*(0.5-chute)+0.14*catchment;
  float mantle = mix(geom.y,normal.y,0.26)-0.63+clamp((altitude-72.)*0.0016,-0.045,0.085)+shelter;
  float footprint = max(length(dx),length(dy));
  float snowLine = smoothstep(50.,74.,snowHeight);
  snow = snowLine*smoothstep(-0.040,0.040+min(0.040,0.018*footprint),mantle);

  float bedPhase = dot(vWP,vec3(0.026,0.098,-0.038)) + 0.49*seam + 0.78*crag;
  float bands = 0.5 + 0.5*cos(6.28318*bedPhase)*(1.-smoothstep(0.6,3.,footprint));
  float fracture = smoothstep(0.08,0.33,abs(seam-0.48)+0.24*chute);
  float spall = smoothstep(0.34,0.72,scan.b+0.22*chute-0.09);
  vec3 schist = mix(vec3(0.039,0.057,0.084),vec3(0.36,0.34,0.31),0.31*crag+0.49*chute+0.20*bands);
  schist *= (0.60+0.71*fracture)*(0.57+0.94*spall);
  // Broken bedding planes run across the face. Scree and snow bury them at
  // the toe of the wall; fine seams disappear with the projected footprint.
  schist *= 1.-0.32*smoothstep(0.66,0.96,bands)*fracture;
  float apron = smoothstep(0.48,0.83,geom.y)*smoothstep(-0.13,0.37,0.30*bowl+0.63*chute-0.21);
  vec2 fanUV = vWP.xz*0.010 + vec2(0.18*crag,0.13*seam);
  vec4 blocks = textureGrad(uTrailMaterial,fanUV,0.010*dx.xz,0.010*dy.xz);
  float stone = smoothstep(0.42,0.80,blocks.b);
  vec3 talus = mix(vec3(0.13,0.111,0.096),vec3(0.28,0.257,0.226),stone)*(0.66+0.54*blocks.a);
  schist = mix(schist,talus,0.76*apron);
  vec3 relief = vec3(blocks.r-0.5,0.,blocks.g-0.5);
  face = normalize(face+apron*(0.34+1.25*stone)*(relief-face*dot(face,relief)));
  // Dark mats of scrub thin into separate colonies and end at the scree.
  float heath = (1.-smoothstep(34.,61.,altitude+9.*crag-6.*catchment))*smoothstep(0.56,0.84,geom.y);
  float colony = smoothstep(0.26,0.69,0.40*seam+0.36*chute+0.24*blocks.a+0.16*bowl);
  schist = mix(schist,mix(vec3(0.080,0.098,0.051),vec3(0.031,0.067,0.045),colony),heath*(0.43+0.57*colony)*(1.-0.65*stone));
  // Coarse blocks break the edge of thin snow. Deeper drifts bury the blocks
  // and soften their normals while keeping the shape of the underlying bowl.
  float powder = smoothstep(-0.025,0.24,mantle+0.07*(chute-0.5));
  snow *= 1.-0.29*stone*apron*(1.-powder);
  float openSnow = smoothstep(-0.13,0.54,dot(geom,uStarDir)-0.23*max(catchment,0.));
  vec3 frost = mix(vec3(0.32,0.55,0.70),vec3(0.94,0.95,0.96),powder);
  frost *= mix(vec3(1.),vec3(0.71,0.85,1.),(1.-openSnow)*clearAfternoon());
  // Wind exposes blue ice between deposits, even high on the shoulders.
  frost *= mix(0.76+0.31*scan.b+0.12*spall,1.,powder*(0.52+0.48*chute));
  normal = normalize(mix(face,mix(normal,geom,0.64*powder),snow));
  return vec4(mix(schist,frost,snow),mix(0.78,mix(0.44,0.86,powder),snow));
}
vec3 lastAlpineLight(float snow,float nl,float sun){
  float low = (1.-smoothstep(0.07,0.40,uStarDir.y))*smoothstep(-0.07,0.08,uStarDir.y);
  return vec3(1.,0.43,0.28)*(0.19*low*snow*smoothstep(40.,110.,vWP.y)*max(0.,nl)*sun*(1.-uNight));
}
void main(){
  if (vWP.y < uClip) discard;
  vec2 p = vWP.xz; vec2 uv = fieldUV(p); float inf = inField(uv);
  vec2 gr = vec2(0.);
  if (inf > 0.) gr = vec2(texture(uGround, uv).r, texture(uWear, uv).r);
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
    // Broad hollows only. The mipmapped earth tile supplies the close relief.
    vec2 grad = noiseSlope(p * 2.6).yz;
    N = normalize(N - dn * (1. - steep) * (1. - 0.7 * wear) * (1. - 0.6 * moist) * vec3(grad.x, 0., grad.y) * 0.19);
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
  vec3 terrainDx=dFdx(vWP), terrainDy=dFdy(vWP);
  float outerRange = smoothstep(122.,206.,max(abs(p.x),abs(p.y)));
  float alpine = smoothstep(30.-11.*outerRange,51.-15.*outerRange,y+(0.5-crag)*8.);
  float snow = 0.;
  vec4 ridge = vec4(0.);
  vec3 alpineNormal = N;
  if (alpine > 0.) ridge = mountainSurface(terrainDx,terrainDy,crag,seam,chute,alpineNormal,snow);
  // Beyond the playable basin a fully alpine pixel has no meadow, walking
  // track, shore or local fields. Finish it before those materials are read.
  if (alpine >= 1. && inf == 0.) {
    float nl = dot(alpineNormal,uSunDir);
    float sun = nl > 0. ? directLight(vWP) : 0.;
    vec3 lit = pbr(ridge.rgb,ridge.a,0.,alpineNormal,normalize(uCam-vWP),vWP,sun,0.);
    o = vec4(tonemap((lit+lastAlpineLight(snow,nl,sun))*vAir.a+vAir.rgb),0.);
    return;
  }
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
  // stand above it, so distant grass cover carries the same pigment as nearby blades.
  vec3 stand = meadowStand(p).rgb;
  float clump = vnoise(p * 2.3 + 4.1);
  float thatch = mix(0.5, smoothstep(0.26, 0.76, 0.63 * clump + 0.37 * n3), fine);
  vec3 litter = stand * mix(0.16, 0.52, smoothstep(0.18, 0.85, thatch)) * (0.8 + 0.4 * clump) + vec3(0.012, 0.010, 0.009);
  vec3 moss = mix(litter * 0.78, litter * 1.12 + vec3(0.01, 0.02, 0.008), hummocks) * (0.82 + 0.36 * n3);
  vec3 sand = mix(vec3(0.16, 0.12, 0.083), vec3(0.41, 0.34, 0.22), n1) * (0.75 + 0.42 * n2);
  vec3 bed = mix(vec3(0.060, 0.096, 0.082), vec3(0.24, 0.23, 0.16), n2) * (0.74 + 0.48 * n3);
  vec3 rock = mix(vec3(0.095, 0.103, 0.117), vec3(0.33, 0.28, 0.25), n2 * 0.65 + n1 * 0.35);
  vec3 alb = moss; float rough = 0.88, metal = 0.;
  float wrack = vnoise(p * vec2(2.7, 1.4) + n1 * 2.);
  float shore = 1. - smoothstep(0.17, 0.52 + 0.33 * wrack, bank);
  float tide = smoothstep(-0.24, -0.04, bank) * (1. - smoothstep(0.04, 0.37 + 0.21 * wrack, bank));
  sand *= mix(vec3(1.), vec3(0.60, 0.67, 0.66), tide);
  alb = mix(alb, sand, shore); rough = mix(rough, 0.75 - 0.25 * tide, shore);
  float under = 1. - smoothstep(-0.35, -0.05, bank);
  alb = mix(alb, bed, under);
  float upland = smoothstep(54., 79., max(abs(p.x), abs(p.y)));
  vec3 heath = mix(vec3(0.045, 0.12, 0.095), vec3(0.15, 0.13, 0.083), smoothstep(-50., 70., p.x + p.y * 0.35));
  alb = mix(alb, mix(heath, litter, 0.5) * (0.68 + 0.55 * hummocks + 0.15 * n3), upland * (1. - shore) * 0.64);
  float rk = max(smoothstep(0.34, 0.58, mix(slopeG, slope, 0.22) + 0.13 * n2), smoothstep(6. + 11. * upland, 12. + 16. * upland, y) * 0.8);
  alb = mix(alb, rock, rk); rough = mix(rough, 0.62, rk);
  vec2 sill=p-vec2(${riverX(falls.lip).toFixed(3)},${falls.lip});
  if (abs(sill.y)<4.2 && abs(sill.x)<5.5) {
    vec3 sp=vWP*0.63;
    float mineral=dot(weights,vec3(texture(uRockSurface,sp.zy).b, texture(uRockSurface,sp.xz).b, texture(uRockSurface,sp.xy).b));
    float layer=vnoise(vec2(dot(p,vec2(0.88,-0.38))*0.65,vWP.y*2.4+0.30*vWP.x+1.6*n1));
    float face=smoothstep(0.08,0.39,slopeG)*(1.-smoothstep(1.9,4.2,abs(sill.y)))*(1.-smoothstep(3.5,5.5,abs(sill.x)));
    float drier=smoothstep(-0.03,0.84,bank+0.20*(n2-0.5));
    vec3 slate=shale(0.24+0.57*layer)*(0.54+0.90*mineral)*(0.69+0.31*drier);
    float cap=smoothstep(0.55,0.85,vN.y+0.17*(n2-0.5))*smoothstep(0.33,0.64,0.6*n1+0.4*mineral)*drier;
    slate=mix(slate,mix(vec3(0.067,0.106,0.039),vec3(0.17,0.21,0.078),n2)*(0.72+0.46*n3),cap);
    alb=mix(alb,slate,face); rough=mix(rough,mix(0.44,0.76,drier),face);
  }
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
    // Pale gneiss is exposed on the southeast face of the western switchbacks.
    // Its dipping bands cross the hiking benches and taper out at the hill's foot.
    vec2 spur = (p - vec2(-40., -26.)) / vec2(22., 15.);
    float exposure = 1. - smoothstep(0.38, 1., dot(spur,spur));
    if (exposure > 0.) {
      const vec3 strike = vec3(0.15,0.08,-0.10), dip = vec3(0.042,0.27,0.06);
      vec3 grain = textureGrad(uRockSurface, vec2(dot(vWP,strike),dot(vWP,dip)) + 0.17*flutes,
        vec2(dot(terrainDx,strike),dot(terrainDx,dip)), vec2(dot(terrainDy,strike),dot(terrainDy,dip))).rgb;
      vec3 bedding = (grain.r-0.5)*normalize(strike) + (grain.g-0.5)*normalize(dip);
      float fault = bedHeight * 0.31 + lateral * 0.16 + lithology * 0.43;
      float seam = (1. - smoothstep(0.035, 0.20, abs(fract(fault + 0.5) - 0.5))) * smoothstep(0.23, 0.63, flutes);
      float pale = smoothstep(0.30,0.70,0.33*ledge+0.67*grain.b);
      vec3 gneiss = mix(vec3(0.12,0.145,0.15),vec3(0.73,0.69,0.55),pale);
      gneiss = mix(gneiss,vec3(0.76,0.73,0.58),0.82 * seam);
      face = mix(face,gneiss*(1. - 0.27*runnel),exposure);
      N=normalize(N+exposure*cliff*2.4*(bedding-N*dot(N,bedding)));
    }
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
  float islandDist=length(vec2((isle.x+0.21*isle.y)/${ISLET_WIDTH},isle.y/${ISLET_DEPTH}));
  float islandStone=(1.-smoothstep(1.07,1.50,islandDist))*smoothstep(-0.35,0.28,y);
  float mantleSoil = islandStone * smoothstep(0.42,0.93,vN.y)*(1.-0.72*smoothstep(0.52,0.98,islandDist));
  if (islandStone>0.) {
    // Dipping stone beds surface along the shoulders. Moss catches the tops
    // of shelves while wave-washed seams break up their shaded faces.
    float drift = (n1-0.5)*1.35 + (n2-0.5)*0.21;
    float bed = 1.72*y + dot(isle,vec2(0.22,-0.13)) + drift;
    float lens = vnoise(vec2(dot(isle,vec2(0.67,-0.41))+n1,bed));
    float shale = smoothstep(0.27,0.76,lens+0.19*(n3-0.5));
    float joint = (1.-smoothstep(0.02,0.15,abs(fract(bed+0.5)-0.5)))*smoothstep(0.27,0.64,lens);
    vec3 face = mix(vec3(0.082,0.102,0.118),vec3(0.40,0.37,0.30),shale)*(1.-0.40*joint);
    float moss = smoothstep(0.41,0.75,vN.y+0.22*(lens-0.5))*smoothstep(0.29,0.63,n2+0.22*shale);
    face = mix(face,mix(vec3(0.083,0.114,0.044),vec3(0.26,0.30,0.10),n2),0.82*moss);
    alb = mix(alb,face*(0.76+0.48*n3),islandStone*(1.-0.7*mantleSoil));
  }
  // The smaller offset, rotated soil patch neither copies the chip pattern nor
  // inherits its slope direction. Use explicit derivatives across the verge.
  vec2 dx=terrainDx.xz, dy=terrainDy.xz;
  // The same tread that suppresses grass roots governs the material. Break
  // only the partially worn edge so the packed centre stays readable.
  float edge = 4. * vGround.x * (1. - vGround.x);
  float pathMask=smoothstep(0.09,0.91,vGround.x+edge*((n2-0.5)*0.43+(clump-0.5)*0.22));
  float soilCover = max(pathMask, mantleSoil);
  float compact = max(pathMask, smoothstep(0.025,0.60,wear));
  float pore = 0.50;
  // where the meadow's floor still shows through what has been laid over it
  float meadowFloor = fine * (1. - shore) * (1. - under) * (1. - rk) * (1. - cliff) * (1. - islandStone) * (1. - 0.6 * upland);
  if (vGround.x>0.01 || mantleSoil>0. || meadowFloor>0.01) {
    mat2 rot = mat2(0.80,0.60,-0.60,0.80);
    vec2 soilUV = p*0.38+vec2(0.12*n1,0.045*n2);
    vec4 coarse = textureGrad(uTrailMaterial,soilUV,0.38*dx,0.38*dy);
    vec4 detail = textureGrad(uTrailMaterial,1.21*(rot*p)+vec2(0.19,0.61),1.21*(rot*dx),1.21*(rot*dy));
    float grains = 0.56*coarse.a + 0.44*detail.a;
    // Signed inclusion around 102/255. Organics and shale filter smoothly
    // into the neutral earth value as the texture recedes.
    float grit = max(0.,max(coarse.b-0.4,0.57*(detail.b-0.4))) / 0.6;
    float scraps = max(0.,max(0.4-coarse.b,0.73*(0.4-detail.b))) / 0.4;
    vec3 clay=mix(vec3(0.102,0.069,0.051),vec3(0.38,0.239,0.151),0.19+0.48*n1+0.33*n2);
    float crumb = smoothstep(0.32,0.72,grains);
    float loose = 1.-compact;
    // Humus accumulates under crowns. On the verge the stand takes hold in
    // pockets in the loam, leaving mineral chips visible through the roots.
    float humus = loose*(0.20+0.66*vCover);
    clay *= mix(vec3(1.),vec3(0.52,0.64,0.58),humus);
    vec3 earth = clay*(0.50+0.96*crumb+0.06*compact);
    vec3 flakes = shale(0.15+0.75*coarse.a) * (0.83+0.45*detail.a);
    earth = mix(earth,flakes,grit);
    float margin = smoothstep(0.20,0.79,0.50*thatch+0.32*hummocks+0.18*(1.-crumb));
    float rootCover = loose*loose*margin*(1.-grit)*(1.-0.50*vCover);
    vec3 roots = mix(stand*0.36,earth,0.20)*(0.77+0.42*detail.a);
    vec3 floorCol = mix(earth,roots,rootCover);
    float litterCover = scraps*(0.24+loose*(0.54+0.22*vCover))*(1.-grit);
    vec3 leafMould = mix(vec3(0.118,0.054,0.021),vec3(0.45,0.248,0.088),crumb);
    floorCol = mix(floorCol,leafMould,litterCover);
    float soilWeight=max(soilCover,meadowFloor);
    alb=mix(alb,floorCol,soilWeight);
    vec2 relief=(2.*coarse.rg-1.)*0.65 + transpose(rot)*(2.*detail.rg-1.)*0.53;
    float surfaceRelief = mix(1.05,0.55,compact*(1.-grit));
    N=normalize(N+vec3(relief.x,0.,relief.y)*soilWeight*surfaceRelief);
    rough=mix(rough,0.93-0.14*compact-0.16*grit,soilWeight);
    pore=mix(pore,0.16+0.78*(1.-crumb)*(1.-grit),soilWeight);
  }
  float vein = rk * smoothstep(0.74, 0.8, n3) * (1. - smoothstep(12., 28., dist));
  // Pale seams are silica in the bedrock, so they keep a broad dielectric highlight.
  rough = mix(rough, 0.48, vein);
  alb = mix(alb, vec3(0.33, 0.30, 0.29), vein * 0.44);
  // forest under the snow line on the far slopes, rock laid down in strata, and snow that settles on ledges and in
  // gullies while steep faces and the sharpest crests stay bare
  float treeline = far * smoothstep(9., 15., y) * (1. - smoothstep(24., 36., y + n1 * 8.)) * (1. - smoothstep(0.45, 0.7, slope));
  // Tree cover climbs the sheltered folds in small tongues. The joints
  // already sampled for relief give these patches a stable scale at range.
  float grove = smoothstep(0.25, 0.71, 0.66 * seam + 0.34 * chute);
  vec3 forestFloor = mix(vec3(0.066, 0.078, 0.061), vec3(0.026, 0.062, 0.066), grove);
  alb = mix(alb, forestFloor, treeline * (0.48 + 0.45 * grove));
  // Broad, tilted beds cut across the relief. Narrow benches weather to a lighter colour.
  float bench = smoothstep(0.30,0.72,0.64*crag+0.36*seam);
  alb *= mix(vec3(1.),mix(vec3(0.74,0.78,0.90),vec3(1.24,1.14,0.96),bench),rk*far);
  if (alpine > 0.) {
    alb = mix(alb,ridge.rgb,alpine);
    rough = mix(rough,ridge.a,alpine);
    N = normalize(mix(N,alpineNormal,alpine));
  }
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
    float chip = max(0.,grit.b-0.4)/0.6;
    vec3 shingle = mix(alb * (0.73 + 0.52*grit.a), shale(0.29+0.69*grit.a), 0.15+0.69*chip);
    float wcob = cobZ * (0.40 + 0.60*deposit);
    alb = mix(alb, shingle, wcob);
    vec2 relief = transpose(driftDir)*((grit.rg*2.-1.)*stretch);
    N = normalize(N + vec3(relief.x,0.,relief.y)*wcob*0.50);
    rough = mix(rough, 0.65-0.12*under, wcob);
    pore=mix(pore,0.23+0.69*(1.-grit.a)*(1.-chip),wcob);
    // Soft moving caustic patches break across the sand and gravel in sunlit shallows.
    float drift = dot(p, vec2(1.6, 1.0)) + uTime * 0.70 + 4.0 * n1;
    float focus = 0.5 + 0.5 * sin(drift * 2.6 + sin(p.y * 1.7 - uTime * 0.43) * 2.8);
    alb *= 1. + 0.48 * under * (1. - uNight) * sun * wcob * focus * focus * n2 * (1. - 0.85*uStorm);
  }
  // Fresh pressure darkens the loose grains even where an old path is fully packed.
  float printWear = smoothstep(0.03,0.59,wear)*(1.-under)*(1.-rk);
  alb *= 1.-printWear*mix(0.25,0.15,pathMask);
  rough = mix(rough,0.66,printWear);
  // Water darkens porous earth before a continuous film covers its raised grit.
  float damp = clamp(moist*(0.68+0.64*pore),0.,1.);
  alb *= mix(vec3(1.),vec3(0.48,0.55,0.60),damp);
  rough = mix(rough,0.30,smoothstep(0.11,0.78,damp)*0.87);
  vec3 V = normalize(uCam - vWP);
  vec3 col = pbr(alb, rough, metal, N, V, vWP, sun, vCover);
  // The last warm light catches sun-facing peaks while the valleys cool.
  col += lastAlpineLight(snow*alpine,dot(N,uSunDir),sun);
  // Scuffed dirt keeps its wear and moisture. Living blades and leaves carry contact light.
  col += moss * uNight * 0.16 * (1. - rk) * (1. - shore) * (1. - pathMask);
  vec2 foxDelta = p - uFoxShadow.xy;
  if (uFoxShadow.w > 0. && dot(foxDelta, foxDelta) < 1.6) {
    vec2 along = vec2(sin(uFoxShadow.z), -cos(uFoxShadow.z));
    vec2 spread = vec2(dot(foxDelta, along), dot(foxDelta, vec2(-along.y, along.x)));
    vec2 ellipse = spread / vec2(0.86, 0.44);
    col *= 1. - 0.39 * uFoxShadow.w * (1. - smoothstep(0.08, 1., dot(ellipse, ellipse)));
  }
  o = vec4(tonemap(col * vAir.a + vAir.rgb), 0.);
}`);

const ROCK = program(WORLD_VS + `
in vec3 aPos, aPos1, aPos2, aNor, aNor1, aNor2; in vec4 aI, aS, aBed;
flat out vec4 vBed; flat out vec3 vAlong, vUp;
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
  vBed = vec4(max(0.,aBed.z),aBed.w,max(aS.x,aS.z),float(aBed.z<0.)); vToe = rp.y;
  gl_Position = project(vWP);
}`,
`uniform float uClip; uniform sampler2D uRockSurface;
flat in vec4 vBed; flat in vec3 vAlong, vUp; in vec3 vWP, vLoc, vNl; in float vH, vToe, vCurv; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 V = normalize(uCam - vWP);
  vec2 uv = fieldUV(vWP.xz); float inf = inField(uv);
  float dist = length(uCam - vWP);
  vec3 col;
  {
    vec3 lp = vLoc * 1.6 + vec3(vH * 17.);
    // A metre of mineral grain has the same scale on a pebble and a boulder.
    // Each piece exposes another cut through the bed.
    vec3 Nl = normalize(vNl), aw = Nl*Nl; aw *= aw; aw /= aw.x + aw.y + aw.z;
    // Individual fissures widen into visible bands at the far-side scale.
    float broadRock = smoothstep(16., 53., dist);
    vec3 sp = vLoc * mix(0.56 + 0.17*vH, 0.21 + 0.06*vH, broadRock)
              + vec3(7.9, 15.1, 8.7)*vH;
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
    float beds = smoothstep(0.28, 0.64, vnoise(lp.xy * vec2(0.8, 1.88) + n2 * 0.52));
    alb *= (1. - (0.38 + 0.20 * broadRock) * crack) * mix(1., 0.70 + 0.52 * beds, 0.72 * broadRock);
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
    if(vBed.w>0.){
      // Beds continue across adjoining blocks. Moss takes the damp, sky-facing shelves.
      float layer=vWP.y*1.82+dot(vWP.xz,vec2(.33,-.17))+.41*vnoise(vWP.xz*1.1);
      float fracture=vnoise(vec2(dot(vWP.xz,vec2(.79,.44)),floor(layer)*1.17));
      float joint=(1.-smoothstep(.026,.105,abs(fract(layer)-.5)))*smoothstep(.27,.68,fracture);
      float ledge=smoothstep(.31,.76,N.y+.25*(humus-.5));
      float cap=ledge*(.38+.62*smoothstep(.27,.69,humus+.18*(mineral-.5)))*smoothstep(.03,.55,vWP.y-vBed.y);
      vec3 weathered=mix(alb,vec3(.23,.24,.205)*(.47+.82*mineral),.49);
      alb=mix(weathered*(1.-.33*joint),vec3(.085,.145,.047)*(.61+.85*n2),cap);
    }
    float shoreWet;
    alb = waterline(alb, vWP, vBed.y, shoreWet);
    float wet = clamp(max(shoreWet, (texture(uGround, uv).r + uSheet) * inf), 0., 1.);
    // soil splashed up the foot, and the foot darker where the ground hides it from the sky
    alb = mix(alb, vec3(0.15, 0.115, 0.085) * (0.8 + 0.4 * n2), (1. - smoothstep(-0.39, -0.16, vToe + 0.05 * (speck - 0.5))) * 0.32);
    alb *= (1. - 0.3 * wet) * mix(0.64, 1., smoothstep(-0.39, 0.03, vToe));
    col = pbr(alb, mix(0.8 - 0.15 * lich, 0.14, wet * 0.9), 0., N, V, vWP);
    // light the sunlit soil around the stone throws back up onto its lower faces, warm as the trail it lies by
    float below = clamp(0.55 - 0.65 * N.y, 0., 1.);
    float bounce = below * smoothstep(-0.40,-0.08,vToe) * (1. - uNight);
    if (bounce > 0.) col += alb * vec3(0.95, 0.66, 0.42) * bounce * (0.12 + 0.3 * directLight(vWP + vec3(0., -0.3, 0.))) * (1. - 0.7 * wet);
    if (uNight > 0. && moss > 0.) {
      float glow = textureLod(uGlow,uv,0.).r * inf;
      col += mossTint * moss * uNight * (0.28 + glowI(glow));
    }
    col += lichC * lich * (0.03 * uNight) * (0.6 + 0.4 * sin(uTime * 0.8 + vH * 30.));
  }
  o = vec4(tonemap(fogged(col, vWP)), 0.);
}`);

// Interpolate at a covered sample on thin foliage. A pixel center can fall far outside a subpixel triangle.
const JLEAF = program(WORLD_VS + BRUSH_VS + `
uniform float uNight; uniform bool uSimpleLeaf; in vec4 aR; in vec4 aD; in vec4 aM; in vec4 aB;
centroid out vec3 vWP, vN;
centroid out vec2 vBlade; flat out vec4 vLeaf; flat out vec3 vAcross; centroid out vec3 vTan;
void main(){
  // Nearby leaves share a raised spine between two curved faces. The distant
  // strip and shadow caster use the same silhouette with three lengthwise spans.
  int id = gl_VertexID;
  float u = uSimpleLeaf ? float(id / 2) / 3. : float(id / 3) / 6.;
  float side = uSimpleLeaf ? (id == 6 ? 0. : float(id % 2) * 2. - 1.) : float(id % 3 - 1);
  float seed = aM.w, L = aD.w;
  vec3 up = vec3(0., 1., 0.), dir = normalize(aD.xyz);
  vec3 sd = cross(up, dir); sd = length(sd) < 1e-3 ? vec3(1., 0., 0.) : normalize(sd);
  float curve = sin(3.14159 * u), lift = aM.x, droop = aM.y;
  vec3 p = aR.xyz + L * (dir * u + up * (lift * curve - droop * u * u));
  vec3 bend = brushBend(aR.xyz + L * (dir * 0.67 + up * (0.86 * lift - 0.45 * droop)));
  p += bend * (0.78 * L * u * u);
  float gust = windWave(aR.xz) * uWind;
  float ripple = tipFlutter(aR.xz,uWindFrame.x,seed);
  // Swivel the whole spray at its stalk. The same angle drives both the
  // shape and normals so the leaf veins stay fixed to the leaf.
  vec2 push = normalize(WIND_DIR + sd.xz * ((seed - 0.5) * 0.61));
  vec3 hinge = vec3(push.y,0.,-push.x);
  float a = leafBend(gust * (0.38 + 0.40 * seed));
  a += 0.095 * ripple * min(gust, 1.25) * (0.55 + 0.45 * abs(dot(dir.xz, WIND_DIR)));
  vec2 swivel = vec2(cos(a), sin(a));
  vec3 tang = normalize(dir + up * (lift * 3.14159 * cos(u * 3.14159) - 2. * droop * u)
    + bend * (1.56 * u));
  vec3 upper = normalize(cross(tang, sd));
  vec3 across = normalize(sd + upper * ((seed - 0.5) * (0.40 + 1.65 * u)));
  upper = normalize(cross(tang, across));
  // The strap keeps its atlas proportions all the way to its tip.
  float width = L * ${STRAP_ASPECT} * (0.9 + 0.2 * seed) * uLodW;
  p += sd * (seed - 0.5) * L * u * u * 0.43;
  float fold = (0.46 + 0.10 * curve) * 0.6;
  p += across * side * width;
  if (!uSimpleLeaf) p += upper * (1. - abs(side)) * width * fold;
  p = aR.xyz + rotateFoliage(p - aR.xyz, hinge, swivel);
  vN = rotateFoliage(normalize(upper + across * side * fold * 1.65), hinge, swivel);
  vec2 uv = fieldUV(aB.xy);
  vLeaf = vec4(aB.w, aM.w, uNight > 0. ? textureLod(uGlow, uv, 0.).r : 0., clamp(textureLod(uGround, uv, 0.).r + uSheet, 0., 1.));
  vAcross = rotateFoliage(sd, hinge, swivel); vWP = p; vBlade = vec2(u, side); vTan = rotateFoliage(tang, hinge, swivel);
  gl_Position = project(p);
}`, sprayGLSL + `
uniform float uClip; uniform bool uCoverage;
centroid in vec3 vWP, vN, vTan; centroid in vec2 vBlade; flat in vec4 vLeaf; flat in vec3 vAcross; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  float u = clamp(vBlade.x, 0., 1.), side = clamp(vBlade.y, -1., 1.);
  float seed = vLeaf.y, wet = vLeaf.w;
  vec4 spray = texture(uLeafSprays, sprayUV(u, side, 1., seed));
  // Coverage sharpened to about a pixel: crisp leaf edges up close, the mips keep far crowns full.
  float cover = clamp((spray.a - 0.5) / max(fwidth(spray.a), 1e-4) + 0.5, 0., 1.);
  if (uCoverage ? cover < 0.02 : spray.a < 0.5) discard;
  vec3 tint = crownPigment(vLeaf.x) * mix(vec3(0.83,0.92,0.87),vec3(1.12,1.02,0.92),seed);
  // Moist leaves deepen within the same pigment family as the dry tissue.
  tint *= mix(vec3(1.),vec3(0.91,0.95,0.94),wet);
  // the leaf's own surface from the atlas: cupped, creased at the midrib, veined
  vec3 Ng = normalize(vN), T = normalize(vTan - Ng * dot(vTan, Ng)), B = cross(Ng, T);
  B *= sign(dot(B, vAcross) + 1e-4);
  vec2 slope = (spray.rg * 2. - 1.) * 2.;
  vec3 N = normalize(Ng + 0.55 * (slope.x * B + slope.y * T)), V = normalize(uCam - vWP);
  float tone = spray.b, stem = 1. - smoothstep(0.02, 0.06, tone);
  float vein = smoothstep(0.82, 0.97, tone);
  vec3 albedo = tint * (0.3 + 0.62 * tone) * (1. - 0.19 * wet);
  albedo = mix(albedo, vec3(0.15, 0.1, 0.075), stem);
  float upper = smoothstep(-0.18, 0.18, dot(N, V));
  vec3 sun = uSunCol * directLight(vWP);
  vec3 sky = mix(ambient(-N), ambient(N), upper) * contactLight(vWP) * mix(vec3(1.), vec3(0.34, 0.48, 0.48), canopyCover(vWP));
  float facing = dot(N,uSunDir);
  vec2 sides = vec2(max(facing,0.),max(-facing,0.));
  float direct = mix(sides.y,sides.x,upper);
  vec3 light = albedo * (2.55 * sky + floraSpill(vWP) + sun * (0.06 + 0.55 * direct));
  // Green laminae transmit more amber and green light, most where they are thin.
  float green = smoothstep(0.01, 0.21, tint.g - tint.r);
  vec3 transmitted = albedo * mix(vec3(1.), vec3(1.58, 1.23, 0.58), green * 0.6);
  light += sun * transmitted * mix(sides.x,sides.y,upper) * 0.36 * (1. - stem) * (0.7 + 0.3 * u);
  float halfAngle = dot(N, normalize(V + uSunDir));
  float sheen = mix(max(-halfAngle,0.),max(halfAngle,0.),upper);
  float broad = sheen * sheen; broad *= broad; broad *= broad;
  float gloss = broad * broad; gloss *= gloss;
  light += sun * direct * (broad * 0.025 + gloss * (0.15 + 0.27 * wet)) * (1. - stem);
  // A waxy leaf also catches a broad strip of open sky between the boughs.
  float skyFacing = max(0., reflect(-V, N).y);
  float rim = 1. - abs(dot(N, V)); rim *= rim;
  light += sky * (skyFacing * skyFacing) * (0.10 + 0.64 * rim) * (0.60 + wet) * (1. - stem);
  float night = smoothstep(0.12, 0.95, uNight), response = glowI(vLeaf.z);
  float reached = smoothstep(0.01, 0.45 + 0.27 * u, response);
  float tips = smoothstep(0.64, 0.97, u) * (1. - stem);
  vec3 luminous = mix(tint, sqrt(tint), 0.45);
  light += luminous * night * (vein * (0.06 + 0.1 * seed + 1.2 * reached * response) + tips * (0.044 + 0.22 * response));
  o = vec4(tonemap(fogged(light, vWP)), uCoverage ? cover : 0.);
}`);

// grass: Corey's blade (ceeboozwah/grass), ported. Three rows plus a tip, quadratic bend, width taper,
// rounded normals, rolling gust waves, a root-mid-tip ramp with patch noise and root AO, sun backlight through
// the tips. Wired to the certified fields: wear tramples it flat, moisture droops and darkens it, glow lights
// the tips you stirred. Instances are shuffled, so drawing a prefix is an even thinning (adaptive density).
const grassDefines = (GRASS_LAB ? '#define GRASS_LAB\n' : '') + (!TEST ? '#define BLADE_CONTACT\n' : '');
const bladeVertex = `
#ifdef GRASS_LAB
out float vContact;
#endif
layout(location=0) in vec4 aRoot;
layout(location=1) in vec4 aDetail;
#if defined(GRASS_LAB) && !defined(SOLVE_BLADE) && !defined(STAMP_BLADE)
layout(location=2) in float aBladeIndex;
#endif
#if defined(SOLVE_BLADE) || defined(STAMP_BLADE)
uniform vec3 uCam;
#endif
uniform vec2 uGrassHeight; uniform int uBladeRows;
#if defined(SOLVE_BLADE) || defined(STAMP_BLADE)
const int uGrassFields=7;
#else
uniform int uGrassFields;
${grassPulseGLSL}
#endif
centroid out vec3 vWP; centroid out vec4 vGA; centroid out float vGlow; centroid out float vWet; centroid out vec3 vN; centroid out float vPatch;
flat out vec4 vGrassColour; centroid out vec4 vAir; centroid out float vDry;
void main(){
  vec4 aG = vec4((aRoot.xy - 0.5) * uExtent, uGrassHeight.x + aRoot.z * uGrassHeight.y, aDetail.w);
  int packed = int(aRoot.w*65535. + 0.5), cell = packed & 15;
  float edge = float((packed >> 4) & 7)/7.;
  vec4 aR = vec4(aDetail.xyz, float(packed >> 7)/511. * ${BLADE_HEIGHT_RANGE.toFixed(1)});
  float distanceToRoot = distance(vec3(aG.x,aG.z,aG.y),uCam);
  float widthScale = 1., coverage = 1.;
#if defined(SOLVE_BLADE) || defined(STAMP_BLADE)
  int sibling=gl_InstanceID%3;
  ivec2 site=bladeSite(aG.xy), page=site-uSiteBase;
  gl_Position=vec4(3,3,0,1); gl_PointSize=1.;
  if (!onPage(page)) return;
  if ((sibling==1 && aG.w<=${SISTER_ONE}) || (sibling==2 && aG.w<=${SISTER_TWO})) return;
#ifdef STAMP_BLADE
  int sampleIndex=gl_InstanceID/3;
  if(texelFetch(uBladeNow,ivec3(address(page,sibling),sampleIndex/2),0).a<0.5) return;
#endif
  int vid=0, rows=4;
#else
  int vid = gl_VertexID, rows = uBladeRows;
#ifdef GRASS_LAB
  int sibling=int(aBladeIndex);
#else
  int sibling = vid/16;
  vid %= 16;
  if (sibling != 0) rows=max(2,rows-1);
  float fraction = rootFraction(distanceToRoot);
  float rank = (float(gl_InstanceID)+0.5)*uPopulation.x;
  float feather = max(0.00001,min(0.16*fraction,0.40*(1.-fraction)));
  coverage = fraction >= 0.9999 ? 1. : smoothstep(0.,feather,fraction-rank);
  if(sibling>0) {
    float end = sibling==1 ? 18. : 14.;
    coverage *= 1.-smoothstep(end-6.,end,distanceToRoot);
    if(aG.w <= (sibling==1 ? ${SISTER_ONE} : ${SISTER_TWO})) coverage=0.;
  }
  if(coverage<0.001) { gl_Position=vec4(2.,2.,2.,1.); return; }
  widthScale = min(1.9,inversesqrt(max(0.01,fraction)));
#endif
#endif
  vec2 cq = aG.xy / ${CLUMP};
  ivec2 ci = ivec2(floor(cq)) + ivec2(cell % 3 - 1, cell / 3 - 1);
  uint th = clumpHash(ci);
  vec2 toTuft = vec2(ci) + clumpOffset(th) - cq;
  float tuftDist = length(toTuft), tuft = float((th * 747796405u) >> 8)/16777216.;
  bool sister = sibling != 0;
  vid = min(vid, 2*rows);
  float by = float(vid/2)/float(rows);
  float side = vid == 2*rows ? 0. : float(vid % 2) - 0.5;
  uint bh = clumpHash(ivec2(floor(aG.xy*613.)) + ivec2(sibling * 31, sibling * -17));
  float shape = float(bh & 0xffffu)/65536., deadRoll = float(bh >> 16)/65536.;
  float a = aR.x*6.2831853 + (float(sibling) * (1.53 + 1.18 * aG.w));
  vec2 ax = vec2(cos(a), sin(a)), fd = vec2(-ax.y, ax.x);
  vec2 uv=fieldUV(aG.xy);
  float glow=(uGrassFields&1)!=0 ? textureLod(uGlow,uv,0.).r : 0.;
  float moisture=(uGrassFields&2)!=0 ? textureLod(uGround,uv,0.).r : 0.;
  float wear=(uGrassFields&4)!=0 ? textureLod(uWear,uv,0.).r : 0.;
  float wet=min(1.,moisture+uSheet), trample=smoothstep(0.04,0.45,wear);
#ifdef GRASS_LAB
  trample = 0.;
#endif
  float reed = step(1.6, aR.w);
  // Three blades: most are ordinary, many slender and tall, a few broad and short. The tuft sets the height
  // around them, highest in its middle; by the tread they splay and stand a little lower.
  float slender = step(shape, 0.43), broad = step(0.91, shape);
  float H = 0.52 * (0.62 + 0.76 * aR.y) * aR.w * (1. - 0.28 * trample) * mix(1., 1.14, slender) * mix(1., 0.78, broad)
          * mix(0.8, 1.2, tuft) * (1. - 0.28 * smoothstep(0.22, 0.68, tuftDist)) * (1. - 0.1 * edge);
  // Sisters keep their arc length as detail retires. Only their screen
  // coverage fades, so a change in frame rate cannot push tips underground.
  if (sister) H *= sibling==2 ? 0.64+0.26*shape : 0.80+0.21*shape;
  // Corey's proportions (ceeboozwah/grass): a short blade is a broad one, and a blade holds its width most of the way
  // up, narrowing a little into its sheath at the foot.
  float W0 = (0.05 + 0.03*aR.z)*mix(1.12, 1., clamp(H / 0.2, 0., 1.))*mix(1.,0.48,reed)*widthScale
           * mix(1.,0.68,slender)*mix(1.,1.19,broad)
           * mix(0.61,1.,smoothstep(0.42,1.,aR.w));
  float wd = W0 * (0.43 + 0.57*smoothstep(0.,0.27,by)) * pow(1.-by,0.75);
  wd *= coverage*(sister ? 0.80 : 1.);
  // Each blade answers the same moving front with its own spring angle and
  // phase. Short shoots inside a tuft shelter behind its taller outer blades.
  float soak = smoothstep(0.05, 0.75, wet) * (1. - trample);
  vec2 away = toTuft / max(tuftDist, 0.04) * -1.;
  float crowded = 1. - smoothstep(0.12, 0.52, tuftDist);
  float flexibility = mix(0.63, 1.27, shape) * (sister ? 0.79 : 1.);
  float shelter = mix(0.68, 1., smoothstep(0.08, 0.66, H));
  float wake = 0.11 + 0.35 * shape + 0.15 * float(sister);
  float sweep=0., flutter=0.;
#ifdef GRASS_LAB
  if (!uStillGrass)
#endif
  {
    float load = windWave(aG.xy + WIND_DIR * wake) * uWind * (1. - 0.74 * trample);
    float force = load * flexibility * mix(0.62,1.,smoothstep(0.54,1.40,load));
    sweep = 1.27 * force * shelter / sqrt(0.84 + force * force);
    flutter = smoothstep(0.05,0.65,load)*tipFlutter(aG.xy, uWindFrame.x, (shape + tuft) * 1.6);
  }
  vec2 lateral = vec2(-WIND_DIR.y,WIND_DIR.x);
#ifdef BLADE_CONTACT
  vec3 brush = vec3(0.);
#else
  vec3 brush = brushBend(vec3(aG.x, aG.z + H * 0.5, aG.y));
#endif
  vec2 rest = mix(fd, away, (sister ? 0.30 : 0.55) * smoothstep(0.09, 0.45, tuftDist));
  vec2 steer = WIND_DIR * sweep + rest * (0.24 + 0.46 * aR.z + 0.68 * soak + 0.31 * trample + 0.17 * edge)
             + lateral * flutter * (0.07 + 0.18 * abs(sweep)) * (1. - 0.53 * crowded) + brush.xz * 1.12;
  // Treat the adjacent shoots as a compliant tuft. Inward bending presses
  // against its core and shares the windward lay, while the tips stay free.
  float inward = max(0., -dot(steer, away));
  steer += away * inward * crowded * 0.42;
  float magnitude = length(steer);
  vec2 lean = steer / max(magnitude, 0.0001);
  float curvature = 1.78 * magnitude * inversesqrt(0.48 + magnitude * magnitude);
  float angle = by * curvature;
  float bow = sin(angle), upright = cos(angle);
  // Integrate the circular arc along the blade so its centreline has the
  // same length in still air, in a gust, and while springing back.
  float arc = H * (1. - 0.18 * soak) * (1. - 0.20 * trample) * (1. + 0.36 * min(0., brush.y));
  vec3 root=vec3(aG.x,aG.z,aG.y);
#ifdef SOLVE_BLADE
  if (arc<0.01) return;
  solveBlade(root,vec3(ax.x,0.,ax.y)*0.5*W0*(sister ? 0.80 : 1.),lean,arc,curvature,site,sibling);
#elif defined(STAMP_BLADE)
  stamp(root,lean,arc,curvature,0.5*W0*(sister ? 0.80 : 1.),site,sibling,sampleIndex);
#else
  float horizontal = angle < 0.04 ? 0.5 * angle : (1. - upright) / angle;
  float vertical = angle < 0.04 ? 1. - angle * angle / 6. : bow / angle;
  vec3 tangent = vec3(lean.x * bow, upright, lean.y * bow);
  vec3 hinge = vec3(lean.y, 0., -lean.x);
  vec3 across = rotateFoliage(vec3(ax.x, 0., ax.y), hinge, vec2(upright, bow));
  vec3 centre = vec3(aG.x, aG.z, aG.y) + arc * by * vec3(lean.x * horizontal, vertical, lean.y * horizontal);
  vec3 p = centre + across * (side * wd);
  float contactLight = 0.;
#ifdef GRASS_LAB
  vContact=0.;
#endif
#ifdef BLADE_CONTACT
  // The contact solve already relays bends to touching stems on the next
  // tick. Their light follows the interpolated bend as those stems spring back.
  ivec2 site=bladeSite(aG.xy), slot=site-uSiteBase;
  if(uContactEnabled && by>0. && onPage(slot)) {
    float f=by*4.;
    int k=min(3,int(ceil(f))-1);
    ivec2 dest=address(slot,sibling);
    vec4 lo=knot(uBladeNow,dest,k-1), hi=knot(uBladeNow,dest,k);
    ivec2 old=site-uLastBase;
    if(onPage(old)) {
      ivec2 lastDest=address(old,sibling);
      lo.xyz=mix(knot(uBladeLast,lastDest,k-1).xyz,lo.xyz,uBladeMix);
      hi.xyz=mix(knot(uBladeLast,lastDest,k).xyz,hi.xyz,uBladeMix);
    }
    vec3 offset=mix(lo.xyz,hi.xyz,f-float(k));
    float flex2=dot(offset,offset);
    if(flex2>0.000001) {
      tangent=normalize(tangent+(hi.xyz-lo.xyz)*(4./max(arc,0.01)));
      across=normalize(across-tangent*dot(across,tangent)+vec3(0.000001,0.,0.));
      p=centre+offset+across*(side*wd);
      if (uNight>0.) contactLight=0.085*flex2/(0.0036+flex2);
    }
#ifdef GRASS_LAB
    if(uMarkContact) vContact=hi.w>0.9 ? 1. : hi.w>0.4 ? -1. : 0.;
#endif
  }
#endif
  contactLight = max(contactLight,grassPulseLight(uGrassFields>>3,aG.xy,tuft));
  vec3 face = cross(tangent, across);
  vN = normalize(-face + tangent * (0.48 + 0.41 * by) + across * (side * 0.88));
  vGA = vec4(by, aR.z, 2. * side, bow); vWP = p; vGlow = glow + contactLight; vWet = wet; vPatch = aR.y;
  // last season's blades still standing: a few everywhere, more in some tufts, many along the tread
  vDry = step(deadRoll, 0.05 + 0.3 * tuft * tuft * tuft + 0.24 * edge);
  // Pigment belongs to the whole blade. The folded normal and glints still resolve per pixel.
  vec4 stand = meadowStand(aG.xy);
  vec3 tip = stand.rgb * (0.86+0.20*tuft+0.08*aR.y);
  float young = smoothstep(0.83,0.98,tuft)*smoothstep(0.05,0.50,tip.r-tip.g);
  tip = mix(tip,mix(LEAF,NEW_GROWTH,0.63),young);
  tip = mix(tip, mix(NEW_GROWTH * vec3(0.98,0.78,0.67), tip*0.5+vec3(0.2,0.16,0.11),0.38), vDry);
  vGrassColour = vec4(tip,0.76*stand.a+0.24*tuft);
  vAir = airAt(p);
  gl_Position = project(p);
#endif
}`;
const grassHeader = WORLD_VS + BRUSH_VS + clumpGLSL + grassDefines + (!TEST ? bladeStateGLSL : '');
const GRASS = program(grassHeader + meadowLodGLSL + valleyAir + floraPalette + bladeVertex,
(GRASS_LAB ? '#define GRASS_LAB\n' : '') + `
#ifdef GRASS_LAB
in float vContact;
#endif
centroid in vec3 vWP; centroid in vec4 vGA; centroid in float vGlow; centroid in float vWet; centroid in vec3 vN; centroid in float vPatch;
centroid in float vDry; flat in vec4 vGrassColour; centroid in vec4 vAir; out vec4 o;
void main(){
  // Grass is drawn only in the main opaque pass. Keeping this shader opaque
  // lets tiled GPUs reject overlapping blades before evaluating their light.
  float y = clamp(vGA.x, 0., 1.);
  vec3 tip = vGrassColour.rgb;
  float rose = smoothstep(0.04,0.40,tip.r-tip.g);
  // A little warm, papery tissue at the soil line grounds both pink and green clumps.
  vec3 sheath = vec3(0.113,0.084,0.045) + tip*mix(0.16,0.065,rose);
  tip += vec3(0.060,0.042,0.030)*rose*y*y;
  vec3 gc = mix(sheath, tip * (0.63 + 0.31*y), smoothstep(0.,0.76,y));
  float pn = vGrassColour.a;
  gc *= mix(0.8, 1.2, pn);
  gc = mix(gc, tip, smoothstep(0.55, 0.95, pn) * 0.2 * y);
  float rootShade = mix(0.72, 1., smoothstep(0.,0.48,y));
  gc *= (0.89 + 0.22*vGA.y) * rootShade * (1.-0.37*vWet);
  // The central fold stays visible up close and blends out across subpixel blades.
  float footprint = max(fwidth(vGA.z), 0.012);
  float rib = (1. - smoothstep(0.035, 0.12 + footprint, abs(vGA.z))) * (1. - smoothstep(0.17, 0.72, footprint));
  float margin = smoothstep(0.62, 1., abs(vGA.z))*(1.-smoothstep(0.30,0.90,footprint));
  gc *= 1. + (0.24*rib + 0.11*margin) * smoothstep(0.05, 0.36, y);
  vec3 sunlight=uSunCol*directLight(vWP);
  vec3 lit = floraLight(gc,vWP,normalize(vN),normalize(uCam-vWP),y,0.12*(1.-vDry),sunlight);
  if (vGlow > 0. && uNight > 0.) {
    // The root samples the field once for the bent shoot. Its sheath stays dark
    // while the soft blade and folded midrib briefly show their colony's pigment.
    float response = vGlow/(0.072+vGlow);
    float tissue = smoothstep(0.07,0.41,y) * (0.36 + 0.52*rib + 0.21*y);
    vec3 sap = mix(vec3(0.13,0.67,0.42),vec3(0.75,0.27,0.48),rose);
    lit += sap*tissue*response*uNight*(1.-vDry)*(0.70+0.30*vPatch);
  }
  // a wet blade is a mirror: the sun glints along its fold and the sky shows in its face
  if (vWet > 0.03) {
    vec3 V = normalize(uCam - vWP), Nw = normalize(vN);
    if (dot(Nw, V) < 0.) Nw = -Nw;
    float fres = 0.04 + 0.96 * pow(1. - max(dot(Nw, V), 0.), 5.);
    float glint = pow(max(dot(Nw, normalize(uSunDir + V)), 0.), 80.);
    vec3 reflected = reflect(-V, Nw);
    float openSky = smoothstep(0.04,0.66,reflected.y);
    float film = smoothstep(0.03,0.60,vWet)*smoothstep(0.12,0.55,y)*(0.58+0.42*vPatch);
    lit += film * (sunlight * glint * 0.57
         + ambient(reflected) * openSky * (0.045 + 0.53*fres));
  }
  // Sky reflection on the exposed blade faces follows the crest across the stand.
  lit += tip * ambient(normalize(vN)) * (0.72 * max(vGA.w, 0.) * y * (1. - uNight));
#ifdef GRASS_LAB
  lit = mix(lit, vec3(0.14, 0.92, 0.72), max(0.,vContact));
  lit = mix(lit, vec3(1., 0.55, 0.10), max(0.,-vContact));
#endif
  o = vec4(tonemap(lit*vAir.a + vAir.rgb), 0.);
}`);

const solveBlades = TEST ? null : program(grassHeader + '#define SOLVE_BLADE\n' + contactGLSL + solveGLSL + bladeVertex, knotsFragment);
const stampBlades = TEST ? null : program(grassHeader + '#define STAMP_BLADE\n' + contactGLSL + stampGLSL + bladeVertex, stampFragment);

// understory: one parametric strip shared by the meadow species. Rosettes (blush leaves with a living midrib), ferns (fronds cut into
// leaflets in the fragment shader), glow tubes (capsules whose tips are lamps), coilferns (stalks that roll their tips
// into spirals) and lantern bells (arching stems that nod a glowing bulb). Each blade follows a centreline in its own
// plane; veins brighten at night and when you stir the ground beside them.
const PLANT = GRASS_LAB ? null : program(WORLD_VS + BRUSH_VS + `
uniform float uNight;
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
    // Run one half-strip up to the pointed tip and the other back down.
    // The same 25 vertices now resolve the cupped midrib at every section.
    int row = (vid <= 12 ? vid : 24-vid) / 2;
    u = row == 0 ? 0. : 0.24+0.76*float(row-1)/5.;
    side = vid < 12 ? float(vid % 2)-1. : vid == 12 ? 0. : 1.-float(vid % 2);
    float blade = clamp((u-0.24)/0.76,0.,1.);
    float belly = pow(max(0.,sin(3.14159*pow(blade,0.77))),0.79);
    float width = W*(0.043*(1.-blade)+belly*(1.-0.22*blade));
    float fold = (0.36+0.24*seed)*belly;
    vec3 along = normalize(dir + sd*(seed-0.5)*blade*0.8);
    vec3 across = normalize(sd + up*(seed-0.48)*0.9*blade);
    vec3 tangent = along*(0.11 + (u >= 0.24 ? aS2.x/0.76 : 0.))
      + up*(aS2.y + 3.14159*aS2.z*cos(u*3.14159) - 1.12*blade/0.76);
    vec3 upper = normalize(cross(across,tangent));
    vec3 p = along*L*(0.11*u+aS2.x*blade) + up*L*(aS2.y*u+aS2.z*sin(u*3.14159)-0.56*blade*blade)
      + width*(across*side + upper*fold*abs(side));
    float gust = windWave(aP.xz+along.xz*blade*L)*uWind;
    p.xz += WIND_DIR * gust * L * 0.30*u*u;
    p += brushBend(aP.xyz+up*L*0.48)*L*0.57*u*u;
    vN = normalize(upper - across*side*fold);
    vWP=p+aP.xyz; vU=u; vSide=side; vType=type; vSeed=seed; vHue=aS2.w;
    vStir = uNight > 0. ? textureLod(uGlow,fieldUV(aP.xz),0.).r : 0.;
    gl_Position = project(vWP); return;
  }
  vec2 c = path(type, u, L, aS2), t2 = normalize(path(type, min(u + 0.01, 1.), L, aS2) - path(type, max(u - 0.01, 0.), L, aS2));
  vec3 p = dir * c.x + up * c.y;
  float flex = type > 1.5 && type < 2.5 ? 0.3 : 1.;
  vec3 bend = brushBend(aP.xyz + L * (up * 0.40 + dir * (type < 1.5 ? 0.48 : 0.))) * flex;
  p += bend * (0.62 * L * u * u);
  float flutter = type > 4.5 ? 0.12 : 1.;
  float load = windWave(aP.xz + dir.xz*c.x*flutter)*uWind;
  vec3 windBend = vec3(WIND_DIR.x,-0.16*abs(load),WIND_DIR.y) * (0.34*load)
                + sd * (0.046*load*flutter*tipFlutter(aP.xz,uWindFrame.x,seed));
  p += windBend * (u*u*L*flex);
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
  vec3 tang = normalize(dir * t2.x + up * t2.y + (1.24*bend + 2.*flex*windBend) * u);
  vN = normalize(normalize(cross(wdir, tang)) + wdir * side * (type > 1.5 ? 1.6 : 0.7));
  vStir = uNight > 0. ? textureLod(uGlow,fieldUV(aP.xz),0.).r : 0.;
  vWP = p + aP.xyz; vU = u; vSide = side; vType = type; vSeed = seed; vHue = type > 4.5 ? aS2.w : fract(aP.x * 0.21 + aP.z * 0.17);
  gl_Position = project(vWP);
}`,
`uniform float uClip; centroid in vec3 vWP; centroid in float vU; centroid in float vSide; centroid in vec3 vN; centroid in float vType; centroid in float vStir; centroid in float vSeed; centroid in float vHue; out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  float u = clamp(vU, 0., 1.), s = clamp(vSide, -1., 1.);
  if (vType > 0.5 && vType < 1.5 && abs(s) > 0.16 + 0.84 * smoothstep(0.1, 0.65, abs(sin(u * 3.1416 * 15.)))) discard;
  // each species is a pigment and a vein; the ramp and the light are everyone's
  vec3 tip = understoryPigment(vType, vHue);
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
    float feather=abs(sin(3.14159*(u*10.-0.52*abs(s)+vSeed)));
    if(abs(s)>0.20+0.80*smoothstep(0.16,0.71,feather)) discard;
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
    gc = tip * (0.24 + 0.38 * u + 0.13 * veins + 0.18 * rim);
    gc *= (0.70 + 0.30 * striae) * (0.75 + 0.25 * abs(s));
  } else if (vType < 0.5) {
    gc = mix(LEAF * 0.24, tip * (0.66 + 0.30 * u), smoothstep(0.02,0.46,u)) * (0.92 + veins * 0.18);
  } else gc *= 0.86 + veins * 0.25;
  vec3 lit = floraLight(gc, vWP, normalize(vN), normalize(uCam - vWP), u, 0.04, uSunCol*directLight(vWP));
  if (uNight > 0.10) {
    float night = smoothstep(0.10, 0.94, uNight);
    float breath = 0.92 + 0.08 * sin(uTime * 0.74 + vHue * 11. - 3.2 * u);
    float stir = vStir / (0.09 + vStir);
    vec3 sap = mix(tip,vec3(0.17,0.71,0.43),0.30);
    lit += night * tissue * (tip * breath * 0.56 + sap * (1.64 * stir));
  }
  o = vec4(tonemap(fogged(lit, vWP)), 0.);
}`);

const cascade = createWaterfall(gl,program,WORLD_VS,vao);
const waterVertex = WORLD_VS + `
layout(location=0) in vec2 aXZ;
layout(location=1) in vec3 aWater;
layout(location=2) in vec2 aBedSlope; out vec3 vWP; out float vDepth, vWave, vFlow, vGust; out vec2 vBedSlope;
void main(){
  vGust=max(0.,windWave(aXZ)*uWind); vBedSlope=aBedSlope;
  vWave = waterWave(aXZ, uTime).x + waterCrests(aXZ, aWater.y, aBedSlope, uTime, vGust).x + surfaceAt(aXZ).x;
  vWP = vec3(aXZ.x, aWater.x + vWave, aXZ.y); vDepth = aWater.y; vFlow = aWater.z; gl_Position = project(vWP);
}`;
const waterFragment = plungeGLSL + `uniform sampler2D uRefl, uUnder; uniform vec2 uRes, uRightXZ; uniform float uMirrorLevel;
in vec3 vWP; in float vDepth, vWave, vFlow, vGust; in vec2 vBedSlope; out vec4 o;
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
vec2 waveGrad(vec2 p, float pixelMetres, float clearLake){
  vec2 g = waterWave(p, uTime).yz;
  // Cross-winds shear the small surface trains into short, uneven crests.
  float shear = vnoise(p*0.31 + vec2(-0.12,0.09)*uTime) - 0.5;
  // Sheltered water seen at a grazing angle resolves broad swells. Let the
  // shorter creases soften with their projected footprint between gusts.
  float gusts = smoothstep(0.17, 1.3, vGust);
  float shortWave = 1.-0.84*clearLake*(1.-gusts)*smoothstep(0.012,0.12,pixelMetres);
  g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 1.3 + uTime * 1.1 + shear*2.6) * (0.016*shortWave);
  g += vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 2.1 + uTime * 1.6 - shear*2.1) * (0.010*shortWave);
  g += vec2(0.2, -0.98) * cos(dot(p, vec2(0.2, -0.98)) * 3.7 + uTime * 2.2 + shear*3.3) * (0.006*shortWave);
  g += vec2(-0.9, -0.3) * cos(dot(p, vec2(-0.9, -0.3)) * 6.3 + uTime * 3.1 - shear*4.2) * (0.004*shortWave);
  // wind gust patches ("cat's paws"): the same rolling waves that move the grass roughen the water as they pass
  float capillary = 1. - smoothstep(0.15, 0.49, pixelMetres);
  if (gusts * capillary > 0.) {
    g += WIND_DIR * cos(dot(p, WIND_DIR) * 9. - uTime * 5.3 + vnoise(p * 0.8) * 3.) * 0.048 * gusts * capillary;
    g += vec2(-WIND_DIR.y, WIND_DIR.x) * cos(dot(p, vec2(-WIND_DIR.y, WIND_DIR.x)) * 13. + uTime * 6.1) * 0.012 * gusts * capillary;
  }
  return g;
}
void main(){
  float depth = vDepth + vWave;
  if (depth <= -0.02) discard; // Dry beach has zero water coverage.
  vec2 p = vWP.xz;
  float level = vWP.y - vWave;
  if (p.y > ${falls.lip-0.5} && p.y < ${falls.lip+0.95}
      && level > ${(riverLevel(falls.lip+falls.reach)+0.03).toFixed(3)} && level < ${(riverLevel(falls.lip)-0.035).toFixed(3)}) discard;
  float stream = vFlow;
  float pixelMetres = max(length(dFdx(p)), length(dFdy(p)));
  vec2 rain = vec2(0.);
  if (uStorm > 0.005 && pixelMetres < 0.065)
    rain = rainSlope(p, pixelMetres) * (1. - smoothstep(0.025, 0.065, pixelMetres));
  vec4 disturbance = surfaceAt(p);
  vec4 front=waterCrests(p,vDepth,vBedSlope,uTime,vGust);
  float clearLake = (1.-uNight)*(1.-uStorm)*(1.-stream);
  vec2 g = waveGrad(p, pixelMetres, clearLake) + rain + disturbance.yz + front.yz;
  // This cross-stream coordinate follows the same bends as the wet grid.
  vec2 downstream = normalize(vec2(0.442*cos(p.y*0.13)+0.406*cos(p.y*0.29+0.8),1.));
  float currentCap=0.;
  if (stream>0.) {
    float bendX=-5.+3.4*sin(p.y*0.13)+1.4*sin(p.y*0.29+0.8);
    float lane=p.x-mix(bendX,-18.,smoothstep(66.,100.,-p.y));
    float flow=p.y*3.3-uTime*2.2+vnoise(vec2(lane*1.3,p.y*1.3-uTime*0.78))*3.8;
    g+=stream*(downstream*0.028*cos(flow)+vec2(downstream.y,-downstream.x)*0.012*sin(flow*0.71));
    currentCap=0.065*stream*smoothstep(0.84,1.,sin(flow));
  }
  vec2 fineWake=vec2(0.);
#ifdef SWIM_WAKE
  fineWake=swimmerSlope(p,
    downstream*stream*(.24+.64*smoothstep(.02,.57,depth))+WIND_DIR*.085*clamp(vGust,0.,1.7),level,pixelMetres);
  fineWake*=smoothstep(.012,.075,depth);
#endif
  g+=fineWake;
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
    if (ray.y > 0.) sky = cloudLight(sky, sky, ray, cloudColumn(vWP, ray));
    refl = mix(tonemap(sky), refl, planar);
  }

  // The ray bends toward the normal as it enters the lake (air/water index ratio 0.75).
  // Its vertical component gives the distance to the bed even when the eye skims the bank.
  float cosWater = sqrt(0.4375 + 0.5625 * NdV * NdV);
  float rayDown = 0.75 * V.y + (cosWater - 0.75 * NdV) * N.y;
  float path = max(0., depth) / max(0.25, rayDown);
  float through = exp(-path * (mix(0.53, 0.69, stream) - 0.16*clearLake));
  float absorb = 1. - through;
  // Red light dies out fastest. T*(1-loss*(1-T)) blends one and two absorption
  // lengths per channel using one exponential. Scattering takes the complementary share.
  vec3 loss = vec3(0.78, 0., 0.16) + clearLake*vec3(0.21,0.,-0.15);
  float scatter = (1. - F) * absorb;
  // The shoal returns more blue-green light from suspended minerals. The
  // shallower it gets, the more of the actual sand and stones show through.
  vec3 shoal = vec3(0.046, 0.255, 0.184) + clearLake*vec3(-0.008,0.072,0.138);
  vec3 basin = vec3(0.008, 0.077, 0.117) + clearLake*vec3(-0.001,0.024,0.029);
  vec3 body = mix(shoal, basin, absorb) * (1. + loss * through);
  float sun = directLight(vWP);
  body *= ambient(N) * 2.8 + uSunCol * sun * (0.12 + 0.14 * max(uSunDir.y, 0.));
  if (uNight > 0. && disturbance.a > 0.) {
    // Light within the stirred water shifts underneath the surface as the eye
    // moves. Sample halfway through the upper 32 cm, or the shallows above the bed.
    vec2 rayXZ = -0.75*V.xz - (cosWater - 0.75*NdV)*N.xz;
    float column = min(depth,0.32);
    float charge = surfaceAt(p + rayXZ*(0.5*column / max(0.25,rayDown))).a;
    float scatterLight = planktonLight(charge) * (disturbance.a/(0.025+disturbance.a));
    body += vec3(0.067,0.39,0.29)*scatterLight*uNight*uNight;
  }
  float alpha = F + scatter;
  vec3 col = (F * refl + scatter * tonemap(fogged(body, vWP))) / max(alpha, 0.022);
  vec3 Hh = normalize(uSunDir + V);
  // Unresolved ripples spread the same reflected sunlight across a wider lobe.
  float roughWater = clamp(vGust*0.38 + uStorm*0.46 + pixelMetres*2.4, 0., 1.);
  float gloss = mix(610., 185., roughWater);
  float sunGlint = pow(clamp(dot(N, Hh), 0., 1.), gloss) * (gloss * 0.0069);
  col += tonemap(uSunCol * sun * sunGlint * F) * (1. - 0.85 * uNight);

  // A tilted crest reflects a brighter or darker part of the overcast sky.
  if (uStorm > 0.005) {
    vec2 skyDirection = uSunDir.xz - 0.45*V.xz;
    float tilt = dot(rain, skyDirection);
    col += tilt * (0.70 + 0.45*NdV) * (0.39*refl + 0.71*ambient(vec3(0.,1.,0.)));
  }
  float steepness=length(disturbance.yz);
  // The two faces of a short ripple catch different parts of the sky. This
  // still reads at a steep chase-camera angle looking into dark water.
  vec2 skySlope=normalize(uSunDir.xz-0.56*V.xz+vec2(0.001,0.));
  float tilt=dot(disturbance.yz+fineWake,skySlope);
  float skylight=1.-0.91*uNight, face=max(0.,tilt);
  col*=1.-0.29*skylight*smoothstep(0.,0.20,-tilt);
  col+=(0.19*refl+0.23*col+vec3(0.037,0.054,0.057))*(face/(face+0.15))*skylight;
  float splashCap=smoothstep(0.015,0.073,disturbance.x)*smoothstep(0.067,0.30,steepness);
  float cap=min(1.,front.w+0.58*splashCap);
  float swash=(1.-smoothstep(0.024,0.16,abs(depth-0.041)))*(0.045+0.61*front.w);
  float whitewater=plungeFoam(p,uTime)*smoothstep(0.,0.23,depth);
  // Residual bubbles follow the same advected contact field as the plankton.
  // They break up along wave faces and lose their white tips as the water settles.
  float churn=(1.-uNight)*smoothstep(0.05,0.57,disturbance.a)*(0.24+0.76*smoothstep(0.010,0.107,steepness));
  // Deep, undisturbed water has no foam. Only evaluate the noise bands
  // whose amplitude can contribute to this fragment.
  float breaker=0., foam=0., wash=0.;
  if (cap>0. || currentCap>0. || churn>0.001) {
    wash=vnoise(p*vec2(3.9,2.6)-downstream*uTime*(0.21+0.53*stream));
    if (cap>0.) breaker=cap*smoothstep(0.19,0.80,wash+0.23*(vnoise(15.*p-0.45*uTime)-0.5));
    if (churn>0.001) {
      float flecks=smoothstep(0.51,0.77,vnoise(p*21.+wash*1.6-downstream*uTime*(0.22+stream)));
      foam=churn*(0.10+0.50*flecks);
    }
  }
  float bankFoam=swash+currentCap*smoothstep(0.44,0.74,wash);
  if (bankFoam>0.) foam+=bankFoam*shoreFroth(p);
  foam=min(1.,foam+breaker+whitewater);
  col = mix(col, tonemap(vec3(0.75, 0.82, 0.82) * (ambient(N) * 2.4 + uSunCol * sun * 0.16)), min(1.,foam*0.58+whitewater*0.38+breaker*0.20));
  alpha = min(1., alpha + foam * 0.2);
  // the bed and whatever stands in the water, seen through the surface: bent by the same waves, more as it deepens,
  // and tinted by the water it passes through. At the very edge the true bed shows, unbent.
  vec2 bend = suv - distortion * clamp(depth * 0.25, 0., 0.09) * frame;
  vec3 transmission = 1. - loss * absorb;
  if (uHDR < 0.5) transmission = pow(transmission,vec3(1./2.2));
  vec3 under = texture(uUnder, clamp(bend, 0.002, 0.998)).rgb * transmission;
  vec3 surface = mix(under,col,alpha);
  if (uNight > 0. && disturbance.a > 0.) {
    // Lit plankton remain visible in a trough. Their wave's signed height
    // (metres) and moon-facing slope change the colour and intensity smoothly.
    float charge = disturbance.a;
    float light = planktonLight(charge);
    float lift = 9.*disturbance.x + 0.65*tilt;
    float ridge = 0.5 + 0.5*lift/(0.38+abs(lift));
    vec3 plankton = mix(vec3(0.065,0.30,0.21),vec3(0.20,0.59,0.35),ridge);
    vec3 emission = tonemap(plankton*light*(0.85+3.95*ridge)*uNight*uNight);
    // In the display-encoded fallback, keep headroom for reflected highlights.
    surface += uHDR > 0.5 ? emission : emission*(1.-clamp(surface,0.,1.));
  }
  o = vec4(surface, smoothstep(-0.02, 0.035, depth));
}`;
const WATERP = program(waterVertex, waterFragment);
const WAKE_WATER = program(waterVertex, '#define SWIM_WAKE\n' + swimmerWakeGLSL + waterFragment);

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
  return { ground, pos, nor, heights: hs, heightRange: [low - 0.05, high - low + 0.1] };
}
function terrainFar() {
  const rings = touch ? 150 : 190, sectors = touch ? 320 : 512, stride = sectors + 1, edge = NEAR.half - 0.5;
  const pos = new Float32Array((rings + 1) * stride * 3), packedNormals = new Int16Array((rings + 1) * stride * 4);
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
  const ringRatio = (1500 / innerRadius) ** (1 / rings);
  const bowlRatio = ringRatio ** 3;
  for (let j = 0; j <= rings; j++) {
    const radius = innerRadius * ringRatio ** j;
    const bowlArc = 2 * radius * Math.sin(3 * Math.PI / sectors);
    const bowlRun = radius * (bowlRatio - 1);
    for (let i = 0; i <= sectors; i++) {
      const vertex = j * stride + i;
      const left = 3 * (j * stride + (i + sectors - 1) % sectors), right = 3 * (j * stride + (i + 1) % sectors);
      const inner = 3 * (Math.max(0, j - 1) * stride + i), outer = 3 * (Math.min(rings, j + 1) * stride + i);
      const ax = pos[right] - pos[left], ay = pos[right + 1] - pos[left + 1], az = pos[right + 2] - pos[left + 2];
      const bx = pos[outer] - pos[inner], by = pos[outer + 1] - pos[inner + 1], bz = pos[outer + 2] - pos[inner + 2];
      const nx = ay*bz-az*by, ny = az*bx-ax*bz, nz = ax*by-ay*bx;
      const scale = 32767 / Math.hypot(nx,ny,nz);
      const elevation = pos[vertex*3+1];
      // Sample the neighbouring shoulders for snow collection. A three-cell
      // span measures a gully even when its floor contains small bumps.
      let bowl = 0;
      if (j >= 3 && j <= rings-3) {
        const before = 3*(j*stride+(i+sectors-3)%sectors)+1, after = 3*(j*stride+(i+3)%sectors)+1;
        const along = (pos[before]+pos[after]-2*elevation)/bowlArc;
        const across = ((pos[3*(vertex+3*stride)+1]-elevation)-bowlRatio*(elevation-pos[3*(vertex-3*stride)+1]))/bowlRun;
        bowl = 0.5*(along+across);
      }
      const k = vertex*4;
      packedNormals[k] = Math.round(nx*scale);
      packedNormals[k+1] = Math.round(ny*scale);
      packedNormals[k+2] = Math.round(nz*scale);
      packedNormals[k+3] = Math.round(32767*Math.max(-1,Math.min(1,bowl)));
    }
  }
  return { pos, packedNormals, sectors, ...terrainPatches(pos, sectors, rings, true) };
}
function waterMesh(terrain) {
  const cols = 256, rows = 352, stride = cols + 1, tileCells = 16;
  const x0 = LAKE[0] - 52, z0 = spring.z - 23, w = 101, d = LAKE[1] + 44 - z0;
  const xz = new Float32Array(2 * stride * (rows + 1)), water = new Float32Array(3 * stride * (rows + 1));
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const v = j * stride + i, x = x0 + i * w / cols, z = z0 + j * d / rows, level = waterLevel(x, z);
    xz[v * 2] = x; xz[v * 2 + 1] = z;
    water[v * 3] = level; water[v * 3 + 1] = level - nearH(terrain, x, z); water[v * 3 + 2] = riverFlow(z, level);
  }
  // Bake the gradient of still-water depth once. The renderer uses it to
  // bend waves up a sloping beach without extra terrain reads per pixel.
  const bedSlope = new Float32Array(xz.length);
  for (let j=1; j<rows; j++) for (let i=1; i<cols; i++) {
    const v=j*stride+i, k=3*v+1;
    bedSlope[2*v]=(water[k+3]-water[k-3])*cols/(2*w);
    bedSlope[2*v+1]=(water[k+3*stride]-water[k-3*stride])*rows/(2*d);
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
      width: (endX - i0) * w / cols, depth: (endZ - j0) * d / rows, y0: low - 0.5, y1: high + 0.5, pad: 0 });
  }
  return { xz, water, bedSlope, idx: new Uint32Array(idx), patches };
}
// Each family shares its topology. A stone's seed interpolates two different
// silhouettes before the rigid pose is applied, including in the shadow pass.
const ROCK_STYLES = {
  round: { power: 2.6, squash: 0.79, breaks: 4, bevel: 0.17, reach: 0.79 },
  block: { power: 4.2, squash: 0.91, breaks: 7, bevel: 0.08, reach: 0.61 },
  slab:  { power: 4.8, squash: 0.48, breaks: 5, bevel: 0.05, reach: 0.66 },
  tall:  { power: 3.3, squash: 1.02, breaks: 6, bevel: 0.09, reach: 0.68 },
};
function rockTopology(sub) {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((c) => c / l); });
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
  const around = v.map(() => new Set());
  for (const [a, b, c] of f) {
    around[a].add(b).add(c); around[b].add(a).add(c); around[c].add(a).add(b);
  }
  return {
    vertices: v, faces: f, neighbours: around.map(set => Array.from(set)),
    levels: [f, levels[sub-1], levels[sub-2]].map(level => new Uint16Array(level.flat())),
    refinements: edges.slice(-2),
  };
}
function rockMesh(seed, { vertices, faces, refinements, neighbours }, style) {
  const kind = ROCK_STYLES[style], rr = rng(Math.floor(seed * 100003));
  const lean = (rr() - 0.5) * 0.58, rake = (rr() - 0.5) * 0.47, bedTilt = (rr() - 0.5) * 0.44;
  const planes = Array.from({ length: kind.breaks }, () => {
    const a = rr() * Math.PI * 2, el = (rr() - 0.34) * 1.95;
    return [Math.cos(a)*Math.cos(el), Math.sin(el), Math.sin(a)*Math.cos(el), kind.reach + 0.30*rr()];
  });
  // Worn corners between a few old fracture planes. Both the inclined bedding
  // and the offset shoulders run through the volume, including its outline.
  const pos = vertices.map(([x, y, z]) => {
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
  for (const midpoints of refinements) for (const [a, b, m] of midpoints) {
    if (vertices[m][1] < -0.10) pos[m] = pos[a].map((x, j) => 0.5 * (x + pos[b][j]));
  }
  const nor = pos.map(() => [0, 0, 0]);
  for (const [a, b, c] of faces) {
    const A = pos[a], B = pos[b], C = pos[c];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const q of [a, b, c]) { nor[q][0] += n[0]; nor[q][1] += n[1]; nor[q][2] += n[2]; }
  }
  // Curvature from each vertex to the middle of its neighbours, along the normal: hollows positive, edges negative.
  // It rides in the normal's length (1 + 0.45 c), so the shader gets worn edges and dark crevices for nothing.
  const unit = nor.map(n => { const length = Math.hypot(...n) || 1; return n.map(v => v / length); });
  const curvature = pos.map((p, i) => {
    let mx = 0, my = 0, mz = 0, reach = 0;
    for (const j of neighbours[i]) { mx += pos[j][0]; my += pos[j][1]; mz += pos[j][2]; reach += Math.hypot(pos[j][0] - p[0], pos[j][1] - p[1], pos[j][2] - p[2]); }
    const n = neighbours[i].length, d = [mx / n - p[0], my / n - p[1], mz / n - p[2]];
    return Math.max(-1, Math.min(1, 6 * (d[0] * unit[i][0] + d[1] * unit[i][1] + d[2] * unit[i][2]) / (reach / n || 1)));
  });
  let cumulative = 0;
  const errors = refinements.slice().reverse().map(midpoints => {
    let error = 0;
    for (const [a, b, m] of midpoints) {
      const delta = pos[m].map((c, i) => c - (pos[a][i] + pos[b][i]) / 2);
      error = Math.max(error, Math.hypot(...delta));
    }
    cumulative += error;
    return cumulative;
  });
  return { pos: new Float32Array(pos.flat()), nor: new Float32Array(unit.map((n, i) => n.map(v => v * (1 + 0.45 * curvature[i]))).flat()),
    errors };
}
function rockSet(topology, shapes) {
  const meshes = shapes.map(([seed, style]) => rockMesh(seed, topology, style));
  return { pos: meshes.map(m => m.pos), nor: meshes.map(m => m.nor), levels: topology.levels,
    errors: meshes[0].errors.map((_, i) => Math.max(...meshes.map(m => m.errors[i]))) };
}
// ---------------------------------------------------------------- scatter
// terrain height and slope from the near mesh (fast, for a million blades)
function nearH(near, x, z) {
  const { S } = NEAR, fx = Math.min(S - 1e-6, Math.max(0, terrainCoord(x))), fz = Math.min(S - 1e-6, Math.max(0, terrainCoord(z)));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j;
  const stride = S + 1, k = j * stride + i, P = near.heights;
  const right = P[k + 1], up = P[k + stride];
  if (u + w <= 1) return P[k] * (1 - u - w) + right * u + up * w;
  return P[k + stride + 1] * (u + w - 1) + right * (1 - w) + up * (1 - u);
}
function nearNy(near, x, z) {
  const { S } = NEAR, i = Math.min(S, Math.max(0, Math.round(terrainCoord(x)))), j = Math.min(S, Math.max(0, Math.round(terrainCoord(z))));
  return near.nor[(j * (S + 1) + i) * 3 + 1];
}
// Blades per square metre in a full stand. bakeMeadow thins distant tiles.
const GRASS_DENSITY = touch ? 70 : TEST ? 64 : 150;
const START = GRASS_LAB ? [PLOT.x-1.8, PLOT.z+2.5] : [8, 30], SHORE_CAM = [19, 26];
function southLanding(x,z) {
  return GRASS_LAB ? 0 : 1-sm(0.20,1.35,((x-11)/15)**2+((z-28)/8)**2);
}
const clearOf = (x, z, level=waterLevel(x,z), ground) => (!GRASS_LAB || plotDistance(x, z) >= 7.8) && trailCover(x, z) < 0.02 && (level === 0 || (ground ?? H(x,z)) > level + 0.2) && Math.hypot(x - START[0], z - START[1]) > 3.5 && Math.hypot(x - SHORE_CAM[0], z - SHORE_CAM[1]) > 3.5;
const inMap = (x, z, m = 2) => Math.abs(x) < WORLD_HALF - m && Math.abs(z) < WORLD_HALF - m;

function besideWalk(points, rand, inner = 1.8, width = 2.2) {
  const i = Math.floor(rand() * (points.length - 1)), [x, z] = points[i];
  const dx = points[i + 1][0] - x, dz = points[i + 1][1] - z, along = rand();
  const offset = (rand() < 0.5 ? -1 : 1) * (inner + width * rand()) / Math.hypot(dx, dz);
  return [x + dx * along - dz * offset, z + dz * along + dx * offset];
}

function scatter(near, fixed, meshes) {
  // rocks: clusters with one big stone each, a broken field on the outcrop, low erratics on the rim, stones
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
    // Keep the sightline from the rose meadow to the golden crown open.
    if (v === 2 && Math.hypot(x - 26, z - 44) < 3) return;
    if (v !== 3 && (trailDistance(x,z) < 0.85+1.2*reach || inRestArea(x,z,reach))) return;
    const iz = z - ISLET[1], ix = x - ISLET[0] + 0.21*iz;
    if (Math.hypot(ix/ISLET_WIDTH, iz/ISLET_DEPTH) < 1.28 + reach/ISLET_DEPTH) return;
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
    add(2, x, z, 1.45*w, w*(0.53+0.17*r()), w*(0.95+0.3*r()));
  }

  for (let q = 0; q < 26; q++) {
    let x, z, k = 0;
    do { x = LAKE[0] + (r() * 2 - 1) * 30; z = LAKE[1] + (r() * 2 - 1) * 24; k++; } while ((lakeD(x, z) < 8.6 || lakeD(x, z) > 10.6) && k < 60);
    const s0 = 0.4 + r() * 0.9; add(q % 2, x, z, s0, s0 * 0.8, s0 * 1.1);
  }
  // Part of the valley gravel collects in shallow bars a few metres
  // offshore. Reserve those stones from the same small-rock budget.
  const shoals = [[14.5,20.5],[0.1,20.3],[-9.4,28.0],[-27.8,21.2],[-22.9,3.5],[-16.5,-12.8],[12.1,-1.4]];
  const barStones = 24, looseStones = (touch ? 900 : 1600) - shoals.length*barStones;
  for (let q = 0; q < looseStones; q++) {
    let x, z, k = 0;
    if (q < 1000) do { x = LAKE[0] + (r() * 2 - 1) * 34; z = LAKE[1] + (r() * 2 - 1) * 28; k++; } while ((lakeD(x, z) < 9.6 || lakeD(x, z) > 12.4) && k < 60);
    else { x = (r() * 2 - 1) * (VALLEY_HALF - 2); z = (r() * 2 - 1) * (VALLEY_HALF - 2); }
    const s0 = 0.04 + Math.pow(r(), 2) * 0.18; add(3, x, z, s0, s0 * 0.7, s0 * (0.8 + 0.4 * r()));
  }
  const barRand = rng(36158);
  for (const [cx,cz] of shoals) {
    const gx=groundAt(cx+0.5,cz)-groundAt(cx-0.5,cz), gz=groundAt(cx,cz+0.5)-groundAt(cx,cz-0.5);
    const grade=Math.max(0.001,Math.hypot(gx,gz)), tx=gz/grade, tz=-gx/grade;
    for (let i=0;i<barStones;i++) {
      const along=2*barRand()-1, across=(barRand()-barRand())*(1.55-0.75*Math.abs(along));
      const x=cx+3.7*along*tx-across*tz, z=cz+3.7*along*tz+across*tx;
      // Larger flakes at the heart of the bar give way to grit at its ends.
      // Keep the top below the trough of the swell even at the shallow margin.
      const size=0.075+0.46*barRand()**2*(1.-0.62*Math.abs(along));
      if (-groundAt(x,z)<0.12+0.82*size) continue;
      add(3,x,z,size,0.33*size,0.82*size,barRand);
    }
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

  // The embedded outcrop below supplies the lip. Rounded stones collect farther down the pool.
  const ledgeRand=rng(17631);
  for (const [side,dz,rx,ry,rz] of [
    [-1.73,4.5,0.71,0.74,0.88], [2.10,5.35,0.80,0.54,0.90],
  ]) {
    const z=falls.lip+dz;
    add(1,riverX(z)+side,z,rx,ry,rz,ledgeRand);
  }
  // Shingle accumulates in tongues along the wash line. Leave bare seams of
  // wet sand between bars, and the centre of the landing pool free for the fox.
  const poolGravel=rng(714931);
  for (const [along,side] of [[2.9,-1],[4.4,1],[6.1,-1],[8.6,1],[10.2,1]]) {
    for (let i=0; i<(touch?13:23); i++) {
      const z=falls.lip+along+1.42*(poolGravel()-poolGravel());
      const x=riverX(z)+side*(2.63+1.12*(poolGravel()-poolGravel()));
      const r=0.055+0.28*poolGravel()**2;
      add(3,x,z,r,0.39*r,(0.94+0.58*poolGravel())*r,poolGravel);
    }
  }
  // Common trees, saplings and a few old giants with space for their low branches.
  r = rng(2628268434); // The forest has its own seed, independent of the shoreline.
  const trees = [];
  // Preserve the established planting seed across local river excavations.
  const plantingGrade=(x,z)=>H(x,z,0,false);
  const ground = (x, z) => { const y = plantingGrade(x,z);
    const slope=Math.hypot(plantingGrade(x+0.15,z)-plantingGrade(x-0.15,z),plantingGrade(x,z+0.15)-plantingGrade(x,z-0.15));
    return y > 0.3 && y < 11 && 0.30/Math.hypot(0.30,slope) > 0.84 && lakeD(x, z) > 12.3 && clearOf(x,z,waterLevel(x,z,false),y) && Math.hypot(x - START[0], z - START[1]) > 7 && Math.hypot(x - SHORE_CAM[0], z - SHORE_CAM[1]) > 7 && inMap(x, z, 4) && outcrop(x, z) < 0.5; };
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
  // Fill out the skirts of established groves. Seed this pass independently
  // so the old clearings, specimen trees and shoreline keep their landmarks.
  const groveRand = rng(72051), existing = trees.length;
  let recruits = 0;
  for (let t = 0; t < 4500 && recruits < 100; t++) {
    const parent = 5 * Math.floor(groveRand() * existing / 5);
    if (trees[parent+4] < 3.0) continue;
    const angle = groveRand()*Math.PI*2, reach = 3.6 + groveRand()*5.8;
    const x = trees[parent]+Math.cos(angle)*reach, z = trees[parent+2]+Math.sin(angle)*reach;
    if (!ground(x,z) || !room(x,z,2.75) || trailDistance(x,z)<2.8) continue;
    const h = 2.8 + 4.1*groveRand()**1.4;
    trees.push(x,nearH(near,x,z)-0.06,z,groveRand(),h);
    recruits++;
  }
  // Ground surviving trees on the rendered terrain. Excavation can leave a
  // formerly dry trunk site underwater, including outside the plunge pool.
  for (let i=trees.length-5;i>=0;i-=5) {
    const x=trees[i], z=trees[i+2];
    if (nearH(near,x,z)<waterLevel(x,z)+0.09) trees.splice(i,5);
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
  // Adjacent weathered blocks belong to one outcrop. Their crowns follow the
  // bank, and their bases extend into the lower substrate around each toe.
  for (const [lane, run, sx, thickness, sz, yaw, tint] of [
    [-2.18,-0.43, 0.88,0.92,1.00, 0.67,0.28], [-3.31,0.59, 1.24,1.20,1.12, 2.67,0.12],
    [-2.04,0.83, 0.71,1.16,0.85, 0.21,0.32], [-2.27,1.67, 0.86,0.98,0.76, 0.94,0.06],
    [-2.96,2.37, 0.96,0.80,0.83, 1.92,0.27], [-3.84,3.49, 0.65,0.55,0.81, 1.27,0.40],
    [2.34,-0.75, 0.89,0.99,0.96, 2.12,0.24], [3.44,0.57, 1.08,1.06,1.16, 0.96,0.10],
    [2.24,0.51, 0.85,1.39,0.89, 1.78,0.26], [2.05,1.41, 0.73,1.12,0.85, 2.55,0.14],
    [3.08,1.64, 0.95,1.38,1.16, 0.78,0.29], [2.51,2.54, 0.91,0.83,0.83, 1.14,0.04],
    [3.61,3.12, 1.04,0.79,0.95, 2.94,0.21], [3.91,4.04, 0.74,0.60,0.70, 0.52,0.45],
  ]) {
    const z = falls.lip + run, x = riverX(z) + lane;
    const ground = groundAt(x,z);
    let toe = ground;
    for (let i=0; i<12; i++) {
      const a=i*Math.PI/6;
      const dx=0.78*sx*Math.cos(a), dz=0.78*sz*Math.sin(a);
      toe=Math.min(toe,groundAt(x+dx*Math.cos(yaw)-dz*Math.sin(yaw),z+dx*Math.sin(yaw)+dz*Math.cos(yaw)));
    }
    const sy=Math.min(1.78,thickness+0.58*(ground-toe));
    const y=Math.min(ground-0.27*sy,toe+0.035*sy);
    const footprint = drop(meshes[1], x, z, sx, sy, sz, yaw, tint, { gx: 0, gz: 0 });
    reserve(footprint,true);
    rv[1].push(x, y, z, yaw); rs[1].push(sx, sy, sz, tint);
    beds[1].push(0, 0, -1, waterLevel(x, z));
    const x0 = macro(footprint.x0), x1 = macro(footprint.x1), z1 = macro(footprint.z1);
    for (let j = macro(footprint.z0); j <= z1; j++) fixed.fill(1, j*fixedWidth+x0, j*fixedWidth+x1+1);
  }
  boulders.sort((a,b) => Math.max(b[3],b[5])-Math.max(a[3],a[5]));
  boulders.forEach(place);
  gravel.forEach(place);
  return { rv: rv.map((a) => new Float32Array(a)), rs: rs.map((a) => new Float32Array(a)), beds: beds.map(a => new Float32Array(a)), trees: new Float32Array(trees) };
}

// Spiral crowns grow in small colonies at the margins of groves, treads and water.
function growRosettes(sc, near, leaves) {
  const r = rng(11497);
  const pockets = [[15, 27], [-28, 14], [-5, -39], [-25, -87], [-101, 5], [104, -18], [10, 102]];
  for (let i = 0; i < sc.trees.length; i += 10) pockets.push([sc.trees[i], sc.trees[i + 2]]);
  for (const walk of [trail, ...Object.values(valleyWalks), ...Object.values(rangeWalks)]) {
    for (let i = 1; i < walk.length; i += 3) pockets.push(walk[i]);
  }
  const obstacles = [];
  for (let i = 0; i < sc.trees.length; i += 5)
    obstacles.push([sc.trees[i], sc.trees[i + 2], 0.14 * sc.trees[i + 4], sc.trees[i + 4]]);
  for (let g = 0; g < sc.rv.length; g++) {
    if (g === 3) continue;
    const sites = sc.rv[g], sizes = sc.rs[g];
    for (let i = 0; i < sites.length; i += 4)
      obstacles.push([sites[i], sites[i + 2], Math.max(sizes[i], sizes[i + 2])]);
  }
  for (const [cx, cz] of pockets) {
    const nearby = obstacles.filter(([x, z, radius]) => Math.abs(cx - x) < 7 + radius && Math.abs(cz - z) < 7 + radius);
    const warm = vnoise(cx * 0.06 + 2, cz * 0.06 + 3) > 0.65;
    for (let plant = 0; plant < 3; plant++) {
      const a = r() * 2 * Math.PI, offset = 1.7 + 4.5 * r();
      const x = cx + Math.cos(a) * offset, z = cz + Math.sin(a) * offset;
      const underCrown = nearby.some(([tx,tz,,height]) => height && (x-tx)**2 + (z-tz)**2 < (0.63*height)**2);
      const y = nearH(near, x, z), fullSize = (0.63 + 0.99 * r()) * (plant ? 0.83 : 1.24) * (underCrown ? 1 : 0.47);
      if (!inMap(x, z) || y < waterLevel(x, z) + 0.12 || nearNy(near, x, z) < 0.84 ||
          trailCover(x,z) > 0.12 || trailDistance(x, z) < 1.15 + fullSize || Math.hypot(x - START[0], z - START[1]) < 1.9) continue;
      // Leave room around boulders and tree trunks for every crown to open.
      if (nearby.some(([bx, bz, radius]) => (x - bx) ** 2 + (z - bz) ** 2 < (radius + 0.32 * fullSize) ** 2)) continue;
      const landing = southLanding(x,z), h = fullSize*(1-0.47*landing);
      const seed = r(), spin = r() * 6.2832;
      const hue = landing>0.5 ? 0.87+0.025*seed : warm ? 0.78+0.13*seed : 0.55*seed;
      for (let j = 0; j < 21; j++) {
        // Three neighbouring fans grow from a single clump. Their outer leaves arch over the litter.
        const fan = spin + (j % 3) * 2.39996, rank = Math.floor(j / 3) - 3;
        const young = 1 - Math.abs(rank) / 3, az = fan + rank * 0.41 + 0.18 * r();
        const footX = x + 0.12 * h * Math.cos(fan), footZ = z + 0.12 * h * Math.sin(fan);
        const dx = Math.cos(az), dz = Math.sin(az), stalk = 0.12 * h * (1 - young);
        const length = h * (0.98 - 0.50 * young + 0.24 * r());
        leaves.R.push(footX + dx * stalk, nearH(near, footX, footZ) - 0.045, footZ + dz * stalk, 0.06);
        leaves.D.push(...norm([dx, 0.22 + 1.95 * young * young, dz]), length);
        leaves.M.push(0.26 + 0.15 * r(), 0.17 * (1 - young), length * (0.15 + 0.09 * Math.sin(Math.PI * young) + 0.055 * r()), 0.08 + 0.49 * young + 0.40 * r());
        leaves.B.push(x, z, h, hue);
      }
    }
  }
}
// understory around tree bases and big stones, ferns along the shade and the shore, glow tubes by the water,
// coilferns curling in the shade of the broadleaf groves, and lantern bells nodding along the shore and the meadows
function plantScatter(sc, near, shelterAt) {
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
    const [x, z] = at, y = H(x, z), shelter = sm(0.04,0.41,shelterAt(x,z));
    const scl = (0.7 + r() * 0.8)*(0.54 + 0.46*shelter), n = 9 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) { P.push(x, y - 0.03, z, scl); F.push(i / n * 6.2832 + r() * 0.4, 0.5 + r() * 0.45, 0.11 + r() * 0.05, 0); S2.push(0.55 + r() * 0.25, 0.45, 0.25 + r() * 0.15, 0.45 + r() * 0.25); }
  }
  for (let c = 0; c < 480 * k; c++) {
    const at = place(() => (r() < 0.6 ? nearA(0.8, 3.2) : shoreP(12, 14.5))); if (!at) continue;
    const [x, z] = at, y = H(x, z), shelter = sm(0.04,0.41,shelterAt(x,z));
    const scl = (0.7 + r() * 0.6)*(0.46 + 0.54*shelter), n = 10 + Math.floor(r() * 5);
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
        P.push(x,y-0.025,z,1); F.push(angle,leaf,leaf*(0.10+0.065*ridgeRand()),6);
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
  // Established colonies here hug the exposed bank, including the waxy cups
  // and their filaments. The same size reaches their shadows and light bake.
  for (let i=0; i<P.length; i+=4) P[i+3] *= 1-0.47*southLanding(P[i],P[i+2]);
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
const { near, wm, surface, boulderCells, sc, rocks, forest, leaves, grass, plants, coilView, lanternView, sailwings, wildlife, heightRange } = buildValley();
const far = (() => {
  const mesh=terrainFar(), terrain=uploadTerrain(mesh);
  terrain.trees=uploadRidgeTrees(mesh);
  return terrain;
})();
function uploadRidgeTrees(mesh) {
  const random=rng(40119), sites=[];
  const sectors=mesh.sectors, stride=sectors+1;
  for(let id=0;id+stride+1<mesh.pos.length/3;id++) {
    if(id%stride===sectors || random()>0.22) continue;
    const k=3*id, x=mesh.pos[k], y=mesh.pos[k+1], z=mesh.pos[k+2];
    if(Math.max(Math.abs(x),Math.abs(z))<NEAR.half+8 || Math.hypot(x,z)>520 ||
       y<8 || y>80 || mesh.packedNormals[id*4+1]<21500) continue;
    const grove=vnoise(x*0.044,z*0.044);
    if(grove<0.46 || y>32+42*grove) continue;
    // Barycentric placement on the rendered ring triangle keeps every root grounded.
    let a=random(), b=random();
    if(a+b>1) { a=1-a; b=1-b; }
    for(let j=k;j<k+3;j++) sites.push(mesh.pos[j]+a*(mesh.pos[j+3]-mesh.pos[j])+b*(mesh.pos[j+3*stride]-mesh.pos[j]));
    sites[sites.length-2]-=0.24;
    sites.push(2.4+3.1*random());
  }
  // Two interlocking whorls, each crossed in world space for oblique views.
  const crown=[];
  for(const [base,tip,radius] of [[0,0.76,0.31],[0.33,1,0.23]]) {
    crown.push(-radius,base,0, 0,tip,0, radius,base,0, 0,base,-radius, 0,tip,0, 0,base,radius);
  }
  return {count:sites.length/4,vao:vao([
    {loc:loc(RIDGE_TREES,'aCrown'),size:3,data:Float32Array.from(crown)},
    {loc:loc(RIDGE_TREES,'aSite'),size:4,data:Float32Array.from(sites),div:1}])};
}
function uploadTerrain(mesh) {
  // Placement reads the original valley normals. The GPU only needs 16-bit
  // directions and one signed component for the mountain's hollow or spur.
  const normals = mesh.packedNormals ?? new Int16Array((mesh.pos.length / 3) * 4);
  if (!mesh.packedNormals) {
    for (let i = 0, k = 0; i < mesh.nor.length; i += 3, k += 4) {
      normals[k] = Math.round(32767*mesh.nor[i]);
      normals[k+1] = Math.round(32767*mesh.nor[i+1]);
      normals[k+2] = Math.round(32767*mesh.nor[i+2]);
    }
  }
  const attrs = [{ loc: loc(TERRAIN, 'aPos'), size: 3, data: mesh.pos },
    { loc: loc(TERRAIN, 'aNor'), size: 4, data: normals, type: gl.SHORT, normalized: true }];
  if (mesh.ground) attrs.push({ loc: loc(TERRAIN, 'aGround'), size: 2, data: mesh.ground });
  return { vao: vao(attrs, mesh.idx), count: mesh.fullCount, patches: mesh.patches, drawCounts: mesh.drawCounts, byteOffsets: mesh.byteOffsets };
}
function uploadWater(mesh) {
  const attrs = [{ loc: 0, size: 2, data: mesh.xz }, { loc: 1, size: 3, data: mesh.water },
    { loc: 2, size: 2, data: mesh.bedSlope }];
  return { vao: vao(attrs, mesh.idx), patches: mesh.patches,
    drawCounts: new Int32Array(mesh.patches.length), byteOffsets: new Int32Array(mesh.patches.length) };
}
function buildValley() {
  // Ground arrays are used to place vegetation and flight paths, then live only on the GPU.
  const near = terrainNear();
  const fixed = new Uint8Array((NEAR.S / 2) ** 2);
  const boulder = rockTopology(4), shingle = rockTopology(3);
  const stoneMeshes = [
    rockSet(boulder, [[1.3, 'round'], [5.9, 'block'], [3.3, 'slab']]),
    rockSet(boulder, [[4.1, 'block'], [8.6, 'round'], [6.2, 'slab']]),
    rockSet(boulder, [[7.7, 'tall'], [9.4, 'tall'], [2.8, 'block']]),
    rockSet(shingle, [[2.2, 'round'], [5.1, 'slab'], [7.3, 'block']]),
  ];
  const sc = scatter(near, fixed, stoneMeshes);
  const boulderCells = indexBoulders(sc);
  const surface = createWaterSurface(basinGrid, (x,z,bed) => {
    const level=waterLevel(x,z), depth=level-nearH(near,x,z);
    bed.depth=depth;
    if (depth<=0.013 || rockAt(x,level,z,0,boulderCells)) { bed.depth=0; return; }
    const speed=riverFlow(z,level)*(0.24+0.64*sm(0.02,0.57,depth));
    const tangent=(riverX(z+0.12)-riverX(z-0.12))/0.24;
    bed.level=level; bed.vz=speed/Math.hypot(1,tangent); bed.vx=tangent*bed.vz;
  });
  const rocks = stoneMeshes.map((mesh, k) => rockBatches(mesh, sc.rv[k], sc.rs[k], sc.beds[k]));
  Object.assign(near, terrainPatches(near.pos, NEAR.S, NEAR.S, false, fixed));
  const sx = ISLET[0]-1.15, sz = ISLET[1]+0.55;
  // Wind-pruned crowns break the skyline at the switchbacks. Grow them on
  // the shoulders between treads and keep the steep mineral faces exposed.
  const canopySites = Array.from(sc.trees);
  for (const [x,z,h] of [[-50.2,-25,2.8],[-48.4,-24.6,1.45],[-35.8,-29.2,2.8],[-33.8,-29.8,1.35],
    [-29.2,-27.4,1.95],[-48.4,-16.6,2.4],[-35.8,-12.4,1.65],[-26.8,-19,1.2],[-43,-14.2,1.35]]) {
    const y = nearH(near,x,z);
    if (nearNy(near,x,z) > 0.74 && trailDistance(x,z) > 2.5 && !rockAt(x,y+0.12,z,0.22,boulderCells))
      canopySites.push(x,y,z,vnoise(x*2.31,z*1.14),h);
  }
  const stands = forestStands(canopySites, highSites.instances, [sx,nearH(near,sx,sz)-0.08,sz,5.65,0.7317], vnoise, rng,
    (x,z) => Math.max(Math.abs(x),Math.abs(z)) < NEAR.half ? nearH(near,x,z) : H(x,z));
  const rosettes = { R: [], D: [], M: [], B: [] };
  growRosettes(sc,near,rosettes);
  for (const key of Object.keys(rosettes)) rosettes[key] = new Float32Array(rosettes[key]);
  const leaves = new Tiled(JLEAF, { aR: rosettes.R, aD: rosettes.D, aM: rosettes.M, aB: rosettes.B },
    rosettes.R, i => 2.2*rosettes.D[i*4+3]+0.75, 7, 34, 0.075);
  const shelterAt = bakeCanopy(gl, rosettes, stands, EXTENT);
  const forest = uploadForest(stands);
  const grass = bakeMeadow({ gl, shader: GRASS, half: WORLD_HALF, density: GRASS_LAB ? (touch ? 85 : 150) : GRASS_DENSITY, heightRange: near.heightRange,
    heightAt: (x, z) => nearH(near, x, z), outsideView, rng, touch, contact: !TEST, plot: GRASS_LAB ? PLOT : null,
    habitatAt(x, z, data, i, colours, k) {
      const y = nearH(near, x, z), water = waterLevel(x, z);
      const stand = sm(0.28,0.68,fbm(x*0.035+21,z*0.035-9,3));
      const tuftBed = vnoise(x*0.38,z*0.38);
      const shade = sm(0.10,0.58,shelterAt(x,z));
      const damp = 1-sm(0.12,1.05,y-water);
      const heath = sm(5,17,y)*(1-0.6*shade);
      // The rose bench follows the east hillside. Smaller colonies follow the
      // sheltered west bank and a reach of the upper river. Break up their edges.
      const warp = (stand-0.5)*4, drift = (tuftBed-0.5)*0.22;
      const bench = ((x-19-0.62*(z-36)+warp)/6.8)**2 + ((z-36)/13)**2;
      const fen = ((x+30+warp)/9)**2 + ((z+6)/13)**2;
      const upper = ((x-riverX(z)-6+warp)/5.2)**2 + ((z+46)/12)**2;
      // Wind keeps the south landing cropped. Rose tufts collect in two
      // sheltered pockets; the silvery sedge between them opens onto the islet.
      const landing = southLanding(x,z);
      const westTufts = ((x-4+0.45*(z-31)+0.38*warp)/3.0)**2+((z-31)/5.4)**2;
      const eastTufts = ((x-18-0.64*(z-28)+0.44*warp)/3.1)**2+((z-28)/4.0)**2;
      const pockets = landing*(1-sm(0.05,1.1,Math.min(westTufts,eastTufts)+drift));
      const broadRose = 1-sm(0.30,1.38,Math.min(bench,fen,upper)+drift);
      const rose = GRASS_LAB ? 0 : Math.max(broadRose*(1-0.6*landing),pockets)*(1-0.33*damp);
      writeMeadowColour(colours,k,0.60*stand+0.40*tuftBed,shade,Math.max(damp,0.76*landing),heath,rose);
      if (GRASS_LAB) {
        data[i] = 1;
        data[i+1] = 0.68 + 0.48*(1-sm(PLOT.z-2,PLOT.z+4,z)) + 0.17*tuftBed;
        return;
      }
      const tread = trailCover(x,z);
      if (y < water - 0.12 || tread >= 0.98) return;
      const island = Math.hypot((x-ISLET[0]+0.21*(z-ISLET[1]))/ISLET_WIDTH, (z-ISLET[1])/ISLET_DEPTH);
      if (island < 1.6) {
        data[i] = 0.36*(1-sm(0.43,0.87,island))*sm(0.8,1.6,y);
        data[i+1] = 0.52+0.28*vnoise(x*0.8,z*0.8);
        return;
      }
      const ld = y > -0.38 && y < 0.55 ? lakeD(x, z) : 0;
      if ((ld > 9.7 && ld < 12.6 || water > 0.1) && y-water < 0.44) {
        const nearFalls=Math.abs(z-falls.lip)<4.2 && Math.abs(x-riverX(z))<5.5;
        const shelf=nearFalls ? sm(0.55,0.82,nearNy(near,x,z)) : 1;
        const sedge = sm(0.53,0.83,tuftBed)*sm(-0.10,0.21,y-water)*shelf;
        data[i] = 0.29*sedge*(1-tread);
        data[i+1] = 0.62+1.60*sedge;
        return;
      }
      const edge = Math.max(Math.abs(x), Math.abs(z)), upland = sm(51, 85, edge);
      const moisture = water > 0.02 ? sm(0.04, 0.80, y - water) : 1;
      const grade = nearNy(near, x, z);
      const soil = sm(0.49, 0.79, grade) * (1 - 0.73 * outcrop(x, z));
      const patch = vnoise(x * 0.64 + 7, z * 0.64 - 3);
      const grow = sm(0.13, 0.68, y - water) * (1 - sm(16 + 12 * upland, 25 + 16 * upland, y))
        * soil * (0.81 + 0.32 * patch);
      const mapEdge = 1 - sm(WORLD_HALF - 5 - 10 * stand, WORLD_HALF, edge);
      data[i] = Math.min(1, grow * 1.47) * (0.08 + 0.92 * moisture) * mapEdge * (1-sm(0.12,0.96,tread));
      const distance = trailDistance(x,z);
      data[i + 2] = 1 - sm(0.9,2.7,distance);
      const opening = (1-0.77*shade)*sm(1.1,3.8,distance)*sm(0.58,0.88,grade);
      const short = 0.72 + 0.16*tuftBed;
      const tall = 1.18 + 0.22*tuftBed + 0.11*stand;
      const meadow = Math.max(rose*0.95,opening*(0.46+0.54*stand));
      data[i+1] = (short+(tall-short)*meadow)*(1-0.17*tread)*(1-0.20*heath)*(1-0.58*landing+0.12*pockets);
    },
  });
  const pl = plantScatter(sc, near, shelterAt);
  const plants = GRASS_LAB ? null : new Tiled(PLANT, { aP: pl.P, aF: pl.F, aS2: pl.S2 },
    pl.P, i => 0.2 + 1.8 * pl.P[i * 4 + 3] * pl.F[i * 4 + 1], 25, 24, 0.06);
  const heightRange = bakeGroundLight(gl, EXTENT, (x, z) => nearH(near, x, z), waterLevel, sc, stands, pl);
  bakeFloraSpill(pl);
  const wildlife = TEST || GRASS_LAB ? null : createWildlife(gl, ANIMAL, (x,z) => nearH(near,x,z), outsideView, touch);
  const sailwings = createSailwings({ gl, program, vao, worldVertex: WORLD_VS, groundAt: (x, z) => nearH(near, x, z), waterLevel, riverX, sc, stands, random: rng(971), windAt: (x,z) => wind.sample(x,z)*windStrength(), outsideView });
  const terrain = uploadTerrain(near), wm = uploadWater(waterMesh(near));
  // Resident animals keep sampling these heights after the mesh is uploaded.
  // Release the staging arrays from the object their sampler holds.
  near.pos = near.nor = near.ground = near.idx = null;
  return { surface, boulderCells, near: terrain, wm, heightRange, sailwings, wildlife, sc, rocks,
    forest, leaves, grass, plants, coilView: plantView(pl, 3), lanternView: plantView(pl, 4) };
}
function uploadForest(stands) {
  const site = { loc:loc(CANOPY,'aSite'), size:4, data:stands.sites, div:1 };
  const habit = { loc:loc(CANOPY,'aHabit'), size:4, data:stands.styles, div:1 };
  const slope = { loc:loc(CANOPY,'aSlope'), size:2, data:stands.slopes, div:1 };
  const groups = stands.meshes.map((mesh, variant) => {
    const attrs = [
      { loc:loc(CANOPY,'aPos'), size:3, data:mesh.position },
      { loc:loc(CANOPY,'aNor'), size:3, data:mesh.normal },
      { loc:loc(CANOPY,'aBlade'), size:3, data:mesh.blade },
      { loc:loc(CANOPY,'aStalk'), size:3, data:mesh.stalk },
      { loc:loc(CANOPY,'aGraft'), size:1, data:mesh.graft },
      { loc:loc(CANOPY,'aTissue'), size:1, data:mesh.tissue }, site, habit, slope,
    ];
    gl.bindVertexArray(null);
    const levels = new Uint16Array(mesh.index.length+mesh.skylineIndex.length);
    levels.set(mesh.index); levels.set(mesh.skylineIndex,mesh.index.length);
    const indices = uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, levels);
    const tiles = stands.tiles.filter(tile => tile.variant===variant);
    for (const tile of tiles) tile.vao = vao(attrs,indices,tile.start);
    const count = tiles.reduce((sum,tile) => sum+tile.count, 0);
    return {tiles, count, shoots:count*mesh.foliage.length/4, counts:[mesh.skylineIndex.length,mesh.farCount,mesh.nearCount], offsets:[mesh.index.length*2,mesh.nearCount*2,0]};
  });
  return { groups, fieldTiles:treeFieldTiles(stands.sites,WORLD_HALF,MEADOW_TILE),
    count:stands.sites.length/4, shoots:groups.reduce((sum,group) => sum+group.shoots, 0) };
}
function drawTreeRun(group, firstTile, count, level, shade) {
  if (shade) {
    const glow=glowF.textureCache, ground=groundF.textureCache;
    // A shared mask never divides a draw. A run with any live root samples
    // the original texture, including the one-texel halo at a tile edge.
    const mask=mode===DENSE ? (night>0 ? 3 : 2) : treeFieldMask(forest.fieldTiles,firstTile.start,count,
      night>0 && glow.pages.size ? glow.tileBlocks : null, ground.pages.size ? ground.tileBlocks : null);
    if (mask!==CANOPY.fieldMask) {
      gl.uniform1i(CANOPY.u('uTreeFields'),mask);
      CANOPY.fieldMask=mask;
    }
  }
  gl.bindVertexArray(firstTile.vao);
  gl.drawElementsInstanced(gl.TRIANGLES, group.counts[level], gl.UNSIGNED_SHORT,
    group.offsets[level], count);
}
function drawForest(planes, mirror, eye, slice = 0, slices = 1) {
  const distance = mirror < 0 ? 5 : 13;
  for (let i=slice; i<forest.groups.length; i+=slices) {
    const group=forest.groups[i];
    if (!group.count) continue;
    if (!planes) {
      drawTreeRun(group, group.tiles[0], group.count, 1);
      continue;
    }
    // Adjacent visible tiles share the mesh and contiguous instance attributes.
    // Submit a run with its first VAO while keeping the original culling bounds.
    let first = null, count = 0, detailed = 0;
    for (const tile of group.tiles) {
      if (outsideView(planes,tile,tile.width,tile.depth)) continue;
      const dx=Math.max(tile.x0-eye[0],0,eye[0]-tile.x0-tile.width);
      const dz=Math.max(tile.z0-eye[2],0,eye[2]-tile.z0-tile.depth);
      const detailReach = distance + 0.85*tile.pad;
      const distance2=dx*dx+dz*dz;
      const skylineReach=48+3.5*tile.pad;
      const close = distance2<detailReach*detailReach ? 2 : distance2<skylineReach*skylineReach ? 1 : 0;
      if (first && (first.start+count !== tile.start || close !== detailed)) {
        drawTreeRun(group,first,count,detailed,true);
        first = null;
      }
      if (!first) { first=tile; count=0; detailed=close; }
      count+=tile.count;
    }
    if (first) drawTreeRun(group,first,count,detailed,true);
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
const P_RAYS = program(FSQ, viewRay + `uniform sampler2D tMap; uniform vec2 uSunUV; uniform float uVis; uniform vec3 uRayCol; in vec2 vUv; out vec4 o;
void main(){
  const float steps = 24.;
  vec2 toSun = uSunUV - vUv, stepUV = toSun / steps;
  float distanceToSun = length(toSun), weight = exp(-5. * distanceToSun);
  float gain = exp(5. * distanceToSun / steps) * 0.954;
  vec2 q = vUv + stepUV * 0.5;
  float scattered = 0., openings = 0., observed = 0.;
  for (int i = 0; i < 24; i++) {
    // Clamping an offscreen shaft to the last screen pixel stretches a bright
    // streak across the land. Integrate only actual openings in the canopy.
    if (any(lessThan(q, vec2(0.))) || any(greaterThan(q, vec2(1.)))) break;
    vec4 c = texture(tMap, q);
    float sunlit = smoothstep(0.34, 1.45, max(c.r, max(c.g, c.b)));
    scattered += c.a * sunlit * weight;
    openings += c.a; observed += 1.;
    weight *= gain; q += stepUV;
  }
  float reach = viewDepth(texture(tDepth, vUv).r);
  float foreground = smoothstep(0.45,8.,reach) * (1. - 0.72 * texture(tMap, vUv).a);
  // A shaft needs both a gap and an occluder along the sightline.
  float gap= openings/max(1.,observed);
  float brokenLight=smoothstep(0.015,0.12,gap)*(1.-smoothstep(0.36,0.76,gap));
  o=vec4(uRayCol*scattered*(uVis/steps)*foreground*brokenLight,1.); }`);
const P_TEMPORAL = program(FSQ, temporalFragment), P_MIST = program(FSQ, mistFragment);
const P_FINAL = program(FSQ, viewRay + historyColor + `uniform sampler2D tScene, tBloom, tRays, tMist; uniform float uBloom, uRays; uniform bool uMistActive; in vec2 vUv; out vec4 o;
vec3 acesF(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0., 1.); }
// Bilateral upsampling keeps air behind a nearby leaf or bank on its own side of the edge.
vec4 valleyMist(){
  if(!uMistActive) return vec4(0.,0.,0.,1.);
  vec4 local=texture(tMist,vUv);
  if(local.a==1. && dot(local.rgb,local.rgb)<1e-9) return vec4(0.,0.,0.,1.);
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
  vec3 c = unpackLight(texture(tScene, vUv).rgb), b = texture(tBloom, vUv).rgb;
  vec3 r = uRays>0. ? texture(tRays,vUv).rgb : vec3(0.);
  vec4 fog = valleyMist();
  if (uHDR > 0.5) c = pow(acesF((c + b * uBloom + r * uRays) * fog.a + fog.rgb), vec3(1. / 2.2));
  else c = pow(clamp(pow(clamp(c + b * uBloom * 0.7 + r * uRays * 0.6, 0., 1.), vec3(2.2)) * fog.a + fog.rgb, 0., 1.), vec3(1./2.2));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float clear = (1.-uNight)*(1.-uStorm);
  // Bring out quiet earth and midtone leaves. Roll off the chroma boost
  // toward saturated pigments and bright water, snow and cloud highlights.
  float chroma = max(c.r,max(c.g,c.b)) - min(c.r,min(c.g,c.b));
  float vibrance = (0.075 + 0.12*clear) * (1.-smoothstep(0.17,0.65,chroma)) * (1.-smoothstep(0.64,0.96,l));
  c += (c - l) * vibrance;
  c *= 1. + 0.29*clear*(l-0.35)*(1.-l);
  vec2 q = vUv - 0.5; c *= 1. - dot(q, q) * 0.32;
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
  if (post.w === w && post.h === h && post.samples === sceneSamples) return;
  if (post.res) {
    for (const f of [post.ms, post.resF, ...post.mips.map((m) => m.f), post.rays.f, post.mist.f, post.under?.f, ...post.history.map(m => m.f)]) if (f) gl.deleteFramebuffer(f);
    for (const t of [post.res, ...post.mips.map((m) => m.t), post.rays.t, post.depth, post.mist.t, post.under?.t, ...post.history.map(m => m.t)]) if (t) gl.deleteTexture(t);
    for (const rb of [post.msC, post.msD]) if (rb) gl.deleteRenderbuffer(rb);
  }
  post.w = w; post.h = h; post.samples = sceneSamples; post.ms = post.msC = post.msD = null;
  post.res = colorTex(w, h);
  if (sceneSamples > 1) {
    post.msC = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, post.msC); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, sceneSamples, CFMT, w, h);
    post.msD = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, post.msD); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, sceneSamples, gl.DEPTH_COMPONENT24, w, h);
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
  post.rays = { t: colorTex(mw,mh), w:mw, h:mh };
  post.rays.f=fboFor(post.rays.t);
  post.under = null;
  if (!post.ms) {
    const rw=Math.max(2,w>>1), rh=Math.max(2,h>>1), t=colorTex(rw,rh);
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
  const sunEdge=cw>0 ? Math.max(Math.abs(cx/cw),Math.abs(cy/cw)) : Infinity;
  const vis=sm(0.34,0.78,facing)*(1-sm(0.85,1.42,sunEdge));
  gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, post.depth);
  const rayStrength = vis > 0 ? (HDR ? 0.46 : 0.32) * (1 - night) : 0;
  if (rayStrength > 0) {
    pass(P_RAYS, post.rays.f, post.rays.w, post.rays.h, post.res);
    gl.uniform1i(P_RAYS.u('tDepth'), 15); gl.uniform2fv(P_RAYS.u('uDepthRange'), depthRange);
    gl.uniform2f(P_RAYS.u('uSunUV'), cw > 0 ? cx / cw * 0.5 + 0.5 : 0.5, cw > 0 ? cy / cw * 0.5 + 0.5 : 0.5);
    gl.uniform1f(P_RAYS.u('uVis'), vis); gl.uniform3fv(P_RAYS.u('uRayCol'), [1.0 * starTint[0] * (1 - night) + 0.25 * night, 0.62 * starTint[1] * (1 - night) + 0.38 * night, 0.36 * starTint[2] * (1 - night) + 0.8 * night]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const history = post.history[post.write];
  // If even the closest ray in the frustum misses the shaft cone, clear
  // afternoon air has exactly unit transmission throughout this view.
  const halfCone=Math.atan(Math.hypot(tanX,tanY));
  const sunAngle=Math.acos(Math.min(1,Math.max(-1,b.f[0]*starDirection[0]+b.f[1]*starDirection[1]+b.f[2]*starDirection[2])));
  const fair=(1-night)*(1-storm)*sm(0.055,0.34,starDirection[1])*(1-sm(0.02,0.35,sheet));
  const mistActive=fair<0.98 || sunAngle < halfCone+Math.acos(0.035**0.1)+0.005;
  for (const p of [P_MIST, P_TEMPORAL]) {
    if (p===P_MIST && !mistActive) continue;
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
  pass(P_FINAL, null, canvas.width, canvas.height, null);
  if (canvas.width !== w || canvas.height !== h) {
    // The recording keeps its initial dimensions even if the player rotates
    // the phone or adaptive quality changes. CSS crops these bars in live play.
    const fit = Math.min(canvas.width/w, canvas.height/h);
    const pw = Math.max(1,Math.round(w*fit)), ph = Math.max(1,Math.round(h*fit));
    if (pw < canvas.width || ph < canvas.height) {
      gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.viewport((canvas.width-pw)>>1,(canvas.height-ph)>>1,pw,ph);
  }
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, post.mist.t); gl.uniform1i(P_FINAL.u('tMist'), 3);
  gl.uniform1i(P_FINAL.u('tDepth'), 15); gl.uniform2fv(P_FINAL.u('uDepthRange'), depthRange);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, history.t); gl.uniform1i(P_FINAL.u('tScene'), 4);
  gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, post.mips[0].t); gl.uniform1i(P_FINAL.u('tBloom'), 5);
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, post.rays.t); gl.uniform1i(P_FINAL.u('tRays'), 6);
  gl.uniform1f(P_FINAL.u('uNight'),night); gl.uniform1f(P_FINAL.u('uStorm'),storm);
  gl.uniform1i(P_FINAL.u('uMistActive'),mistActive);
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
const uploadSurfaceWaves = waterTexture(gl,surface,28);
let simT = 0, denseUpload = null;
const grassPulses = new GrassPulses(WORLD_HALF);
const swimmerWake=createSwimWake(surface,waterLevel,(x,z,energy) => glowF.contact(x,z,energy));

function setMode(m) {
  // Dense rows overwrite the whole image. All three layers can reuse the same staging buffer.
  denseUpload = m === DENSE ? (denseUpload ?? new Uint8Array(N * N)) : null;
  mode = m; sailwings.reset(); surface.reset(); swimmerWake.reset(); grassPulses.reset(); post.previous = null;
  acc = { frames: 0, t: 0, ms: 0, up: 0 }; wall = 0;
  for (const f of [glowF, groundF, wearF]) f.set(m);
}

// events: what the world does to the fields
function footstep(x, z, inWater, wetFeet, run, depth = 0.35) {
  if (inWater) {
    const load=(run?0.86:0.55)*(0.55+0.45*sm(0.02,0.42,depth));
    wetContact(x,z,load,0.58);
  } else {
    glowF.contact(x,z,0.95); wearF.deposit(x,z,0,run?0.3:0.2);
    if (night>0) grassPulses.touch(x,z,simT);
    if (wetFeet>0) groundF.contact(x,z,0.70*wetFeet);
  }
}
function wetContact(x,z,strength,energy) {
  if (surface.touch(x,z,strength,energy)) glowF.contact(x,z,0.55*energy);
}
function splash(x, z, water, strength = 1.4, at = simT) {
  sailwings.startle(x, water ? waterLevel(x,z) : H(x,z), z, at, strength);
  if (water) wetContact(x,z,strength,1);
  else { glowF.contact(x,z,1); groundF.contact(x,z,0.25); wearF.deposit(x,z,0,0.5); }
}
function advanceWater(dt) {
  const drift=0.085*windStrength();
  surface.advance(dt,windDirection[0]*drift,windDirection[1]*drift,wind.sample);
}
function spore(r, cx, cz) {
  // The moisture sheet covers the world. Individual impacts follow the shower
  // around the hiker at constant density as the playable area grows.
  const radius = VALLEY_HALF - 2, margin = WORLD_HALF - radius - 2;
  const x = Math.max(-margin, Math.min(margin, cx)) + (r() * 2 - 1) * radius;
  const z = Math.max(-margin, Math.min(margin, cz)) + (r() * 2 - 1) * radius, y = H(x, z);
  if (y < waterLevel(x,z)) wetContact(x,z,0.24,0.30);
  else glowF.contact(x,z,0.5);
}

// Pods ride the surface to the lip, then fall for the same flight time as the curtain.
const PODS = 8;
const podPaths = Array.from({ length: PODS }, (_, i) => {
  const lane = 0.22 + 0.11 * Math.sin(i * 2.7);
  const lip = lipZ(lane), [footX, footZ] = landingAt(lane);
  const head = riverLevel(falls.lip), drop = head - riverLevel(footZ);
  const flightTime = Math.sqrt(2 * drop / 9.81);
  const drift = (48 - (footZ - lip)) / (70 - flightTime);
  const takeoff = (lip + 62) / drift;
  return { lane, lip, footX, footZ, head, flightTime, drift, takeoff, landing: takeoff + flightTime };
});
const podAge = (i, t) => (70 * i / PODS + t) % 70;
function podPosition(i, t) {
  const path = podPaths[i], age = podAge(i, t);
  let z, level;
  const flight = Math.min(1, Math.max(0, (age - path.takeoff) / path.flightTime));
  if (age < path.takeoff) z = -62 + age * path.drift;
  else if (age < path.landing) z = path.lip + (path.footZ - path.lip) * flight;
  else z = path.footZ + (age - path.landing) * path.drift;
  const guide = 1 - sm(0, 3, Math.max(0, path.lip - z, z - path.footZ));
  const lane = path.lane * falls.halfWidth * (0.99 + 0.08 * flight * flight);
  const x = riverX(z) + guide * lane + (1 - guide) * 0.64 * Math.sin(z * 0.47 + i * 1.8);
  if (age >= path.takeoff && age < path.landing) level = path.head - 4.905 * (age - path.takeoff) ** 2;
  else level = waterLevel(x, z);
  return [x, level + 0.063, z];
}
function skimWater(x, z) { wetContact(x,z,0.36,0.52); }
function riverEvents(t, dt) {
  sailwings.skim(t, dt, skimWater);
  const tick = Math.floor(t * 5);
  if (tick === Math.floor((t - dt) * 5)) return;
  const stamp = tick / 5;
  for (let i = 0; i < PODS; i++) {
    const path = podPaths[i], age = podAge(i, stamp);
    if (age >= path.takeoff && age < path.landing) continue;
    if (age >= path.landing && age < path.landing + 0.2) wetContact(path.footX, path.footZ, 0.72, 0.65);
    const [x, , z] = podPosition(i, stamp);
    wetContact(x, z, 0.075, 0.45);
  }
  // The two tongues aerate a narrow, moving line where they meet the pool.
  for (const lane of [-0.72+0.12*Math.sin(t*4.13),0.24+0.42*Math.sin(t*2.31)]) {
    const [x,z]=landingAt(lane);
    surface.touch(x,z,0.47,0.048+0.04*Math.sin(t*3.2+lane));
  }
}

// ---------------------------------------------------------------- storms
// Rain feeds the moisture field. A lightning flash lights the valley and its strike
// deposits at the point of contact. Thunder follows after the sound travel time.
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
  // Local organisms respond at the strike. The separate optical flash lights the valley.
  if (Math.abs(x) < EXTENT / 2 - 8 && Math.abs(z) < EXTENT / 2 - 8) {
    if (waterLevel(x,z)>y) wetContact(x,z,1.8,1);
    else { glowF.contact(x,z,1); groundF.contact(x,z,0.6); }
  }
  audio?.thunder(d, bearing(x, z));
}

// ---------------------------------------------------------------- camera + player
const player = { x: START[0], z: START[1], y: 0, yaw: GRASS_LAB ? 0.05 : -0.27, pitch: GRASS_LAB ? 0.06 : 0.18, vx: 0, vz: 0, vy: 0, grounded: true, onStone: false, swimming: false, scrambling: false, stroke: 0, flight: 0, stride: 0, bob: 0, foot: 1, wet: 0 };
player.y = H(player.x, player.z);
function readPreference(key) {
  try { return localStorage.getItem('tarn.' + key); } catch { return null; }
}
function savePreference(key, value) {
  try { localStorage.setItem('tarn.' + key, value); } catch { /* Play for this session. */ }
}
let fox, thirdPerson = readPreference('camera') !== 'first', selection = 0;
const chase = { height: player.y, arm: 3.55 };
const contactGrid = TEST ? null : contactVolume();
const bladeContact = TEST ? null : createBladeContact(gl,solveBlades,stampBlades,contactGrid);
let contactOn = true, coupled = true, markContacts = false, stillGrass = true, labView = 0;
const foxPose = { yaw: player.yaw, turn: 0, bend: 0, backing: false, reverseYaw: null, pitch: 0, roll: 0, height: player.y, impact: 0, landingTime: 1 };
function indexBoulders(sc) {
  const cells = new Map();
  for (let group = 0; group < 3; group++) {
    for (let i = 0; i < sc.rv[group].length; i += 4) {
      const [x, y, z, yaw] = sc.rv[group].subarray(i, i+4);
      const [sx, sy, sz] = sc.rs[group].subarray(i, i+3);
      if (sy < 0.38) continue;
      const r = Math.max(sx, sz) + 0.3;
      const stone = { x, y, z, sx, sy, sz, c: Math.cos(yaw), s: Math.sin(yaw) };
      for (let cz = Math.floor((z-r)/4); cz <= Math.floor((z+r)/4); cz++) {
        for (let cx = Math.floor((x-r)/4); cx <= Math.floor((x+r)/4); cx++) {
          const key = cx + 4096*cz;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(stone);
        }
      }
    }
  }
  return cells;
}

function rockAt(x, y, z, padding, cells=boulderCells) {
  const stones = cells.get(Math.floor(x/4) + 4096*Math.floor(z/4));
  if (!stones) return null;
  for (const rock of stones) {
    const dx = x-rock.x, dz = z-rock.z, dy = y-rock.y;
    const a = (dx*rock.c + dz*rock.s) / (rock.sx*0.85 + padding);
    const b = (-dx*rock.s + dz*rock.c) / (rock.sz*0.85 + padding);
    if (a*a + b*b + (dy/(rock.sy + padding))**2 < 1) return rock;
  }
  return null;
}

function stoneTop(x, z, ceiling, floor) {
  const stones = boulderCells.get(Math.floor(x/4) + 4096*Math.floor(z/4));
  if (!stones) return floor;
  for (const stone of stones) {
    const dx = x-stone.x, dz = z-stone.z;
    const a = (dx*stone.c + dz*stone.s) / (stone.sx*0.85);
    const b = (dz*stone.c - dx*stone.s) / (stone.sz*0.85);
    const disk = 1-a*a-b*b;
    if (disk <= 0) continue;
    const top = stone.y + stone.sy*Math.sqrt(disk);
    if (top <= ceiling) floor = Math.max(floor, top);
  }
  return floor;
}

// The outer strip joins the rock's vertical flank to the soil. It is only a
// paw's reach wide. The rounded cap inside is the same one used for landings.
function climbingSupport(x, z, terrain = H(x,z)) {
  const stones = boulderCells.get(Math.floor(x/4) + 4096*Math.floor(z/4));
  let support = terrain;
  if (!stones) return support;
  for (const rock of stones) {
    const dx=x-rock.x, dz=z-rock.z, rx=rock.sx*0.85, rz=rock.sz*0.85;
    const a=(dx*rock.c+dz*rock.s)/rx, b=(dz*rock.c-dx*rock.s)/rz;
    const disk=1-a*a-b*b;
    if (disk >= 0) {
      const u=Math.min(1,disk/0.10);
      const cap=disk < 0.10 ? Math.sqrt(0.10)*u*(1.5-0.5*u) : Math.sqrt(disk);
      support=Math.max(support,rock.y+rock.sy*cap);
    } else {
      const radius=Math.sqrt(1-disk);
      const metres=(radius-1)*Math.hypot(dx,dz)/radius;
      if (metres < 0.28) support=Math.max(support,terrain+(rock.y-terrain)*(1-sm(0,0.28,metres)));
    }
  }
  return support;
}

function updateFox(dt, ground, distance, alongBody, running) {
  const ease = -Math.expm1(-15*dt);
  const x = player.x, z = player.z, size = Math.sqrt(fox?.contactScale ?? 1);
  const f = Math.sin(foxPose.yaw), g = -Math.cos(foxPose.yaw);
  const span = 0.44 * size, width = 0.20 * size;
  // Sample the paws' reach, including the lip before the body reaches a stone.
  const pawHeight = (ahead, side) => player.grounded
    ? climbingSupport(x + ahead*f + side*g, z + ahead*g - side*f) : ground;
  const fl = pawHeight(span,width), fr = pawHeight(span,-width);
  const hl = pawHeight(-span,width), hr = pawHeight(-span,-width);
  const front = (fl+fr)*0.5, rear = (hl+hr)*0.5;
  const left = (fl+hl)*0.5, right = (fr+hr)*0.5;
  // The pitch and roll account for the support plane. A rock under just one
  // paw leaves a diagonal residual that the individual legs can take up.
  const diagonal = Math.max(-0.09*size,Math.min(0.09*size,(fl-fr-hl+hr)*0.25));
  const flying = !player.swimming && !player.grounded;
  const pitch = flying ? 0.21*Math.tanh(player.vy/3) : player.swimming ? (fox?.species.id==='Fox' ? 0.015 : 0.065) : Math.atan(Math.max(-3.4,Math.min(3.4,(front-rear)/(2*span))));
  const roll = flying ? 0 : player.swimming ? 0.026*Math.sin(2*Math.PI*player.stroke)
    : Math.atan(Math.max(-0.80,Math.min(0.80,(right-left)/(2*width))));
  foxPose.pitch += (pitch - foxPose.pitch) * ease;
  foxPose.roll += (roll - foxPose.roll) * ease;
  foxPose.landingTime += dt;
  const settle = player.grounded ? foxPose.impact * sm(0,0.055,foxPose.landingTime) * (1-sm(0.055,0.23,foxPose.landingTime)) : 0;
  const sole = ground + Math.min(0.10*size,Math.max(-0.05,0.225*(front+rear-2*ground))) + 0.02;
  foxPose.height = player.grounded ? Math.max(ground - 0.05, foxPose.height + (sole-foxPose.height)*ease) : player.y + 0.02;
  const follow = player.swimming ? player.y : ground + 0.65*Math.max(0, player.y-ground);
  chase.height += (follow - chase.height) * -Math.expm1(-10*dt);
  const reverse = Math.abs(alongBody) > 0.0001 ? alongBody < 0 : foxPose.backing;
  const stride = Math.max(distance, Math.abs(foxPose.turn)*0.33) * (reverse ? -1 : 1);
  const phase = player.grounded || player.swimming ? -1 : Math.min(0.94, 0.24 + 0.70*player.flight/jumpDuration);
  const grade = player.grounded ? Math.max(-1, Math.min(1, (front-rear)/(2*span))) * sm(0.1,0.6,distance/dt) : 0;
  fox?.advance(dt,stride,running && distance/dt>2,foxPose.bend,phase,player.swimming,player.scrambling,player.stroke,grade,diagonal,settle, pushTime > 0 ? 1-pushTime/pushDuration : -1);
}

function foxCamera(dt = 0) {
  const yaw = player.yaw, pitch = Math.max(-1.15, Math.min(1.1, player.pitch - 0.23));
  const { f } = camBasis(yaw, pitch);
  const x = player.x, z = player.z, ground = H(x, z);
  const lift = Math.max(1.14, (fox?.eyeHeight ?? 0) + 0.26);
  const pivot = Math.max(chase.height + lift, ground + lift - 0.14, waterLevel(x, z) + 0.68);
  const limit = (touch ? 3.35 : 3.55) + 0.65 * (lift - 1.14);
  const shoulderX = Math.cos(yaw)*0.53, shoulderZ = Math.sin(yaw)*0.53;
  let clear = limit;
  for (let i = 1; i <= 14; i++) {
    const d = limit*i/14, xx = x-f[0]*d+shoulderX*d/limit, yy = pivot-f[1]*d, zz = z-f[2]*d+shoulderZ*d/limit;
    if (yy < Math.max(H(xx, zz), waterLevel(xx, zz)) + 0.32 || rockAt(xx, yy, zz, 0.22)) {
      clear = Math.max(0.38, d-limit/14);
      break;
    }
  }
  chase.arm = Math.min(clear, chase.arm + (clear-chase.arm) * -Math.expm1(-7*dt));
  const d = chase.arm, xx = x-f[0]*d+shoulderX*d/limit, zz = z-f[2]*d+shoulderZ*d/limit;
  return { eye: [xx, Math.max(pivot-f[1]*d, H(xx, zz)+0.30, waterLevel(xx, zz)+0.30), zz], yaw, pitch };
}

function playerCamera(dt) {
  if (GRASS_LAB && labView) {
    if (labView === 2) return { eye: [PLOT.x, 15, PLOT.z+0.16], yaw: 0, pitch: -1.559 };
    const pivot = [player.x, foxPose.height + 0.42, player.z];
    const yaw = -1.30, pitch = -0.29, f = camBasis(yaw, pitch).f;
    return { eye: pivot.map((p, i) => p - f[i] * (touch ? 2.8 : 2.45)), yaw, pitch };
  }
  return thirdPerson && fox ? foxCamera(dt)
    : { eye: [player.x, Math.max(player.y + (fox?.eyeHeight ?? 1.65) + player.bob, waterLevel(player.x,player.z)+0.12), player.z], yaw: player.yaw, pitch: player.pitch };
}

function setCamera(third, remember = true) {
  thirdPerson = third;
  if (GRASS_LAB) {
    labView = 0;
    document.getElementById('labView').textContent = third ? 'Chase view' : 'First person';
  }
  document.getElementById('bCamera').setAttribute('aria-pressed', String(thirdPerson));
  document.getElementById('bFirstPerson').setAttribute('aria-pressed', String(!thirdPerson));
  if (remember) savePreference('camera', third ? 'third' : 'first');
  post.previous = null;
}
function toggleCamera() { if (fox) setCamera(!thirdPerson); }

async function chooseAnimal(species) {
  const version = ++selection, picker = document.getElementById('animalChoice');
  const status = document.getElementById('animalStatus');
  picker.value = species.id;
  status.textContent = '';
  if (fox?.species === species) return;
  status.textContent = 'Loading ' + species.label + '…';
  try {
    const next = await loadPlayerAnimal(gl, ANIMAL, species);
    if (version !== selection) { next.dispose(); return; }
    const previous = fox;
    fox = next;
    previous?.dispose();
    bladeContact?.reset();
    swimmerWake.reset();
    post.previous = null;
    savePreference('animal', species.id);
    status.textContent = '';
  } catch (error) {
    if (version !== selection) return;
    picker.value = fox?.species.id ?? '';
    status.textContent = 'Couldn’t load ' + species.label + '. Choose it again to retry.';
    console.warn(error);
  }
}
const keys = {};
const controller = foxController();
const menu = document.getElementById("fieldMenu"), gallery = document.getElementById("capture-library");
let rain = false, hudOn = false, started = false;
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

function walkable(x, z) {
  return inMap(x, z, 1) && (!GRASS_LAB || plotDistance(x,z) < 6.4);
}

// Spend a surface-distance budget. The bisection handles curved boulder rims
// and abrupt changes of grade without letting a long frame teleport uphill.
function crossSlope(dx, dz, draft) {
  const { x, z } = player, edge = WORLD_HALF - 1.001;
  dx = Math.max(-edge,Math.min(edge,x+dx))-x;
  dz = Math.max(-edge,Math.min(edge,z+dz))-z;
  const distance = Math.hypot(dx,dz);
  if (distance < 0.00001 || !walkable(x+dx,z+dz)) return;
  const supportAt = (xx,zz) => Math.max(climbingSupport(xx,zz),waterLevel(xx,zz)-draft);
  const from = supportAt(x,z);
  const ahead = supportAt(x+dx,z+dz);
  const grade = (ahead-from)/distance;
  const budget = distance / (1 + 0.24*Math.min(2,Math.max(0,grade)));
  let fraction = Math.min(1,budget/Math.hypot(distance,ahead-from));
  const rise = fraction === 1 ? ahead-from : supportAt(x+dx*fraction,z+dz*fraction)-from;
  const used = Math.hypot(distance*fraction,rise);
  if (Math.abs(used-budget)>Math.max(0.0003,0.025*budget)) {
    let lo=used<budget ? fraction : 0, hi=used<budget ? 1 : fraction;
    for(let i=0;i<8;i++) {
      const mid=(lo+hi)*0.5, rise=supportAt(x+dx*mid,z+dz*mid)-from;
      if (Math.hypot(distance*mid,rise)<=budget) lo=mid; else hi=mid;
    }
    fraction=lo;
  }
  player.x=x+dx*fraction; player.z=z+dz*fraction;
}

const pushDuration = 0.15;
let jumpBuffer = 0, pushTime = 0;
function stepPlayer(dt) {
  if (jumpBuffer > 0) {
    if (player.swimming) jumpBuffer = 0;
    else if (player.grounded) { pushTime = pushDuration; jumpBuffer = 0; }
    else jumpBuffer -= dt;
  }
  if (pushTime > 0) {
    pushTime = player.grounded ? Math.max(0,pushTime-dt) : 0;
    if (pushTime === 0 && player.grounded) requestJump(player);
  }
  let mx = controller.input.x, mz = controller.input.forward;
  if (keys.KeyW || keys.ArrowUp) mz += 1; if (keys.KeyS || keys.ArrowDown) mz -= 1;
  if (keys.KeyA || keys.ArrowLeft) mx -= 1; if (keys.KeyD || keys.ArrowRight) mx += 1;
  if (stick.id !== null) { mx += stick.x; mz += -stick.y; }
  const len = Math.hypot(mx, mz);
  const ground = H(player.x, player.z), level = waterLevel(player.x, player.z);
  const draft = fox?.draft ?? 0.42, depth = Math.max(0, level - player.y);
  const run = controller.input.run || keys.ShiftLeft || keys.ShiftRight || (stick.id !== null && len > 0.92 && mz >= -0.24);
  const moveYaw = GRASS_LAB && labView ? (labView === 2 ? 0 : -1.30) : player.yaw;
  const speedLimit = steerFox(foxPose, mx, mz, moveYaw, run, dt, !player.grounded && !player.swimming);
  const waterDrag = player.swimming ? 0.69 : 1 - 0.40 * sm(0.02, draft + 0.08, depth);
  const pace = speedLimit * waterDrag;
  let vx = Math.sin(foxPose.yaw)*pace, vz = -Math.cos(foxPose.yaw)*pace;
  if (!thirdPerson || !fox) {
    const scale = (run ? 4.2 : 1.9)*waterDrag / Math.max(1, len);
    const sy = Math.sin(moveYaw), cy = Math.cos(moveYaw);
    vx = (sy*mz+cy*mx)*scale; vz = (-cy*mz+sy*mx)*scale;
  }
  if (player.swimming) {
    const current=0.34*riverFlow(player.z,level);
    const bend=(riverX(player.z+0.12)-riverX(player.z-0.12))/0.24;
    const downstream=current/Math.hypot(1,bend);
    vx+=bend*downstream; vz+=downstream;
  }
  const rate = player.swimming ? 3.5 : !player.grounded ? 2.4 : len > 0.05 ? 10 : 17, blend = -Math.expm1(-rate * dt);
  const dx = vx * dt + (player.vx - vx) * blend / rate, dz = vz * dt + (player.vz - vz) * blend / rate;
  player.vx += (vx - player.vx) * blend; player.vz += (vz - player.vz) * blend;
  const oldX = player.x, oldZ = player.z, oldY=player.y, wasGrounded = player.grounded;
  const wasSwimming = player.swimming;
  let target;
  if (wasGrounded || wasSwimming) {
    crossSlope(dx,dz,draft);
    target = climbingSupport(player.x,player.z);
  } else {
    const x = oldX+dx, z = oldZ+dz, terrain = H(x,z);
    const ceiling = player.y + Math.max(0,player.vy*dt) + 0.035;
    const support = stoneTop(x,z,ceiling,terrain);
    const side = rockAt(x,Math.max(player.y,support)+0.20,z,0.09);
    if (terrain<=ceiling && (!side || support>terrain+0.02) && walkable(x,z)) {
      player.x=x; player.z=z; target=support;
    } else target=stoneTop(oldX,oldZ,ceiling,ground);
    const impactSpeed = Math.max(0,-player.vy);
    if (advanceFlight(player,target,dt)) {
      foxPose.impact = Math.min(1,impactSpeed/5);
      foxPose.landingTime = 0;
      const d=waterLevel(player.x,player.z)-target;
      if (d<=0.015 && target<=H(player.x,player.z)+0.02) footstep(player.x,player.z,false,player.wet,true,d);
      player.stride=0;
    }
  }
  const newLevel=waterLevel(player.x,player.z), waterDepth=newLevel-target;
  const touched = wasGrounded || wasSwimming || (player.vy<=0 && player.y<=newLevel-draft+0.04);
  player.swimming = touched && waterDepth > draft + (wasSwimming ? -0.055 : 0.08);
  if (player.swimming) {
    player.grounded=false; player.onStone=false; player.scrambling=false; player.vy=player.flight=0;
    const floatY=Math.max(target,newLevel-draft+0.018*Math.sin(player.stroke*4*Math.PI));
    player.y=Math.max(target,player.y+(floatY-player.y)*-Math.expm1(-12*dt));
  } else if (wasGrounded || wasSwimming || player.grounded) {
    player.y=target; player.grounded=true; player.onStone=target>H(player.x,player.z)+0.012;
  }
  const submerged=newLevel-player.y;
  if (!wasGrounded && !wasSwimming && oldY>=level && submerged>0 && waterDepth>0.01) {
    const u=(oldY-level)/(oldY-level+submerged);
    wetContact(oldX+(player.x-oldX)*u,oldZ+(player.z-oldZ)*u,Math.min(1.2,0.45+0.16*(oldY-player.y)/dt),0.82);
  }
  const travel = Math.hypot(player.x-oldX, player.z-oldZ);
  const rise=player.y-oldY;
  const distance = wasGrounded && player.grounded ? Math.hypot(travel,rise) : player.swimming || player.grounded ? travel : 0;
  if (player.grounded && wasGrounded && travel>0.0001) {
    player.scrambling=Math.abs(rise)/travel > (player.scrambling ? 0.65 : 0.84);
  } else if (!player.grounded || !wasGrounded) player.scrambling=false;
  if (player.swimming) {
    player.stroke=(player.stroke+dt*(0.50+0.52*Math.min(2.5,travel/dt)))%1;
  }
  const speed = distance / dt, strideLen = 0.48 + 0.49 * sm(1.9, 4.2, speed);
  const alongBody = (player.x-oldX)*Math.sin(foxPose.yaw) - (player.z-oldZ)*Math.cos(foxPose.yaw);
  updateFox(dt, target, distance, alongBody, run);
  if (fox) swimmerWake.update(fox,[player.x,foxPose.height,player.z],foxBasis(),
    (player.x-oldX)/dt,(player.z-oldZ)/dt,dt,simT,player.swimming,night);
  const phase = player.grounded ? player.stride + distance / strideLen : 0;
  if (phase >= 1) {
    player.foot = -player.foot;
    const u = (1 - player.stride) * strideLen / distance;
    const x = oldX + (player.x - oldX) * u + Math.cos(foxPose.yaw) * 0.11 * player.foot;
    const z = oldZ + (player.z - oldZ) * u + Math.sin(foxPose.yaw) * 0.11 * player.foot;
    const soil=H(x,z), support=player.onStone?stoneTop(x,z,player.y+0.15,soil):soil;
    const footDepth=waterLevel(x,z)-support;
    if (footDepth>0.015) {
      if (!fox) footstep(x,z,true,player.wet,speed>2.6,footDepth);
    } else if (support<=soil+0.02) footstep(x,z,false,player.wet,speed>2.6);
  }
  player.stride = phase % 1;
  const bob = (0.014 + 0.014 * sm(2, 4.2, speed)) * Math.min(1, speed) * Math.sin(player.stride * Math.PI) ** 2;
  player.bob += (bob - player.bob) * -Math.expm1(-24 * dt);
  player.wet = submerged>0.035 ? 1 : Math.max(0,player.wet-dt/9);
  if (!GRASS_LAB) brush.advance(player.x, player.y, player.z, dt);
}

function jump() {
  if (!started || menu.open || capture?.viewing || player.swimming) return;
  if (player.grounded) { if (pushTime === 0) pushTime = pushDuration; }
  else if (player.vy < 0) jumpBuffer = 0.12;
}

function throwStone() {
  const cam = playerCamera(0);
  const aim = camBasis(cam.yaw, cam.pitch).f;
  const eye = [player.x, Math.max(player.y + (fox?.eyeHeight ?? 1.65), waterLevel(player.x,player.z)+0.12), player.z];
  const b = { f: thirdPerson && fox ? norm(cam.eye.map((v, i) => v + aim[i]*16 - eye[i])) : aim };
  stones.push({ p: [eye[0] + b.f[0] * 0.4, eye[1] + b.f[1] * 0.4 - 0.1, eye[2] + b.f[2] * 0.4], v: [b.f[0] * 15, b.f[1] * 15 + 3.5, b.f[2] * 15], t: 0 });
}
function stepStones(dt) {
  for (let i = stones.length - 1; i >= 0; i--) {
    const s = stones[i]; s.t += dt;
    const [x, y, z] = s.p, dx = s.v[0] * dt, dz = s.v[2] * dt, dy = (s.v[1] - 4.9 * dt) * dt;
    s.p[0] += dx; s.p[1] += dy; s.p[2] += dz; s.v[1] -= 9.8 * dt;
    if (s.t > 6) { stones.splice(i, 1); continue; }
    const solidAt=(sx,sy,sz)=>sy<=Math.max(H(sx,sz),waterLevel(sx,sz)) || !!rockAt(sx,sy,sz,0.025);
    if (!solidAt(...s.p)) continue;
    // Locate the first contact within this step, including the elevated river.
    let lo = 0, hi = 1;
    for (let j = 0; j < 8; j++) {
      const u = (lo + hi) / 2, px = x + dx * u, pz = z + dz * u;
      if (solidAt(px,y+dy*u,pz)) hi=u; else lo=u;
    }
    const px = x + dx * hi, pz = z + dz * hi;
    const remaining = (1 - hi) * dt, impactY = s.v[1] + 9.8 * remaining;
    const strength = Math.min(1.65, 0.5 + 0.085 * Math.hypot(impactY, 0.5 * s.v[0], 0.5 * s.v[2]));
    const hitsRock=rockAt(px,y+dy*hi,pz,0.025), wet=!hitsRock && H(px,pz)<waterLevel(px,pz);
    if (!hitsRock) splash(px,pz,wet,strength,simT-remaining);
    else sailwings.startle(px,y+dy*hi,pz,simT-remaining,strength);
    audio?.splash(wet, Math.hypot(px - player.x, pz - player.z), bearing(px, pz));
    stones.splice(i, 1);
  }
}

// ---------------------------------------------------------------- render
const SUN = norm([-0.86, 0.40, -0.33]), SUNCOL = [3.95, 3.03, 2.02], PLANET = skyBodies.amber, MOONCOL = [0.19, 0.29, 0.55];
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
    const siteHue = x * 0.21 + z * 0.17;
    const hue = type > 4 ? plants.S2[i + 3] : siteHue - Math.floor(siteHue);
    const pigment = understoryPigment(type, hue);
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
const valleyShadows = createShadows(gl, touch ? 1536 : 2560, WORLD_HALF, 3, [
  { source: TERRAIN, draw() { gl.bindVertexArray(near.vao); gl.drawElements(gl.TRIANGLES, near.count, gl.UNSIGNED_INT, 0); } },
  { source: ROCK, draw: () => drawRocks() },
  { source: CANOPY, slices: 3, fragmentSource: `#version 300 es
precision highp float;
centroid in vec2 vBlade; flat in float vTissue;
${sprayGLSL}
void main(){ if (vTissue>=0. && texture(uLeafSprays,sprayUV(vBlade.x,vBlade.y,0.,vTissue)).a<0.5) discard; }`,
    setup: p => gl.uniform1i(gl.getUniformLocation(p,'uLeafSprays'),20),
    draw: (i,slices) => drawForest(null,1,null,i,slices) },
  { source: JLEAF, slices: 4, fragmentSource: `#version 300 es
precision highp float;
centroid in vec2 vBlade; flat in vec4 vLeaf;
${sprayGLSL}
void main(){ if (texture(uLeafSprays, sprayUV(clamp(vBlade.x, 0., 1.), clamp(vBlade.y, -1., 1.), 1., vLeaf.y)).a < 0.5) discard; }`,
    setup: (p) => gl.uniform1i(gl.getUniformLocation(p, 'uLeafSprays'), 20), draw(i, slices) {
    // Each VAO starts at its tile in a contiguous buffer. Draw neighbouring
    // tiles together, spreading the forest across successive clock frames.
    const start = Math.floor(i * leaves.tiles.length / slices), end = Math.floor((i + 1) * leaves.tiles.length / slices);
    if (start === end) return;
    const first = leaves.tiles[start], last = leaves.tiles[end - 1];
    gl.bindVertexArray(first.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, leaves.verts, last.start + last.count - first.start);
  } },
]);
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
const SHADOW_STEP = 0.012, TIMELAPSE_SHADOW_STEP = 0.094, EXTINCTION = [0.06, 0.12, 0.27];
// relative air mass toward a star `y` (the sine of its elevation) above the horizon (Kasten and Young, 1989)
const airMass = (y) => 1 / (Math.max(y, 0) + 0.50572 * Math.pow(96.07995 - Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI, -1.6364));
const SET_AIR = airMass(SUN[1]);
let day = 'still', dayAngle = 0, skyOffset = 0, timelapseElapsed = null, weatherLead = 0, cloudMotion = 0;
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
  const step = timelapseElapsed === null ? SHADOW_STEP : TIMELAPSE_SHADOW_STEP;
  if (shadowKeys.stale || dayAngle < from || dayAngle >= to + step) {
    if (shadowKeys.moved || dayAngle !== 0) valleyShadows.rebake(shadowKeys.layers[0], starDirection);
    shadowKeys.angles = [dayAngle, dayAngle + step];
    shadowKeys.pending = valleyShadows.prepare(shadowKeys.layers[1], starAt(dayAngle + step));
    shadowKeys.stale = false;
  } else if (dayAngle >= to) {
    // A long frame can cross the boundary. Finish the target before making it current.
    if (shadowKeys.pending) valleyShadows.advance(shadowKeys.pending, valleyShadows.passes);
    shadowKeys.layers.reverse();
    shadowKeys.angles = [to, to + step];
    shadowKeys.pending = valleyShadows.prepare(shadowKeys.layers[1], starAt(to + step));
  }
  shadowKeys.moved = true;
  const phase = Math.max(0, Math.min(1, (dayAngle - shadowKeys.angles[0]) / (shadowKeys.angles[1] - shadowKeys.angles[0])));
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
  if (day !== 'running') return dt;
  let skyDt = dt;
  if (timelapseElapsed !== null) {
    const end = Math.min(TIMELAPSE_SECONDS, timelapseElapsed + dt);
    skyDt = timelapseTravel(end) - timelapseTravel(timelapseElapsed);
    if (end === TIMELAPSE_SECONDS) {
      day = 'paused';
      skyDt += dt - (end - timelapseElapsed);
      timelapseElapsed = null;
      refreshDayControls();
    } else timelapseElapsed = end;
  }
  dayAngle += DAY_RATE * skyDt;
  // Keep the angle continuous across midnight so the shadow queue stays valid.
  skyOffset = (skyOffset - DAY_RATE * skyDt - 0.007 * dt) % (2 * Math.PI);
  return skyDt;
}

function refreshDayControls() {
  const lapse = timelapseElapsed !== null;
  document.getElementById('bDay').setAttribute('aria-pressed', String(day === 'running' && !lapse));
  const button = document.getElementById('bTimelapse');
  button.setAttribute('aria-pressed', String(lapse));
  button.textContent = lapse ? 'Stop lapse' : 'Timelapse';
}

function startDay() {
  if (day === 'still') dayAngle = night > 0.5 ? -2.55 : 0;
  day = 'running';
}

function toggleDay() {
  if (timelapseElapsed !== null) {
    timelapseElapsed = null;
  } else if (day === 'running') day = 'paused';
  else startDay();
  refreshDayControls();
}

function toggleTimelapse() {
  if (timelapseElapsed === null) {
    startDay();
    timelapseElapsed = 0;
  } else {
    timelapseElapsed = null;
    day = 'paused';
  }
  refreshDayControls();
}

let frameNumber = 0, lightDirection = SUN, lightColor = SUNCOL, exposure = 0.95;
// First-order diffuse sky lighting. Compute its three RGB coefficients once
// for both the scene and the reflection, including dusk, overcast and flashes.
const ambientLight = new Float32Array(9);
const skyIrradiance = [0.094, 0.132, 0.181], soilBounce = [0.047, 0.038, 0.029];
const moonSky = [0.019, 0.032, 0.067], moonGround = [0.006, 0.009, 0.015];
const duskLoss = [0.22, 0.37, 0.30], sunwardFill = [0.016, 0.010, 0.002];
const overcastSky = [0.093, 0.105, 0.121], overcastGround = [0.035, 0.038, 0.044];
const flashLight = [0.15, 0.17, 0.26];
function updateAmbientLight(skyFlash) {
  const low = 1 - sm(0.03, 0.36, starDirection[1]);
  const day = 1 - night, deck = storm * 0.70;
  for (let i = 0; i < 3; i++) {
    const daylight = day * (1 - low * low * duskLoss[i]);
    const top = (skyIrradiance[i] + deck * (overcastSky[i] - skyIrradiance[i])) * daylight + moonSky[i] * night;
    const base = (soilBounce[i] + deck * (overcastGround[i] - soilBounce[i])) * daylight + moonGround[i] * night;
    ambientLight[i] = 0.5 * (top + base) + flashLight[i] * skyFlash * 0.55;
    ambientLight[3+i] = 0.5 * (top - base) + flashLight[i] * skyFlash * 0.45;
    ambientLight[6+i] = sunwardFill[i] * starTint[i] * daylight * (1 - storm);
  }
}
function windStrength() { return (rain && !TEST ? 1.18 : 1.0) + 0.7 * storm; }
function common(p, eye, VP, mirror, t) {
  gl.useProgram(p);
  if (p.worldFrame === undefined) {
    gl.uniform1i(p.u('uSurface'),28);
    gl.uniform1i(p.u('uMeadowColour'),30);
    gl.uniform1i(p.u('uBarkColor'),26); gl.uniform1i(p.u('uBarkNormal'),27);
    gl.uniform1i(p.u('uOceanAtlas'),18); gl.uniform1i(p.u('uLeafSprays'), 20); gl.uniform1i(p.u('uRockSurface'), 19); gl.uniform1i(p.u('uGusts'),16); gl.uniform1i(p.u('uTrailMaterial'),17);
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
    gl.uniform3f(p.u('uCloudLayerMix'), clouds.front, clouds.blend, clouds.lastLayer);
    gl.uniform3fv(p.u('uSunDir'), lightDirection); gl.uniform3fv(p.u('uSunCol'), lightColor);
    gl.uniformMatrix3fv(p.u('uAmbientLight'), false, ambientLight);
    gl.uniform3fv(p.u('uStarDir'), starDirection); gl.uniform3fv(p.u('uStarTint'), starTint); gl.uniform3fv(p.u('uCloudTint'), cloudTint);
    if (p.shadowVersion !== valleyShadows.version) {
      p.shadowVersion = valleyShadows.version;
      gl.uniformMatrix4fv(p.u('uLightVP[0]'), false, valleyShadows.matrices);
    }
    gl.uniform2i(p.u('uSunLayers'), shadowKeys.layers[0], shadowKeys.layers[1]); gl.uniform1f(p.u('uSunBlend'), shadowKeys.blend);
    gl.uniform2f(p.u('uWindFrame'),wind.travel,wind.mix);
    gl.uniform1f(p.u('uNight'), night);
    if (p === ANIMAL && night > 0. && player.wet > 0.) {
      gl.uniform1f(p.u('uAnimalWaterLevel'), waterLevel(player.x,player.z));
    }
    gl.uniform1f(p.u('uExposure'), exposure); gl.uniform1f(p.u('uTime'), t);
    gl.uniform1f(p.u('uStorm'), storm); gl.uniform1f(p.u('uFlash'), flash * storm * (0.3 + 0.7 * night));
    gl.uniform1f(p.u('uSheet'), sheet); gl.uniformMatrix3fv(p.u('uSky'), false, skyTurn);
    gl.uniform1f(p.u('uWind'), windStrength());
    if (p === GRASS || p === CANOPY || p === JLEAF || p === PLANT) {
      gl.uniform3f(p.u('uBrush'), player.x, player.z, brush.cells.size ? 1 : 0);
    }
    gl.uniform1f(p.u('uSurfaceMix'),surface.textureMix);
  }
  gl.uniformMatrix4fv(p.u('uVP'), false, VP); gl.uniform3fv(p.u('uCam'), eye);
  gl.uniform1f(p.u('uMirror'), mirror); gl.uniform1f(p.u('uClip'), mirror < 0 ? reflectionLevel - 0.02 : -1e9);
}
const indexedMultiDraw = gl.getExtension('WEBGL_multi_draw');
function drawIndexedPatches(mesh, planes, eye, focalPixels, waterRegion, useWater) {
  const { drawCounts, byteOffsets } = mesh;
  let runs = 0, end = -1, activeShader;
  for (const patch of mesh.patches) {
    if (outsideView(planes, patch, patch.width, patch.depth)) continue;
    if (waterRegion) {
      const touchesWake = patch.x0 <= waterRegion[2] && patch.x0 + patch.width >= waterRegion[0]
        && patch.z0 <= waterRegion[3] && patch.z0 + patch.depth >= waterRegion[1];
      const shader = touchesWake ? WAKE_WATER : WATERP;
      if (shader !== activeShader) {
        // Preserve the transparent surface's original patch order.
        submitIndexedRuns(mesh,runs);
        runs = 0; end = -1; activeShader = shader;
        useWater(shader);
      }
    }
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
  submitIndexedRuns(mesh,runs);
}
function submitIndexedRuns(mesh,runs) {
  const { drawCounts, byteOffsets } = mesh;
  if (!runs) return;
  gl.bindVertexArray(mesh.vao);
  if (indexedMultiDraw && runs > 1) {
    indexedMultiDraw.multiDrawElementsWEBGL(gl.TRIANGLES, drawCounts, 0, gl.UNSIGNED_INT, byteOffsets, 0, runs);
  } else {
    for (let i = 0; i < runs; i++) gl.drawElements(gl.TRIANGLES, drawCounts[i], gl.UNSIGNED_INT, byteOffsets[i]);
  }
}
function meadowFields(tile) {
  const waves = night>0 ? grassPulses.tiles[tile]<<3 : 0;
  if(mode===DENSE) return waves | (night > 0 ? 7 : 6);
  return waves | (night > 0 && glowF.textureCache.tileBlocks[tile] ? 1 : 0) |
    (groundF.textureCache.tileBlocks[tile] ? 2 : 0) | (wearF.textureCache.tileBlocks[tile] ? 4 : 0);
}
function drawScene(eye, b, VP, mirror, t, opts) {
  const planes = prepareViewPlanes(VP, mirror, opts.crop);
  gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE); gl.frontFace(mirror < 0 ? gl.CW : gl.CCW);
  common(TERRAIN, eye, VP, mirror, t);
  gl.uniform4f(TERRAIN.u('uFoxShadow'), player.x, player.z, foxPose.yaw, opts.avatar ? 1/(1+1.8*Math.max(0,player.y-H(player.x,player.z))) : 0);
  drawIndexedPatches(near, planes, eye, opts.px * 400 / opts.tanY);
  drawIndexedPatches(far, planes);
  common(ROCK, eye, VP, mirror, t); drawRocks(VP, mirror, opts.px * 400 / opts.tanY, planes);
  gl.disable(gl.CULL_FACE);
  if (!outsideView(planes,fallsBounds,7.8,4.2)) {
    common(cascade.curtain,eye,VP,mirror,t); cascade.sheet();
  }
  if (opts.avatar) drawFox(eye, VP, mirror, t);
  wildlife?.draw(planes, eye, t, p => common(p, eye, VP, mirror, t));
  common(RIDGE_TREES,eye,VP,mirror,t);
  gl.bindVertexArray(far.trees.vao);
  gl.drawArraysInstanced(gl.TRIANGLES,0,12,far.trees.count);
  const coverage = mirror > 0 && Boolean(post.ms) && !opts.crop;
  if (coverage) { gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE); gl.colorMask(true,true,true,false); }
  common(CANOPY, eye, VP, mirror, t);
  gl.uniform1i(CANOPY.u('uCoverage'),coverage);
  drawForest(planes,mirror,eye);
  common(JLEAF, eye, VP, mirror, t);
  gl.uniform1i(JLEAF.u('uCoverage'),coverage);
  leaves.draw(planes, eye, mirror < 0 ? 0.62 : 1);
  if (coverage) { gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE); gl.colorMask(true, true, true, true); }
  common(sailwings.shader, eye, VP, mirror, t); sailwings.draw(t, planes, eye, b.f, mirror);
  if (plants) { common(PLANT, eye, VP, mirror, t); plants.draw(planes, eye, mirror < 0 ? 0.72 : 1); }
  if (opts.grass) {
    common(GRASS, eye, VP, mirror, t);
    if (grassPulses.update(simT)) gl.uniform4fv(GRASS.u('uGrassPulses[0]'),grassPulses.waves);
    if (bladeContact) {
      gl.uniform1i(GRASS.u('uContactEnabled'), Number(contactOn && Boolean(fox) && started && bladeContact.stats.roots > 0));
      gl.uniform1i(GRASS.u('uMarkContact'), Number(markContacts));
      gl.uniform1i(GRASS.u('uStillGrass'), Number(stillGrass));
      bladeContact.bind(GRASS);
    }
    grassDrawn = grass.draw(planes, eye, grassDensity, meadowFields);
  }
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

function foxBasis() {
  const { yaw, pitch, roll } = foxPose;
  const { f, r, u } = camBasis(yaw, pitch);
  const c = Math.cos(roll), s = Math.sin(roll);
  // The asset faces +Z. A fox facing the camera's forward direction has
  // its local +X on the camera's left.
  const side = r.map((v, i) => -v*c - u[i]*s);
  const up = u.map((v, i) => v*c - r[i]*s);
  return [...side, ...up, ...f];
}

function drawFox(eye, VP, mirror, t) {
  common(fox.shader, eye, VP, mirror, t);
  fox.draw([player.x, foxPose.height, player.z], foxBasis(), player.wet);
}

function render(t, camOverride, glowTexture = texGlow, dt = 0) {
  const dpr = Math.min(devicePixelRatio || 1, touch ? 1.5 : 2) * renderScale;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  const output = capture?.outputSize;
  const outWidth = output?.width ?? w, outHeight = output?.height ?? h;
  if (canvas.width !== outWidth) canvas.width = outWidth;
  if (canvas.height !== outHeight) canvas.height = outHeight;
  const fov = 1.15, aspect = w / h, tanY = Math.tan(fov / 2), tanX = tanY * aspect;
  const cam = camOverride || playerCamera(dt);
  const avatar = Boolean(fox && (thirdPerson || labView) && !camOverride && started && chase.arm > 0.7);
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
    gl.generateMipmap(gl.TEXTURE_2D);
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
  uploadSurfaceWaves();
  wildlife?.update(t, cam.eye);
  frameNumber++;
  lightDirection = norm(starDirection.map((v, i) => v * (1 - night) + PLANET[i] * night));
  lightColor = starColor.map((v, i) => v * (1 - night) + MOONCOL[i] * night);
  updateAmbientLight(flash * storm * (0.3 + 0.7 * night));
  if (bladeContact && contactOn && fox && started) {
    bladeContact.advance(dt,player.x,foxPose.height,player.z,H(player.x,player.z),fox,foxBasis(),grass,p => {
      common(p,cam.eye,VP,1,t);
      gl.uniform2fv(p.u('uGrassHeight'),grass.heightRange);
      gl.uniform1i(p.u('uStillGrass'),Number(stillGrass));
    },coupled);
  }
  clouds.update(t, cam.eye, starDirection, sm(0, 0.41, starDirection[1]), storm, Boolean(camOverride), t + weatherLead, cloudMotion);
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
    drawScene([cam.eye[0], 2 * reflectionLevel - cam.eye[1], cam.eye[2]], b, reflectionVP, -1, t, { tanX, tanY, grass: false, px: rh / 800, jitter: jitter.offset, crop: waterInView, avatar });
    gl.disable(gl.SCISSOR_TEST);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, post.ms || post.resF); gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawScene(cam.eye, b, VP, 1, t, { tanX, tanY, grass: true, px: h / 800, jitter: jitter.offset, avatar });
  gl.enable(gl.BLEND);
  if (waterInView) {
    copyUnderwater(w, h, waterInView);
    gl.colorMask(true, true, true, false);
    const wakeRegion = swimmerWake.prepare(t);
    function useWater(shader) {
      const first = shader.worldFrame !== frameNumber;
      common(shader, cam.eye, VP, 1, t);
      if (!first) return;
      if (shader === WAKE_WATER) swimmerWake.bind(gl,shader);
      gl.uniform2f(shader.u('uRes'), w, h);
      gl.uniform2f(shader.u('uRightXZ'), b.r[0], b.r[2]);
      gl.uniform1f(shader.u('uMirrorLevel'), reflectionLevel);
    }
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, reflTex);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (!wakeRegion) useWater(WATERP);
    drawIndexedPatches(wm, waterPlanes, null, 0, wakeRegion, useWater);
  }
  gl.depthMask(false);
  gl.colorMask(true, true, true, true);
  if (waterInView && !outsideView(waterPlanes,fallsBounds,7.8,4.2)) {
    gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ZERO,gl.ONE_MINUS_SRC_ALPHA);
    common(cascade.spray,cam.eye,VP,1,t); cascade.drops(h*0.91);
  }
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
  stepPlayer(dt); stepStones(dt); riverEvents(simT, dt); advanceWater(dt); stepStorm(dt);
  if (rain) { sporeAcc += dt * 30; while (sporeAcc >= 1) { spore(sporeR, player.x, player.z); sporeAcc -= 1; } if (groundF.sheet < 0.45) groundF.rain(dt * 0.025); }
  const t0 = performance.now();
  for (const f of layers()) f.advance(dt);
  acc.ms += performance.now() - t0;
}

// Use a wall-clock window so a struggling phone gets relief within seconds.
// A single long frame (returning to the tab or starting a clip) cannot trigger a cut.
let perfT = [], renderScale = 1, warm = 0, windowTime = 0, coolUntil = 0;
function adaptDensity(rawDt) {
  if (TEST || !started || document.hidden || rawDt <= 0 || rawDt > 1) return;
  warm += rawDt;
  if (warm < 1.5) return;
  perfT.push(rawDt);
  windowTime += rawDt;
  if (windowTime < 1 || perfT.length < 5) return;
  const ts = perfT.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length*0.5)], p90 = ts[Math.min(ts.length-2, Math.floor(ts.length*0.9))];
  perfT = []; windowTime = 0;
  const slow = med > 1 / 50 || p90 > 1 / 33;
  if (slow) {
    if (med > 1 / 32) {
      sceneSamples = lightSamples;
      renderScale = Math.max(0.72, renderScale * 0.86);
      grassDensity = Math.max(0.30, grassDensity * 0.85);
    } else if (sceneSamples>lightSamples) sceneSamples=lightSamples;
    else if (grassDensity>0.65) grassDensity=Math.max(0.65,grassDensity*0.88);
    else if (renderScale > 0.72) renderScale = Math.max(0.72, renderScale * 0.9);
    else grassDensity = Math.max(0.30, grassDensity * 0.85);
    coolUntil = warm + 6;
  } else if (med < 1 / 57 && p90 < 1 / 52 && warm > coolUntil) {
    if (renderScale < 1) renderScale = Math.min(1, renderScale * 1.06);
    else if (grassDensity < 1) grassDensity = Math.min(1, grassDensity * 1.08);
    else sceneSamples = preferredSamples;
  }
}
let capture;
function frame(now) {
  requestAnimationFrame(frame);
  const elapsed = Math.max(0, (now - last) / 1000);
  last = now;
  controller.poll(Math.min(0.1, elapsed), { started, menu, gallery, toggleMenu, look, jump, throwStone, toggleCamera });
  if (capture?.viewing) return;
  adaptDensity(elapsed);
  const dt = Math.min(0.1, elapsed);
  const skyDt = started ? advanceDay(dt) : dt;
  // Cloud drift, condensate and the sun advance on the same eased lapse clock.
  weatherLead += skyDt - dt;
  const boost = dt > 0 ? sm(0.8, 9., (skyDt - dt) / dt) : 0;
  cloudMotion += (boost - cloudMotion) * (1 - Math.exp(-dt * 6.));
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
  const weatherSun = day === 'still' ? starDirection[1] : starAt(dayAngle)[1];
  clouds.advance(skyDt, sm(0, 0.41, weatherSun), storm, simT + weatherLead, groundF.sheet);
  render(simT, undefined, texGlow, dt);
  capture?.frame(now);
  if (!started) return;
  if (audio) {
    // what the ears get: the gust where you stand, how far the river and the lake are and which side they are on
    const gust = wind.sample(player.x,player.z);
    const rz = Math.max(spring.z, Math.min(-8, player.z)), rx = riverX(rz);
    const riverDistance = Math.hypot(player.x - rx, Math.max(0, spring.z - player.z, player.z + 8));
    audio.update({ wind: windStrength(), gust, height: player.y, night, storm,
      falls: [Math.hypot(player.x-riverX(falls.lip),player.z-falls.lip),bearing(riverX(falls.lip),falls.lip)],
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
    const measuredFps = Math.round(f / Math.max(1e-3, (now - wall) / 1000));
    hud.fps.textContent = measuredFps + ' fps'; wall = now;
    if (GRASS_LAB) document.getElementById('labStats').textContent =
      `${measuredFps} fps · ${fmt(grassDrawn)} roots · ${contactOn ? 'contact CPU ' + time(bladeContact.stats.cpuMs) + '/tick' : 'contact off'}`;
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
  document.getElementById('bMode').textContent = 'Engine · ' + MODE_NAME[mode];
  hud.note.textContent = mode === BOXEL
    ? 'The bound tracks how far the sparse field can differ from the full calculation. The target is 1/255. Each retiring block is checked against its budget.'
    : 'Dense mode updates every cell on the map. Switch engines to restart the three fields and compare their cost.';
}
function cycleMode() { setMode(mode === BOXEL ? DENSE : BOXEL); refreshModeUI(); }

// ---------------------------------------------------------------- input
function resetMovement() {
  for (const k in keys) keys[k] = false;
  player.vx = player.vz = player.bob = 0;
  stick = { x: 0, y: 0, id: null };
  lookId = lookLast = null;
  document.getElementById('knob').style.transform = '';
}
function toggleMenu() {
  resetMovement();
  if (menu.open) menu.close();
  else {
    if (document.pointerLockElement) document.exitPointerLock();
    menu.showModal();
  }
}
function bindInput() {
  document.getElementById('menuOpen').onclick = toggleMenu;
  document.getElementById('menuClose').onclick = toggleMenu;
  menu.addEventListener('focusin', resetMovement);
  addEventListener('keydown', (e) => {
    if (capture.viewing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (started && e.code === 'KeyQ') {
      e.preventDefault();
      if (!e.repeat) toggleMenu();
      return;
    }
    if (menu.open) return;
    if (started && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.code === 'Backquote') { e.preventDefault(); capture.toggle(); return; }
      if (e.code === 'KeyG') { e.preventDefault(); capture.open(); return; }
    }
    keys[e.code] = true;
    if (!started || e.repeat) return;
    if (e.code === 'Space') { e.preventDefault(); jump(); }
    if (e.code === 'KeyF') throwStone();
    if (e.code === 'KeyR') toggleRain();
    if (e.code === 'KeyT') toggleStorm();
    if (e.code === 'KeyV' && audio) audio.toggle();
    if (e.code === 'KeyM') cycleMode();
    if (e.code === 'KeyH') toggleHud();
    if (e.code === 'KeyN') toggleNight();
    if (e.code === 'KeyC') toggleDay();
    if (e.code === 'KeyL') toggleTimelapse();
    if (e.code === 'KeyP') toggleCamera();
    if (GRASS_LAB && e.code === 'KeyB') document.getElementById('labView').click();
    if (GRASS_LAB && e.code === 'KeyX') document.getElementById('labContact').click();
    if (GRASS_LAB && e.code === 'KeyK') document.getElementById('labMark').click();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', resetMovement);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    last = performance.now();
    perfT.length = 0;
    windowTime = 0;
    wall = 0;
  });
  let dragStart = null, dragged = false;
  canvas.addEventListener('contextmenu', e => {
    if (!started || touch) return;
    e.preventDefault();
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(() => {});
  });
  addEventListener('mousemove', e => {
    if (document.pointerLockElement === canvas) look(e.movementX, e.movementY, 0.0022);
  });
  canvas.addEventListener('pointerdown', e => {
    if (!started || e.pointerType === 'touch' || e.button !== 0) return;
    if (document.pointerLockElement === canvas) { throwStone(); return; }
    dragStart = lookLast = [e.clientX, e.clientY];
    dragged = false;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragStart || !lookLast || !e.buttons || e.pointerType === 'touch') return;
    dragged ||= Math.hypot(e.clientX-dragStart[0], e.clientY-dragStart[1]) > 4;
    if (dragged) {
      look(e.clientX-lookLast[0], e.clientY-lookLast[1], 0.004);
      lookLast = [e.clientX, e.clientY];
    }
  });
  canvas.addEventListener('pointerup', e => {
    if (e.pointerType === 'touch') return;
    if (dragStart && lookLast && !dragged && e.button === 0) throwStone();
    dragStart = lookLast = null;
  });
  canvas.addEventListener('lostpointercapture', e => { if (e.pointerType !== 'touch') dragStart = lookLast = null; });
  canvas.addEventListener('wheel', e => {
    if (!started || e.ctrlKey) return;
    e.preventDefault();
    look(e.deltaX, e.deltaY, e.deltaMode === 1 ? 0.035 : 0.0025);
  }, { passive: false });
  capture = bindCapture(canvas, {
    audio: () => audio,
    pause() { resetMovement(); audio?.suspend(); },
    resume() { last = performance.now(); wall = 0; audio?.resume(); },
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
  document.getElementById('bJump').onclick = jump;
  document.getElementById('bThrow').onclick = () => started && throwStone();
  document.getElementById('bRain').onclick = () => started && toggleRain();
  document.getElementById('bStorm').onclick = () => started && toggleStorm();
  document.getElementById('bMode').onclick = () => started && cycleMode();
  document.getElementById('bHud').onclick = toggleHud;
  document.getElementById('bNight').onclick = () => started && toggleNight();
  if (GRASS_LAB) bindGrassLab();
  document.getElementById('bCamera').onclick = () => setCamera(true);
  document.getElementById('bFirstPerson').onclick = () => setCamera(false);
  const picker = document.getElementById('animalChoice');
  picker.onchange = () => chooseAnimal(animalById(picker.value));
  document.getElementById('bDay').onclick = () => started && toggleDay();
  document.getElementById('bTimelapse').onclick = () => started && toggleTimelapse();
}
function bindGrassLab() {
  document.body.classList.add('grass-lab');
  document.getElementById('grassLab').hidden = false;
  document.getElementById('labContact').onclick = (event) => {
    contactOn = !contactOn; bladeContact.reset();
    event.currentTarget.setAttribute('aria-pressed', String(contactOn));
  };
  document.getElementById('labShare').onclick = (event) => {
    coupled = !coupled; bladeContact.reset();
    event.currentTarget.setAttribute('aria-pressed', String(coupled));
  };
  document.getElementById('labMark').onclick = (event) => {
    markContacts = !markContacts;
    event.currentTarget.setAttribute('aria-pressed', String(markContacts));
    document.getElementById('labLegend').hidden = !markContacts;
  };
  document.getElementById('labWind').onclick = (event) => {
    stillGrass = !stillGrass;
    event.currentTarget.setAttribute('aria-pressed', String(!stillGrass));
  };
  document.getElementById('labView').onclick = (event) => {
    labView = (labView + 1) % 3;
    event.currentTarget.textContent = [thirdPerson ? 'Chase view' : 'First person', 'Side view', 'Overhead view'][labView];
    post.previous = null;
  };
  document.querySelector('#intro p').textContent = 'Walk the fox through a 10 × 10 m patch. Mark contact to see the fox touch a blade in mint and that blade push a neighbour in amber.';
  document.getElementById('go').textContent = 'Enter grass lab';
}

function look(dx, dy, s) { player.yaw += dx * s; player.pitch = Math.max(-1.35, Math.min(1.35, player.pitch - dy * s)); }
function toggleRain() { rain = !rain; document.getElementById('bRain').setAttribute('aria-pressed', String(rain)); }
function toggleNight() {
  // the hand-set day and night: stops the clock, and the star goes back to the afternoon
  if (day !== 'still') { day = 'still'; timelapseElapsed = null; refreshDayControls(); }
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
  falls: { eye: [-3.20,H(-3.20,-40.0)+1.65,-40.0],
    yaw: Math.atan2(riverX(falls.lip+0.75)+3.20,-40.0-falls.lip-0.75), pitch: 0.15 },
  river: { eye: [riverX(-40) + 2.6, H(riverX(-40) + 2.6, -40) + 2.4, -40], yaw: -0.25, pitch: -0.32 },
  stones: { eye: [OUTCROP[0] - 7, H(OUTCROP[0] - 7, OUTCROP[1] + 6) + 1.7, OUTCROP[1] + 6], yaw: Math.atan2(7, 6), pitch: -0.3 },
  boulder: { eye: [OUTCROP[0] - 7, H(OUTCROP[0] - 7, OUTCROP[1] + 6) + 1.7, OUTCROP[1] + 6], yaw: Math.atan2(7, 6) - 0.62, pitch: -0.52 },
  verge: { eye: [trail[3][0] + 0.6, H(trail[3][0] + 0.6, trail[3][1]) + 1.65, trail[3][1]], yaw: Math.atan2(trail[4][0] - trail[3][0], trail[3][1] - trail[4][1]) + 0.35, pitch: -0.5 },
  shore: { eye: [SHORE_CAM[0], H(...SHORE_CAM) + 2.6, SHORE_CAM[1]], yaw: -0.95, pitch: -0.24, motes: true },
  planet: { eye: [START[0], H(...START) + 1.7, START[1]], yaw: 0.05, pitch: 0.12, motes: true },
  sunset: { eye: [12, H(12, 4) + 1.7, 4], yaw: -1.5, pitch: 0.08, motes: true },
  outcrop: { eye: [12, H(12, -14) + 1.7, -14], yaw: 0.9, pitch: 0.05, motes: true },
  beach: { eye: [12.5, H(12.5, 28) + 1.5, 28], yaw: -1.9, pitch: -0.32, motes: false },
  stack: { eye: [ISLET[0] + 11, 1.5, ISLET[1] + 7.4], yaw: -0.98, pitch: -0.08, motes: false },
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
    // The river view includes a wet paw leaving the pool onto moss. This keeps
    // a visible Boxel contact in the control exposure as the plankton drifts away.
    if (f === 868 || f === 888) {
      const z = f === 868 ? -42.8 : -43.25, x = riverX(z) + 2.9;
      footstep(x, z, false, 1, false);
    }
    if (f > 300 && f < 600) { if (r() < 0.5) spore(r, px, pz); groundF.rain(0.0004); }
    advanceWater(dt);
    for (const l of layers()) l.advance(dt);
  }
  const ms = performance.now() - t0;
  for (const l of layers()) l.upload();
  renderFixture(view, simT);
  const st = layers().map((l) => l.stats());
  const stepped = st.reduce((sum, s) => sum + s.stepped, 0);
  return { mode: MODE_NAME[m], frames, ms, stepped, violations: st.reduce((n, s) => n + s.violations, 0), blocks: st.map((s) => s.blocks), bytes: st.reduce((n, s) => n + s.bytes, 0) };
}

// ---------------------------------------------------------------- boot
(async () => {
  const picker = document.getElementById('animalChoice');
  for (const species of animals) picker.add(new Option(species.label, species.id));
  document.getElementById('playerSettings').hidden = TEST;
  const saved = animalById(readPreference('animal')) ?? animals[0];
  const avatarReady = TEST ? null : chooseAnimal(saved).then(() => {
    if (!fox && saved !== animals[0]) return chooseAnimal(animals[0]);
  });
  const [fieldEngine, [rock, bark, barkNormal], sprays] = await Promise.all([loadEngine(), surfacesReady, leafSpraysReady, avatarReady]);
  setCamera(thirdPerson, false);
  engine = fieldEngine;
  uploadSurface(gl, rock, 19, gl.RGBA8, [128,128,128]);
  uploadSurface(gl, bark, 26, gl.SRGB8_ALPHA8, () => barkTile(false));
  uploadSurface(gl, barkNormal, 27, gl.RGBA8, () => barkTile(true));
  uploadLeafSprays(gl, sprays, 20);
  // Both lights see the same cutouts as the camera on their first bake.
  valleyShadows.rebake(0, SUN); valleyShadows.rebake(1, PLANET); shadowKeys.stale = true;
  wind = createWind(engine.boxel, H);
  gl.activeTexture(gl.TEXTURE0+16); gl.bindTexture(gl.TEXTURE_2D,gustTexture);
  gl.texStorage2D(gl.TEXTURE_2D,1+Math.log2(wind.size),gl.RGBA8,wind.size,wind.size);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,wind.size,wind.size,gl.RGBA,gl.UNSIGNED_BYTE,wind.bytes);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  clouds = createClouds(gl, program, FSQ, engine.boxel, { mobile: touch, test: TEST,
    sources: [[...LAKE, 1.27], [spring.x, spring.z, 0.55]] });
  checkPrograms();
  const t0 = performance.now();
  glowF = new Layer(engine.boxel, SPECS.glow, texGlow);
  groundF = new Layer(engine.boxel, SPECS.moist, texGround);
  wearF = new Layer(engine.boxel, SPECS.wear, texWear);
  setMode(BOXEL);
  refreshModeUI();
  document.getElementById('status').textContent = `boxel ready: three surface fields on an unbounded plane, cones computed in ${Math.round(performance.now() - t0)} ms`;
  if (touch) { document.getElementById('go').textContent = GRASS_LAB ? 'Enter grass lab' : 'Tap to step onto the shore'; document.getElementById('keys').innerHTML = '<b>left thumb</b><span>walk, pull back, or push forward to run</span><b>right thumb</b><span>look</span><b>buttons</b><span>jump, throw, or open the field menu</span>'; }
  window.__game = { setNight: (v) => { night = nightTarget = v; }, setDay: (a) => { day = a === null ? 'still' : 'paused'; dayAngle = a ?? 0; shadowKeys.stale = true; },
    runDay: (seconds) => { day = 'running'; for (let s = 0; s < seconds; s += 1 / 30) { advanceDay(1 / 30); placeStar(); } day = 'paused'; }, setStorm: (v) => { storm = stormTarget = v; }, look: (view, pitch, yaw) => { const c = typeof view === 'string' ? VIEWS[view] : view; Object.assign(player, { x: c.eye[0], y: c.eye[1] - 1.65, z: c.eye[2], yaw: c.yaw + (yaw ?? 0), pitch: pitch ?? c.pitch, bob: 0, vx: 0, vz: 0 });
      player.grounded = true; player.onStone = false; player.swimming = player.scrambling = false;
      player.vy = player.flight = player.stride = player.stroke = 0;
      const terrain=H(player.x,player.z), level=waterLevel(player.x,player.z);
      if (fox && level-climbingSupport(player.x,player.z,terrain)>fox.draft+0.08) {
        player.y=level-fox.draft; player.swimming=true; player.grounded=false;
      }
      foxPose.yaw = player.yaw; foxPose.reverseYaw = null; foxPose.pitch = foxPose.roll = 0;
      jumpBuffer = pushTime = 0; foxPose.impact = 0; foxPose.landingTime = 1;
      foxPose.height = chase.height = player.swimming ? player.y : terrain;
      chase.arm = 3.55; swimmerWake.reset(); post.previous = null;
    }, soak: (amount) => { groundF.rain(amount); sheet = groundF.sheet; }, strike: (x, z) => { strike(rng(7), [x, z]); flash = 1; boltLight = 1; }, hdr: HDR, get samples() { return sceneSamples; }, scripted, setMode, H, ready: true, engine: engine.kind, state: () => ({ player: { ...player }, pose: { ...foxPose }, camera: playerCamera(0), thirdPerson: Boolean(fox && thirdPerson), animal: fox?.species.id, gait: fox?.gait, started, wildlife: wildlife?.state() ?? [],
    ...(GRASS_LAB && { grassLab: { occupied: contactOn ? contactGrid.occupied : 0, contactMs: bladeContact.stats.cpuMs, activeRoots: bladeContact.stats.roots, uploadBytes: bladeContact.stats.uploadBytes, coupled, markContacts, stillGrass, contactOn, view: labView } }),
    blocks: layers().map((l) => l.stats().blocks), instances: { grass: grass.count, oaks: 0, ridgeTrees:far.trees.count, trees: forest.count, leaves: leaves.count + forest.shoots, plants: plants?.count ?? 0, grassDrawn } }) };
  if (qs.has('falls')) window.__game.look('falls');
  else if(qs.has('oak')) {
    const [x,z]=[23.12,36.43];
    window.__game.look({eye:[x-2,H(x-2,z-1)+1.65,z-1],yaw:Math.atan2(2,-1),pitch:.20});
  }
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

  });
  requestAnimationFrame((t) => { last = t; frame(t); });
})().catch((e) => fail('The field engine did not start: ' + e.message));
