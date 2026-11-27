// The collision volume is in the fox's posed, metre-scaled frame. Each
// scanline accumulates oriented crossings of the current skinned triangles.
export const CONTACT_CELL = 0.035;
export const CONTACT_SIZE = [32, 44, 72];
export const CONTACT_ORIGIN = [-0.56, -0.28, -1.26];

export function contactVolume(size = CONTACT_SIZE, origin = CONTACT_ORIGIN, cell = CONTACT_CELL) {
  const [nx, ny, nz] = size, plane = nx * ny, count = plane * nz;
  const crossings = new Int16Array(count), inside = new Uint8Array(count);
  const queue = new Uint32Array(count), source = new Int32Array(count);
  const solid = new Uint32Array(count);
  const firstX = new Int32Array(ny*nz), lastX = new Int32Array(ny*nz);
  const bytes = new Uint8Array(4 * count);
  const coordinate = (value, axis) => (value - origin[axis]) / cell - 0.5;
  let occupied = 0;
  const bounds = new Int32Array(6);
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
          if (x < nx) {
            const line = y + ny*z;
            crossings[x + nx*line] += sign;
            firstX[line] = Math.min(firstX[line], x);
            lastX[line] = Math.max(lastX[line], x);
          }
        }
      }
    }
  }

  function update(surfaces) {
    crossings.fill(0);
    for (let k = 0; k < occupied; k++) {
      const i = solid[k];
      inside[i] = 0;
      bytes.fill(0, 4*i, 4*i+4);
    }
    firstX.fill(nx);
    lastX.fill(-1);
    occupied = 0;
    bounds.set([nx, ny, nz, 0, 0, 0]);
    for (const { positions, indices } of surfaces) raster(positions, indices);
    // Leave a clear voxel border for the texture sampler and the escape search.
    for (let z = 1; z < nz-1; z++) {
      for (let y = 1; y < ny-1; y++) {
        const line = y + ny*z, first = firstX[line], last = lastX[line];
        if (last <= first) continue;
        const lane = nx*line;
        let wind = 0;
        for (let x = first; x <= last; x++) wind += crossings[lane+x];
        if (wind !== 0) continue; // an open or clipped scanline cannot enclose a solid
        if (first === 0) wind = crossings[lane];
        for (let x = Math.max(1, first); x < last; x++) {
          wind += crossings[lane+x];
          if (!wind) continue;
          const i = lane+x;
          inside[i] = 1;
          source[i] = -1;
          solid[occupied++] = i;
          bounds[0] = Math.min(bounds[0],x); bounds[1] = Math.min(bounds[1],y); bounds[2] = Math.min(bounds[2],z);
          bounds[3] = Math.max(bounds[3],x+1); bounds[4] = Math.max(bounds[4],y+1); bounds[5] = Math.max(bounds[5],z+1);
        }
      }
    }
    let head = 0, tail = 0;
    for (let k = 0; k < occupied; k++) {
      const i = solid[k];
      for (const step of steps) {
        if (inside[i+step]) continue;
        source[i] = i+step;
        queue[tail++] = i;
        break;
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

  return { update, bounds, get occupied() { return occupied; } };
}

export const contactGLSL = `
uniform highp sampler3D uFoxVolume;
uniform mat3 uContactBasis;
uniform vec3 uContactOrigin;

const vec3 CONTACT_MIN = vec3(${CONTACT_ORIGIN.join(',')});
const vec3 CONTACT_EXTENT = vec3(${CONTACT_SIZE.map(n => (n*CONTACT_CELL).toFixed(4)).join(',')});
const float CONTACT_STEP = ${CONTACT_CELL};

uniform float uContactScale;
vec3 surfaceEscape(vec3 p) {
  vec3 uv = (transpose(uContactBasis) * (p-uContactOrigin) / uContactScale - CONTACT_MIN) / CONTACT_EXTENT;
  if (any(lessThan(uv, vec3(0.))) || any(greaterThan(uv, vec3(1.)))) return vec3(0.);
  vec4 sampleV = textureLod(uFoxVolume, uv, 0.);
  if (sampleV.a <= 0.44) return vec3(0.);
  vec3 direction = (sampleV.rgb * 255. / sampleV.a - 128.) * 0.25;
  float distance = length(direction);
  if (distance < 0.0001) return vec3(0.);
  float clearance = max(0., (distance - 1. + sampleV.a)) * CONTACT_STEP * uContactScale + 0.008;
  return uContactBasis * (direction * (clearance/distance) * smoothstep(0.44, 0.62, sampleV.a));
}

vec3 longestEscape(vec3 a, vec3 b) { return dot(a,a) > dot(b,b) ? a : b; }

vec3 bladeArc(float arc, float curvature, vec2 lean, float t) {
  float angle = curvature*t;
  float sideways = angle < 0.04 ? 0.5*angle : (1.-cos(angle))/angle;
  float upright = angle < 0.04 ? 1.-angle*angle/6. : sin(angle)/angle;
  return arc*t*vec3(lean.x*sideways, upright, lean.y*sideways);
}

`;
