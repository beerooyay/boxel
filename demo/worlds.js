// Azimuth is measured from north toward east. The sky shaders and inspection cameras share these positions.
function skyDirection(azimuth, elevation) {
  const az = azimuth * Math.PI / 180, el = elevation * Math.PI / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}
export const skyBodies = {
  amber: skyDirection(13, 26),
  rose: skyDirection(-141, 40),
  ocean: skyDirection(112, 34),
  ice: skyDirection(-59, 49),
};
const glslDirection = v => `vec3(${v.map(x => x.toFixed(9)).join(', ')})`;

// Project each distant body into its own tangent plane. A visible ring fragment must be
// closer to the viewer than the spherical surface at that pixel.
export const companionWorlds = `
// Every body's visible hemisphere uses the same world-space stellar illumination.
// Low, cool fill keeps the material visible on the night side without moving the terminator.
// Tarn's own air lies in front of every body, the same for all of them: by day their night sides take the sky's blue,
// as a moon does in daylight; by night there is almost none of it.
vec3 gBehind;
vec3 bodyLight(vec3 albedo, vec3 normal, float viewCos, float atmosphere) {
  float incidence = dot(normal, uStarDir);
  float direct = max(incidence, 0.);
  float rim = pow(1. - clamp(viewCos, 0., 1.), 4.) * smoothstep(-0.02, 0.32, incidence);
  return albedo * (vec3(0.014, 0.019, 0.031) + 1.20 * direct)
       + atmosphere * (albedo + 0.12) * rim + gBehind * 0.42;
}

// Ring coordinates are in planet radii. Trace toward the star from the particle
// to tell whether the globe lies between it and the light.
float ringSun(vec3 position) {
  float along = dot(position, uStarDir);
  float miss = length(position - min(0., along) * uStarDir);
  return mix(0.09, 1., smoothstep(0.96, 1.04, miss));
}
vec3 roseClouds(vec3 n) {
  vec2 p = n.xy;
  vec2 storm = (p - vec2(-0.22, -0.20)) * vec2(0.76, 1.35);
  float curl = 4.6 * exp(-dot(storm, storm) * 12.);
  float latitude = p.y + (sin(curl) * storm.x + (cos(curl) - 1.) * storm.y) / 1.35;
  float flow = fbm3(vec2(p.x * 4. - uTime * 0.009, latitude * 8.) + n.z);
  float wave = sin(latitude * 20. + 1.25 * sin(p.x * 5. + latitude * 4.) + flow * 3.);
  vec3 body = mix(vec3(0.68, 0.16, 0.36), vec3(0.96, 0.28, 0.055), smoothstep(-0.7, 0.68, wave));
  float clouds = fbm3(vec2(p.x * 11. - uTime * 0.014, latitude * 30. + flow * 3.));
  body = mix(body, vec3(1., 0.53, 0.65), smoothstep(0.34, 0.72, clouds) * 0.72);
  return mix(body, vec3(1., 0.75, 0.12), smoothstep(0.90, 1., wave) * smoothstep(0.40, 0.65, clouds));
}

// The ocean world, in its own frame (x right, y up, z toward Tarn). It spins about the pole of its first ring.
const vec3 OCEAN_POLE = vec3(-0.194, 0.951, 0.24);
const float RING_TILT = 0.24;
vec3 spin(vec3 v, vec3 k, float a) { return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1. - cos(a)); }
// continents of red desert and pale green, deep seas that pale over their shelves, white caps at the poles
vec3 oceanGround(vec3 p, float lat, out float sea) {
  float land = fbm3(p.xy * 2.3 + 3.1) * 0.5 + fbm3(p.yz * 2.1 - 1.7) * 0.3 + fbm3(p.zx * 2.7 + 5.3) * 0.2;
  land += 0.08 * (vnoise(p.xy * 9. + p.z * 3.) - 0.5);
  sea = 1. - smoothstep(0.495, 0.515, land);
  vec3 deep = mix(vec3(0.01, 0.045, 0.17), vec3(0.03, 0.2, 0.42), smoothstep(0.36, 0.5, land));
  deep = mix(deep, vec3(0.07, 0.42, 0.52), smoothstep(0.47, 0.5, land) * 0.6);
  float wet = fbm3(p.yx * 3.7 + 9.) + 0.25 * (1. - abs(lat));
  vec3 ground = mix(vec3(0.56, 0.16, 0.08), vec3(0.66, 0.36, 0.16), smoothstep(0.35, 0.55, fbm3(p.zy * 6. + 2.)));
  ground = mix(ground, vec3(0.46, 0.72, 0.34), smoothstep(0.55, 0.7, wet));
  ground *= 0.86 + 0.24 * vnoise(p.xz * 18.);
  vec3 c = mix(ground, deep, sea);
  return mix(c, vec3(0.9, 0.93, 0.98), smoothstep(0.8, 0.9, abs(lat) + 0.05 * vnoise(p.xy * 12.)));
}
// weather: three cyclones wind the cloud deck into spirals around clear eyes, trade winds comb the rest into streaks
float oceanClouds(vec3 p) {
  vec3 c[3] = vec3[3](normalize(vec3(0.5, 0.35, 0.8)), normalize(vec3(-0.6, -0.3, 0.7)), normalize(vec3(0.1, -0.55, 0.85)));
  float eye = 1.;
  for (int i = 0; i < 3; i++) {
    float d = 1. - dot(p, c[i]), w = exp(-d * 28.);
    p = spin(p, c[i], w * (5. + float(i)) * (i == 1 ? -1. : 1.));
    eye *= 1. - exp(-d * 900.);
  }
  float lat = dot(p, OCEAN_POLE);
  float deck = fbm3(vec2(p.x * 3.2 + p.z * 2.1, lat * 11.) + 1.3) * 0.65 + fbm3(vec2(p.z * 7. - p.x * 3., lat * 23.)) * 0.35;
  return smoothstep(0.46, 0.7, deck) * eye;
}
// How much of the star a ring lets through to the globe at p (all in planet radii, ring frame rotated by rot): follow
// the light from p to the ring's plane and see whether it crosses the ring there.
float ringShade(vec3 p, vec3 L, mat2 rot) {
  vec3 pr = vec3(rot * p.xy, p.z), lr = vec3(rot * L.xy, L.z), nr = vec3(0., sqrt(1. - RING_TILT * RING_TILT), RING_TILT);
  float den = dot(lr, nr); if (abs(den) < 1e-4) return 1.;
  float t = -dot(pr, nr) / den; if (t <= 0.) return 1.;
  float rho = length(pr + lr * t);
  float cover = smoothstep(1.27, 1.32, rho) * (1. - smoothstep(1.94, 2., rho)) * (1. - 0.85 * smoothstep(1.61, 1.65, rho) * (1. - smoothstep(1.69, 1.72, rho)));
  return 1. - 0.62 * cover;
}
vec3 oceanWorld(vec3 n, vec3 normal, vec3 right, vec3 up, vec3 axis) {
  vec3 L = vec3(dot(uStarDir, right), dot(uStarDir, up), -dot(uStarDir, axis));
  vec3 pole = normalize(OCEAN_POLE);
  vec3 p = spin(n, pole, uTime * 0.01), pc = spin(n, pole, uTime * 0.016);
  float sea, lat = dot(n, pole);
  vec3 ground = oceanGround(p, lat, sea);
  float cloud = oceanClouds(pc), shadow = oceanClouds(spin(n - L * 0.025, pole, uTime * 0.016));
  ground *= 1. - 0.45 * shadow * (1. - cloud);
  vec3 surf = mix(ground, vec3(0.96, 0.97, 1.), cloud * 0.92);
  mat2 ra = mat2(0.98, -0.20, 0.20, 0.98), rb = mat2(0., -1., 1., 0.) * ra;
  float rings = ringShade(n, L, ra) * ringShade(n, L, rb);
  float viewCos = n.z, incidence = dot(normal, uStarDir);
  vec3 c = bodyLight(surf * rings, normal, viewCos, 0.);
  // the star's glint on open water, and the blue of the air thickening toward the edge
  vec3 h = normalize(uStarDir - axis);
  c += vec3(1., 0.94, 0.84) * pow(max(dot(normal, h), 0.), 90.) * sea * (1. - cloud) * rings * 0.9;
  c += vec3(0.3, 0.55, 1.) * pow(1. - viewCos, 2.4) * smoothstep(-0.15, 0.35, incidence) * 0.5;
  return c;
}
vec3 ringLayer(vec3 sky, vec2 q, float surfaceZ, vec3 tint, vec3 planeXY, vec3 axis) {
  const float tilt = 0.24;
  float radius = length(vec2(q.x, q.y / tilt));
  float coverage = smoothstep(1.27, 1.32, radius) * (1. - smoothstep(1.94, 2., radius));
  float gap = smoothstep(1.61, 1.65, radius) * (1. - smoothstep(1.69, 1.72, radius));
  float depth = -q.y * sqrt(1. - tilt * tilt) / tilt;
  float grain = 0.74 + 0.15 * sin(radius * 62.) + 0.09 * sin(radius * 117.);
  return mix(sky, tint * grain * ringSun(planeXY - depth * axis), coverage * (1. - 0.85 * gap) * step(surfaceZ, depth) * 0.76);
}

vec3 companion(vec3 d, vec3 sky, vec3 axis, float radius, bool ocean) {
  float facing = dot(d, axis);
  if (facing < 0.95) return sky;
  vec3 right = normalize(cross(axis, vec3(0., 1., 0.))), up = cross(right, axis);
  vec2 q = vec2(dot(d, right), dot(d, up)) / (facing * radius);
  float r2 = dot(q, q), surfaceZ = -3.;
  if (r2 < 1.) {
    surfaceZ = sqrt(1. - r2);
    vec3 n = vec3(q, surfaceZ);
    vec3 normal = right * n.x + up * n.y - axis * n.z;
    if (ocean) sky = oceanWorld(n, normal, right, up, axis);
    else sky = bodyLight(roseClouds(n), normal, n.z, 0.08);
  } else if (ocean) {
    // a thin edge of air just past the limb, on the side the star lights
    float lit = smoothstep(-0.2, 0.5, dot(normalize(right * q.x + up * q.y), uStarDir));
    sky += vec3(0.3, 0.55, 1.) * exp(-(sqrt(r2) - 1.) * 45.) * lit * 0.22;
  }
  if (ocean && r2 < 4.1) {
    vec2 r = mat2(0.98, -0.20, 0.20, 0.98) * q;
    vec2 v = vec2(r.y, -r.x);
    // Paint the farther of the two ring planes first at their crossings.
    bool horizontalFirst = r.y > v.y;
    vec3 silver = vec3(0.54, 0.63, 0.72), copper = vec3(0.62, 0.45, 0.38);
    vec3 planeXY = right * q.x + up * q.y;
    sky = ringLayer(sky, horizontalFirst ? r : v, surfaceZ, horizontalFirst ? silver : copper, planeXY, axis);
    sky = ringLayer(sky, horizontalFirst ? v : r, surfaceZ, horizontalFirst ? copper : silver, planeXY, axis);
  }
  return sky;
}
const vec3 ICE_DIR = ${glslDirection(skyBodies.ice)}, ROSE_DIR = ${glslDirection(skyBodies.rose)}, OCEAN_DIR = ${glslDirection(skyBodies.ocean)};
vec3 companions(vec3 d, vec3 sky) {
  sky = companion(d, sky, ROSE_DIR, 0.198, false);
  return companion(d, sky, OCEAN_DIR, 0.143, true);
}
`;
