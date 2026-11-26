// A moving air mass above the valley. One cell represents 32 metres. Boxel
// transports excess condensate in the horizontal plane. The renderer supplies
// the vertical shape and optical scattering separately.
export const WEATHER_SIZE = 256;
export const WEATHER_CELL = 32;
export const WEATHER_TILE = 8; // subdivide each 16-cell engine block for optical bounds
export const WEATHER_METRES = WEATHER_SIZE * WEATHER_CELL;
export const WEATHER_SPEC = { spread: 0.17, fade: 0.072, tolerance: 1 / 255, events: 512 };
export const CLOUD_WIND = [2.45, 1.41]; // metres per second, east and south
const BLOCK = 16;

// Magnus dew point, followed by the lifted-parcel approximation (metres).
export function liftingLevel(celsius, humidity) {
  const g = Math.log(Math.max(0.01, Math.min(1, humidity))) + 17.625 * celsius / (243.04 + celsius);
  return Math.max(0, 125 * (celsius - 243.04 * g / (17.625 - g)));
}

// Clear afternoons warm the boundary layer. Rain cools and moistens it.
export function cloudBase(sun, storm) {
  return liftingLevel(15 + 9 * sun - 3 * storm, 0.835 + 0.085 * storm + 0.025 * (1 - sun));
}

function thermals() {
  let seed = 14159;
  const draw = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const plumes = [];
  function bank(x, z, radius, lift) {
    // Small flanking plumes share an inflow. Their separate caps make a bank
    // of cumulus congestus rise at several heights.
    let angle = draw() * 6.283, count = 2 + Math.floor(draw() * 4);
    for (let n = 0; n < count; n++) {
      const scale = n === 0 ? 1 : 0.32 + draw() * 0.49;
      const distance = n === 0 ? 0 : radius * (0.45 + 1.2 * draw());
      angle += 1.4 + draw();
      plumes.push({ x: Math.round(x + Math.cos(angle) * distance), z: Math.round(z + Math.sin(angle) * distance),
        radius: Math.max(2, Math.round(radius * scale)), lift: lift * (0.55 + 0.45 * scale), phase: 6.28 * draw() });
    }
  }
  // The lake opening has clear air overhead. Thermals rise over its sunlit
  // shoulders, with stronger convection on the windward side of the range.
  bank(-22, -31, 11, 0.93); bank(25, -37, 13, 1); bank(7, -50, 10, 0.63);
  bank(-38, 2, 12, 0.87); bank(-22, 25, 7, 0.64); bank(36, 21, 10, 0.79);
  bank(4, 47, 8, 0.52); bank(26, -9, 5, 0.53);
  bank(-18, -13, 4, 0.57); bank(-27, -17, 6, 0.64); bank(12, -20, 4, 0.50);
  // A few smaller parcels reach saturation nearer the lake. Their shallower
  // crowns hang above the ridge, with blue air visible underneath.
  bank(-4, -12, 4.8, 0.62); bank(-10, -15, 3.3, 0.59);
  bank(12, -12, 3.2, 0.53); bank(-10, 3, 4.5, 0.63); bank(6, 13, 4.3, 0.59);
  for (let z = -100; z <= 100; z += 24) for (let x = -100; x <= 100; x += 24) {
    if (Math.hypot(x, z) < 59 || draw() < 0.17) continue;
    bank(x + (draw() - 0.5) * 13, z + (draw() - 0.5) * 13, 4 + draw() * 8, 0.42 + 0.58 * draw());
  }
  return plumes;
}

export function createWeather(boxel, { dense = false, sources = [] } = {}) {
  const size = WEATHER_SIZE, half = size / 2;
  // The reference includes a quiet halo outside the part the renderer sees.
  // Diffusion crosses the visible border on the unbounded field.
  const guard = 48;
  const field = dense ? boxel.grid(WEATHER_SPEC, -half - guard, -half - guard, size + 2 * guard) : boxel.field(WEATHER_SPEC);
  const plumes = thermals(), water = new Uint8Array(size * size);
  // Each tile also encloses the one-texel apron read by bilinear filtering,
  // including at the periodic boundary. Zero here really is clear air.
  const tiles = size / WEATHER_TILE, maxima = new Uint8Array(tiles * tiles);
  const raw = new Uint8Array(size * size), scratch = new Uint16Array(size * size);
  let tick = 0;
  function feed(sun, storm, initial, time = 0, wet = 0) {
    const base = cloudBase(sun, storm);
    // Replenish one eighth of the plumes per tick by the amount lost since
    // their last visit. The whole field still takes every transport step.
    const period = 8;
    for (let i = initial ? 0 : tick % period; i < plumes.length; i += initial ? 1 : period) {
      const p = plumes[i];
      const updraft = p.lift * (0.79 + 0.21 * Math.sin(tick * 0.092 + p.phase));
      const depth = Math.max(0, 375 + 755 * updraft * (0.52 + 0.48 * sun) + 380 * storm - base);
      const amount = Math.min(1, depth / 720) * (initial ? 0.97 : 1 - (1 - WEATHER_SPEC.fade) ** period);
      if (amount <= 0) continue;
      field.deposit(p.x, p.z, p.radius, amount * 0.24);
      field.deposit(p.x, p.z, Math.round(p.radius * 0.76), amount * 0.32);
      field.deposit(p.x, p.z, Math.round(p.radius * 0.46), amount * 0.44);
    }
    // Moisture from the lake, spring and rain-wet banks enters the moving air
    // mass downwind, after the estimated ascent time to its condensation level.
    const ascentTime = base / (1.4 + 2.8 * sun);
    const evaporation = (0.16 + 0.84 * sun) * (1 - 0.76 * storm) * (1 + 0.45 * wet);
    for (const [x, z, area] of sources) {
      const cx = Math.floor((x + CLOUD_WIND[0] * (ascentTime - time)) / WEATHER_CELL);
      const cz = Math.floor((z + CLOUD_WIND[1] * (ascentTime - time)) / WEATHER_CELL);
      field.deposit(((cx + half) & (size - 1)) - half, ((cz + half) & (size - 1)) - half,
        2, area * evaporation * (initial ? 0.13 : 0.024));
    }
    field.step();
    if (!dense) field.forgetFreed();
    tick++;
  }
  function snapshot() {
    const byte = value => Math.min(255, Math.round(value * 255));
    raw.fill(0);
    if (dense) {
      for (let y = 0; y < size; y++) {
        const row = field.row(y - half);
        for (let x = 0; x < size; x++) raw[y * size + x] = byte(row[x + guard]);
      }
    } else {
      field.blocks((bx, by, values) => {
        const x = bx * BLOCK + half, y = by * BLOCK + half;
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        for (let j = 0; j < BLOCK; j++) for (let i = 0; i < BLOCK; i++)
          raw[(y + j) * size + x + i] = byte(values[j * BLOCK + i]);
      });
    }
    // A positive, normalized footprint spreads each updraft across a few
    // cells. It removes deposition rings and preserves the input error bound.
    const mask = size - 1;
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        scratch[row + x] = raw[row + x] * 4
          + 3 * (raw[row + ((x - 1) & mask)] + raw[row + ((x + 1) & mask)])
          + 2 * (raw[row + ((x - 2) & mask)] + raw[row + ((x + 2) & mask)])
          + raw[row + ((x - 3) & mask)] + raw[row + ((x + 3) & mask)];
      }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      water[i] = (128 + 4 * scratch[i]
        + 3 * (scratch[((y - 1) & mask) * size + x] + scratch[((y + 1) & mask) * size + x])
        + 2 * (scratch[((y - 2) & mask) * size + x] + scratch[((y + 2) & mask) * size + x])
        + scratch[((y - 3) & mask) * size + x] + scratch[((y + 3) & mask) * size + x]) >> 8;
    }
    for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {
      let high = 0;
      for (let y = -1; y <= WEATHER_TILE; y++) {
        const row = ((ty * WEATHER_TILE + y) & mask) * size;
        for (let x = -1; x <= WEATHER_TILE; x++) high = Math.max(high, water[row + ((tx * WEATHER_TILE + x) & mask)]);
      }
      maxima[ty * tiles + tx] = high;
    }
  }
  feed(1, 0, true);
  for (let i = 0; i < 3; i++) feed(1, 0, false);
  snapshot();
  return { field, water, maxima, advance(sun, storm, time, wet) { feed(sun, storm, false, time, wet); snapshot(); } };
}
