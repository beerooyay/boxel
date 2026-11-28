import { createWeather, cloudBase, CLOUD_WIND, WEATHER_METRES, WEATHER_SIZE, WEATHER_TILE } from './weather.js';

// An azimuth/elevation atlas stores integrated light, high-altitude skylight,
// opacity-weighted distance along the viewing ray and opacity. The main view, reflected sky and ground
// illumination all look into the same volume, including in a storm.
export const cloudSky = `
uniform highp sampler2DArray uClouds;
uniform vec4 uCloudEye, uLastCloudEye;
uniform vec3 uCloudLayerMix;
vec2 cloudSkyUV(vec3 d) {
  // Longitude is immaterial at the zenith, where atan(0, 0) is undefined.
  float az = abs(d.x) + abs(d.z) < 0.00001 ? 0. : atan(d.x, -d.z);
  return vec2(az * 0.159154943 + 0.5, asin(clamp(d.y, 0., 1.)) * 0.636619772);
}
vec4 cloudSample(vec3 origin, vec3 ray, vec4 anchor, float layer) {
  vec3 delta = origin - anchor.xyz;
  float guess = max(60., (anchor.w-delta.y)/max(ray.y,0.045));
  vec3 dir = normalize(delta + guess*ray);
  vec4 col = texture(uClouds, vec3(cloudSkyUV(dir),layer));
  // Optical distance follows each bank. A near turret and a distant horizon
  // cloud travel different angles across the sky as the fox or the air moves.
  if (col.a > 0.10 && dot(delta,delta) > 0.09) {
    float range = clamp(8300.*col.b/col.a-dot(delta,ray),0.64*guess,1.75*guess);
    // A nearly clear pixel has too little optical mass to locate a bank.
    // Ease into the distance estimate as its opacity and parallax grow.
    float confidence = 0.72*smoothstep(0.10,0.76,col.a)*smoothstep(0.3,3.,length(delta));
    vec3 refined=ray+delta*mix(1./guess,1./range,confidence);
    col=texture(uClouds,vec3(cloudSkyUV(normalize(refined)),layer));
  }
  return col;
}
vec4 cloudColumn(vec3 origin, vec3 ray) {
  if (uCloudLayerMix.y == 0.) return cloudSample(origin,ray,uLastCloudEye,uCloudLayerMix.z);
  vec4 col = cloudSample(origin,ray,uCloudEye,uCloudLayerMix.x);
  if (uCloudLayerMix.y < 1.)
    col = mix(cloudSample(origin,ray,uLastCloudEye,uCloudLayerMix.z),col,uCloudLayerMix.y);
  return col;
}
vec3 cloudLight(vec3 behind, vec3 clearSky, vec3 ray, vec4 col) {
  if (all(equal(col, vec4(0.)))) return behind;
  float dusk = 1. - smoothstep(0.025, 0.39, uStarDir.y);
  vec3 ambientLight = mix(vec3(0.070, 0.107, 0.165), vec3(0.044, 0.061, 0.120), dusk);
  vec3 topLight = mix(vec3(0.21, 0.225, 0.26), vec3(0.23, 0.15, 0.15), dusk);
  float forward = pow(max(dot(ray, uStarDir), 0.), 12.);
  vec3 direct = vec3(1.72, 1.265, 0.97) * uCloudTint * (1. + 0.8 * forward);
  // The atlas stores premultiplied light. Keeping it premultiplied all the
  // way to the composite lets a single quantization level fade into blue sky.
  // Only a sunlit, translucent edge can acquire a silver lining. The atlas
  // carries incident light as well as opacity, even through a crossfade.
  float rim = col.r * (1. - col.a) * (0.20 + 0.80 * forward);
  vec3 lit = ambientLight * col.a + topLight * col.g + direct * (col.r + 0.60 * rim);
  lit = mix(lit, col.a * vec3(0.050, 0.067, 0.098) + col.g * vec3(0.16, 0.175, 0.20)
    + direct * col.r * 0.42, uStorm);
  float towardsMoon = pow(max(dot(ray, uPlanetDir), 0.), 5.);
  vec3 moon = vec3(0.009, 0.013, 0.028) * col.a + vec3(0.023, 0.034, 0.067) * col.g
    + vec3(0.038, 0.051, 0.080) * towardsMoon * (col.g + 0.70 * col.a * (1. - col.a));
  lit = mix(lit, moon, uNight);
  float haze = 0.45 * smoothstep(1700.,8000.,8300.*col.b/max(col.a,0.001));
  lit = mix(lit, col.a * clearSky, haze);
  lit += vec3(0.43, 0.48, 0.69) * uFlash * (0.38 * col.a + 0.62 * col.g);
  return behind * (1. - col.a) + lit;
}`;

// Three periodic nearest-feature distance fields. Splat each feature only into
// the voxels it can reach, then let the GPU interpolate the packed octaves.
function billowNoise(size) {
  const bytes = new Uint8Array(size ** 3 * 3), mask = size - 1;
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
          if (yz >= 1.) continue;
          const span = radius * Math.sqrt(1. - yz);
          const row = ((k & mask) * size + (j & mask)) * size;
          for (let i = Math.ceil(cx - span); i <= cx + span; i++) {
            const v = Math.round(255 * (1 - yz - (i - cx) ** 2 * inv));
            const dest = (row + (i & mask)) * 3 + channel;
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
  vec3 q = p - vec3(0.10, 0., 0.055) * (p.y - uBase);
  vec3 warp = textureLod(uBillows, q.zxy / 1690. + vec3(0.21, 0.38, 0.72), 0.).rgb;
  q += (warp - 0.68) * vec3(77., 46., 43.);
  // New lobes rise through the moist column while the crown and base
  // dissolve them. Move the smaller billows faster than the main body.
  vec3 large = textureLod(uBillows, q / 1200. - vec3(0., uDriftTime * 0.00034, 0.), 0.).rgb;
  vec3 fine = textureLod(uBillows, q.zxy / 480. + vec3(0.31, -uDriftTime * 0.00036, 0.53 - uDriftTime * 0.00092), 0.).rgb;
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
  float base = smoothstep(floorHeight, floorHeight + 0.135, height);
  float crown = 1. - smoothstep(0.76 + 0.13 * warp.g, 1.03, height);
  float moisture = smoothstep(MIN_WATER, 0.13, water);
  return smoothstep(0., 0.21, envelope) * base * crown * moisture * (0.69 + 0.31 * large.g);
}
float sunlight(vec3 p, float rho) {
  float h, nearLight = density(p + uLight * 13., h);
  float offset = 0.85 + 0.32 * smoothstep(0.05, 0.70, rho);
  float tau = 24. * nearLight + 54. * density(p + uLight * (51. * offset), h)
            + 116. * density(p + uLight * (139. * offset), h) + 245. * density(p + uLight * (313. * offset), h);
  float face = clamp(0.69 + 1.35 * (rho - nearLight), 0.24, 1.08);
  return face * (0.90 * exp(-0.024 * tau) + 0.10 * exp(-0.0048 * tau));
}
void main() {
  float az = (vUv.x - 0.5) * 6.283185307, el = vUv.y * 1.570796327;
  vec3 d = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  float start = max(0., (uBase - 62. - uOrigin.y) / max(d.y, 0.001));
  float end = min(8300., (uBase + 1.03 * ceiling(1.) - uOrigin.y) / max(d.y, 0.001));
  if (start >= end) { o = vec4(0.); return; }
  float range = end - start, trans = 1.;
  vec3 sum = vec3(0.);
  // Use more samples near the observer. Adjacent rays share a continuous
  // phase so the lookup texture has neither random flecks nor a texel lattice.
  float phase = 0.5 + 0.31 * sin(19. * d.x + 11. * d.y) * sin(17. * d.z - 12. * d.y);
  float bias = 0.36 * smoothstep(1400., 7000., range);
  float tileExit = -1., tileTop = 0.;
  for (int i = 0; i < ${steps}; i++) {
    float a = float(i) / float(${steps}), b = float(i + 1) / float(${steps});
    float begin = start + range * mix(a, a * a, bias);
    float finish = start + range * mix(b, b * b, bias);
    float dist = mix(begin, finish, phase);
    vec3 p = uOrigin + d * dist;
    // A complete rain deck gives every cell a moisture floor of 0.33.
    // Direct density sampling is cheaper there than walking tile boundaries.
    if (uSkip && uRainDeck < 1.) {
      if (dist >= tileExit) {
        vec2 cell = (p.xz + WORLD * 0.5) / TILE;
        float maxWater = texelFetch(uTileMax, ivec2(mod(floor(cell), ${WEATHER_SIZE / WEATHER_TILE}.)), 0).r;
        maxWater = mix(maxWater, 0.33 + 0.64 * maxWater, uRainDeck);
        tileTop = maxWater <= MIN_WATER ? -1e20 : uBase + 1.03 * ceiling(maxWater);
        vec2 remain = mix(fract(cell), 1. - fract(cell), step(vec2(0.), d.xz));
        vec2 crossing = remain * TILE / max(abs(d.xz), vec2(0.00001));
        tileExit = dist + min(crossing.x, crossing.y) - 0.01;
      }
      if (p.y > tileTop) continue;
    }
    float height, rho = density(p, height);
    if (rho <= 0.) continue;
    float alpha = 1. - exp(-rho * (finish - begin) * 0.016);
    float weight = trans * alpha;
    float light = sunlight(p, rho);
    light = mix(light, smoothstep(0.13, 0.72, light), 0.72);
    sum += weight * vec3(light, smoothstep(-0.02, 0.90, height), dist / 8300.);
    trans *= 1. - alpha;
    if (trans < 0.003) break;
  }
  o = vec4(sum, 1. - trans);
}`;
}

export function createClouds(gl, program, triangle, boxel, { mobile, test, sources }) {
  const weather = createWeather(boxel, { sources });
  const width = test ? 512 : mobile ? 1024 : 1536, height = width / 4;
  const march = program(triangle, volumeShader(test ? 72 : mobile ? 120 : 168));
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
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, 3);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Density samples levels 0 and 3.8. Level 4 completes the latter filter.
  const map = texture(4, gl.R8, WEATHER_SIZE, WEATHER_SIZE, gl.LINEAR_MIPMAP_LINEAR, 5);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 4);
  const tiles = texture(5, gl.R8, WEATHER_SIZE / WEATHER_TILE, WEATHER_SIZE / WEATHER_TILE, gl.NEAREST);
  const noise = gl.createTexture();
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_3D, noise);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 64, 64, 64, 0, gl.RGB, gl.UNSIGNED_BYTE, billowNoise(64));
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const eyeUniform = new Float32Array(4), lastEyeUniform = new Float32Array(4);
  const priorWater = weather.water.slice(), priorMaxima = weather.maxima.slice();
  const waterMix = weather.water.slice(), maxMix = weather.maxima.slice();
  const WEATHER_PERIOD = 4;
  let weatherTick = 0, uploadedTick = -1, uploadedFraction = -1;
  let front = 0, shown, previous, pending, row = 0, swappedAt = 0, blend = 1, weatherAge = 0;
  let blendDuration = 1;
  let lastLayer = 0;
  function spareLayer() {
    // The three layer indices sum to 3. Keep both sampled layers intact.
    return previous ? 3 - front - lastLayer : (front + 1) % 3;
  }
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
    gl.uniform3f(march.u('uOrigin'), state.eye[0] - CLOUD_WIND[0] * state.weatherTime, state.eye[1], state.eye[2] - CLOUD_WIND[1] * state.weatherTime);
    gl.uniform3fv(march.u('uLight'), state.direction ?? state.light); gl.uniform1f(march.u('uDriftTime'), state.weatherTime);
    gl.uniform1f(march.u('uBase'), state.base); gl.uniform1f(march.u('uRainDeck'), state.rain);
    gl.uniform1i(march.u('uSkip'), skip);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function upload(fraction) {
    // The initial two snapshots coincide. Every subsequent pair is stable
    // until the engine advances, even as the camera starts another bake.
    if (weatherTick === 0) fraction = 0;
    if (uploadedTick === weatherTick && uploadedFraction === fraction) return;
    uploadedTick = weatherTick;
    uploadedFraction = fraction;
    for (let i = 0; i < waterMix.length; i++) waterMix[i] = Math.round(priorWater[i] + fraction * (weather.water[i] - priorWater[i]));
    // An upward-rounded crossfade of maxima bounds every interpolated texel
    // in the tile, including the bilinear apron.
    for (let i = 0; i < maxMix.length; i++) maxMix[i] = Math.ceil(priorMaxima[i] + fraction * (weather.maxima[i] - priorMaxima[i]));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const [unit, tex, bytes, size] of [[4, map, waterMix, WEATHER_SIZE], [5, tiles, maxMix, WEATHER_SIZE / WEATHER_TILE]]) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED, gl.UNSIGNED_BYTE, bytes);
      if (tex === map) gl.generateMipmap(gl.TEXTURE_2D);
    }
  }
  function anchor(state, weatherTime, out) {
    const dt = weatherTime - state.weatherTime;
    out[0] = state.eye[0] + CLOUD_WIND[0] * dt; out[1] = state.eye[1];
    out[2] = state.eye[2] + CLOUD_WIND[1] * dt; out[3] = state.base + 165 - state.eye[1];
  }
  function update(t, eye, light, sun, rain, fixture, weatherTime = t, motion = 0) {
    const alignment = shown ? light[0] * shown.light[0] + light[1] * shown.light[1] + light[2] * shown.light[2] : 0;
    const reset = !shown || t < shown.t;
    const displaced = shown && Math.hypot(eye[0] - shown.eye[0], eye[1] - shown.eye[1], eye[2] - shown.eye[2]) > 18;
    const weatherChanged = shown && Math.abs(rain - shown.rain) > 0.10;
    if (previous && (fixture || t - swappedAt >= blendDuration)) previous = null;
    const changed = shown && (t - shown.t >= 1.0 - 0.66 * motion || displaced || weatherChanged ||
      (fixture && (alignment < 0.99999 || Math.abs(rain - shown.rain) > 0.001)));
    // The third layer is available throughout the blend, including at walking speed.
    if (reset || (!pending && changed)) {
      upload(weatherAge / WEATHER_PERIOD);
      // Deep twilight lights the existing volume in the composite. Keep the
      // optical light ray above the horizon as the sun sets.
      const direction = [light[0], Math.max(0.14, light[1]), light[2]];
      const length = Math.hypot(...direction);
      pending = { t, weatherTime, motion, layer: spareLayer(), eye: [...eye], light: [...light], rain,
        base: cloudBase(sun, rain), direction: direction.map(x => x / length) };
      row = 0;
    }
    if (pending && row < height) {
      const rowsPerFrame = Math.ceil(height / (27 - (mobile ? 7 : 10) * pending.motion));
      const count = Math.min(height - row, reset || fixture ? height : rowsPerFrame);
      marchRows(pending, row, count, pending.layer, true);
      row += count;
    }
    if (pending && row === height && (reset || !previous)) {
      previous = reset || fixture ? null : shown;
      lastLayer = front;
      front = pending.layer;
      shown = pending;
      pending = null;
      // At low frame rates a complete striped bake takes longer. Match that
      // cadence so the shapes keep moving between successive volume updates.
      blendDuration = Math.max(1.0-0.66*shown.motion, Math.min(2.4,t-shown.t));
      swappedAt = t;
    }
    const fraction = previous ? Math.min(1, Math.max(0, (t - swappedAt) / blendDuration)) : 1;
    blend = fraction;
    anchor(shown, weatherTime, eyeUniform);
    if (previous) anchor(previous, weatherTime, lastEyeUniform);
    gl.activeTexture(gl.TEXTURE11); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
  }
  function advance(dt, sun, rain, time, wet) {
    weatherAge += dt;
    while (weatherAge >= WEATHER_PERIOD) {
      weatherAge -= WEATHER_PERIOD;
      priorWater.set(weather.water);
      priorMaxima.set(weather.maxima);
      weather.advance(sun, rain, time - weatherAge, wet);
      weatherTick++;
    }
  }
  // Read the spare layer only when the browser fixture compares marches.
  function readOptics(state, skip, rgba) {
    upload(weatherAge / WEATHER_PERIOD);
    marchRows({ ...state, weatherTime: state.t }, 0, height, spareLayer(), skip);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    try {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Cloud comparison framebuffer incomplete');
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      pending = null; previous = null; blend = 1;
    }
  }
  return { update, advance, eyeUniform, lastEyeUniform, get front() { return front; }, get lastLayer() { return lastLayer; }, get blend() { return blend; }, width, height, readOptics };
}
