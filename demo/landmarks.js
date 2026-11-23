// Shared by terrain generation, water rendering, placement and wading. All distances are metres.
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const summit = [-41, -35];
const hills = [
  // centre, footprint radii, prominence, spur direction
  [...summit, 30, 30, 23, 0.7],
  [-43, 17, 12, 16, 5.4, 1.3],
  [34, 39, 14, 12, 6.4, 0.4],
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
const segments = trail.slice(1).map(([bx, bz], i) => {
  const [x, z] = trail[i], dx = bx - x, dz = bz - z;
  return { x, z, dx, dz, length2: dx * dx + dz * dz,
    left: Math.min(x, bx) - 4, right: Math.max(x, bx) + 4,
    near: Math.min(z, bz) - 4, far: Math.max(z, bz) + 4 };
});
function trailDistance(x, z) {
  let nearest = 4;
  if (x < summit[0] - 34 || x > summit[0] + 34 || z < summit[1] - 34 || z > summit[1] + 34) return nearest;
  for (const s of segments) {
    if (x < s.left || x > s.right || z < s.near || z > s.far) continue;
    const u = Math.max(0, Math.min(1, ((x - s.x) * s.dx + (z - s.z) * s.dz) / s.length2));
    nearest = Math.min(nearest, Math.hypot(x - s.x - u * s.dx, z - s.z - u * s.dz));
  }
  return nearest;
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
    const grade = 1.6 + 24.4 * (1 - smooth(2.8, startRadius, radius));
    const path = 1 - smooth(0.85, 4, trailDistance(x, z));
    base += (grade - base) * Math.max(path, 1 - smooth(2, 4, radius));
  }
  if (x < -20 || x > 8 || z < -77 || z > -4) return base;
  const d = riverDistance(x, z), level = riverLevel(Math.max(-69, z));
  const bed = level - 0.58 + 1.65 * smooth(1.2, 3.4, d);
  // At the mouth, the channel opens into the existing lake basin.
  const bank = bed + (Math.min(base, bed) - bed) * smooth(-18, -14, z);
  return base + (bank - base) * (1 - smooth(3.4, 7.5, d));
}
