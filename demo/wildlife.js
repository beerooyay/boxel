import { interpolate, loadAnimal } from './animal-rig.js';

// Trail clearings, in world metres. Each walking loop leaves space for the
// animal's body at the waterline, nearby boulders and tree trunks.
const homes = [
  // model, centre x/z, model scale, loop radii
  ['Deer',        16,    32.5, 0.35, 2.30, 1.40],
  ['Stag',        31.5,  35.5, 0.38, 2.50, 1.70],
  ['ShibaInu',     6,    32.5, 0.24, 1.65, 1.24],
  ['Alpaca',     -30,    48,   0.35, 2.70, 1.80],
  ['Bull',       -33.5,  86,   0.38, 2.80, 2.00],
  ['Cow',        -41,    86.5, 0.37, 2.65, 1.95],
  ['Donkey',     -71.5,  40.5, 0.37, 2.70, 1.80],
  ['Horse',       42,   101,   0.42, 3.35, 2.40],
  ['Horse_White', 55.5,  81,   0.41, 2.60, 1.65],
  ['Husky',      -32,   -78,   0.28, 2.15, 1.70],
  ['Wolf',        77.5, -32,   0.35, 2.65, 1.75],
];
const TAU = Math.PI * 2, SAMPLES = 48;
const smooth = x => { const u = Math.max(0, Math.min(1, x)); return u*u*(3-2*u); };

function makeRoute([name, cx, cz, scale, rx, rz], i, ground) {
  const samples = new Float32Array(3 * (SAMPLES + 1));
  let y0 = Infinity, y1 = -Infinity;
  // Sample the rendered terrain during world construction. Use the support
  // under the whole body to pitch and roll the animal as it crosses the slope.
  for (let j = 0; j <= SAMPLES; j++) {
    const a = TAU * j / SAMPLES, x = cx + rx*Math.cos(a), z = cz + rz*Math.sin(a);
    const h = ground(x, z), span = 1.7 * scale;
    samples[3*j] = h;
    samples[3*j+1] = (ground(x+span,z)-ground(x-span,z))/(2*span);
    samples[3*j+2] = (ground(x,z+span)-ground(x,z-span))/(2*span);
    y0 = Math.min(h, y0); y1 = Math.max(h, y1);
  }
  const reach = 5.4*scale;
  return { name, cx, cz, scale, rx, rz, samples, offset: i * 7.17 + 1.2,
    move: 4.5 + (i % 3)*0.85, rest: 4.8 + ((i*7) % 5)*0.92, stride: 3.4*scale,
    origin: new Float32Array([cx + rx, samples[0], cz]), basis: new Float32Array(9),
    bounds: { x0: cx-rx, z0: cz-rz, y0: y0-reach, y1: y1+7*scale, pad: reach },
    sampledAt: -Infinity, retryAt: 0, rig: null, loading: false };
}

function place(animal, t) {
  const { cx, cz, rx, rz, samples, move, rest, offset, origin, basis } = animal;
  const clock = t + offset, leg = Math.floor(clock/(move+rest)), elapsed = clock % (move+rest);
  const progress = leg + smooth(elapsed/move), angle = TAU * (progress/4 % 1);
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = angle*SAMPLES/TAU, j = Math.min(SAMPLES-1, Math.floor(k)), f = k-j;
  const at = 3*j;
  const h = samples[at] + f*(samples[at+3]-samples[at]);
  const gx = samples[at+1] + f*(samples[at+4]-samples[at+1]);
  const gz = samples[at+2] + f*(samples[at+5]-samples[at+2]);
  origin[0] = cx + rx*c; origin[1] = h; origin[2] = cz + rz*s;
  const dx = -rx*s, dz = rz*c, dy = gx*dx + gz*dz;
  const forward = Math.hypot(dx, dy, dz), up = Math.hypot(gx, 1, gz);
  basis[3] = -gx/up; basis[4] = 1/up; basis[5] = -gz/up;
  basis[6] = dx/forward; basis[7] = dy/forward; basis[8] = dz/forward;
  basis[0] = basis[4]*basis[8] - basis[5]*basis[7];
  basis[1] = basis[5]*basis[6] - basis[3]*basis[8];
  basis[2] = basis[3]*basis[7] - basis[4]*basis[6];
  animal.walk = smooth(elapsed/0.65) * smooth((move-elapsed)/0.65);
  animal.walkPhase = progress * (0.25*TAU*Math.hypot(rx,rz)/Math.SQRT2) / animal.stride;
  const stop = elapsed < move/2 ? leg-1 : leg;
  animal.restClip = (stop+3) % 3 === 0 ? 'Idle' : 'Eating';
}

function pose(animal, t) {
  const { rig, still, walking, walk, walkPhase, restClip } = animal;
  if (walk < 1) {
    const clip = rig.clips[restClip];
    rig.sample(still, clip, (t+animal.offset) % clip.duration);
  }
  if (walk > 0) {
    const clip = rig.clips.Walk;
    rig.sample(walking, clip, (walkPhase % 1) * clip.duration);
  }
  if (walk > 0 && walk < 1) {
    for (let i = 0; i < still.length; i++) {
      interpolate(still[i], still[i], 0, walking[i], 0, 3, walk, 0);
      interpolate(still[i], still[i], 3, walking[i], 3, 4, walk, 3);
    }
  }
  rig.apply(walk === 1 ? walking : still);
  animal.sampledAt = t;
}

export function createWildlife(gl, shader, ground, outsideView, coarse) {
  const animals = homes.map((home, i) => makeRoute(home, i, ground));
  const visible = coarse ? 38 : 52, preload = visible + 10;
  let pending = 0;
  async function request(animal) {
    pending++; animal.loading = true;
    try {
      const url = new URL('./animals/' + animal.name + '.glb', import.meta.url);
      const rig = await loadAnimal(gl, shader, url, ['Idle', 'Walk', 'Eating']);
      animal.still = rig.rest.map(n => n.slice()); animal.walking = rig.rest.map(n => n.slice());
      animal.rig = rig;
    } catch (error) {
      animal.retryAt = performance.now() + 15000;
      console.warn(error);
    } finally {
      animal.loading = false; pending--;
    }
  }
  function update(t, eye) {
    for (const a of animals) {
      const dx = a.cx-eye[0], dz = a.cz-eye[2];
      a.nearby = dx*dx+dz*dz <= preload*preload;
      if (!a.nearby) continue;
      if (!a.rig && !a.loading && pending < 2 && performance.now() >= a.retryAt) request(a);
      place(a, t);
    }
  }
  function draw(planes, eye, t, bind) {
    let bound = false;
    for (const a of animals) {
      if (!a.nearby || !a.rig || outsideView(planes, a.bounds, 2*a.rx, 2*a.rz)) continue;
      const dx = a.origin[0]-eye[0], dz = a.origin[2]-eye[2], d2 = dx*dx+dz*dz;
      if (d2 > visible*visible) continue;
      if (!bound) { bind(shader); bound = true; }
      // Reuse the same palette in the reflection. At range the legs occupy few pixels.
      if (t !== a.sampledAt && (d2 < 18*18 || t < a.sampledAt || t-a.sampledAt >= 1/24)) pose(a, t);
      a.rig.draw(a.origin, a.basis, a.scale);
    }
  }
  return { update, draw, state: () => animals.map(a => ({ name: a.name, home: [a.cx,a.cz],
    loaded: Boolean(a.rig), position: a.nearby ? Array.from(a.origin) : null,
    gait: a.nearby ? (a.walk >= 0.5 ? 'Walk' : a.restClip) : null })) };
}
