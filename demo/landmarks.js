// Shared by terrain generation, water rendering, placement and wading. All distances are metres.
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const VALLEY_HALF = 64, WORLD_HALF = 128;
export const spring = { x: -18, z: -99, level: 5.5 };

// The last coordinate is the tread elevation. Each route joins the next at
// the same height. Their inner ends pick up a walk in the original valley.
export const rangeWalks = {
  headwaters: [[-12, -52, 5], [-16, -63, 7], [-18, -73, 7.7], [-26, -83, 7.4], [-34, -94, 6.9], [-37, -103, 7.5],
    [-47, -109, 9.8], [-62, -110, 12], [-74, -99, 13.8], [-86, -86, 14], [-96, -71, 12]],
  west: [[-49, 30, 7.6], [-58, 35, 8.7], [-70, 38, 9], [-82, 31, 8], [-93, 17, 6.8], [-101, 4, 6],
    [-105, -10, 6.2], [-97, -24, 7.6], [-90, -40, 9.4], [-99, -55, 11], [-96, -71, 12]],
  south: [[36, 43, 7], [43, 53, 8.3], [49, 68, 9], [56, 81, 11.4], [45, 94, 13.6], [30, 104, 14.9],
    [11, 111, 15.8], [-10, 106, 14], [-31, 94, 11], [-52, 86, 10], [-69, 72, 10], [-82, 55, 9.1], [-82, 31, 8]],
  east: [[39, -29, 7.4], [50, -31, 8.3], [63, -29, 9.8], [75, -38, 12], [86, -45, 15],
    [100, -39, 18], [109, -23, 21], [112, -5, 22.4], [105, 15, 20], [92, 32, 16.5],
    [78, 44, 14.5], [71, 63, 12.8], [56, 81, 11.4]],
};

function springRadius(x, z) {
  const dx = (x - spring.x) / 17.5, dz = (z - spring.z) / 12;
  return Math.hypot(dx + 0.12 * Math.sin(dz * 3), dz) + 0.06 * Math.sin(dx * 4 + dz * 2);
}

export const summit = [-41, -35];
const hills = [
  // centre, footprint radii, prominence, spur direction
  [...summit, 31, 31, 20.8, 0.7],
  [-46, 16, 11, 19, 3.8, 1.3], [-38, 24, 11, 13, 2.3, 0.3],
  [34, 39, 19, 15, 4.4, 0.4], [44, 37, 13, 10, 2.1, 1.7],
  [11, -44, 11, 16, 6.8, 0.8],
  [-21, 47, 12, 10, 4.8, 2.1],
];
// Wind around the slope, then level out over the last few metres of the lookout.
const trailhead = [-15, -21];
const startRadius = Math.hypot(trailhead[0] - summit[0], trailhead[1] - summit[1]);
const startAngle = Math.atan2(trailhead[1] - summit[1], trailhead[0] - summit[0]);
export const trail = Array.from({ length: 57 }, (_, i) => {
  const u = i / 56, r = startRadius * (1 - u), a = startAngle + u * 8.8;
  return [summit[0] + r * Math.cos(a), summit[1] + r * Math.sin(a)];
});
// The fern walk threads the low saddle, the fan terrace makes a circuit, and
// the crystal walk climbs the long shoulder of the eastern outcrop.
export const valleyWalks = {
  fern: [[-32, 4], [-36, 7], [-40, 10], [-41, 14], [-40, 18], [-42, 22], [-46, 25], [-49, 30]],
  fan: [[20, 31], [25, 33], [28, 37], [30, 42], [35, 45], [40, 43], [43, 39], [40, 36], [35, 36], [30, 38], [28, 37]],
  crystal: [[19, -11], [23, -13], [27, -16], [29, -20], [28, -24], [30, -28], [34, -30], [39, -29]],
};
// Terrain, grazing cover and tree placement all query these treads. Index only
// segments that can affect each eight-metre square, including room for boulders.
const reach = 7, binWidth = 8, binStride = 2 * Math.ceil((WORLD_HALF + reach) / binWidth) + 1;
const trailBins = new Map();
for (const points of [trail, ...Object.values(valleyWalks), ...Object.values(rangeWalks)]) {
  for (let i = 1; i < points.length; i++) {
    const [x, z, y] = points[i - 1], [bx, bz, by] = points[i], dx = bx - x, dz = bz - z;
    const segment = { x, z, dx, dz, y, dy: y === undefined ? 0 : by - y, length2: dx * dx + dz * dz };
    for (let j = Math.floor((Math.min(z, bz) - reach) / binWidth); j <= Math.floor((Math.max(z, bz) + reach) / binWidth); j++) {
      for (let k = Math.floor((Math.min(x, bx) - reach) / binWidth); k <= Math.floor((Math.max(x, bx) + reach) / binWidth); k++) {
        const key = j * binStride + k;
        if (!trailBins.has(key)) trailBins.set(key, []);
        trailBins.get(key).push(segment);
      }
    }
  }
}

function nearby(x, z) {
  if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return;
  return trailBins.get(Math.floor(z / binWidth) * binStride + Math.floor(x / binWidth));
}
function alongSegment(s, x, z) {
  return Math.max(0, Math.min(1, ((x - s.x) * s.dx + (z - s.z) * s.dz) / s.length2));
}
export function trailDistance(x, z) {
  const segments = nearby(x, z);
  if (!segments) return reach;
  let nearest2 = reach * reach;
  for (const s of segments) {
    const u = alongSegment(s, x, z);
    const dx = x - s.x - u * s.dx, dz = z - s.z - u * s.dz;
    nearest2 = Math.min(nearest2, dx * dx + dz * dz);
  }
  return Math.sqrt(nearest2);
}

function uplandHeight(x, z, base, edge) {
  const blend = smooth(49, 65, edge) * (1 - smooth(128, 158, edge));
  if (!blend) return base;
  const west = 1 - smooth(0.30, 1, Math.hypot((x + 98) / 31, (z + 4) / 60));
  const east = 1 - smooth(0.20, 1, Math.hypot((x - 106) / 39, (z + 12) / 62));
  const south = 1 - smooth(0.10, 1, Math.hypot((x - 8) / 76, (z - 102) / 33));
  let y = base - west * (6.5 + 1.7 * Math.cos(z * 0.13)) + south * (3.4 + 1.65 * Math.sin(x * 0.13 + z * 0.08));
  const strata = x * 0.76 + z * 0.35;
  y += east * (4.3 + 2.4 * Math.sin(strata * 0.12) + 1.7 * smooth(-0.18, 0.18, Math.sin(strata * 0.30)));
  // Grade the trail across each contour. Leave exposed rock and rolling hills either side.
  const segments = nearby(x, z);
  let distance2 = reach * reach, grade = y;
  if (segments) for (const s of segments) {
    if (s.y === undefined) continue;
    const u = alongSegment(s, x, z), dx = x - s.x - s.dx * u, dz = z - s.z - s.dz * u;
    const d2 = dx * dx + dz * dz;
    if (d2 < distance2) { distance2 = d2; grade = s.y + u * s.dy; }
  }
  y += (grade - y) * (1 - smooth(1.6, reach, Math.sqrt(distance2)));
  return base + (y - base) * blend;
}
export function trailCover(x, z) {
  const lookout = 1 - smooth(1.8, 3, Math.hypot(x - summit[0], z - summit[1]));
  return Math.max(lookout, 1 - smooth(0.56, 1.18, trailDistance(x, z)));
}

export function riverX(z) {
  const lower = -5 + 3.4 * Math.sin(z * 0.13) + 1.4 * Math.sin(z * 0.29 + 0.8);
  return lower + (spring.x - lower) * smooth(66, 100, -z);
}
function riverDistance(x, z) {
  return Math.hypot(x - riverX(Math.max(spring.z, Math.min(-8, z))), Math.max(0, spring.z - z, z + 8));
}
function riverLevel(z) {
  return Math.min(spring.level, Math.max(0, -z - 12) * 0.055 + 1.15 * (1 - smooth(-49, -44, z)) + 0.65 * smooth(65, 82, -z));
}
// Both lakes are still. Water and drifting impacts pick up the current below the spring's outlet.
export function riverFlow(z, level) {
  return smooth(0.02, 0.65, level) * smooth(spring.z + 10, spring.z + 20, z);
}
export function waterLevel(x, z) {
  if (z < -80 && z > -120 && x > -45 && x < 10 && springRadius(x, z) < 1.40) return spring.level;
  if (x < -25 || x > 5 || z < spring.z || z > -8) return 0;
  return riverDistance(x, z) < 3.6 ? riverLevel(z) : 0;
}
export function terrainHeight(x, z, base) {
  for (const [cx, cz, rx, rz, height, phase] of hills) {
    if (Math.abs(x - cx) > rx || Math.abs(z - cz) > rz) continue;
    const dx = (x - cx) / rx, dz = (z - cz) / rz, r = Math.hypot(dx, dz);
    const spur = Math.sin(3 * Math.atan2(dz, dx) + phase + r) * 0.12 * Math.sin(Math.PI * Math.min(1, r));
    base += height * (1 - smooth(0.05, 1, r)) * (1 + spur);
  }
  const radius = Math.hypot(x - summit[0], z - summit[1]);
  if (radius < startRadius + 4) {
    // Three radiating buttresses and an exposed bench break up the lookout's round profile.
    // The trail grade below still determines the tread and the flat summit.
    const bearing = Math.atan2(z - summit[1], x - summit[0]);
    const ridge = Math.cos(bearing * 3 + radius * 0.075) * 0.72 + Math.cos(bearing * 7 - 0.5) * 0.28;
    const flank = smooth(2, 10, radius) * (1 - smooth(17, startRadius + 3, radius));
    const strata = base + (x - summit[0]) * 0.16 - (z - summit[1]) * 0.08;
    base += flank * (3.6 * ridge + 1.6 * smooth(7, 9.8, strata) - 1.0 * smooth(13, 16.5, strata));
    const grade = 1.6 + 21.8 * (1 - smooth(2.8, startRadius, radius));
    const path = 1 - smooth(1.05, 4, trailDistance(x, z));
    base += (grade - base) * Math.max(path, 1 - smooth(2, 4, radius));
  }
  const edge = Math.max(Math.abs(x), Math.abs(z));
  if (edge > 49 && edge < 158) base = uplandHeight(x, z, base, edge);
  if (x < -49 || x > 13 || z < -122 || z > -4) return base;
  if (z < -77) {
    const r = springRadius(x, z);
    const basin = spring.level - 1.9 + 2.95 * smooth(0.28, 1.18, r);
    base += (basin - base) * (1 - smooth(1.06, 1.62, r));
  }
  const d = riverDistance(x, z), level = riverLevel(Math.max(spring.z, z));
  // A shallow gravel ford just upstream of the lake connects both sides of
  // the watershed. Its longer banks can be climbed straight out of the water.
  const ford = 1 - smooth(1.3, 4.6, Math.abs(z + 25));
  const bankToe = 1.2 - 0.6 * ford, bankTop = 3.4 + 0.7 * ford;
  const bed = level - 0.58 + 0.26 * ford + (1.65 - 0.30 * ford) * smooth(bankToe, bankTop, d);
  // At the mouth, the channel opens into the existing lake basin.
  const bank = bed + (Math.min(base, bed) - bed) * smooth(-18, -14, z);
  return base + (bank - base) * (1 - smooth(bankTop, 7.5, d)) * smooth(spring.z, spring.z + 10, z);
}
