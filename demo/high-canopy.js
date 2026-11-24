// The taller canopy continues past the playable meadow and breaks up the lower ridgelines.
// One instanced mesh carries the curved trunk, the crown and its divided fronds.
export function highCanopyMesh(random) {
  const position = [], normal = [], tissue = [], index = [];
  function vertex(x, y, z, nx, ny, nz, leaf) {
    position.push(x, y, z); normal.push(nx, ny, nz); tissue.push(leaf);
    return tissue.length - 1;
  }
  function quad(a, b, c, d) { index.push(a, b, c, b, d, c); }
  const bend = t => 0.13 * t * t - 0.036 * Math.sin(t * Math.PI);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, radius = 0.025 * (1 - 0.62 * t) + 0.024 * Math.exp(-16 * t);
    for (let j = 0; j <= 7; j++) {
      const a = j / 7 * 2 * Math.PI, x = Math.cos(a), z = Math.sin(a);
      const v = vertex(bend(t) + radius * x, t, radius * z, x, 0.08, z, 0);
      if (i && j) quad(v - 9, v - 8, v - 1, v);
    }
  }
  for (let frond = 0; frond < 22; frond++) {
    const a = frond * 2.39996 + random() * 0.24, dx = Math.cos(a), dz = Math.sin(a);
    const upper = (frond % 3) / 2, reach = (0.30 + 0.16 * random()) * (1 - 0.22 * upper);
    const lift = 0.32 + 0.17 * upper, fall = 0.57 - 0.16 * upper + 0.12 * random();
    const height = 0.91 + 0.085 * upper;
    for (let row = 0; row <= 12; row++) {
      const t = row / 12, envelope = Math.sin(Math.PI * t) ** 0.70;
      const width = (row % 2 ? 0.083 : 0.039) * envelope;
      const x = bend(height) + reach * t * dx, z = reach * t * dz;
      const y = height + lift * t - fall * t * t;
      const swept = width * 0.62;
      const tilt = (2 * fall * t - lift) / reach;
      const v = vertex(x - dz * width + swept * dx, y - width * 0.34, z + dx * width + swept * dz, dx * tilt - dz * 0.28, 1, dz * tilt + dx * 0.28, 0.35 + 0.48 * t);
      vertex(x, y, z, dx * tilt, 1, dz * tilt, 0.61 + 0.36 * t);
      vertex(x + dz * width + swept * dx, y - width * 0.34, z - dx * width + swept * dz, dx * tilt + dz * 0.28, 1, dz * tilt - dx * 0.28, 0.33 + 0.51 * t);
      if (row) { quad(v - 3, v - 2, v, v + 1); quad(v - 2, v - 1, v + 1, v + 2); }
    }
  }
  return { position: new Float32Array(position), normal: new Float32Array(normal), tissue: new Float32Array(tissue), index: new Uint16Array(index) };
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
