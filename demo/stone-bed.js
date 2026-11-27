// Fit the rigid underside against the triangles the walker actually sees.
// Reject a ledge if one side of the footprint would hang free or disappear.
export function stoneBed(ground, x, z, sx, sy, sz, yaw, kind) {
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
  return { gx, gz };
}

// Clip a rock face to one terrain triangle in barycentric coordinates. The
// third component is the vertical lift needed at that point. It is linear on
// the overlap polygon, so its maximum is attained at one of the clipped vertices.
function clipEdge(src, count, dst, edge) {
  let used = 0, prev = 3 * (count - 1);
  for (let i = 0; i < 3 * count; i += 3) {
    const a = edge < 2 ? src[prev + edge] : 1 - src[prev] - src[prev + 1];
    const b = edge < 2 ? src[i + edge] : 1 - src[i] - src[i + 1];
    if ((a < 0) !== (b < 0)) {
      const t = a / (a - b);
      for (let j = 0; j < 3; j++) dst[used++] = src[prev+j] + t * (src[i+j] - src[prev+j]);
    }
    if (b >= 0) for (let j = 0; j < 3; j++) dst[used++] = src[i+j];
    prev = i;
  }
  return used / 3;
}

// Drop a closed rigid mesh straight down after orienting it to the local bed.
// Piecewise-planar terrain can hit the middle of a rock face or edge before
// any of its vertices. Use the actual render triangles at each detail level.
export function stoneDrop(terrain, stride, coord, ground) {
  const cell = x => Math.max(0, Math.min(stride - 2, Math.floor(coord(x))));
  const polygon = new Float64Array(24), scratch = new Float64Array(24);
  let vertices = new Float64Array(0);
  return function drop(mesh, x, z, sx, sy, sz, yaw, seed, { gx, gz }) {
    // Same interpolation and orthonormal frame as the stone vertex shader.
    const form = Math.min(2.999999, Math.fround(Math.fround(seed) * 3));
    const primary = Math.floor(form), t = form - primary;
    const A = mesh.pos[primary], B = mesh.pos[(primary + 1) % 3];
    if (vertices.length < 4 * A.length / 3) vertices = new Float64Array(4 * A.length / 3);
    const c = Math.cos(yaw), s = Math.sin(yaw), alongGrade = gx*c + gz*s;
    const along = Math.hypot(1, alongGrade), up = Math.hypot(1, gx, gz);
    const ax = c/along, ay = alongGrade/along, az = s/along;
    const ux = -gx/up, uy = 1/up, uz = -gz/up;
    const bx = ay*uz - az*uy, by = az*ux - ax*uz, bz = ax*uy - ay*ux;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    let sum0 = Infinity, sum1 = -Infinity, diff0 = Infinity, diff1 = -Infinity;
    let low = Infinity, lowest = 0;
    for (let i = 0, k = 0; i < A.length; i += 3, k += 4) {
      const px = sx*(A[i] + t*(B[i] - A[i]));
      const py = sy*(A[i+1] + t*(B[i+1] - A[i+1]));
      const pz = sz*(A[i+2] + t*(B[i+2] - A[i+2]));
      const wx = x + ax*px + ux*py + bx*pz, wz = z + az*px + uz*py + bz*pz;
      vertices[k] = wx; vertices[k+1] = ay*px + uy*py + by*pz; vertices[k+2] = wz;
      vertices[k+3] = py*up; // height above the tilted plane through (x, 0, z)
      x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); z0 = Math.min(z0, wz); z1 = Math.max(z1, wz);
      sum0 = Math.min(sum0, wx+wz); sum1 = Math.max(sum1, wx+wz);
      diff0 = Math.min(diff0, wx-wz); diff1 = Math.max(diff1, wx-wz);
      if (vertices[k+3] < low) { low = vertices[k+3]; lowest = k; }
    }
    const contact = { x0, x1, z0, z1, sum0, sum1, diff0, diff1, y: 0 };
    let lift = ground(vertices[lowest], vertices[lowest+2]) - vertices[lowest+1];
    let roof = -Infinity;
    const right = cell(x1) + 1, back = cell(z1) + 1;
    for (let j = cell(z0); j <= back; j++) for (let i = cell(x0); i <= right; i++) {
      const k = 3*(j*stride + i);
      roof = Math.max(roof, terrain[k+1] - gx*(terrain[k]-x) - gz*(terrain[k+2]-z));
    }
    // A single plane (the usual pebble bed) settles to submillimetre accuracy
    // without clipping a single triangle. The upper bound also skips high faces.
    if (roof - low <= lift + 0.00025) {
      contact.y = roof - low;
      return contact;
    }
    for (const indices of mesh.levels) for (let n = 0; n < indices.length; n += 3) {
      const a = 4*indices[n], b = 4*indices[n+1], c = 4*indices[n+2];
      if (roof - Math.min(vertices[a+3], vertices[b+3], vertices[c+3]) <= lift) continue;
      const il = cell(Math.min(vertices[a], vertices[b], vertices[c]));
      const ir = cell(Math.max(vertices[a], vertices[b], vertices[c]));
      const jl = cell(Math.min(vertices[a+2], vertices[b+2], vertices[c+2]));
      const jr = cell(Math.max(vertices[a+2], vertices[b+2], vertices[c+2]));
      for (let j = jl; j <= jr; j++) for (let i = il; i <= ir; i++) {
        const k = 3*(j*stride + i), next = k + 3*stride;
        const dx = terrain[k+3] - terrain[k], dz = terrain[next+2] - terrain[k+2];
        for (let half = 0; half < 2; half++) {
          const origin = half ? next + 3 : k, h = terrain[origin+1];
          const du = terrain[(half ? next : k+3)+1] - h, dv = terrain[(half ? k+3 : next)+1] - h;
          const sign = half ? -1 : 1;
          for (let v = 0; v < 3; v++) {
            const p = 4*indices[n+v];
            const u = sign*(vertices[p] - terrain[origin])/dx, w = sign*(vertices[p+2] - terrain[origin+2])/dz;
            polygon[3*v] = u; polygon[3*v+1] = w;
            polygon[3*v+2] = h + du*u + dv*w - vertices[p+1];
          }
          if (Math.max(polygon[2], polygon[5], polygon[8]) <= lift) continue;
          const m = clipEdge(polygon, 3, scratch, 0);
          const l = clipEdge(scratch, m, polygon, 1);
          const count = clipEdge(polygon, l, scratch, 2);
          for (let v = 0; v < count; v++) lift = Math.max(lift, scratch[3*v+2]);
        }
      }
    }
    contact.y = lift;
    return contact;
  };
}

// Projected bounds on the two map axes and their diagonals enclose the actual
// tilted stone at every detail level. A separating interval guarantees a gap.
export function stoneSpacing() {
  const bins = new Map(), width = 4;
  return function reserve(stone, embedded = false) {
    const keys = [];
    for (let j = Math.floor(stone.z0/width); j <= Math.floor(stone.z1/width); j++) {
      for (let i = Math.floor(stone.x0/width); i <= Math.floor(stone.x1/width); i++) {
        const key = i + ',' + j;
        keys.push(key);
        if (embedded) continue;
        for (const other of bins.get(key) || []) {
          if (stone.x1 <= other.x0 || stone.x0 >= other.x1 || stone.z1 <= other.z0 || stone.z0 >= other.z1) continue;
          if (stone.sum1 <= other.sum0 || stone.sum0 >= other.sum1 || stone.diff1 <= other.diff0 || stone.diff0 >= other.diff1) continue;
          return false;
        }
      }
    }
    for (const key of keys) {
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(stone);
    }
    return true;
  };
}
