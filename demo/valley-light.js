// Sky occlusion, ground height and water level share a half-metre texel. Only
// static geometry is baked. Moisture, glow and the light in the air stay live.
export function groundAtlas(size, extent, groundAt, waterAt, addOccluders) {
  const step = extent / size, ground = new Float32Array(size * size);
  const water = new Float32Array(ground.length);
  let min = Infinity, max = -Infinity;
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const wx = (x + 0.5) * step - extent / 2, wz = (z + 0.5) * step - extent / 2;
    const i = z * size + x, y = groundAt(wx, wz), surface = waterAt(wx, wz);
    ground[i] = y; water[i] = surface;
    min = Math.min(min, y, surface); max = Math.max(max, y, surface);
  }
  const top = ground.slice();
  addOccluders((cx, base, cz, rx, height, rz, angle, gx = 0, gz = 0) => {
    const radius = Math.max(rx, rz);
    const x0 = Math.max(0, Math.floor((cx - radius + extent / 2) / step));
    const x1 = Math.min(size - 1, Math.floor((cx + radius + extent / 2) / step));
    const z0 = Math.max(0, Math.floor((cz - radius + extent / 2) / step));
    const z1 = Math.min(size - 1, Math.floor((cz + radius + extent / 2) / step));
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5) * step - extent / 2 - cx, dz = (z + 0.5) * step - extent / 2 - cz;
      const d2 = ((c * dx + s * dz) / rx) ** 2 + ((c * dz - s * dx) / rz) ** 2;
      if (d2 < 1) top[z * size + x] = Math.max(top[z * size + x], base + gx*dx + gz*dz + height * Math.sqrt(1 - d2));
    }
  });
  const data = new Uint8Array(3 * ground.length), span = Math.max(max - min, 0.01);
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const i = z * size + x;
    const dx = (ground[i + (x < size - 1 ? 1 : 0)] - ground[i - (x > 0 ? 1 : 0)]) / (x > 0 && x < size - 1 ? 2 : 1);
    const dz = (ground[i + (z < size - 1 ? size : 0)] - ground[i - (z > 0 ? size : 0)]) / (z > 0 && z < size - 1 ? 2 : 1);
    let blocked = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      if (!a && !b) continue;
      const distance = step * (a && b ? Math.SQRT2 : 1), grade = a * dx + b * dz;
      let horizon = 0;
      for (let reach = 1; reach <= 8; reach *= 2) {
        const nx = x + a * reach, nz = z + b * reach;
        if (nx < 0 || nx >= size || nz < 0 || nz >= size) break;
        const rise = top[nz * size + nx] - ground[i] - grade * reach - 0.04;
        horizon = Math.max(horizon, rise / (distance * reach));
      }
      blocked += horizon * horizon / (1 + horizon * horizon);
    }
    data[3 * i] = Math.round(255 * blocked / 8);
    data[3 * i + 1] = Math.round(255 * (ground[i] - min) / span);
    data[3 * i + 2] = Math.round(255 * (water[i] - min) / span);
  }
  return { data, heightRange: [min, span] };
}

export function bakeGroundLight(gl, extent, groundAt, waterAt, sc, forest, pl) {
  const size = 2 * extent;
  const atlas = groundAtlas(size, extent, groundAt, waterAt, stamp => {
    for (let g = 0; g < sc.rv.length; g++) {
      if (g === 3) continue; // Individual shingle is smaller than one texel.
      const sites = sc.rv[g], dims = sc.rs[g];
      for (let i = 0; i < sites.length; i += 4)
        stamp(sites[i], sites[i + 1], sites[i + 2], 0.85 * dims[i], (g < 2 ? 0.66 : 0.86) * dims[i + 1], 0.85 * dims[i + 2], sites[i + 3], sc.beds[g][i], sc.beds[g][i+1]);
    }
    for (let i = 0; i < forest.sites.length; i += 4) {
      const h = forest.sites[i+3], r = Math.max(0.26, 0.085 * h * forest.styles[i+2]);
      stamp(forest.sites[i], forest.sites[i+1], forest.sites[i+2], r, h * 0.44, r, 0);
    }
    // Leaves in a tuft share a root. Use the largest footprint there.
    for (let i = 0; i < pl.P.length; i += 4) {
      const h = pl.P[i + 3] * pl.F[i + 1];
      if (h > 0.8) stamp(pl.P[i], pl.P[i + 1], pl.P[i + 2], h * 0.35, h * 0.30, h * 0.35, 0);
    }
  });
  gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, atlas.data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return atlas.heightRange;
}

export const groundLight = `
uniform sampler2D uValleyGround;
uniform vec2 uGroundRange;
float groundHeight(float value){ return uGroundRange.x + value * uGroundRange.y; }
float atlasCoverage(vec2 uv){
  vec2 edge = abs(uv - 0.5);
  return 1. - smoothstep(0.483, 0.5, max(edge.x, edge.y));
}
float contactLight(vec3 wp){
  vec2 uv = fieldUV(wp.xz);
  if (inField(uv) < 0.5 || wp.y > uGroundRange.x + uGroundRange.y + 2.) return 1.;
  vec2 ground = textureLod(uValleyGround, uv, 0.).rg;
  float local = 1. - smoothstep(0.07, 1.75, wp.y - groundHeight(ground.g));
  return 1. - 0.66 * ground.r * local * atlasCoverage(uv);
}
`;

// Both the temporal resolve and the mist use forward camera distance.
export const viewRay = `
uniform highp sampler2D tDepth;
uniform vec3 uRayRight, uRayUp, uForward;
uniform vec2 uJitter;
uniform vec2 uDepthRange;
float viewDepth(float z){ return uDepthRange.x / (1. - z * (1. - uDepthRange.x / uDepthRange.y)); }
vec3 cameraRay(vec2 uv){
  vec2 ndc = uv * 2. - 1. - uJitter;
  return uForward + uRayRight * ndc.x + uRayUp * ndc.y;
}
`;

export const mistFragment = viewRay + `
in vec2 vUv; out vec4 o;
float mistSun(vec3 wp, int layer) {
  vec3 q = (uLightVP[layer] * vec4(wp, 1.)).xyz * 0.5 + 0.5;
  if (any(lessThan(q, vec3(0.))) || any(greaterThan(q, vec3(1.)))) return 1.;
  return texture(uShadows, vec4(q.xy, float(layer), q.z - 0.0005));
}
void main(){
  vec3 ray = cameraRay(vUv);
  float reach = min(32., length(ray) * viewDepth(texture(tDepth, vUv).r));
  vec3 dir = normalize(ray);
  float transmission = 1.;
  vec3 light = vec3(0.);
  float forward = pow(max(dot(dir, uStarDir), 0.), 6.);
  vec3 day = vec3(0.19, 0.29, 0.32) + forward * vec3(1., 0.68, 0.39) * uStarTint;
  // Moist soil and standing water keep some low mist even under a high star.
  vec2 densityRange = vec2(0.008, 0.064) * (1. - vec2(0.76, 0.42) * clearAfternoon());
  // A little suspended moisture catches sunbeams inside the crowns. Only
  // sun-facing rays need the extra canopy lookup. Reuse the mist shadow march.
  float beam = forward * (1.-uNight) * (1.-0.85*uStorm) * smoothstep(-0.015,0.08,uStarDir.y);
  float start = 0.;
  for (int i = 1; i <= 10; ++i) {
    float end = reach * float(i*i) * 0.01, stepLength = end - start;
    vec3 wp = uCam + dir * ((start + end) * 0.5); start = end;
    vec2 uv = fieldUV(wp.xz);
    if (inField(uv) < 0.5) continue;
    vec2 levels = textureLod(uValleyGround, uv, 0.).gb;
    float bed = groundHeight(levels.x), water = groundHeight(levels.y);
    float above = wp.y - max(water, bed);
    if (above < -0.3 || above > (beam > 0.025 ? 8. : 3.8)) continue;
    float aerosol = 0.;
    if (beam > 0.025)
      aerosol = 0.026 * beam * canopyCover(wp) * smoothstep(0.12,1.1,above)
        * (1.-smoothstep(3.5,8.,above));
    float wet = clamp(textureLod(uGround, uv, 0.).r + uSheet + 0.53 * (1. - smoothstep(-0.1, 1., bed - water)), 0., 1.);
    float drift = vnoise(wp.xz * 0.29 + vec2(-0.054, 0.017) * uTime + above * 0.16);
    float density = atlasCoverage(uv) * mix(densityRange.x, densityRange.y, wet) * (0.3 + drift) * exp(-max(0., above) * 1.35);
    float scatter = 1. - exp(-(density + aerosol) * stepLength);
    vec3 incident = vec3(0.021, 0.040, 0.068);
    if (uNight < 0.999) {
      float sun = mistSun(wp, uSunLayers.x);
      if (uSunBlend > 0.) sun = mix(sun, mistSun(wp, uSunLayers.y), uSunBlend);
      incident = mix(day * (0.28 + 0.72 * sun), incident, uNight);
      vec3 shaft = sun * uStarTint * vec3(1.65,1.26,0.75);
      incident = mix(incident,shaft,aerosol / max(0.0001,density+aerosol));
    }
    if (uNight > 0.001) {
      float glow = glowI(textureLod(uGlow, uv, 0.).r);
      vec3 colony = textureLod(uFloraSpill, uv, 0.).rgb;
      float strength = max(max(colony.r, colony.g), colony.b);
      vec3 hue = mix(glowCol(wp.xz), colony / max(strength, 0.001), smoothstep(0.02, 0.16, strength));
      incident += uNight * uNight * (0.42 * colony + 3.8 * glow * hue);
    }
    light += transmission * scatter * incident;
    transmission *= 1. - scatter;
  }
  vec3 radiance = light * uExposure;
  o = vec4(uHDR > 0.5 ? radiance : sqrt(radiance), transmission);
}`;
