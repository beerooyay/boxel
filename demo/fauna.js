// A sailwing has two pairs of hinged membranes, a segmented abdomen and paired streamers.
// The same articulated mesh is instanced throughout the watershed and in its reflection.
const TAU = 2 * Math.PI;
const vertexSource = `
in vec3 aPos, aMark;
in vec4 aPose;
in vec3 aAngles;
in vec2 aStroke;
out vec3 vWP, vMark;
flat out vec2 vSignal;
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
    p.x += span * span * (0.052 * sin(beat * 0.53 - span * 3.) + 0.04 * sign(p.x));
    p.y += span * span * 0.13 * sin(beat * 0.48 - span * 3. - 1.);
  }
  vec2 heading = vec2(sin(aAngles.x), cos(aAngles.x));
  float c = cos(aAngles.z), s = sin(aAngles.z);
  p.xy = mat2(c, s, -s, c) * p.xy;
  float pitch = aAngles.y + 0.022 * effort * cos(beat);
  p.zy = mat2(cos(pitch), sin(pitch), -sin(pitch), cos(pitch)) * p.zy;
  vec2 world = vec2(heading.y, -heading.x) * p.x + heading * p.z;
  vWP = aPose.xyz + vec3(world.x, p.y, world.y) * abs(aPose.w);
  vMark = aMark;
  vSignal = vec2(step(0., aPose.w), texture(uGlow, fieldUV(aPose.xz)).r);
  gl_Position = project(vWP);
}`;
const fragmentSource = `
uniform float uClip;
in vec3 vWP, vMark;
flat in vec2 vSignal;
out vec4 o;
void main(){
  if (vWP.y < uClip) discard;
  vec3 n = normalize(cross(dFdx(vWP), dFdy(vWP)));
  if (n.y < 0.) n = -n;
  vec3 pigment = mix(vec3(0.83, 0.25, 0.36), vec3(0.095, 0.69, 0.55), vSignal.x);
  vec3 ink = mix(vec3(0.070, 0.017, 0.064), vec3(0.012, 0.042, 0.076), vSignal.x);
  float part = vMark.x, span = vMark.y, chord = vMark.z;
  float mark = 0.;
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
    float silk = smoothstep(0.03, 0.60, span) * (1. - smoothstep(0.64, 1., span));
    vec3 shoulder = mix(vec3(0.34, 0.063, 0.13), vec3(0.028, 0.16, 0.23), vSignal.x);
    float incidence = abs(dot(n, normalize(uCam - vWP)));
    alb = mix(shoulder, pigment * (0.47 + 0.23 * incidence), silk * (0.46 + 0.54 * sin(3.14 * chord)));
    alb = mix(alb, ink, max(0.92 * margin, 0.92 * disc));
    mark = max(ring, max(0.55 * radial, 0.24 * joint) * (1. - disc)) * (1. - smoothstep(0.36, 1.3, width));
    // The broad satin edge survives after the fine cells fall below a pixel.
    mark = max(mark, 0.25 * margin * smoothstep(0.32, 0.78, span));
  } else if (part == 0.) {
    float band = abs(fract(span * 7.) - 0.5);
    mark = (1. - smoothstep(0.035, 0.1 + fwidth(span * 7.), band)) * 0.55;
    alb = mix(ink, pigment, 0.12 + 0.12 * span);
  } else {
    mark = part == 4. ? 0.31 : smoothstep(0.45, 0.94, span) * 0.72;
  }
  alb = mix(alb, pigment * 0.89 + 0.035, 0.79 * mark);
  vec3 ambientSky = ambient(n) * mix(vec3(1.), vec3(0.40, 0.53, 0.55), canopyCover(vWP));
  vec3 light = ambientSky * 2.6 + floraSpill(vWP) + uSunCol * directLight(vWP) * (0.10 + 0.48 * abs(dot(n, uSunDir)));
  float night = smoothstep(0.22, 0.94, uNight);
  vec3 membrane = alb * light + pigment * mark * night * (0.53 + 1.65 * glowI(vSignal.y));
  o = vec4(tonemap(fogged(membrane, vWP)), 0.);
}`;

function sailwingMesh() {
  const positions = [], markings = [], indices = [];
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
      const front = hind ? 0.02 - 0.44 * s * s + 0.04 * bow : 0.145 + 0.36 * bow - 0.085 * s;
      const scallop = 0.035 * bow * (1 - Math.cos(s * TAU * 4));
      const width = (1 - s) * 0.12 + Math.pow(bow, 0.83) * (hind ? 0.34 : 0.40) - scallop
        + (hind ? 0.32 * Math.exp(-Math.pow((s - 0.72) / 0.10, 2)) : 0);
      for (let j = 0; j <= across; j++) {
        const u = j / across;
        point(side * x, bow * (0.06 + 0.09 * Math.sin(Math.PI * u)) - 0.09 * s * s, front - u * width, hind ? 2 : 1, s, u);
        const k = start + i * (across + 1) + j;
        if (i && j) indices.push(k - across - 2, k - across - 1, k - 1, k - 1, k - across - 1, k);
      }
    }
  }
  function body(rings, offsetX, offsetY, part) {
    const start = positions.length / 3, sides = 8;
    for (let i = 0; i < rings.length; i++) {
      const [z, radius] = rings[i];
      for (let j = 0; j < sides; j++) {
        const a = j * TAU / sides;
        point(offsetX + Math.cos(a) * radius, offsetY + Math.sin(a) * radius * 0.86, z, part, i / (rings.length - 1), 0);
        if (i) {
          const p = start + (i - 1) * sides, next = (j + 1) % sides;
          indices.push(p + j, p + next, p + j + sides, p + next, p + next + sides, p + j + sides);
        }
      }
    }
  }
  body([[-0.53, 0.009], [-0.44, 0.036], [-0.27, 0.06], [-0.04, 0.092], [0.12, 0.095], [0.19, 0.061], [0.24, 0.082], [0.31, 0.056], [0.35, 0.008]], 0, 0.012, 0);
  for (const side of [-1, 1]) {
    body([[0.24,0.004],[0.25,0.025],[0.279,0.024],[0.285,0.004]], side * 0.063, 0.047, 4);
    for (let j = 0; j <= 5; j++) {
      const u = j / 5, w = 0.009 * (1 - 0.7 * u);
      const x = side * (0.045 + 0.091 * u + 0.052 * u * u), z = 0.28 + 0.25 * u;
      const k = point(x - w, 0.04 + 0.092 * Math.sin(2.2 * u), z, 5, u, 0);
      point(x + w, 0.04 + 0.092 * Math.sin(2.2 * u), z, 5, u, 1);
      if (j) indices.push(k - 2, k - 1, k, k, k - 1, k + 1);
    }
    // Twin trailing filaments have a tiny leaf-shaped paddle at each end.
    for (let j = 0; j <= 9; j++) {
      const s = j / 9, w = 0.013 * (1 - s) + 0.026 * Math.exp(-Math.pow((s - 0.84) * 10, 2));
      const x = side * (0.016 + 0.16 * s + 0.04 * s * s), y = 0.013 - 0.14 * s, z = -0.47 - 0.68 * s;
      const v = point(x - w, y, z, 3, s, 0);
      point(x + w, y + w * 0.25, z, 3, s, 1);
      if (j) indices.push(v - 2, v - 1, v, v, v - 1, v + 1);
    }
  }
  return { positions: new Float32Array(positions), markings: new Float32Array(markings), indices: new Uint16Array(indices) };
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

function makeRoutes(groundAt, waterLevel, riverX, sc, random) {
  const routes = [];
  const obstacles = [];
  for (let i = 0; i < sc.trees.length; i += 5) {
    const h = sc.trees[i + 4];
    obstacles.push({ x: sc.trees[i], y: sc.trees[i + 1], z: sc.trees[i + 2], radius: 0.53 * h, height: h * 1.12 + 0.4 });
  }
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
      routes.push({ path, size, phase, period, skims, hue: random() > (water ? 0.25 : 0.60) ? 1 : -1 });
    }
  }
  return routes;
}

export function createSailwings({ gl, program, vao, worldVertex, groundAt, waterLevel, riverX, sc, random }) {
  const shader = program(worldVertex + vertexSource, fragmentSource);
  const mesh = sailwingMesh(), routes = makeRoutes(groundAt, waterLevel, riverX, sc, random);
  const instances = new Float32Array(routes.length * 9), buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, instances.byteLength, gl.DYNAMIC_DRAW);
  const vertices = vao([
    { loc: gl.getAttribLocation(shader, 'aPos'), data: mesh.positions, size: 3 },
    { loc: gl.getAttribLocation(shader, 'aMark'), data: mesh.markings, size: 3 },
    { loc: gl.getAttribLocation(shader, 'aPose'), buffer, size: 4, div: 1, stride: 36, offset: 0 },
    { loc: gl.getAttribLocation(shader, 'aAngles'), buffer, size: 3, div: 1, stride: 36, offset: 16 },
    { loc: gl.getAttribLocation(shader, 'aStroke'), buffer, size: 2, div: 1, stride: 36, offset: 28 },
  ], mesh.indices);
  const indexCount = mesh.indices.length;
  const skimmers = routes.filter(r => r.skims);
  const velocity = new Float64Array(3), acceleration = new Float64Array(3);
  let lastTime = -1;
  return {
    shader,
    draw(t) {
      // The lake reflection and the main view use the same flight pose and upload.
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
          instances[p + 3] = size * hue;
          instances[p + 4] = Math.atan2(dx, dz);
          instances[p + 5] = pitch;
          instances[p + 6] = -0.52 * Math.tanh(turn * 0.55) * lift;
          instances[p + 7] = TAU * hz * t + 0.22 * Math.sin(1.9 * t + phase) + phase * 3 + i;
          instances[p + 8] = (0.72 + 0.17 * Math.sin(t * 1.13 + phase * 3 + i) + 0.15 * Math.max(0, pitch)) * lift;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances);
        lastTime = t;
      }
      gl.bindVertexArray(vertices);
      gl.drawElementsInstanced(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0, routes.length);
    },
    skim(t, dt, disturb) {
      for (const r of skimmers) {
        const cycle = t / r.period + r.phase / TAU;
        if (Math.floor(cycle) !== Math.floor(cycle - dt / r.period)) disturb(r.path[0], r.path[2]);
      }
    },
  };
}
