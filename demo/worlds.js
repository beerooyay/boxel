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
vec3 bodyLight(vec3 albedo, vec3 normal, float viewCos, float atmosphere) {
  float incidence = dot(normal, uStarDir);
  float direct = max(incidence, 0.);
  float rim = pow(1. - clamp(viewCos, 0., 1.), 4.) * smoothstep(-0.02, 0.32, incidence);
  return albedo * (vec3(0.014, 0.019, 0.031) + 1.20 * direct)
       + atmosphere * (albedo + 0.12) * rim;
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

vec3 oceanGround(vec3 n) {
  vec2 map = n.xy * 2.85 + n.z * vec2(0.55, -0.8);
  float land = fbm3(map + fbm3(map * 1.8));
  vec3 sea = mix(vec3(0.012, 0.07, 0.28), vec3(0.028, 0.36, 0.57), smoothstep(0.18, 0.47, land));
  vec3 soil = mix(vec3(0.62, 0.105, 0.055), vec3(0.52, 0.76, 0.32), smoothstep(0.32, 0.59, fbm3(map * 2.3 + 8.)));
  return mix(sea, soil, smoothstep(0.47, 0.51, land));
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
    vec3 surface = ocean ? oceanGround(n) : roseClouds(n);
    sky = bodyLight(surface, normal, n.z, 0.08);
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
const vec3 ICE_DIR = ${glslDirection(skyBodies.ice)};
vec3 companions(vec3 d, vec3 sky) {
  sky = companion(d, sky, ${glslDirection(skyBodies.rose)}, 0.198, false);
  return companion(d, sky, ${glslDirection(skyBodies.ocean)}, 0.143, true);
}
`;
