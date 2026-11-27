// The valley and the outer forest grow from the same fluted trunk and alternating
// broadleaf shoots. Templates change the branching habit, instances set size and pigment.
const habits = [
  { fork: 0.26, spread: 0.49, lift: 0.3, lean: 0.32, taper: 0.44, shoulder: 0.02 }, // spreading
  { fork: 0.19, spread: 0.37, lift: 0.17, lean: 0.06, taper: 0.78, shoulder: 0.05 }, // upright
  { fork: 0.32, spread: 0.37, lift: 0.27, lean: 0.13, taper: 0.46, shoulder: 0.32 }, // rounded
];
const treeSeeds = [9942, 2113, 8605, 981, 7139, 3029];

export function highCanopyMesh(random, variant = 0) {
  const habit = habits[variant % habits.length],
    foliage = [];
  const position = [],
    normal = [],
    tissue = [],
    blade = [],
    stalk = [],
    near = [],
    far = [];
  const tau = 2 * Math.PI;
  function vertex(p, n, shade, u = 0, side = 0, root = p, angle = 0) {
    position.push(...p);
    normal.push(...n);
    tissue.push(shade);
    blade.push(u, side, angle);
    stalk.push(...root);
    return tissue.length - 1;
  }
  function normalise(x, y, z) {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  }
  function mix(a, b, t) {
    return a.map((v, i) => v + t * (b[i] - v));
  }
  function extend(p, angle, reach, rise) {
    return [p[0] + Math.cos(angle) * reach, p[1] + rise, p[2] + Math.sin(angle) * reach];
  }
  // Each limb has its own axis. Broad root flutes die out before the trunk forks.
  function wood(points, radii, sides, buttress = false) {
    const start = tissue.length,
      spin = random() * tau;
    const flares = Array.from({ length: sides }, () => 0.18 + 0.82 * random());
    for (let k = 0; k < points.length; k++) {
      const p = points[k],
        next = points[Math.min(k + 1, points.length - 1)],
        prev = points[Math.max(0, k - 1)];
      const [x, y, z] = normalise(...next.map((v, i) => v - prev[i]));
      const tx = normalise(y, -x, 0),
        tz = [-z * tx[1], z * tx[0], x * tx[1] - y * tx[0]];
      for (let i = 0; i < sides; i++) {
        const a = spin + (i * tau) / sides,
          c = Math.cos(a),
          s = Math.sin(a);
        const n = tx.map((v, j) => v * c + tz[j] * s);
        const flare = buttress && k < 2 ? (k === 0 ? 1.48 : 0.28) * flares[i] ** 2 : 0;
        const r = radii[k] * (0.87 + 0.23 * flares[i] + flare);
        vertex(
          p.map((v, j) => v + r * n[j]),
          n,
          -1 - p[1],
        );
      }
      if (k === 0) continue;
      for (let i = 0; i < sides; i++) {
        const a = start + (k - 1) * sides + i,
          b = start + (k - 1) * sides + ((i + 1) % sides);
        near.push(a, b, a + sides, b, b + sides, a + sides);
        far.push(a, b, a + sides, b, b + sides, a + sides);
      }
    }
  }

  // A card carries a whole twig of veined leaves. Near and far share its four
  // corners and stalk. The closer mesh also resolves the arch along its spine.
  function frond(root, angle, length, slope, droop, tone) {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const roll = (random() - 0.5) * 1.48,
      curl = (random() - 0.5) * 0.27;
    const breadth = length * (0.49 + 0.1 * random());
    const start = tissue.length;
    function row(t) {
      const drift = curl * t * t * length;
      for (const side of [-1, 1]) {
        const lateral = drift + side * breadth;
        const y = length * (slope * t - droop * t * t) + side * breadth * roll;
        const tilt = slope - 2 * droop * t;
        vertex(
          [root[0] + c * length * t - s * lateral, root[1] + y, root[2] + s * length * t + c * lateral],
          normalise(-c * tilt + s * roll, 1, -s * tilt - c * roll),
          tone,
          t,
          side,
          root,
          angle,
        );
      }
    }
    row(0);
    row(0.5);
    row(1);
    for (let k = start; k < start + 4; k += 2) near.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    far.push(start, start + 4, start + 1, start + 1, start + 4, start + 5);
    foliage.push(
      root[0] + 0.54 * c * length,
      root[1] + length * (0.54 * slope - 0.29 * droop),
      root[2] + 0.54 * s * length,
      0.45 * length * breadth,
    );
  }

  function shoot(root, angle, reach, lift) {
    const turn = (random() - 0.5) * 0.86;
    const mid = extend(root, angle, reach * 0.54, lift * 0.76 + 0.02);
    const tip = extend(mid, angle + turn, reach * 0.46, lift * 0.24 - 0.014);
    wood([root, mid, tip], [0.005, 0.0032, 0.0009], 4);
    const pairs = 3 + Math.floor(2 * random()),
      tone = random();
    for (let j = 0; j < 2 * pairs; j++) {
      const t = (j + 0.45 + 0.3 * random()) / (2 * pairs);
      const p = t < 0.54 ? mix(root, mid, t / 0.54) : mix(mid, tip, (t - 0.54) / 0.46);
      const az = angle + turn * t + (j % 2 ? 1 : -1) * (0.8 + 0.49 * (1 - t) + 0.23 * random());
      const length = (0.18 + 0.085 * random()) * (1.06 - 0.29 * t);
      const slope = 0.12 + 0.69 * random() + 0.32 * t;
      const droop = 0.33 + 0.58 * random() + 0.19 * (1 - t);
      frond(p, az, length, slope, droop, 0.06 + 0.5 * tone + 0.38 * random());
    }
    frond(tip, angle + turn, 0.18 + 0.04 * random(), 0.25, 0.6, 0.65 + 0.28 * random());
  }

  const lean = habit.lean * (0.78 + 0.4 * random()),
    twist = (random() - 0.5) * 0.13;
  const spine = (t) => [lean * t * t + 0.029 * Math.sin(t * 5.3), t, twist * t * t];
  wood(
    [0, 0.09, 0.25, 0.42, 0.63, 0.8, 0.94].map(spine),
    [0.065, 0.047, 0.04, 0.033, 0.024, 0.015, 0.004],
    10,
    true,
  );
  const forks = 7 + Math.floor(2 * random()),
    rotation = tau * random();
  for (let i = 0; i < forks; i++) {
    const t = i / (forks - 1),
      a = rotation + i * 2.39996 + (random() - 0.5) * 0.72;
    const base = spine(habit.fork + (0.81 - habit.fork) * t);
    const profile = 1 - habit.taper * t + habit.shoulder * Math.sin(Math.PI * t);
    const reach = habit.spread * profile * (0.82 + 0.37 * random());
    const lift = habit.lift * (1 - 0.53 * t) * (0.76 + 0.4 * random()),
      turn = (random() - 0.5) * 1.0;
    const elbow = extend(base, a, reach * 0.47, lift * 0.57);
    const hand = extend(elbow, a + turn, reach * 0.53, lift * 0.43);
    wood([base, elbow, hand], [0.028 - 0.013 * t, 0.016 - 0.008 * t, 0.004], 7);
    shoot(elbow, a - 0.82, reach * 0.74, 0.055 + 0.075 * random());
    shoot(mix(elbow, hand, 0.52), a + turn + 0.89, reach * 0.69, 0.034 + 0.08 * random());
    shoot(hand, a + turn, 0.15 + 0.055 * random(), 0.015 - 0.066 * random());
  }
  for (let i = 0; i < 4; i++)
    shoot(spine(0.86 + i * 0.022), rotation + i * 1.55, 0.16 + 0.095 * random(), 0.07 + 0.065 * random());
  let radius = 0,
    bottom = Infinity,
    top = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    radius = Math.max(radius, Math.hypot(position[i], position[i + 2]));
    bottom = Math.min(bottom, position[i + 1]);
    top = Math.max(top, position[i + 1]);
  }
  return {
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    blade: new Float32Array(blade),
    stalk: new Float32Array(stalk),
    tissue: new Float32Array(tissue),
    index: new Uint16Array([...near, ...far]),
    foliage: new Float32Array(foliage),
    radius,
    bottom,
    top,
    nearCount: near.length,
    farCount: far.length,
  };
}

export function highCanopySites(heightAt, noise, random, half, pathCover, waterLevel) {
  const instances = [];
  for (let i = 0; i < 2400; i++) {
    const x = (random() * 2 - 1) * 200,
      z = (random() * 2 - 1) * 200;
    const edge = Math.max(Math.abs(x), Math.abs(z)),
      stand = noise(x * 0.045 + 3, z * 0.045 - 11);
    if (edge < half - 12 || stand < 0.5 || (edge < half && stand < 0.73) || pathCover(x, z) > 0.01) continue;
    const y = heightAt(x, z);
    if (y < waterLevel(x, z) + 0.8 || y > 38 || Math.abs(y - heightAt(x + 2, z + 1)) > 2.6) continue;
    instances.push(x, y - 0.55, z, 4.8 + 9.8 * random() + stand * 3.3);
  }
  return { instances: new Float32Array(instances) };
}

// Group trunks by shape and position once. This instance list also places the
// real foliated shoots in the ground shelter bake and supplies the water reflection.
export function forestStands(localTrees, uplandTrees, isletTree, noise, random) {
  const width = 32,
    clusters = new Map();
  const meshes = treeSeeds.map((seed, i) => highCanopyMesh(random(seed), i));
  const accents = [
    [-30, -3, 0.964],
    [10, -19, 0.929],
    [31, 3, 0.875],
  ];
  function plant(x, y, z, h, seed, islet = false) {
    const r = random(Math.floor(seed * 1e8) ^ 0x6a73);
    const colour = 0.74 * noise(x * 0.068 + 7, z * 0.068 - 12) + 0.26 * r();
    let hue = 0.12 + 0.6 * r();
    if (colour < 0.29) hue = 0.855 + 0.047 * r();
    else if (colour > 0.77) hue = 0.921 + 0.024 * r();
    else if (colour > 0.69) hue = 0.951 + 0.031 * r();
    for (const [cx, cz, pigment] of accents) {
      if ((x - cx) ** 2 + (z - cz) ** 2 < 90) hue = pigment + 0.009 * (seed - 0.5);
    }
    if (islet) hue = 0.41;
    let form = Math.floor(r() * 3);
    if (hue >= 0.85 && hue < 0.91) {
      form = 1;
      h *= 1.2;
    }
    if (hue >= 0.91 && hue < 0.95) {
      form = 0;
      h *= 1.18;
    }
    if (islet) form = 0;
    const variant = form + (r() < 0.5 ? 3 : 0);
    const az = islet ? 2.4 : r() * 2 * Math.PI,
      spread = islet ? 1.35 : 0.86 + 0.38 * r();
    const ix = Math.floor(x / width),
      iz = Math.floor(z / width),
      key = [variant, ix, iz].join(',');
    let tile = clusters.get(key);
    if (!tile) {
      tile = {
        variant,
        x0: ix * width,
        z0: iz * width,
        y0: Infinity,
        y1: -Infinity,
        pad: 0,
        sites: [],
        styles: [],
      };
      clusters.set(key, tile);
    }
    tile.sites.push(x, y, z, h);
    tile.styles.push(Math.cos(az), Math.sin(az), spread, hue);
    const mesh = meshes[variant];
    tile.y0 = Math.min(tile.y0, y + h * mesh.bottom - 0.12);
    tile.y1 = Math.max(tile.y1, y + h * (mesh.top + 0.18) + 0.12);
    tile.pad = Math.max(tile.pad, h * (mesh.radius * spread + 0.18) + 0.12);
  }
  for (let i = 0; i < localTrees.length; i += 5)
    plant(localTrees[i], localTrees[i + 1], localTrees[i + 2], localTrees[i + 4], localTrees[i + 3]);
  for (let i = 0; i < uplandTrees.length; i += 4) {
    const x = uplandTrees[i],
      z = uplandTrees[i + 2],
      f = x * 0.75488 + z * 0.56984;
    plant(x, uplandTrees[i + 1], z, uplandTrees[i + 3], f - Math.floor(f));
  }
  plant(...isletTree, true);
  const sites = [],
    styles = [],
    tiles = [];
  for (const tile of [...clusters.values()].sort((a, b) => a.variant - b.variant)) {
    const { sites: local, styles: style, ...bounds } = tile;
    tiles.push({ ...bounds, start: sites.length / 4, count: local.length / 4 });
    sites.push(...local);
    styles.push(...style);
  }
  return { meshes, sites: new Float32Array(sites), styles: new Float32Array(styles), tiles, width };
}
