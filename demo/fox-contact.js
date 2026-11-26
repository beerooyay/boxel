// The collision volume is in the fox's posed, metre-scaled frame. Each
// scanline accumulates oriented crossings of the current skinned triangles.
export const CONTACT_CELL = 0.035;
export const CONTACT_SIZE = [32, 44, 72];
export const CONTACT_ORIGIN = [-0.56, -0.28, -1.26];

export function contactVolume(size = CONTACT_SIZE, origin = CONTACT_ORIGIN, cell = CONTACT_CELL) {
  const [nx, ny, nz] = size, plane = nx * ny, count = plane * nz;
  const crossings = new Int16Array(count), inside = new Uint8Array(count);
  const queue = new Uint32Array(count), source = new Int32Array(count);
  const bytes = new Uint8Array(4 * count);
  const coordinate = (value, axis) => (value - origin[axis]) / cell - 0.5;
  let occupied = 0;
  const steps = [-1, 1, -nx, nx, -plane, plane];

  function raster(positions, indices) {
    for (let i = 0; i < indices.length; i += 3) {
      const a = 3*indices[i], b = 3*indices[i+1], c = 3*indices[i+2];
      const ay = coordinate(positions[a+1], 1), az = coordinate(positions[a+2], 2);
      const by = coordinate(positions[b+1], 1), bz = coordinate(positions[b+2], 2);
      const cy = coordinate(positions[c+1], 1), cz = coordinate(positions[c+2], 2);
      const uy = by-ay, uz = bz-az, vy = cy-ay, vz = cz-az;
      const determinant = uy*vz - uz*vy;
      if (Math.abs(determinant) < 1e-8) continue;
      const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))), y1 = Math.min(ny-1, Math.floor(Math.max(ay, by, cy)));
      const z0 = Math.max(0, Math.ceil(Math.min(az, bz, cz))), z1 = Math.min(nz-1, Math.floor(Math.max(az, bz, cz)));
      const x0 = positions[a], dx1 = positions[b]-x0, dx2 = positions[c]-x0;
      const sign = determinant > 0 ? 1 : -1, inverse = 1/determinant;
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          // The fixed sub-voxel offset keeps neighbouring triangles from
          // counting a shared edge twice, even in a symmetric idle pose.
          const py = y-ay+1e-6, pz = z-az+3e-6;
          const u = (py*vz-pz*vy)*inverse, v = (uy*pz-uz*py)*inverse;
          if (u < 0 || v < 0 || u+v > 1) continue;
          const x = Math.max(0, Math.ceil(coordinate(x0 + u*dx1 + v*dx2, 0)));
          if (x < nx) crossings[x + nx*y + plane*z] += sign;
        }
      }
    }
  }

  function update(surfaces) {
    crossings.fill(0);
    inside.fill(0);
    source.fill(-1);
    bytes.fill(0);
    occupied = 0;
    for (const { positions, indices } of surfaces) raster(positions, indices);
    // Leave a clear voxel border for the texture sampler and the escape search.
    for (let z = 1; z < nz-1; z++) {
      for (let y = 1; y < ny-1; y++) {
        const lane = nx*y + plane*z;
        let wind = 0;
        for (let x = 0; x < nx; x++) wind += crossings[lane+x];
        if (wind !== 0) continue; // an open or clipped scanline cannot enclose a solid
        wind = crossings[lane];
        for (let x = 1; x < nx-1; x++) {
          wind += crossings[lane+x];
          if (wind) inside[lane+x] = 1;
        }
      }
    }
    let head = 0, tail = 0;
    for (let z = 1; z < nz-1; z++) {
      for (let y = 1; y < ny-1; y++) {
        for (let x = 1; x < nx-1; x++) {
          const i = x + nx*y + plane*z;
          if (!inside[i]) continue;
          occupied++;
          for (const step of steps) {
            if (inside[i+step]) continue;
            source[i] = i+step;
            queue[tail++] = i;
            break;
          }
        }
      }
    }
    while (head < tail) {
      const i = queue[head++], exit = source[i];
      for (const step of steps) {
        const k = i+step;
        if (!inside[k] || source[k] !== -1) continue;
        source[k] = exit;
        queue[tail++] = k;
      }
      const dx = exit%nx - i%nx;
      const dy = Math.floor(exit/nx)%ny - Math.floor(i/nx)%ny;
      const dz = Math.floor(exit/plane) - Math.floor(i/plane);
      // Premultiply by occupancy; a trilinear lookup at the surface can then
      // interpolate with a zero texel and reconstruct the local escape vector.
      bytes[4*i] = 128 + dx*4;
      bytes[4*i+1] = 128 + dy*4;
      bytes[4*i+2] = 128 + dz*4;
      bytes[4*i+3] = 255;
    }
    return bytes;
  }

  return { update, get occupied() { return occupied; } };
}

export const contactGLSL = `
uniform highp sampler3D uFoxVolume;
uniform mat3 uContactBasis;
uniform vec3 uContactOrigin;
uniform bool uContactEnabled, uMarkContact, uStillGrass;
const vec3 CONTACT_MIN = vec3(${CONTACT_ORIGIN.join(',')});
const vec3 CONTACT_EXTENT = vec3(${CONTACT_SIZE.map(n => (n*CONTACT_CELL).toFixed(4)).join(',')});
const float CONTACT_STEP = ${CONTACT_CELL};

vec3 surfaceEscape(vec3 p) {
  vec3 uv = (transpose(uContactBasis) * (p-uContactOrigin) - CONTACT_MIN) / CONTACT_EXTENT;
  if (any(lessThan(uv, vec3(0.))) || any(greaterThan(uv, vec3(1.)))) return vec3(0.);
  vec4 sampleV = textureLod(uFoxVolume, uv, 0.);
  if (sampleV.a <= 0.44) return vec3(0.);
  vec3 direction = (sampleV.rgb * 255. / sampleV.a - 128.) * 0.25;
  float distance = length(direction);
  if (distance < 0.0001) return vec3(0.);
  float clearance = max(0., (distance - 1. + sampleV.a)) * CONTACT_STEP + 0.008;
  return uContactBasis * (direction * (clearance/distance) * smoothstep(0.44, 0.62, sampleV.a));
}

vec3 longestEscape(vec3 a, vec3 b) { return dot(a,a) > dot(b,b) ? a : b; }

vec3 bladeArc(float arc, float curvature, vec2 lean, float t) {
  float angle = curvature*t;
  float sideways = angle < 0.04 ? 0.5*angle : (1.-cos(angle))/angle;
  float upright = angle < 0.04 ? 1.-angle*angle/6. : sin(angle)/angle;
  return arc*t*vec3(lean.x*sideways, upright, lean.y*sideways);
}

vec3 aroundSurface(vec3 root, vec3 edge, vec2 lean, float arc, float curvature,
                   int row, int rows, out vec3 tangent, out float contact) {
  // Every rendered row integrates the same chain from its fixed root.
  // After contact, project the segment back onto its original-length sphere.
  vec3 joint = root, original = vec3(0.);
  tangent = vec3(0., 1., 0.);
  contact = 0.;
  for (int j = 1; j <= row; j++) {
    float t = float(j)/float(rows);
    vec3 rest = bladeArc(arc, curvature, lean, t);
    vec3 delta = rest-original;
    vec3 candidate = joint+delta;
    float segment = max(length(delta), 0.00001);
    float radius = (0.43 + 0.57*smoothstep(0., 0.27, t)) * pow(1.-t, 0.75);
    vec3 width = edge*radius;
    float hit = 0.;
    for (int pass = 0; pass < 3; pass++) {
      vec3 escape = longestEscape(surfaceEscape(candidate + width), surfaceEscape(candidate - width));
      escape = longestEscape(escape, surfaceEscape(candidate));
      // A paw can cross the segment between two rows. Sample the middle as
      // well, then give the end enough leverage to move that crossing.
      escape = longestEscape(escape, surfaceEscape((joint+candidate)*0.5)*1.30);
      float amount = length(escape);
      if (amount < 0.00035) break;
      hit = max(hit, amount);
      vec3 step = candidate + escape - joint;
      float reach = max(length(step), 0.00001);
      candidate = joint + step*(segment/reach);
    }
    tangent = normalize(candidate - joint + vec3(0., 0.0000001, 0.));
    joint = candidate;
    original = rest;
    contact = max(hit, contact * 0.55);
  }
  return joint;
}
`;
