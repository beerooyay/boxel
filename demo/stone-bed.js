// Fit the rigid underside against the triangles the walker actually sees.
// Reject a ledge if one side of the footprint would hang free or disappear.
export function seatStone(ground, x, z, sx, sy, sz, yaw, kind) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    a = 0.72 * sx,
    b = 0.72 * sz;
  const y = ground(x, z);
  const along = (ground(x + c * a, z + s * a) - ground(x - c * a, z - s * a)) / (2 * a);
  const across = (ground(x - s * b, z + c * b) - ground(x + s * b, z - c * b)) / (2 * b);
  const gx = along * c - across * s,
    gz = along * s + across * c,
    grade = Math.hypot(gx, gz);
  if (grade > (kind === 2 ? 0.34 : kind === 3 ? 0.65 : 0.86)) return null;
  const tolerance = 0.008 + 0.13 * Math.min(sy, Math.max(sx, sz));
  for (let k = 0; k < 8; k++) {
    const angle = (k * Math.PI) / 4,
      u = a * Math.cos(angle),
      v = b * Math.sin(angle);
    const dx = c * u - s * v,
      dz = s * u + c * v;
    if (Math.abs(ground(x + dx, z + dz) - y - gx * dx - gz * dz) > tolerance) return null;
  }
  return { y: y + 0.196 * sy * Math.hypot(1, grade), gx, gz };
}

// Boulders often share a deposit. Keep the stones close without letting one
// mesh grow through its neighbour. Insert each footprint into every bin it spans.
export function stoneSpacing() {
  const bins = new Map(),
    width = 4;
  return function reserve(x, z, sx, sz, yaw) {
    const radius = Math.max(sx, sz),
      keys = [],
      c = Math.cos(yaw),
      s = Math.sin(yaw);
    for (let j = Math.floor((z - radius) / width); j <= Math.floor((z + radius) / width); j++)
      for (let i = Math.floor((x - radius) / width); i <= Math.floor((x + radius) / width); i++) {
        const key = i + ',' + j;
        keys.push(key);
        for (const other of bins.get(key) || []) {
          const dx = x - other.x,
            dz = z - other.z,
            d = Math.hypot(dx, dz);
          if (d > radius + other.radius) continue;
          if (!d) return false;
          const a = dx / d,
            b = dz / d;
          const reach = Math.hypot(sx * (c * a + s * b), sz * (c * b - s * a));
          const theirs = Math.hypot(other.sx * (other.c * a + other.s * b), other.sz * (other.c * b - other.s * a));
          if (d < 0.98 * (reach + theirs)) return false;
        }
      }
    const stone = { x, z, sx, sz, c, s, radius };
    for (const key of keys) {
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(stone);
    }
    return true;
  };
}
