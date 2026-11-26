import { createWeather, cloudBase, CLOUD_WIND, WEATHER_METRES, WEATHER_SIZE, WEATHER_TILE } from './weather.js';

// An azimuth/elevation atlas stores integrated light, high-altitude skylight,
// aerial perspective and opacity. The main view, reflected sky and ground
// illumination all look into the same volume, including in a storm.
export const cloudSky = `
uniform highp sampler2DArray uClouds;
uniform vec4 uCloudEye, uLastCloudEye;
uniform vec2 uCloudLayerMix;
vec2 cloudSkyUV(vec3 d) {
  // Longitude is immaterial at the zenith, where atan(0, 0) is undefined.
  float az = abs(d.x) + abs(d.z) < 0.00001 ? 0. : atan(d.x, -d.z);
  return vec2(az * 0.159154943 + 0.5, asin(clamp(d.y, 0., 1.)) * 0.636619772);
}
vec2 cloudProjection(vec3 origin, vec3 ray, vec4 anchor) {
  vec3 delta = origin - anchor.xyz;
  float dist = max(60., (anchor.w - delta.y) / max(ray.y, 0.045));
  return cloudSkyUV(normalize(delta + dist * ray));
}
vec4 cloudColumn(vec3 origin, vec3 ray) {
  vec4 col = texture(uClouds, vec3(cloudProjection(origin, ray, uCloudEye), uCloudLayerMix.x));
  if (uCloudLayerMix.y < 1.) {
    vec2 uv = cloudProjection(origin, ray, uLastCloudEye);
    col = mix(texture(uClouds, vec3(uv, 1. - uCloudLayerMix.x)), col, uCloudLayerMix.y);
  }
  return col;
}
vec3 cloudLight(vec3 behind, vec3 ray, vec4 col) {
  float dusk = 1. - smoothstep(0.025, 0.39, uStarDir.y);
  vec3 ambientLight = mix(vec3(0.080, 0.125, 0.205), vec3(0.044, 0.061, 0.120), dusk);
  vec3 topLight = mix(vec3(0.15, 0.19, 0.25), vec3(0.21, 0.14, 0.15), dusk);
  float forward = pow(max(dot(ray, uStarDir), 0.), 12.);
  vec3 direct = vec3(1.49, 1.29, 1.06) * uCloudTint * (1. + 0.8 * forward);
  // Preserve the warm sun on individual lobes and the cool skylight inside
  // their folds. Work in the cloud's own opacity before compositing it.
  float visibleSun = col.r / max(col.a, 0.0039);
  float relief = mix(visibleSun, smoothstep(0.08, 0.74, visibleSun), 0.6);
  float rim = col.a * (1. - col.a) * forward;
  vec3 lit = ambientLight * col.a + topLight * col.g + direct * (col.a * relief + 0.32 * rim);
  lit = mix(lit, col.a * vec3(0.050, 0.067, 0.098) + col.g * vec3(0.16, 0.175, 0.20)
    + direct * col.r * 0.42, uStorm);
  vec3 moon = vec3(0.0035, 0.0062, 0.015) * col.a + vec3(0.009, 0.015, 0.034) * col.g
    + vec3(0.044, 0.062, 0.108) * col.r;
  lit = mix(lit, moon, uNight);
  lit = mix(lit, skyBase(ray) * col.a, col.b / max(col.a, 0.005) * 0.56);
  lit += vec3(0.43, 0.48, 0.69) * uFlash * (0.38 * col.a + 0.62 * col.g);
  return behind * (1. - col.a) + lit;
}`;

// Three periodic nearest-feature distance fields. Splat each feature only into
// the voxels it can reach, then let the GPU interpolate the packed octaves.
function billowNoise(size) {
  const bytes = new Uint8Array(size ** 3 * 4), mask = size - 1;
  let seed = 72512;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (const [channel, cells] of [5, 11, 23].entries()) {
    const radius = size / cells, inv = 1 / (radius * radius);
    for (let z = 0; z < cells; z++) for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
      const cx = (x + 0.14 + 0.72 * rand()) * radius;
      const cy = (y + 0.14 + 0.72 * rand()) * radius;
      const cz = (z + 0.14 + 0.72 * rand()) * radius;
      for (let k = Math.ceil(cz - radius); k <= cz + radius; k++) {
        const dz = (k - cz) ** 2;
        for (let j = Math.ceil(cy - radius); j <= cy + radius; j++) {
          const yz = ((j - cy) ** 2 + dz) * inv;
          const row = ((k & mask) * size + (j & mask)) * size;
          for (let i = Math.ceil(cx - radius); i <= cx + radius; i++) {
            const v = Math.round(255 * (1 - yz - (i - cx) ** 2 * inv));
            const dest = (row + (i & mask)) * 4 + channel;
            if (v > bytes[dest]) bytes[dest] = v;
          }
        }
      }
    }
  }
  return bytes;
}

function volumeShader(steps) {
  return `
precision highp sampler3D;
uniform sampler3D uBillows;
uniform sampler2D uWaterMap, uTileMax;
uniform vec3 uOrigin, uLight;
uniform float uBase, uRainDeck, uDriftTime;
uniform bool uSkip;
in vec2 vUv;
out vec4 o;
const float WORLD = ${WEATHER_METRES}.;
const float TILE = WORLD / ${WEATHER_SIZE / WEATHER_TILE}.;
const float MIN_WATER = 0.047;
vec2 weatherUV(vec2 p) { return p / WORLD + 0.5; }
float ceiling(float water) { return 110. + 760. * sqrt(water); }

float density(vec3 p, out float height) {
  float water = textureLod(uWaterMap, weatherUV(p.xz), 0.).r;
  water = mix(water, 0.33 + 0.64 * water, uRainDeck);
  height = (p.y - uBase) / ceiling(water);
  if (water <= MIN_WATER || height < -0.07 || height > 1.03) return 0.;
  // An isolated narrow updraft entrains more dry air and tops out earlier
  // than a broad, well-fed bank. Both scales come from the same water field.
  float inflow = textureLod(uWaterMap, weatherUV(p.xz), 3.8).r;
  height /= mix(0.34 + 0.66 * smoothstep(0.08, 0.59, inflow), 0.94, uRainDeck);
  if (height < -0.07 || height > 1.03) return 0.;
  // Wind shear inclines the upper lobes. The base stays nearly level where
  // rising air first reaches its dew point. Smaller billows erode the edge.
  vec3 q = p - vec3(0.18, 0., 0.070) * (p.y - uBase);
  vec3 warp = textureLod(uBillows, q.zxy / 1690. + vec3(0.21, 0.38, 0.72), 0.).rgb;
  q += (warp - 0.68) * vec3(77., 46., 43.);
  vec3 large = textureLod(uBillows, q / 1200., 0.).rgb;
  vec3 fine = textureLod(uBillows, q.zxy / 480. + vec3(0.31, -uDriftTime * 0.00036, 0.53), 0.).rgb;
  // A nearest-feature field is steepest around a lobe's shoulders. Using
  // distance here keeps the fine turrets distinct on the sunlit faces.
  large = 1. - sqrt(max(vec3(0.), 1. - large));
  fine = 1. - sqrt(max(vec3(0.), 1. - fine));
  float lobes = dot(large - 0.48, vec3(0.72, 0.40, 0.21));
  float curls = dot(fine - 0.48, vec3(0.25, 0.13, 0.072));
  float floorHeight = -0.022 + (warp.r - 0.68) * (0.105 + 0.18 * uRainDeck) + 0.05 * (large.g - 0.48);
  // Entrained dry air cuts narrow channels between adjacent lobes. Fine
  // erosion concentrates on their sides rather than carving the whole base.
  float cleft = (1. - smoothstep(0.25, 0.48, fine.g)) * smoothstep(0.12, 0.59, height);
  float envelope = 0.55 * sqrt(water) + lobes + curls - 0.15 - 0.075 * cleft;
  envelope -= 0.68 * pow(max(height, 0.), 1.72);
  float base = smoothstep(floorHeight, floorHeight + 0.105, height);
  return smoothstep(0., 0.17, envelope) * base * (0.69 + 0.31 * large.g);
}
float sunlight(vec3 p, float rho) {
  float h, nearLight = density(p + uLight * 13., h);
  float tau = 24. * nearLight + 54. * density(p + uLight * 51., h)
            + 116. * density(p + uLight * 139., h) + 245. * density(p + uLight * 313., h);
  float face = clamp(0.69 + 1.35 * (rho - nearLight), 0.24, 1.08);
  return face * (0.90 * exp(-0.024 * tau) + 0.10 * exp(-0.0048 * tau));
}
void main() {
  float az = (vUv.x - 0.5) * 6.283185307, el = vUv.y * 1.570796327;
  vec3 d = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  float start = max(0., (uBase - 62. - uOrigin.y) / max(d.y, 0.001));
  float end = min(8300., (uBase + 1.03 * ceiling(1.) - uOrigin.y) / max(d.y, 0.001));
  if (start >= end) { o = vec4(0.); return; }
  float ds = (end - start) / float(${steps}), trans = 1.;
  vec3 sum = vec3(0.);
  // A different, fixed phase per angular texel breaks up integration bands
  // on nearly level cloud bases. The pattern stays still as the camera turns.
  uvec2 px = uvec2(gl_FragCoord.xy);
  uint hash = (px.x * 1597334677u) ^ (px.y * 3812015801u);
  hash = (hash ^ (hash >> 16u)) * 2246822519u;
  float phase = (float(hash >> 8u) + 0.5) / 16777216.;
  int tileEnd = -1;
  float maxWater = 0.;
  for (int i = 0; i < ${steps}; i++) {
    float dist = start + (float(i) + phase) * ds;
    vec3 p = uOrigin + d * dist;
    if (uSkip) {
      if (i > tileEnd) {
        vec2 cell = (p.xz + WORLD * 0.5) / TILE;
        maxWater = texelFetch(uTileMax, ivec2(mod(floor(cell), ${WEATHER_SIZE / WEATHER_TILE}.)), 0).r;
        maxWater = mix(maxWater, 0.33 + 0.64 * maxWater, uRainDeck);
        vec2 remain = mix(fract(cell), 1. - fract(cell), step(vec2(0.), d.xz));
        vec2 crossing = remain * TILE / max(abs(d.xz), vec2(0.00001));
        tileEnd = i + int(clamp(floor(min(crossing.x, crossing.y) / ds - 0.001), 0., float(${steps}) - float(i) - 1.));
      }
      if (maxWater <= MIN_WATER || p.y > uBase + 1.03 * ceiling(maxWater)) {
        i = tileEnd;
        continue;
      }
    }
    float height, rho = density(p, height);
    if (rho <= 0.) continue;
    float alpha = 1. - exp(-rho * ds * 0.0145);
    float weight = trans * alpha;
    sum += weight * vec3(sunlight(p, rho), smoothstep(-0.02, 0.90, height), smoothstep(1700., 8000., dist));
    trans *= 1. - alpha;
    if (trans < 0.004) break;
  }
  o = vec4(sum, 1. - trans);
}`;
}

export function createClouds(gl, program, triangle, boxel, { mobile, test, sources }) {
  const weather = createWeather(boxel, { sources });
  const width = test ? 512 : mobile ? 1024 : 1536, height = width / 4;
  const march = program(triangle, volumeShader(test ? 64 : mobile ? 104 : 160));
  const fb = gl.createFramebuffer();
  function texture(unit, format, w, h, filter, levels = 1) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, levels, format, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
    return t;
  }
  const atlas = gl.createTexture();
  gl.activeTexture(gl.TEXTURE11); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, 2);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const map = texture(4, gl.R8, WEATHER_SIZE, WEATHER_SIZE, gl.LINEAR_MIPMAP_LINEAR, 1 + Math.log2(WEATHER_SIZE));
  const tiles = texture(5, gl.R8, WEATHER_SIZE / WEATHER_TILE, WEATHER_SIZE / WEATHER_TILE, gl.NEAREST);
  const noise = gl.createTexture();
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_3D, noise);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 64, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, billowNoise(64));
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const eyeUniform = new Float32Array(4), lastEyeUniform = new Float32Array(4);
  let front = 0, shown, previous, pending, row = 0, swappedAt = 0, blend = 1, weatherAge = 0, dirty = true;
  function marchRows(state, first, count, dest, skip) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, atlas, 0, dest);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, first, width, count);
    gl.colorMask(true, true, true, true);
    gl.useProgram(march); gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, map);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, tiles);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_3D, noise);
    gl.uniform1i(march.u('uWaterMap'), 4); gl.uniform1i(march.u('uTileMax'), 5); gl.uniform1i(march.u('uBillows'), 6);
    gl.uniform3f(march.u('uOrigin'), state.eye[0] - CLOUD_WIND[0] * state.t, state.eye[1], state.eye[2] - CLOUD_WIND[1] * state.t);
    gl.uniform3fv(march.u('uLight'), state.light); gl.uniform1f(march.u('uDriftTime'), state.t);
    gl.uniform1f(march.u('uBase'), state.base); gl.uniform1f(march.u('uRainDeck'), state.rain);
    gl.uniform1i(march.u('uSkip'), skip);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function upload() {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const [unit, tex, bytes, size] of [[4, map, weather.water, WEATHER_SIZE], [5, tiles, weather.maxima, WEATHER_SIZE / WEATHER_TILE]]) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED, gl.UNSIGNED_BYTE, bytes);
      if (tex === map) gl.generateMipmap(gl.TEXTURE_2D);
    }
    dirty = false;
  }
  function anchor(state, t, out) {
    const dt = t - state.t;
    out[0] = state.eye[0] + CLOUD_WIND[0] * dt; out[1] = state.eye[1];
    out[2] = state.eye[2] + CLOUD_WIND[1] * dt; out[3] = state.base + 165 - state.eye[1];
  }
  function update(t, eye, light, sun, rain, fixture) {
    const alignment = shown ? light[0] * shown.light[0] + light[1] * shown.light[1] + light[2] * shown.light[2] : 0;
    const jump = !shown || t < shown.t || Math.abs(rain - shown.rain) > 0.38 || alignment < 0.96;
    const displaced = shown && Math.hypot(eye[0] - shown.eye[0], eye[1] - shown.eye[1], eye[2] - shown.eye[2]) > 18;
    if (previous && (fixture || t - swappedAt >= 0.65)) previous = null;
    const changed = shown && (t - shown.t > 1.25 || displaced ||
      (fixture && (alignment < 0.99999 || Math.abs(rain - shown.rain) > 0.001)));
    if (jump || (!pending && !previous && changed)) {
      if (dirty) upload();
      pending = { t, eye: [...eye], light: [...light], rain, base: cloudBase(sun, rain) };
      row = 0;
    }
    if (pending) {
      const count = jump || fixture ? height : Math.min(height - row, Math.ceil(height / 24));
      marchRows(pending, row, count, 1 - front, true);
      row += count;
      if (row >= height) {
        previous = jump || fixture ? null : shown;
        front = 1 - front; shown = pending; pending = null; swappedAt = t;
      }
    }
    blend = previous ? Math.min(1, Math.max(0, (t - swappedAt) / 0.65)) : 1;
    anchor(shown, t, eyeUniform);
    if (previous) anchor(previous, t, lastEyeUniform);
    gl.activeTexture(gl.TEXTURE11); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
  }
  function advance(dt, sun, rain, time, wet) {
    weatherAge += dt;
    if (weatherAge < 4) return;
    weatherAge %= 4;
    weather.advance(sun, rain, time, wet); dirty = true;
  }
  // Read the spare layer only when the browser fixture compares marches.
  function readOptics(state, skip, rgba) {
    if (dirty) upload();
    marchRows(state, 0, height, 1 - front, skip);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    try {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Cloud comparison framebuffer incomplete');
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      pending = null; previous = null; blend = 1;
    }
  }
  return { update, advance, eyeUniform, lastEyeUniform, get front() { return front; }, get blend() { return blend; }, width, height, readOptics };
}
