// Both levels of detail share the same arch, leaflet tips and gaps to preserve the skyline.
export function highCanopyMesh(random) {
  const position = [], normal = [], tissue = [], near = [], far = [];
  const bend = t => 0.13 * t * t - 0.036 * Math.sin(t * Math.PI);
  function vertex(x, y, z, nx, ny, nz, pigment) {
    position.push(x, y, z);
    normal.push(nx, ny, nz);
    tissue.push(pigment);
    return tissue.length - 1;
  }
  function quad(indices, a, b, c, d) { indices.push(a, b, c, b, d, c); }

  // The dark trunk flares at its foot and narrows into a smooth green crownshaft.
  const sides = 8;
  for (let row = 0; row <= 8; row++) {
    const t = row / 8, radius = 0.025 * (1 - 0.57 * t) + 0.025 * Math.exp(-16 * t);
    const start = tissue.length;
    for (let j = 0; j < sides; j++) {
      const angle = j / sides * 2 * Math.PI, x = Math.cos(angle), z = Math.sin(angle);
      vertex(bend(t) + radius * x, t, radius * z, x, 0.065, z, -1 - t);
    }
    for (let j = 0; j < sides && row; j++) {
      const a = start + j, b = start + (j + 1) % sides;
      quad(near, a - sides, b - sides, a, b);
      if (row % 2 === 0) quad(far, a - 2 * sides, b - 2 * sides, a, b);
    }
  }

  // Older outer fronds bend below the crown. Three tightly folded shoots rise above them.
  for (let frond = 0; frond < 19; frond++) {
    const spear = frond >= 16, tier = (frond % 4) / 3;
    const a = frond * 2.39996 + 0.33 * random(), dx = Math.cos(a), dz = Math.sin(a);
    const height = spear ? 0.986 : 0.91 + 0.074 * tier;
    const reach = spear ? 0.05 + 0.08 * random() : (0.38 + 0.073 * random()) * (1 - 0.20 * tier);
    const lift = spear ? 0.24 + 0.05 * random() : 0.38 + 0.16 * tier;
    const fall = spear ? 0.08 : 0.60 - 0.22 * tier + 0.09 * random();
    const curl = (random() - 0.5) * 0.090, roll = (random() - 0.5) * 0.7;
    const base = bend(height), shade = 0.30 + 0.26 * tier + 0.15 * random();

    // Coordinates follow the curved midrib. Across and relief are in tree-height units.
    function blade(t, across, relief, facet, pigment) {
      const sweep = curl * t * t + across;
      const slope = (2 * fall * t - lift) / reach;
      return vertex(base + dx * reach * t - dz * sweep, height + lift * t - fall * t * t + roll * across + relief,
        dz * reach * t + dx * sweep, dx * slope - dz * facet, 1, dz * slope + dx * facet, pigment);
    }

    const rows = 8, rib = tissue.length;
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const width = spear ? 0.0013 + 0.014 * Math.sin(Math.PI * t) : 0.0015 + 0.005 * (1 - t);
      blade(t, -width, 0, -0.5 - roll, shade + 0.06);
      blade(t, width, 0, 0.5 - roll, shade + 0.33);
      const k = rib + 2 * j;
      if (j) quad(near, k - 2, k - 1, k, k + 1);
      if (j && j % 2 === 0) quad(far, k - 4, k - 3, k, k + 1);
    }
    if (spear) continue;

    const pairs = 8 + Math.floor(3 * random()), breadth = 0.10 + 0.02 * random();
    for (let i = 0; i < pairs; i++) {
      for (const side of [-1, 1]) {
        const t = 0.075 + 0.84 * (i + 0.44 + side * 0.12 + 0.16 * random()) / pairs;
        const envelope = Math.sin(Math.PI * t) ** 0.72;
        const span = side * breadth * envelope * (0.84 + 0.22 * random());
        const forward = (0.080 + 0.087 * t + 0.028 * random()) * envelope;
        const drop = Math.abs(span) * (0.38 + 0.55 * t + 0.27 * random());
        const shoulder = t + forward * 0.40, halfWidth = (0.029 + 0.013 * envelope) * (0.88 + 0.19 * random());
        const color = shade + 0.09 * random(), cant = side * 0.4 - roll;
        const root = blade(t, 0, -0.0003, cant, color - 0.10);
        const trailing = blade(shoulder - halfWidth, span * 0.48, -drop * 0.20, cant - 0.43, color);
        const keel = blade(shoulder, span * 0.52, -drop * 0.12 + 0.003, cant, color + 0.32);
        const leading = blade(shoulder + halfWidth, span * 0.47, -drop * 0.17, cant + 0.43, color + 0.11);
        const taper = t + forward * 0.72;
        const outerTrail = blade(taper - 0.52 * halfWidth, span * 0.77, -drop * 0.50, cant - 0.24, color + 0.06);
        const outerLead = blade(taper + 0.46 * halfWidth, span * 0.76, -drop * 0.46, cant + 0.34, color + 0.17);
        const tip = blade(t + forward, span, -drop, cant + side * 0.35, color + 0.21);
        near.push(root, trailing, keel, root, keel, leading, trailing, outerTrail, keel,
          keel, outerTrail, outerLead, keel, outerLead, leading, outerTrail, tip, outerLead);
        far.push(root, trailing, leading, trailing, tip, leading);
      }
    }
    // A narrow terminal leaflet closes the rachis beyond the last pair.
    const baseTip = blade(0.85, 0, 0, -roll, shade + 0.13);
    const l = blade(0.94, -0.009, -0.002, -0.35 - roll, shade + 0.26);
    const r = blade(0.94, 0.009, -0.002, 0.35 - roll, shade + 0.13);
    const end = blade(1.045, curl * 0.10, -0.008, -roll, shade + 0.34);
    quad(near, baseTip, l, r, end);
    quad(far, baseTip, l, r, end);
  }
  return { position: new Float32Array(position), normal: new Float32Array(normal), tissue: new Float32Array(tissue),
    index: new Uint16Array([...near, ...far]), nearCount: near.length, farCount: far.length };
}

export function highCanopySites(heightAt, noise, random, half, pathCover, waterLevel) {
  const clusters = new Map(), width = 40;
  for (let i = 0; i < 2400; i++) {
    const x = (random() * 2 - 1) * 200, z = (random() * 2 - 1) * 200;
    const edge = Math.max(Math.abs(x), Math.abs(z)), stand = noise(x * 0.045 + 3, z * 0.045 - 11);
    if (edge < half - 12 || stand < 0.50 || edge < half && (stand < 0.73 || pathCover(x, z) > 0.01)) continue;
    const y = heightAt(x, z);
    if (y < waterLevel(x, z) + 0.8 || y > 38 || Math.abs(y - heightAt(x + 2, z + 1)) > 2.6) continue;
    const height = 4.8 + 9.8 * random() + stand * 3.3;
    const ix = Math.floor(x / width), iz = Math.floor(z / width), key = ix + ',' + iz;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { x0: ix * width, z0: iz * width, pad: 11, y0: Infinity, y1: -Infinity, sites: [] };
      clusters.set(key, cluster);
    }
    cluster.y0 = Math.min(cluster.y0, y - 0.55);
    cluster.y1 = Math.max(cluster.y1, y + height * 1.2);
    cluster.sites.push(x, y - 0.55, z, height);
  }
  const instances = [], tiles = [];
  for (const { sites, ...bounds } of clusters.values()) {
    tiles.push({ ...bounds, start: instances.length / 4, count: sites.length / 4 });
    instances.push(...sites);
  }
  return { instances: new Float32Array(instances), tiles, width };
}
