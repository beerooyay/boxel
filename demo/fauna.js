import { windDirection } from './wind.js';
// A sailwing has two pairs of hinged membranes, a segmented abdomen and paired streamers.
// The same articulated mesh is instanced throughout the watershed and in its reflection.
const TAU = 2 * Math.PI;
const vertexSource = `
in vec3 aPos, aMark;
in vec4 aPose;
in vec3 aAngles;
in vec2 aStroke;
out vec3 vWP, vMark;
uniform sampler2D uValleyGround; uniform vec2 uGroundRange;
flat out vec3 vSignal;
void main(){
  vec3 p = aPos;
  float part = aMark.x, span = aMark.y;
  float beat = aStroke.x, effort = aStroke.y;
  if (part == 1. || part == 2.) {
    float hind = step(1.5, part);
    // The leading edge turns first. The tip and the flexible trailing edge
    // follow it around the reversal, then tuck back on the return stroke.
    float phase = beat - 0.47 * hind - span * span * (0.54 + 0.30 * aMark.z);
    float stroke = sin(phase - 0.22 * sin(phase));
    float recover = smoothstep(-0.35, 0.9, cos(phase)) * effort;
    float angle = 0.19 + (0.98 - 0.17 * hind) * stroke * effort;
    p.z -= 0.16 * span * span * recover;
    p.y += 0.085 * aMark.z * span * cos(phase) * effort;
    float c = cos(angle), s = sin(angle), side = sign(p.x);
    float wing = (abs(p.x) - 0.045) * (1. - 0.10 * span * recover);
    p.xy = vec2(side * (0.045 + wing * c - p.y * s), wing * s + p.y * c);
  } else if (part == 3.) {
    p.x += span * span * ((0.022 + 0.045 * effort) * sin(beat * 0.53 - span * 3.) + 0.04 * sign(p.x));
    p.y += span * span * (0.04 + 0.09 * effort) * sin(beat * 0.48 - span * 3. - 1.);
  }
  vec2 heading = vec2(sin(aAngles.x), cos(aAngles.x));
  float c=cos(aAngles.z), s=sin(aAngles.z);
  p.xy = mat2(c, s, -s, c) * p.xy;
  float pitch = aAngles.y + 0.022 * effort * cos(beat);
  p.zy = mat2(cos(pitch), sin(pitch), -sin(pitch), cos(pitch)) * p.zy;
  vec2 world = vec2(heading.y, -heading.x) * p.x + heading * p.z;
  vWP = aPose.xyz + vec3(world.x, p.y, world.y) * abs(aPose.w);
  vMark = aMark;
  vec2 uv = fieldUV(aPose.xz);
  vec2 bed = textureLod(uValleyGround, uv, 0.).gb;
  float clearance = aPose.y - (uGroundRange.x + max(bed.x, bed.y) * uGroundRange.y);
  float reach = 1. - smoothstep(0.10, 1.55, clearance);
  vSignal = vec3(step(0., aPose.w), reach * textureLod(uGlow, uv, 0.).r,
                 clamp(uSheet + reach * textureLod(uGround, uv, 0.).r, 0., 1.));
  gl_Position = project(vWP);
}`;
const fragmentSource = `
uniform float uClip; uniform bool uGlass;
in vec3 vWP, vMark;
flat in vec3 vSignal;
out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 V = normalize(uCam - vWP);
  vec3 n = normalize(cross(dFdx(vWP), dFdy(vWP)));
  if (dot(n, V) < 0.) n = -n;
  vec3 pigment = mix(vec3(0.92, 0.23, 0.28), vec3(0.07, 0.76, 0.57), vSignal.x);
  vec3 ink = mix(vec3(0.068, 0.019, 0.050), vec3(0.012, 0.040, 0.055), vSignal.x);
  float part = vMark.x, span = vMark.y, chord = vMark.z;
  float mark = 0., silk = 0., lacquer = 0.6, membrane = 1.;
  vec3 alb = ink;
  if (part == 1. || part == 2.) {
    float hind = step(1.5, part);
    float fan = (chord - 0.14 + 0.20 * span) / (0.20 + 0.80 * span) * (3.3 + 0.5 * hind);
    float aa = max(fwidth(fan), 0.012);
    float radial = (1. - smoothstep(0.022, 0.052 + aa, abs(fract(fan + 0.5) - 0.5)))
                 * (1. - smoothstep(0.15, 0.6, aa));
    float cell = 6. * span - 0.73 * chord - 0.13 * cos(6.28 * fan);
    float cw = max(fwidth(cell), 0.01);
    float joint = (1. - smoothstep(0.012, 0.038 + cw, abs(fract(cell + 0.5) - 0.5)))
                * (1. - smoothstep(0.12, 0.50, cw)) * smoothstep(0.28, 0.6, span);
    float margin = 1. - smoothstep(0.035, 0.14, min(chord, 1. - chord));
    vec2 eye = (vec2(span, chord) - vec2(0.69 - 0.13 * hind, 0.50)) * vec2(7.2, 3.7);
    float r = length(eye), width = max(fwidth(r), 0.015);
    float ring = 1. - smoothstep(0.08, 0.20 + width, abs(r - 0.64));
    float disc = 1. - smoothstep(0.51, 0.83 + width, r);
    silk = smoothstep(0.07, 0.45, span) * (1. - 0.70 * margin) * (1. - disc);
    // The membrane shifts from indigo to peacock, or plum to copper. Its
    // black ribs, enamel leading edge and opaque eye keep their pigment.
    float grazing = 1. - clamp(dot(n, V), 0., 1.);
    float shift = smoothstep(0.17, 0.88, grazing + 0.20 * sin(5.4 * chord + 2.3 * span));
    vec3 glass = mix(vec3(0.20, 0.035, 0.20), vec3(0.026, 0.085, 0.25), vSignal.x);
    vec3 foil = mix(vec3(0.93, 0.38, 0.13), vec3(0.10, 0.84, 0.56), vSignal.x);
    alb = mix(glass, pigment, (0.30 + 0.54 * sin(3.14 * chord)) * (1. - 0.48 * hind));
    alb = mix(alb, foil, 0.72 * shift) * (0.54 + 0.40 * silk);
    alb = mix(alb, ink, max(0.88 * margin, max(0.94 * disc, 0.73 * max(radial, joint))));
    float leading = (1. - smoothstep(0.03, 0.13 + fwidth(chord), chord)) * smoothstep(0.47, 0.70, span) * (1. - smoothstep(0.81, 0.96, span));
    mark = max(leading, max(ring, radial * 0.40 + joint * 0.08) * (1. - smoothstep(0.36, 1.3, width)));
    float ribs = max(max(margin, radial), max(0.65 * joint, max(disc, leading)));
    float window = smoothstep(0.06, 0.39, span) * (1. - ribs);
    membrane = 1. - window * (0.42 + 0.29 * (1. - grazing));
    alb *= 0.66 + 0.34 * window;
    alb = mix(alb, ink * 0.8, radial * (1. - ring) * 0.45);
    lacquer = 0.29 + 0.60 * radial;
  } else if (part == 0.) {
    float joint = abs(fract(span * 8. + 0.35) - 0.5);
    float collar = (1. - smoothstep(0.027, 0.10 + fwidth(span * 8.), joint)) * (1. - smoothstep(0.52, 0.72, span));
    mark = collar * (0.45 + 0.55 * smoothstep(0.08, 0.56, chord));
    alb = mix(ink * 0.36, pigment, 0.032 + 0.085 * chord);
    mark *= 0.67;
  } else {
    mark = part == 3. ? smoothstep(0.68, 0.91, span) : (part == 4. ? 0.45 : 0.08);
    lacquer = part == 4. ? 1.3 : 0.35;
  }
  alb = mix(alb, pigment * 0.78 + vec3(0.09, 0.075, 0.028), 0.88 * mark);
  vec3 sun = uSunCol * directLight(vWP);
  vec3 sky = ambient(n) * mix(vec3(1.), vec3(0.40, 0.53, 0.55), canopyCover(vWP));
  float nl = dot(n, uSunDir), sheen = pow(max(dot(n, normalize(uSunDir + V)), 0.), 28.);
  vec3 light = alb * (2.6 * sky + floraSpill(vWP) + sun * (0.07 + 0.66 * max(nl, 0.)));
  light += sun * (alb * silk * (0.065 + 0.44 * max(-nl, 0.)) + sheen * lacquer * (0.19 + 0.26 * vSignal.z) * max(nl, 0.));
  light += pigment * mark * smoothstep(0.22, 0.94, uNight) * (0.48 + 1.9 * glowI(vSignal.y));
  o = vec4(tonemap(fogged(light, vWP)), uGlass ? membrane : 0.);
}`;

function sailwingMesh() {
  const positions = [], markings = [], indices = [], coarse = [];
  function point(x, y, z, part, span, chord) {
    positions.push(x, y, z); markings.push(part, span, chord);
    return positions.length / 3 - 1;
  }
  // Forewings have a long costal edge; the smaller hindwings sweep back into a swallowtail.
  for (const side of [-1, 1]) for (const hind of [0, 1]) {
    const start = positions.length / 3, rows = 12, across = 4;
    for (let i = 0; i <= rows; i++) {
      const s = i / rows, bow = Math.sin(Math.PI * s);
      const x = 0.045 + s * (hind ? 0.73 : 1);
      const front = hind ? 0.01 - 0.54 * s * s + 0.045 * bow : 0.15 + 0.24 * bow + 0.16 * s - 0.20 * s * s;
      const scallop = 0.035 * bow * (1 - Math.cos(s * TAU * 4));
      const width = (1 - s) * 0.12 + Math.pow(bow, 0.83) * (hind ? 0.34 : 0.40) - scallop
        + (hind ? 0.32 * Math.exp(-Math.pow((s - 0.72) / 0.10, 2)) : 0);
      for (let j = 0; j <= across; j++) {
        const u = j / across;
        point(side * x, bow * (0.06 + 0.09 * Math.sin(Math.PI * u)) - 0.09 * s * s, front - u * width, hind ? 2 : 1, s, u);
        const k = start + i * (across + 1) + j;
        if (i && j) indices.push(k - across - 2, k - across - 1, k - 1, k - 1, k - across - 1, k);
        if (i && j && i % 2 === 0 && j % 2 === 0) {
          const back = k - 2 * (across + 1);
          coarse.push(back - 2, back, k - 2, k - 2, back, k);
        }
      }
    }
  }
  const wings = indices.length;
  function body(rings, offsetX, offsetY, part) {
    const start = positions.length / 3, sides = 8;
    for (let i = 0; i < rings.length; i++) {
      const [z, radius] = rings[i];
      for (let j = 0; j < sides; j++) {
        const a = j * TAU / sides;
        point(offsetX + Math.cos(a) * radius, offsetY + Math.sin(a) * radius * 0.86, z, part, i / (rings.length - 1), (1 + Math.sin(a)) / 2);
        if (i) {
          const p = start + (i - 1) * sides, next = (j + 1) % sides;
          indices.push(p + j, p + next, p + j + sides, p + next, p + next + sides, p + j + sides);
          if (part === 0 && j % 2 === 0) {
            const b = p + (j + 2) % sides;
            coarse.push(p + j, b, p + j + sides, b, b + sides, p + j + sides);
          }
        }
      }
    }
  }
  const abdomen = [[-0.56, 0.009]];
  for (let i = 0; i < 5; i++) {
    const z = -0.50 + i * 0.077, width = 0.030 + i * 0.007;
    abdomen.push([z, width], [z + 0.058, width * 1.18], [z + 0.071, width * 0.88]);
  }
  body([...abdomen, [-0.073, 0.079], [0.02, 0.108], [0.12, 0.097], [0.19, 0.061], [0.24, 0.082], [0.31, 0.056], [0.35, 0.008]], 0, 0.012, 0);
  for (const side of [-1, 1]) {
    body([[0.24,0.004],[0.25,0.025],[0.279,0.024],[0.285,0.004]], side * 0.063, 0.047, 4);
    for (let j = 0; j <= 5; j++) {
      const u = j / 5, w = 0.009 * (1 - 0.7 * u);
      const x = side * (0.045 + 0.091 * u + 0.052 * u * u), z = 0.28 + 0.25 * u;
      const k = point(x - w, 0.04 + 0.092 * Math.sin(2.2 * u), z, 5, u, 0);
      point(x + w, 0.04 + 0.092 * Math.sin(2.2 * u), z, 5, u, 1);
      if (j) indices.push(k - 2, k - 1, k, k, k - 1, k + 1);
    }
    // Three short jointed legs tuck beneath the thorax while the wings beat.
    for (let pair = 0; pair < 3; pair++) {
      const z = 0.14 - 0.078 * pair, sweep = 0.04 - 0.055 * pair;
      const joints = [[0.048, -0.043, z], [0.125, -0.083, z + sweep],
        [0.104, -0.155, z + sweep - 0.072], [0.135, -0.170, z + sweep - 0.105]];
      for (let j = 0; j < joints.length; j++) {
        const [x, y, pz] = joints[j], w = 0.012 - 0.0028 * j;
        const k = point(side * x, y + w, pz, 6, j / 3, 0);
        point(side * x, y - w, pz + w, 6, j / 3, 1);
        if (j) indices.push(k - 2, k - 1, k, k, k - 1, k + 1);
      }
    }
    // Twin trailing filaments have a tiny leaf-shaped paddle at each end.
    for (let j = 0; j <= 9; j++) {
      const s = j / 9, w = 0.013 * (1 - s) + 0.026 * Math.exp(-Math.pow((s - 0.84) * 10, 2));
      const x = side * (0.016 + 0.16 * s + 0.04 * s * s), y = 0.013 - 0.14 * s, z = -0.47 - 0.68 * s;
      const v = point(x - w, y, z, 3, s, 0);
      point(x + w, y + w * 0.25, z, 3, s, 1);
      if (j) indices.push(v - 2, v - 1, v, v, v - 1, v + 1);
      if (j && j % 3 === 0) coarse.push(v - 6, v - 5, v, v, v - 5, v + 1);
    }
  }
  return { positions: new Float32Array(positions), markings: new Float32Array(markings), indices: new Uint16Array([...indices, ...coarse]), wings, fine: indices.length, coarse: coarse.length };
}

// Each group patrols one watershed habitat. Smaller river circuits follow its actual bends.
const habitats = [
  ['lake', 7, 21, 5.3, 4.1, 3], ['lake', -11, 12, 7.8, 5.6, 3], ['lake', -11, -6, 4.5, 3.8, 2],
  ['river', 0, -34, 1.1, 5.4, 3], ['river', 0, -55, 0.8, 5.2, 2],
  ['meadow', 32, 12, 6.3, 4.4, 2], ['meadow', 28, -34, 4.8, 4.8, 3], ['meadow', 39, 42, 5.8, 6.5, 2],
  ['meadow', -38, 32, 7, 6.1, 2], ['meadow', -41, -34, 6, 4.7, 2], ['meadow', -35, -7, 5.2, 3.8, 2],
  ['meadow', 1, 41, 5.5, 3.8, 2], ['meadow', 42, -6, 5.4, 4.0, 2], ['meadow', -20, -45, 4.7, 5.8, 2],
  ['lake', -20, -99, 7.1, 4.1, 3], ['meadow', -99, 7, 6.4, 5.2, 2],
  ['meadow', 105, -18, 6.1, 8.2, 2], ['meadow', 10, 103, 7.2, 4.2, 2],
];
const samples = 64;

function makeRoutes(groundAt, waterLevel, riverX, sc, forest, random, oaks) {
  const routes = [];
  const obstacles = [];
  for (let i = 0; i < forest.sites.length; i += 4) {
    const h = forest.sites[i+3], spread = forest.styles[i+2];
    obstacles.push({ x: forest.sites[i], y: forest.sites[i+1], z: forest.sites[i+2], radius: 0.57 * h * spread, height: h * 1.12 + 0.4 });
  }
  for (const {x,y,z,height} of oaks) obstacles.push({x,y,z,radius:0.53*height,height:height+0.4});
  for (let group = 0; group < sc.rv.length; group++) {
    if (group === 3) continue; // beach gravel
    const pos = sc.rv[group], scale = sc.rs[group];
    for (let i = 0; i < pos.length; i += 4) {
      obstacles.push({ x: pos[i], y: pos[i + 1], z: pos[i + 2], radius: Math.max(scale[i], scale[i + 2]), height: scale[i + 1] * 1.38 });
    }
  }
  for (const [habitat, cx, cz, rx, rz, count] of habitats) {
    const river = habitat === 'river', water = habitat !== 'meadow';
    const nearby = obstacles.filter(o => Math.abs(o.z - cz) <= rz + 2 * o.radius + 3
      && Math.abs(o.x - (river ? riverX(cz) : cx)) <= rx + 2 * o.radius + (river ? 12 : 3));
    for (let i = 0; i < count; i++) {
      const phase = TAU * (i + random() * 0.35) / count;
      const size = 0.68 * (0.64 + random() * 0.32) * (water ? 1.05 : 1.16);
      const shift = (random() - 0.5) * 0.58, period = (river ? 13 : 17) + 5 * random();
      const path = new Float32Array(samples * 3), clear = new Float32Array(samples);
      for (let k = 0; k < samples; k++) {
        const a = TAU * k / samples, z = cz + rz * Math.sin(a) + shift * Math.cos(2 * a);
        const x = (river ? riverX(z) : cx) + rx * Math.cos(a) + shift * Math.sin(2 * a);
        let top = Math.max(groundAt(x, z), waterLevel(x, z));
        // Ease up over crowns and large boulders. Only the static route builder scans the scene.
        for (const o of nearby) {
          const f = Math.min(1, 1.8 - Math.hypot(x - o.x, z - o.z) / (o.radius + size));
          if (f > 0) top = Math.max(top, o.y + o.height * f);
        }
        path[k * 3] = x; path[k * 3 + 2] = z; clear[k] = top;
      }
      for (let k = 0; k < samples; k++) {
        // Anticipate higher terrain on both sides, reducing pitch changes around cliffs.
        let top = clear[k];
        for (let off = 1; off <= 6; off++) {
          const higher = Math.max(clear[(k + off) % samples], clear[(k + samples - off) % samples]);
          top = Math.max(top, higher - off * 0.23);
        }
        const a = TAU * k / samples;
        const dip = water ? Math.pow(Math.max(0, Math.cos(a)), 9) : 0;
        path[3 * k + 1] = top + (0.066 * size) + (1 - dip) * (1.55 + 0.38 * i + 0.48 * Math.sin(a - 0.3));
      }
      const wx = path[0], wz = path[2], level = waterLevel(wx, wz);
      const skims = water && groundAt(wx, wz) < level - 0.2 && path[1] < level + 0.23;
      routes.push({ path, size, phase, period, skims, alarm: 0, alarmTime: -2, bank: 0, hue: random() > (water ? 0.25 : 0.60) ? 1 : -1 });
    }
  }
  return routes;
}

export function createSailwings({ gl, program, vao, worldVertex, groundAt, waterLevel, riverX, sc, stands, oaks = [], random, outsideView, windAt }) {
  const shader = program(worldVertex + vertexSource, fragmentSource);
  const mesh = sailwingMesh(), routes = makeRoutes(groundAt, waterLevel, riverX, sc, stands, random, oaks);
  const instances = new Float32Array(routes.length * 9), buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, 2 * instances.byteLength, gl.DYNAMIC_DRAW);
  const attrs = [
    { loc: gl.getAttribLocation(shader, 'aPos'), data: mesh.positions, size: 3 },
    { loc: gl.getAttribLocation(shader, 'aMark'), data: mesh.markings, size: 3 },
    { loc: gl.getAttribLocation(shader, 'aPose'), buffer, size: 4, div: 1, stride: 36, offset: 0 },
    { loc: gl.getAttribLocation(shader, 'aAngles'), buffer, size: 3, div: 1, stride: 36, offset: 16 },
    { loc: gl.getAttribLocation(shader, 'aStroke'), buffer, size: 2, div: 1, stride: 36, offset: 28 },
  ];
  const indices = gl.createBuffer();
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  const nearVAO = vao(attrs, indices), farVAO = vao(attrs, indices, routes.length);
  const order = [], rows = routes.map((_, i) => instances.subarray(i * 9, i * 9 + 9));
  const packed = new Float32Array(instances.length), depth = new Float32Array(routes.length);
  const bounds = { x0: 0, z0: 0, y0: 0, y1: 0, pad: 0 };
  const skimmers = routes.filter(r => r.skims);
  const velocity = new Float64Array(3), acceleration = new Float64Array(3);
  let lastTime = -1;
  function alarmAt(route, t) {
    const age = t - route.alarmTime;
    return age >= 0 && age < 1.8 ? route.alarm * Math.min(1, age / 0.18) * (1 - age / 1.8) ** 2 : 0;
  }
  return {
    shader,
    reset() {
      for (const r of routes) r.alarm = 0;
      lastTime = -1;
    },
    startle(x, y, z, t, strength) {
      for (const r of routes) {
        const phase = ((t / r.period + r.phase / TAU) % 1) * samples;
        const k = Math.floor(phase) * 3, next = (k + 3) % r.path.length, u = phase % 1;
        const dx = r.path[k] + u * (r.path[next] - r.path[k]) - x;
        const dy = r.path[k + 1] + u * (r.path[next + 1] - r.path[k + 1]) - y;
        const dz = r.path[k + 2] + u * (r.path[next + 2] - r.path[k + 2]) - z;
        const weight = Math.min(1, strength) * (1 - Math.hypot(dx, dy, dz) / 7);
        if (weight <= 0 || weight < alarmAt(r, t)) continue;
        r.alarm = weight; r.alarmTime = t;
        r.bank = Math.sign(dz * (r.path[next] - r.path[k]) - dx * (r.path[next + 2] - r.path[k + 2]));
      }
      lastTime = -1;
    },
    draw(t, planes, eye, forward, mirror) {
      // Interpolate flight only once for the lake reflection and the main view.
      if (t !== lastTime) {
        for (let i = 0; i < routes.length; i++) {
          const { path, phase, period, size, hue, skims } = routes[i];
          const a = phase + TAU * t / period, at = (a / TAU % 1) * samples, k = Math.floor(at), u = at - k;
          const from = 3 * k, to = 3 * ((k + 1) % samples);
          const prev = 3 * ((k + samples - 1) % samples), next = 3 * ((k + 2) % samples);
          const p = i * 9;
          for (let j = 0; j < 3; j++) {
            const back = path[from+j] - path[prev+j], step = path[to+j] - path[from+j], front = path[next+j] - path[to+j];
            // Monotone tangents in height keep the spline above the sampled
            // water at a skim and prevent overshooting a crest on the other side.
            const m0 = j === 1 ? (back * step > 0 ? 2 * back * step / (back + step) : 0) : 0.5 * (back + step);
            const m1 = j === 1 ? (step * front > 0 ? 2 * step * front / (step + front) : 0) : 0.5 * (step + front);
            const c = 3 * step - 2 * m0 - m1, d = m0 + m1 - 2 * step;
            instances[p+j] = path[from+j] + u * (m0 + u * (c + u * d));
            velocity[j] = m0 + u * (2 * c + 3 * u * d);
            acceleration[j] = 2 * c + 6 * u * d;
          }
          const [dx, dy, dz] = velocity, horizontal = Math.max(0.01, Math.hypot(dx, dz));
          const turn = (dz * acceleration[0] - dx * acceleration[2]) / horizontal * (samples / period) ** 2;
          const lift = skims ? 1 - Math.pow(Math.max(0, Math.cos(a)), 9) : 1;
          const pitch = 0.63 * Math.atan2(dy, horizontal), hz = 1.62 + (0.80 - size) * 0.95;
          const alarm = alarmAt(routes[i], t);
          const sail = Math.max(0, Math.sin(0.86 * t + phase * 2 + i) - 0.34) / 0.66;
          // In a crosswind they bank into the front and ride its lift. Drift
          // fades to zero at a skim, exactly where the water responds.
          const gust=windAt(instances[p],instances[p+2])*lift;
          const crosswind=(windDirection[0]*dz-windDirection[1]*dx)/horizontal;
          instances[p] += 0.32*windDirection[0]*gust;
          instances[p+2] += 0.32*windDirection[1]*gust;
          instances[p + 1] += 0.94 * alarm + 0.10*Math.max(0,gust);
          instances[p + 3] = size * hue;
          instances[p + 4] = Math.atan2(dx, dz);
          instances[p + 5] = pitch + 0.22 * alarm;
          instances[p + 6] = -0.52 * Math.tanh(turn * 0.55) * lift + 0.48 * routes[i].bank * alarm + 0.19*crosswind*gust;
          instances[p + 7] = TAU * hz * t + 0.27 * Math.sin(1.9 * t + phase) + phase * 3 + i + 3.2 * alarm;
          instances[p + 8] = Math.min(1.1, (0.83 - 0.15*Math.max(0,gust) - 0.72 * sail * sail + 0.18 * Math.max(0, pitch)) * lift + 0.88 * alarm);
        }
        lastTime = t;
      }
      // Group by distance and sort the few translucent insects back to
      // front for this eye. The reflection sees the same poses from below.
      const detail = mirror < 0 ? 15 : 28;
      order.length = 0;
      let distant = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i], r = Math.abs(row[3]) * 1.45;
        bounds.x0 = row[0]; bounds.z0 = row[2]; bounds.pad = r;
        bounds.y0 = row[1] - r; bounds.y1 = row[1] + r;
        if (outsideView(planes, bounds, 0)) continue;
        const dx = row[0] - eye[0], dy = row[1] - eye[1], dz = row[2] - eye[2];
        if (dx * dx + dy * dy + dz * dz < detail * detail) {
          depth[i] = dx * forward[0] + dy * forward[1] * mirror + dz * forward[2];
          order.push(i);
        } else packed.set(row, 9 * distant++);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.uniform1i(shader.u('uGlass'), 0);
      if (distant) {
        gl.bufferSubData(gl.ARRAY_BUFFER, instances.byteLength, packed, 0, 9 * distant);
        gl.bindVertexArray(farVAO);
        gl.drawElementsInstanced(gl.TRIANGLES, mesh.coarse, gl.UNSIGNED_SHORT, mesh.fine * 2, distant);
      }
      if (order.length) {
        order.sort((a, b) => depth[b] - depth[a]);
        for (let i = 0; i < order.length; i++) packed.set(rows[order[i]], 9 * i);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed, 0, order.length * 9);
        gl.bindVertexArray(nearVAO);
        gl.drawElementsInstanced(gl.TRIANGLES, mesh.fine - mesh.wings, gl.UNSIGNED_SHORT, mesh.wings * 2, order.length);
      }
    },
    drawWings() {
      if (!order.length) return;
      gl.uniform1i(shader.u('uGlass'), 1);
      gl.bindVertexArray(nearVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.wings, gl.UNSIGNED_SHORT, 0, order.length);
    },
    skim(t, dt, disturb) {
      for (const r of skimmers) {
        const cycle = t / r.period + r.phase / TAU;
        if (Math.floor(cycle) === Math.floor(cycle - dt / r.period)) continue;
        const contactTime = t - (cycle % 1) * r.period;
        if (alarmAt(r, contactTime) < 0.035) disturb(r.path[0], r.path[2]);
      }
    },
  };
}
