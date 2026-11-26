// Shared by the terrain vertex shader and the material fragment shaders.
export const valleyAir = `
uniform vec3 uCam, uStarDir, uPlanetDir, uStarTint;
uniform float uNight, uStorm, uFlash;
const vec3 STAR_COL = vec3(2.7, 1.9, 1.35);
vec3 skyBase(vec3 d){
  float h = d.y;
  vec3 c = mix(vec3(0.34, 0.415, 0.54), vec3(0.025, 0.112, 0.276), smoothstep(-0.055, 0.31, h));
  c = mix(c, vec3(0.009, 0.046, 0.148), smoothstep(0.16, 0.86, h));
  // As the star sinks the day sky dims and cools, a band of fire lies along the horizon under it, and a rose belt
  // rises opposite. None of it shows while the star stands at its hand-set afternoon height or above.
  float low = 1. - smoothstep(0.03, 0.36, uStarDir.y);
  if (low > 0.) {
    vec2 across = d.xz / max(length(d.xz), 1e-3), under = uStarDir.xz / max(length(uStarDir.xz), 1e-3);
    float toward = dot(across, under), dusk = low * low;
    c *= mix(vec3(1.), vec3(0.6, 0.6, 0.76), dusk);
    c += vec3(1.05, 0.44, 0.16) * dusk * pow(max(toward, 0.), 2.) * (1. - smoothstep(-0.03, 0.30, h)) * 0.55;
    c += vec3(0.36, 0.20, 0.32) * dusk * pow(max(-toward, 0.), 1.5) * smoothstep(-0.02, 0.05, h) * (1. - smoothstep(0.05, 0.3, h)) * 0.3;
  }
  vec3 n = mix(vec3(0.030, 0.040, 0.088), vec3(0.008, 0.014, 0.047), smoothstep(0.0, 0.35, h));
  n = mix(n, vec3(0.0018, 0.003, 0.014), smoothstep(0.28, 0.94, h));
  c = mix(c, n, uNight);
  float s = max(dot(d, uStarDir), 0.);
  c += STAR_COL * uStarTint * (1. - uNight) * (0.05 * pow(s, 5.) + 0.25 * pow(s, 60.));
  c += vec3(0.10, 0.08, 0.20) * pow(max(dot(d, uPlanetDir), 0.), 4.) * mix(0.07,0.5,uNight);
  // A storm closes the sky over in grey. Lightning lights the whole of it at once.
  vec3 overcast = mix(vec3(0.17, 0.19, 0.22), vec3(0.27, 0.29, 0.33), smoothstep(-0.05, 0.45, h)) * (1. - 0.9 * uNight);
  c = mix(c, overcast, uStorm * 0.88) + vec3(0.2, 0.23, 0.36) * uFlash * (0.35 + 0.65 * smoothstep(-0.1, 0.4, h));
  return mix(c, vec3(0.05, 0.04, 0.08), (1. - smoothstep(-0.25, 0.0, h)));
}
// Afternoon warmth disperses the shallow inversion. Storm cover and dusk let it reform.
float clearAfternoon(){ return (1. - uNight) * (1. - uStorm) * smoothstep(0.055, 0.34, uStarDir.y); }
// RGB is incident scattered light. Alpha is transmission along this sightline.
vec4 airAt(vec3 wp){
  vec3 d = wp - uCam; float dist = length(d);
  float clear = clearAfternoon();
  float f = (1. - exp(-dist * mix(0.00215, 0.0017, uNight) * (1. - 0.41 * clear))) * (1. - 0.49 * smoothstep(0., 135., wp.y));
  // rain thickens the air: the far ridges go first
  if (uStorm > 0.) f = 1. - (1. - f) * exp(-dist * 0.0055 * uStorm);
  // Integrate exponential density between the eye and the surface. Looking
  // down from the summit and looking up from the river cross the same air.
  float eyeY = max(uCam.y, 0.), endY = max(wp.y, 0.), dy = (endY - eyeY) * 0.12;
  float column = abs(dy) < 0.01 ? exp(-0.06 * (eyeY + endY)) : (exp(-0.12 * eyeY) - exp(-0.12 * endY)) / dy;
  float mist = (1. - exp(-dist * column * 0.017)) * mix(0.145, 0.30, uNight) * (1. + 1.3 * uStorm - 0.71 * clear);
  vec3 vd = normalize(vec3(d.x, max(d.y, 0.02 * dist), d.z));
  vec3 fc = skyBase(vd) * 0.75;
  // the haze glows where it lies between you and the star
  fc += STAR_COL * uStarTint * pow(max(dot(normalize(d), uStarDir), 0.), 8.) * 0.07 * (1. - uNight);
  float forward = max(dot(vd, uStarDir), 0.);
  vec3 mc = mix(vec3(0.17, 0.32, 0.37) + vec3(0.85, 0.48, 0.20) * uStarTint * pow(forward, 6.), vec3(0.025, 0.065, 0.108), uNight);
  mc = mix(mc, vec3(0.2, 0.22, 0.25) * (1. - 0.85 * uNight), uStorm * 0.7) + vec3(0.16, 0.18, 0.28) * uFlash * 0.5;
  return vec4(mix(fc * f, mc, mist), (1. - f) * (1. - mist));
}
`;

export const canopyShelter = `
uniform sampler2D uCanopy;
float canopyCover(vec3 wp) {
  vec2 uv = fieldUV(wp.xz);
  // The encoded crown ceiling is 36 metres, plus the lower edge of the height blend.
  if (wp.y >= 36.7 || any(greaterThan(abs(uv - 0.5), vec2(0.5)))) return 0.;
  vec2 crown = textureLod(uCanopy, uv, 0.).rg;
  float height = 40. * crown.g / max(crown.r, 0.004) - 4.;
  return crown.r * smoothstep(-0.7, 2.0, height - wp.y);
}
`;

// Approximate how much overhead sky remains visible below each crown. Use the
// actual area and height of the leaves, then blur over a few metres of sky.
export function bakeCanopy(gl, forest, extent) {
  const size = extent, cellsPerMetre = size / extent, area = new Float32Array(size * size), moment = new Float32Array(area.length);
  const { R, D, M } = forest;
  for (let i = 0; i < R.length; i += 4) {
    const x = Math.floor((R[i] + 0.45 * D[i] * D[i + 3]) * cellsPerMetre + size / 2);
    const z = Math.floor((R[i + 2] + 0.45 * D[i + 2] * D[i + 3]) * cellsPerMetre + size / 2);
    if (x < 0 || x >= size || z < 0 || z >= size) continue;
    const cover = D[i + 3] * M[i + 2], k = z * size + x;
    area[k] += cover; moment[k] += cover * R[i + 1];
  }
  const data = new Uint8Array(area.length * 2);
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    let mass = 0, y = 0;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (x + dx < 0 || x + dx >= size || z + dz < 0 || z + dz >= size) continue;
      const k = (z + dz) * size + x + dx, w = (3 - Math.abs(dx)) * (3 - Math.abs(dz)) / 81;
      mass += area[k] * w; y += moment[k] * w;
    }
    const i = 2 * (z * size + x);
    const density = 1 - Math.exp(-0.55 * mass);
    data[i] = Math.round(255 * density);
    // Premultiply the height so bilinear filtering preserves it at a crown edge.
    data[i + 1] = Math.round(255 * density * Math.min(1, Math.max(0, (y / (mass || 1) + 4) / 40)));
  }
  gl.activeTexture(gl.TEXTURE12);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, size, size, 0, gl.RG, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, axis, gl.CLAMP_TO_EDGE);
}
