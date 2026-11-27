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
    untilFront = 0,
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
      // A shorter ripple rides on each broad Boxel front. Bake its two
      // crossing wavelengths in air coordinates so the banks and the grass
      // see the same crest and both derivatives match at the wrap.
      const u = (2 * Math.PI * i) / SIZE, v = (2 * Math.PI * j) / SIZE;
      const meander = 1.24 * Math.sin(v + 0.55 * Math.sin(2 * u + v)) + 0.65 * Math.sin(2 * v - u);
      const ripple = 0.59 * Math.sin(5*u + v + meander) + 0.29 * Math.sin(9*u - 2*v + 1.4*meander)
        + 0.12 * Math.sin(14*u + 3*v - meander);
      bytes[4 * (j * SIZE + i) + 3] = Math.round(127.5 * (1 + ripple));
    }
  const draw = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  function advance(storm) {
    // Neighbouring parcels reinforce one bowed front. The sparse field
    // spreads and dissipates their impulse between successive fronts.
    if (--untilFront <= 0) {
      untilFront = 3 + Math.floor(draw()*(5-3*storm));
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
      f = elapsed / STEP,
      t = f*f*(3-2*f);
    function at(a, b, channel) {
      const k = 4 * ((b & 63) * SIZE + (a & 63));
      return channel === 3 ? bytes[k + 3] / 255 : (bytes[k] * (1 - t) + bytes[k + 1] * t) / 255;
    }
    function air(channel) {
      return (1 - fz) * ((1 - fx) * at(i, j, channel) + fx * at(i + 1, j, channel)) +
        fz * ((1 - fx) * at(i, j + 1, channel) + fx * at(i + 1, j + 1, channel));
    }
    const front = Math.min(1, Math.max(0, (air(0) - 0.035) / 0.63));
    const crest = front * front * (3 - 2 * front);
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
    return local * (0.10 + 0.98 * crest + (2 * air(3) - 1) * (0.06 + 0.38 * crest));
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
      const f = elapsed / STEP;
      return f*f*(3-2*f);
    },
    update(dt, storm) {
      travel = (travel + dt * speed * (1.18 + 1.58 * storm)) % (SIZE * metres[0]);
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
// The air at p, averaged over 2^lod cells: a blade feels the air at its root, a crown the air across its width.
float windAir(vec2 p, float lod){
  vec2 cell=vec2(dot(p,WIND_DIR)-uWindFrame.x, dot(p,vec2(-WIND_DIR.y,WIND_DIR.x))) / vec2(${metres[0]},${metres[1]});
  vec4 air = textureLod(uGusts, (cell + 0.5) / ${SIZE}., lod);
  vec2 uv=clamp(p/${2 * WORLD_HALF}.+0.5,vec2(0.5/${SIZE}.),vec2(1.-0.5/${SIZE}.));
  float crest = smoothstep(0.035, 0.665, mix(air.r, air.g, uWindFrame.y));
  float gust = 0.10 + 0.98 * crest + (2. * air.a - 1.) * (0.06 + 0.38 * crest);
  return textureLod(uGusts, uv, lod).b * gust;
}
float windWave(vec2 p){ return windAir(p, 0.); }
// One wind, three responses. A blade or a leaf answers the air where it is, at once. A tree answers as one body: its
// wood is heavy, so it feels the air averaged across its crown and a moment late (the air mass travels downwind, so
// the air a little downwind of the trunk is the air the trunk felt a moment ago). Every part of one tree reads this
// one value, so its twigs, the leaves on them and its trunk move together instead of shearing apart.
float crownLoad(vec2 base){ return windAir(base + WIND_DIR * 2.2, 1.7); }
vec3 rotateFoliage(vec3 v, vec3 axis, vec2 rotation) {
  return v * rotation.x + cross(axis, v) * rotation.y + axis * dot(axis,v) * (1. - rotation.x);
}
// A leaf turns about its stalk toward the wind and no further than it can bend: the angle saturates, so a storm lays
// leaves over instead of folding them back on themselves.
float leafBend(float load){ return 1.15 * load / (1. + load); }
// Twig flex is measured along a branch. The woody base has zero compliance. The load saturates: a bough bends further
// in a stronger gust, but less for each step, as wood stiffens.
vec3 boughOffset(float load, float flex, float height){
  float tip = max(0., (flex-0.36)/0.64);
  return vec3(WIND_DIR.x, -0.16, WIND_DIR.y) * (0.026 * height * tip*tip * 1.8 * load / (1. + 0.45 * load));
}
// A shorter wave rides in the same translating air mass. Integer harmonics
// join exactly as the 64-cell wind texture wraps.
float tipFlutter(vec2 root, float travel, float seed){
  float along = (dot(root,WIND_DIR)-travel) * ${(2*Math.PI/(SIZE*metres[0])).toFixed(9)};
  return sin(17.*along + 0.61*dot(root,vec2(-WIND_DIR.y,WIND_DIR.x)) + seed*4.);
}`;
