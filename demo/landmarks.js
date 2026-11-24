// Shared by terrain generation, water rendering, placement and wading. All distances are metres.
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

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
const reach = 7;
const trailBins = new Map();
for (const points of [trail, ...Object.values(valleyWalks)]) {
  for (let i = 1; i < points.length; i++) {
    const [x, z] = points[i - 1], [bx, bz] = points[i], dx = bx - x, dz = bz - z;
    const segment = { x, z, dx, dz, length2: dx * dx + dz * dz };
    for (let j = Math.floor((Math.min(z, bz) - reach) / 8); j <= Math.floor((Math.max(z, bz) + reach) / 8); j++) {
      for (let k = Math.floor((Math.min(x, bx) - reach) / 8); k <= Math.floor((Math.max(x, bx) + reach) / 8); k++) {
        const key = j * 32 + k;
        if (!trailBins.has(key)) trailBins.set(key, []);
        trailBins.get(key).push(segment);
      }
    }
  }
}
export function trailDistance(x, z) {
  if (Math.abs(x) > 64 || Math.abs(z) > 64) return reach;
  const segments = trailBins.get(Math.floor(z / 8) * 32 + Math.floor(x / 8));
  if (!segments) return reach;
  let nearest2 = reach * reach;
  for (const s of segments) {
    const u = Math.max(0, Math.min(1, ((x - s.x) * s.dx + (z - s.z) * s.dz) / s.length2));
    const dx = x - s.x - u * s.dx, dz = z - s.z - u * s.dz;
    nearest2 = Math.min(nearest2, dx * dx + dz * dz);
  }
  return Math.sqrt(nearest2);
}
export function trailCover(x, z) {
  const lookout = 1 - smooth(1.8, 3, Math.hypot(x - summit[0], z - summit[1]));
  return Math.max(lookout, 1 - smooth(0.56, 1.18, trailDistance(x, z)));
}

export function riverX(z) {
  return -5 + 3.4 * Math.sin(z * 0.13) + 1.4 * Math.sin(z * 0.29 + 0.8);
}
function riverDistance(x, z) {
  return Math.hypot(x - riverX(Math.max(-69, Math.min(-8, z))), Math.max(0, -69 - z, z + 8));
}
function riverLevel(z) {
  return Math.max(0, -z - 12) * 0.055 + 1.15 * (1 - smooth(-49, -44, z));
}
export function waterLevel(x, z) {
  if (x < -15 || x > 5 || z < -73 || z > -8) return 0;
  return riverDistance(x, z) < 3.6 ? riverLevel(Math.max(-69, z)) : 0;
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
  if (x < -20 || x > 8 || z < -77 || z > -4) return base;
  const d = riverDistance(x, z), level = riverLevel(Math.max(-69, z));
  // A shallow gravel ford just upstream of the lake connects both sides of
  // the watershed. Its longer banks can be climbed straight out of the water.
  const ford = 1 - smooth(1.3, 4.6, Math.abs(z + 25));
  const bankToe = 1.2 - 0.6 * ford, bankTop = 3.4 + 0.7 * ford;
  const bed = level - 0.58 + 0.26 * ford + (1.65 - 0.30 * ford) * smooth(bankToe, bankTop, d);
  // At the mouth, the channel opens into the existing lake basin.
  const bank = bed + (Math.min(base, bed) - bed) * smooth(-18, -14, z);
  return base + (bank - base) * (1 - smooth(bankTop, 7.5, d));
}
