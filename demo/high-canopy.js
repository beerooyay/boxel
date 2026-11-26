// A tall, forked crown. Both mesh levels have the same branch ends and leaf tips.
export function highCanopyMesh(random) {
  const position = [],
    normal = [],
    tissue = [],
    blade = [],
    near = [],
    far = [];
  const tau = 2 * Math.PI;
  function vertex(p, n, shade, u = 0, side = 0) {
    position.push(...p);
    normal.push(...n);
    tissue.push(shade);
    blade.push(u, side);
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
        const r = radii[k] * (0.87 + 0.23 * flares[i] + (buttress && k === 0 ? 1.35 * flares[i] ** 2 : 0));
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

  // Two faces fold off the keel. A different roll and shoulder on each side
  // lets a whole spray catch the light without reading as one flat card.
  function leaf(root, angle, length, halfWidth, up, drop, shade) {
    const c = Math.cos(angle),
      s = Math.sin(angle),
      curl = (random() - 0.5) * 0.83;
    const roll = (random() - 0.5) * 1.08,
      asym = 0.8 + 0.36 * random(),
      fold = 0.28 + 0.45 * random();
    function point(t, side, width) {
      const breadth = side * halfWidth * width * (side < 0 ? asym : 1);
      const drift = curl * t * t * length + breadth;
      const slope = up - 2 * drop * t;
      const bank = roll * (0.35 + 0.65 * t) - side * fold;
      const p = [
        root[0] + c * length * t - s * drift,
        root[1] + length * (up * t - drop * t * t) + breadth * roll * (0.35 + 0.65 * t) - Math.abs(breadth) * fold,
        root[2] + s * length * t + c * drift,
      ];
      const n = normalise(-c * slope + s * bank, 1, -s * slope - c * bank);
      return vertex(p, n, shade, t, side);
    }
    const base = point(0, 0, 0),
      l = point(0.39, -1, 1),
      m = point(0.4, 0, 0),
      r = point(0.45, 1, 0.95);
    const ll = point(0.74, -0.6, 0.96),
      mm = point(0.77, 0, 0),
      rr = point(0.72, 0.68, 1);
    const tip = point(1, 0, 0);
    near.push(base, l, m, base, m, r, l, ll, m, m, ll, mm, m, mm, r, r, mm, rr, ll, tip, mm, mm, tip, rr);
    far.push(base, l, m, base, m, r, l, tip, m, m, tip, r);
  }

  function spray(root, angle, reach, lift, outer) {
    const turn = (random() - 0.5) * 0.78;
    const mid = extend(root, angle, 0.55 * reach, lift * 0.74 + 0.018);
    const tip = extend(mid, angle + turn, 0.46 * reach, 0.26 * lift - 0.015);
    wood([root, mid, tip], [0.0065, 0.004, 0.0014], 4);
    const pairs = 4 + Math.floor(2 * random()),
      hue = 0.39 + 0.35 * random(),
      fall = outer ? 0.78 : 0.57;
    for (let j = 0; j < 2 * pairs; j++) {
      const t = 0.06 + (0.88 * (j + 0.42 * random())) / (2 * pairs);
      const p = t < 0.55 ? mix(root, mid, t / 0.55) : mix(mid, tip, (t - 0.55) / 0.45);
      const side = j % 2 ? 1 : -1,
        spin = angle + turn * t + side * (0.56 + 0.4 * random() + 0.28 * (1 - t));
      const length = (0.095 + 0.084 * random()) * (0.81 + 0.25 * Math.sin(Math.PI * t));
      leaf(
        p,
        spin,
        length,
        length * (0.21 + 0.09 * random()),
        0.38 + 0.64 * random(),
        fall + 0.76 * random(),
        hue + 0.16 * random(),
      );
    }
    leaf(tip, angle + turn, 0.14, 0.035, 0.52, fall, hue + 0.19);
  }

  const lean = 0.052 + 0.068 * random(),
    twist = (random() - 0.5) * 0.12;
  const spine = (t) => [lean * t * t + 0.016 * Math.sin(5 * t), t, twist * t * t];
  wood([0, 0.12, 0.39, 0.6, 0.77, 0.91].map(spine), [0.05, 0.035, 0.028, 0.021, 0.014, 0.006], 9, true);
  const forks = 6 + Math.floor(2 * random()),
    rotation = tau * random();
  for (let i = 0; i < forks; i++) {
    const t = i / (forks - 1),
      a = rotation + i * 2.4 + 0.38 * (random() - 0.5);
    const base = spine(0.37 + t * 0.43),
      reach = 0.24 + 0.12 * (1 - t) + 0.12 * random();
    const rise = 0.26 - 0.13 * t + 0.13 * random(),
      turn = (random() - 0.5) * 0.88;
    const elbow = extend(base, a, reach * 0.45, rise * 0.7);
    const hand = extend(elbow, a + turn, reach * 0.55, rise * 0.3);
    wood([base, elbow, hand], [0.019 - 0.007 * t, 0.013 - 0.005 * t, 0.004], 6);
    spray(elbow, a - 0.82, reach * 0.62, 0.035 + 0.06 * random(), false);
    spray(mix(elbow, hand, 0.57), a + turn + 0.76, reach * 0.54, 0.045 + 0.05 * random(), false);
    spray(hand, a + turn, 0.11 + 0.08 * random(), 0.02 - 0.055 * random(), true);
  }
  for (let i = 0; i < 4; i++)
    spray(spine(0.85 + i * 0.017), rotation + i * 1.55, 0.16 + 0.085 * random(), 0.055 + 0.07 * random(), false);
  return {
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    blade: new Float32Array(blade),
    tissue: new Float32Array(tissue),
    index: new Uint16Array([...near, ...far]),
    nearCount: near.length,
    farCount: far.length,
  };
}

export function highCanopySites(heightAt, noise, random, half, pathCover, waterLevel) {
  const clusters = new Map(),
    width = 40;
  for (let i = 0; i < 2400; i++) {
    const x = (random() * 2 - 1) * 200,
      z = (random() * 2 - 1) * 200;
    const edge = Math.max(Math.abs(x), Math.abs(z)),
      stand = noise(x * 0.045 + 3, z * 0.045 - 11);
    if (edge < half - 12 || stand < 0.5 || (edge < half && stand < 0.73) || pathCover(x, z) > 0.01) continue;
    const y = heightAt(x, z);
    if (y < waterLevel(x, z) + 0.8 || y > 38 || Math.abs(y - heightAt(x + 2, z + 1)) > 2.6) continue;
    const height = 4.8 + 9.8 * random() + stand * 3.3;
    const ix = Math.floor(x / width),
      iz = Math.floor(z / width),
      variant = ((Math.floor(x * 19 - z * 23) % 3) + 3) % 3,
      key = ix + ',' + iz + ',' + variant;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { variant, x0: ix * width, z0: iz * width, pad: 0, y0: Infinity, y1: -Infinity, sites: [] };
      clusters.set(key, cluster);
    }
    cluster.pad = Math.max(cluster.pad, height * 0.99);
    cluster.y0 = Math.min(cluster.y0, y - 0.55);
    cluster.y1 = Math.max(cluster.y1, y + height * 1.3);
    cluster.sites.push(x, y - 0.55, z, height);
  }
  const instances = [],
    tiles = [];
  for (const { sites, ...bounds } of [...clusters.values()].sort((a, b) => a.variant - b.variant)) {
    tiles.push({ ...bounds, start: instances.length / 4, count: sites.length / 4 });
    instances.push(...sites);
  }
  return { instances: new Float32Array(instances), tiles, width };
}
