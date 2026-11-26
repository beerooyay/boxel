// Gust strength lives in a translating air mass. Cells are narrower along the
// flow than across it, so a gust sweeps through a meadow as a front.
import { WORLD_HALF } from './landmarks.js';
import { CLOUD_WIND } from './weather.js';

const SIZE = 64,
  STEP = 0.8,
  metres = [1.2, 3.8];
const speed = Math.hypot(...CLOUD_WIND);
export const windDirection = CLOUD_WIND.map((v) => v / speed);
const spec = { spread: 0.13, fade: 0.066, tolerance: 1 / 255, events: 256 };

export function createWind(boxel, heightAt) {
  const field = boxel.field(spec),
    bytes = new Uint8Array(SIZE * SIZE * 4),
    values = new Float32Array(SIZE * SIZE);
  let seed = 86037,
    travel = 0,
    elapsed = 0,
    tick = 0,
    version = 0;
  // A lee in the terrain shelters the meadow. Store the exposure in blue
  // alongside the two gust snapshots, in fixed world coordinates.
  const heights = new Float32Array(SIZE * SIZE),
    step = (2 * WORLD_HALF) / SIZE;
  for (let j = 0; j < SIZE; j++)
    for (let i = 0; i < SIZE; i++)
      heights[j * SIZE + i] = heightAt((i + 0.5) * step - WORLD_HALF, (j + 0.5) * step - WORLD_HALF);
  for (let j = 0; j < SIZE; j++)
    for (let i = 0; i < SIZE; i++) {
      let slope = -0.2;
      for (const reach of [2, 4, 7]) {
        const x = Math.max(0, i - Math.round(windDirection[0] * reach)),
          z = Math.max(0, j - Math.round(windDirection[1] * reach));
        slope = Math.max(slope, (heights[z * SIZE + x] - heights[j * SIZE + i]) / (step * reach));
      }
      bytes[4 * (j * SIZE + i) + 2] = Math.round(255 * Math.max(0.34, Math.min(1, 0.9 - 0.86 * slope)));
    }
  const draw = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  function advance(storm) {
    // Neighbouring parcels reinforce one bowed front. The sparse field
    // spreads and dissipates their impulse between successive fronts.
    if (tick++ % 2 === 0) {
      const x = Math.floor(draw() * SIZE),
        z = Math.floor(draw() * SIZE),
        r = 3 + Math.floor(4 * draw());
      const shear = draw() * 0.8 - 0.4,
        strength = (0.55 + 0.42 * draw()) * (1 + 0.35 * storm);
      for (let i = -2; i <= 2; i++)
        field.deposit(Math.round(x + i * shear + 0.44 * i * i), z + i * r, r, strength * (1 - 0.12 * Math.abs(i)));
    }
    field.step();
  }
  function snapshot() {
    values.fill(0);
    field.blocks((bx, bz, block) => {
      for (let j = 0; j < 16; j++)
        for (let i = 0; i < 16; i++)
          values[((bz * 16 + j) & 63) * SIZE + ((bx * 16 + i) & 63)] += block[j * 16 + i];
    });
    field.forgetFreed();
    for (let i = 0; i < values.length; i++) {
      bytes[4 * i] = bytes[4 * i + 1];
      bytes[4 * i + 1] = Math.round(255 * Math.min(1, values[i]));
    }
    version++;
  }
  // A replay reuses the same initial gusts as a fresh walk.
  for (let i = 0; i < 48; i++) advance(0);
  snapshot();
  for (let i = 0; i < values.length; i++) bytes[i * 4] = bytes[i * 4 + 1];
  function sample(x, z) {
    const u = (x * windDirection[0] + z * windDirection[1] - travel) / metres[0],
      v = (-x * windDirection[1] + z * windDirection[0]) / metres[1];
    const i = Math.floor(u),
      j = Math.floor(v),
      fx = u - i,
      fz = v - j,
      t = elapsed / STEP;
    function at(a, b) {
      const k = 4 * ((b & 63) * SIZE + (a & 63));
      return (bytes[k] * (1 - t) + bytes[k + 1] * t) / 255;
    }
    const gust =
      (1 - fz) * ((1 - fx) * at(i, j) + fx * at(i + 1, j)) + fz * ((1 - fx) * at(i, j + 1) + fx * at(i + 1, j + 1));
    const gx = Math.min(SIZE - 1, Math.max(0, (x + WORLD_HALF) / step - 0.5));
    const gz = Math.min(SIZE - 1, Math.max(0, (z + WORLD_HALF) / step - 0.5));
    const ax = Math.floor(gx),
      az = Math.floor(gz),
      bx = Math.min(ax + 1, SIZE - 1),
      bz = Math.min(az + 1, SIZE - 1);
    const exposure = (a, b) => bytes[4 * (b * SIZE + a) + 2] / 255;
    const fxg = gx - ax,
      fzg = gz - az;
    const local =
      (1 - fzg) * ((1 - fxg) * exposure(ax, az) + fxg * exposure(bx, az)) +
      fzg * ((1 - fxg) * exposure(ax, bz) + fxg * exposure(bx, bz));
    return local * (-0.1 + 1.65 * gust);
  }
  return {
    size: SIZE,
    bytes,
    sample,
    get version() {
      return version;
    },
    get travel() {
      return travel;
    },
    get mix() {
      return elapsed / STEP;
    },
    update(dt, storm) {
      travel = (travel + dt * speed * (1.13 + 0.62 * storm)) % (SIZE * metres[0]);
      elapsed += dt;
      while (elapsed >= STEP) {
        elapsed -= STEP;
        advance(storm);
        snapshot();
      }
    },
    free() {
      field.free();
    },
    stats() {
      return field.stats();
    },
  };
}
export const windShader = `
uniform sampler2D uGusts;
uniform vec2 uWindFrame;
const vec2 WIND_DIR = vec2(${windDirection[0].toFixed(8)},${windDirection[1].toFixed(8)});
float windWave(vec2 p){
  vec2 cell=vec2(dot(p,WIND_DIR)-uWindFrame.x, dot(p,vec2(-WIND_DIR.y,WIND_DIR.x))) / vec2(${metres[0]},${metres[1]});
  vec2 gust=textureLod(uGusts,(cell+0.5)/${SIZE}.,0.).rg;
  vec2 uv=clamp(p/${2 * WORLD_HALF}.+0.5,vec2(0.5/${SIZE}.),vec2(1.-0.5/${SIZE}.));
  return textureLod(uGusts,uv,0.).b*(-0.10+1.65*mix(gust.r,gust.g,uWindFrame.y));
}`;
