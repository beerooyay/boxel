// Four branching leaf clusters of the valley tree and four strap leaves of its understory.
// Each texel carries the leaf's slopes, pigment variation and coverage. The smaller
// mip levels preserve coverage so the same crown holds its silhouette across the lake.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SPRAY_COLUMNS, SPRAY_ROWS, SPRAY_MAX_LEVEL, STRAP_ASPECT } from '../demo/leaf-spray.js';
const TREE_ASPECT = 0.56;

export function makeLeafSprays(random, tile = 256) {
  const width = tile * SPRAY_COLUMNS, height = tile * SPRAY_ROWS, count = width * height;
  const cover = new Float32Array(count), slopeX = new Float32Array(count), slopeY = new Float32Array(count), tone = new Float32Array(count);
  const owner = new Int32Array(count).fill(-1);
  let leafletId = 0;
  const px = 1 / tile;

  for (let row = 0; row < SPRAY_ROWS; row++) for (let col = 0; col < SPRAY_COLUMNS; col++) {
    const aspect = row === 0 ? TREE_ASPECT : STRAP_ASPECT, x0 = col * tile, y0 = row * tile;
    // card space: X across in units of card length (-aspect..aspect), Y along (0 at the root, 1 at the tip)
    const toPixel = (X, Y) => [x0 + (X / aspect * 0.5 + 0.5) * tile - 0.5, y0 + Y * tile - 0.5];
    const leaflets = [];
    const twigs = [];
    if (row === 0) {
      // A card carries a woody spray. Leaves attach individually to secondary
      // twigs, with a shorter, younger flush at the tips and gaps between fans.
      const lean = (random() - 0.5) * 0.28;
      const axis = t => [lean * t * t + 0.018 * Math.sin(t * 5), 0.028 + 0.86 * t];
      function stem(from, to, radius) {
        twigs.push({ from, to, radius });
      }
      function leaf(root, angle, length, side, young) {
        leaflets.push({ x: root[0], y: root[1], dx: Math.sin(angle), dy: Math.cos(angle), length,
          ratio: 0.19 + 0.09 * random(), curl: (random() - 0.5) * 0.31,
          tilt: side * (0.13 + 0.56 * random()), shade: 0.46 + 0.31 * random() + 0.16 * young });
      }
      for (let j = 0; j < 8; j++) stem(axis(j / 8), axis((j + 1) / 8), 0.0068 - 0.00058 * j);
      const fans = 8 + Math.floor(random() * 3);
      for (let j = 0; j < fans; j++) {
        const t = 0.065 + 0.77 * (j + 0.46 * random()) / fans;
        const side = j % 2 ? 1 : -1, base = axis(t);
        const reach = (0.22 + 0.13 * random()) * (0.88 + 0.34 * Math.sin(t * Math.PI * 1.25) - 0.44 * t);
        const angle = side * (0.78 + random() * 0.74 - 0.20 * t);
        const sweep = side * (random() - 0.18) * 0.38;
        const point = u => [base[0] + reach * u * Math.sin(angle + u * sweep),
          base[1] + reach * u * Math.cos(angle + u * sweep)];
        stem(base, point(0.56), 0.0039);
        stem(point(0.56), point(1), 0.0026);
        const count = 4 + Math.floor(random() * 3);
        for (let k = 0; k < count; k++) {
          const u = 0.12 + (k + 0.45 * random()) / count * 0.83;
          const hand = k % 2 ? 1 : -1;
          const length = (0.105 + random() * 0.065) * (1.08 - 0.26 * u);
          leaf(point(u), angle + sweep * u + hand * (0.46 + random() * 0.73), length, hand, u);
        }
        leaf(point(0.94), angle + sweep, 0.09 + 0.04 * random(), side, 1);
      }
      for (let j = 0; j < 4; j++) {
        const hand = j % 2 ? 1 : -1;
        leaf(axis(0.76 + j * 0.07), lean + hand * (0.67 - j * 0.11), 0.117 - j * 0.008, hand, 1);
      }
    } else {
      // a single strap leaf, a little asymmetric, from stalk to point
      const lean = (random() - 0.5) * 0.12;
      leaflets.push({ x: 0, y: 0.02, dx: Math.sin(lean), dy: Math.cos(lean), length: 0.96, ratio: aspect * (0.8 + 0.12 * random()),
        strap: true, curl: (random() - 0.5) * 0.1, tilt: (random() - 0.5) * 0.2, shade: 0.7 + 0.2 * random() });
    }

    for (const { from, to, radius } of twigs) {
      const dx = to[0] - from[0], dy = to[1] - from[1], len2 = dx * dx + dy * dy;
      const pad = radius + px;
      const [x1, y1] = toPixel(Math.min(from[0], to[0])-pad, Math.min(from[1], to[1])-pad);
      const [x2, y2] = toPixel(Math.max(from[0], to[0])+pad, Math.max(from[1], to[1])+pad);
      for (let y = Math.max(y0, Math.floor(y1)); y <= Math.min(y0+tile-1, Math.ceil(y2)); y++)
        for (let x = Math.max(x0, Math.floor(x1)); x <= Math.min(x0+tile-1, Math.ceil(x2)); x++) {
          const rx = ((x + 0.5 - x0) / tile * 2 - 1) * aspect - from[0], ry = (y + 0.5 - y0) / tile - from[1];
          const u = Math.max(0, Math.min(1, (dx * rx + dy * ry) / len2));
          const d = Math.hypot(rx - dx * u, ry - dy * u);
          const alpha = Math.max(0, Math.min(1, 0.5 + (radius - d) / px)), i = y * width + x;
          if (alpha > cover[i]) { cover[i] = alpha; owner[i] = -2; }
        }
    }
    // leaflets in order, the later on top
    for (const leaf of leaflets) {
      const id = leafletId++, l = leaf.length, half = l * leaf.ratio;
      const perpX = leaf.dy, perpY = -leaf.dx;
      const xs = [leaf.x, leaf.x + leaf.dx * l], ys = [leaf.y, leaf.y + leaf.dy * l];
      const [ax, ay] = toPixel(Math.min(...xs) - half - 0.05, Math.min(...ys) - half - 0.05);
      const [bx, by] = toPixel(Math.max(...xs) + half + 0.05, Math.max(...ys) + half + 0.05);
      for (let py = Math.max(y0, Math.floor(ay)); py <= Math.min(y0 + tile - 1, Math.ceil(by)); py++)
        for (let pxl = Math.max(x0, Math.floor(ax)); pxl <= Math.min(x0 + tile - 1, Math.ceil(bx)); pxl++) {
          const X = ((pxl + 0.5 - x0) / tile * 2 - 1) * aspect, Y = (py + 0.5 - y0) / tile;
          const rx = X - leaf.x, ry = Y - leaf.y, s = (rx * leaf.dx + ry * leaf.dy) / l;
          if (s < 0 || s > 1) continue;
          const t = (rx * perpX + ry * perpY) / l - leaf.curl * s * s;
          const w = leaf.strap ? leaf.ratio * Math.pow(Math.sin(Math.PI * Math.min(1, s * 0.62 + 0.38 * s * s)), 0.35) * (1 - 0.15 * s)
            : leaf.ratio * Math.sin(Math.PI * Math.pow(s, 0.81)) ** 0.79
                * (1 + 0.05 * Math.sin(s * 97 + 2 * Math.sign(t))) * (1 + 0.1 * Math.sign(t) * (0.42 - s));
          if (w <= 1e-4) continue;
          const d = (Math.abs(t) - w) * l, a = Math.min(1, Math.max(0, 0.5 - d / px));
          if (a <= 0) continue;
          const p = py * width + pxl;
          if (a < 0.5 && cover[p] >= 0.5) continue;
          // the surface: cupped across, creased along the midrib, the lateral veins pressed in
          const q = t / w, across = -1.1 * q + 0.9 * Math.sign(q) * Math.exp(-(q * q) / 0.012) + leaf.tilt;
          const veinPhase = s * (leaf.strap ? 11 : 6.5) - Math.abs(q) * 1.1;
          const veins = Math.sin(2 * Math.PI * (veinPhase + (leaf.strap ? 0 : 0.18*q*q + 0.14*q)));
          const along = 0.25 * (0.5 - s) + 0.08 * veins + (leaf.strap ? 0 : 0.55 * leaf.curl * s);
          slopeX[p] = across * perpX + along * leaf.dx;
          slopeY[p] = across * perpY + along * leaf.dy;
          const midrib = Math.exp(-(q * q) / 0.004), lateral = Math.max(0, veins) ** 6 * (1 - Math.abs(q));
          tone[p] = Math.min(1, Math.max(0.08, leaf.shade * (0.86 + 0.14 * s) + 0.12 * midrib + 0.06 * lateral + 0.07 * Math.max(0, Math.abs(q) - 0.8) / 0.2));
          if (!leaf.strap) {
            const margin = Math.min(1, Math.abs(q));
            tone[p] *= 0.94 + 0.08 * Math.sin(veinPhase * 3.7 + leaf.tilt * 17)
              + 0.07 * margin + 0.06 * q;
          }
          cover[p] = Math.max(a, cover[p]);
          owner[p] = id;
        }
    }
    // Bake short-range occlusion into the lower leaf where another leaf
    // overlaps it. An isolated blade stays luminous all the way to its edge.
    const offsets = [[0.014,0.010],[-0.012,0.008],[0.006,0.022],[-0.004,-0.011]]
      .map(([dx,dy]) => [Math.round(dx*tile),Math.round(dy*tile)]);
    for (let py = y0; py < y0 + tile; py++) for (let x = x0; x < x0 + tile; x++) {
      const p = py*width+x, me = owner[p];
      if (me < 0) continue;
      for (const [dx,dy] of offsets) {
        const yy = Math.min(y0+tile-1,Math.max(y0,py+dy));
        const xx = Math.min(x0+tile-1,Math.max(x0,x+dx));
        if (owner[yy*width+xx] > me) tone[p] *= 0.92;
      }
    }
  }

  // Coverage-preserving mips: average the surface by coverage, and scale each level's coverage so the share of texels
  // past one half stays what it was at full size.
  const levels = [];
  const pack = (w, h, c, sx, sy, tn) => {
    const bytes = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      bytes[4 * i] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, sx[i] * 0.5)));
      bytes[4 * i + 1] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, sy[i] * 0.5)));
      bytes[4 * i + 2] = Math.round(255 * Math.max(0, Math.min(1, tn[i])));
      bytes[4 * i + 3] = Math.round(255 * Math.max(0, Math.min(1, c[i])));
    }
    return bytes;
  };
  const coverageTarget = new Float32Array(SPRAY_ROWS * SPRAY_COLUMNS);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (cover[y*width+x] >= 0.5) coverageTarget[Math.floor(y/tile)*SPRAY_COLUMNS + Math.floor(x/tile)]++;
  }
  levels.push({ width, height, bytes: pack(width, height, cover, slopeX, slopeY, tone) });
  let w = width, h = height, c = cover, sx = slopeX, sy = slopeY, tn = tone;
  for (let level = 1; level <= SPRAY_MAX_LEVEL; level++) {
    const nw = w >> 1, nh = h >> 1, nc = new Float32Array(nw * nh), nx = new Float32Array(nw * nh), ny = new Float32Array(nw * nh), nt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let a = 0, ax = 0, ay = 0, at = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const k = (2 * y + dy) * w + 2 * x + dx, wt = c[k] + 1e-4;
        a += c[k]; ax += sx[k] * wt; ay += sy[k] * wt; at += tn[k] * wt;
      }
      const k = y * nw + x, norm = a + 4e-4;
      nc[k] = a / 4; nx[k] = ax / norm; ny[k] = ay / norm; nt[k] = at / norm;
    }
    // Match each cutout to its own original coverage. A wide ground leaf must
    // never consume the last visible texel of a distant tree shoot.
    const span = nw / SPRAY_COLUMNS, ranked = new Float32Array(span*span);
    for (let row = 0; row < SPRAY_ROWS; row++) for (let col = 0; col < SPRAY_COLUMNS; col++) {
      const x0 = col*span, y0 = row*span;
      for (let y = 0; y < span; y++) {
        const start = (y0+y)*nw+x0;
        ranked.set(nc.subarray(start, start+span), y*span);
      }
      ranked.sort();
      const wanted = Math.round(coverageTarget[row*SPRAY_COLUMNS+col] * ranked.length/(tile*tile));
      const cut = ranked.length - wanted;
      const lower = cut > 0 ? ranked[cut-1] : 0;
      const upper = cut < ranked.length ? ranked[cut] : 1;
      const scale = Math.min(4, 1/Math.max(lower+upper, 0.001));
      for (let y = 0; y < span; y++) for (let x = 0; x < span; x++) {
        const k = (y0+y)*nw+x0+x;
        nc[k] = Math.min(1, nc[k]*scale);
      }
    }
    levels.push({ width: nw, height: nh, bytes: pack(nw, nh, nc, nx, ny, nt) });
    w = nw; h = nh; c = nc; sx = nx; sy = ny; tn = nt;
  }
  return { width, height, tile, levels };
}


// Usage: node tools/bake-leaf-sprays.mjs (Khronos KTX-Software 4.4+ on PATH).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let state = 2024;
  const atlas = makeLeafSprays(() => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const dir = mkdtempSync(join(tmpdir(), 'tarn-leaves-'));
  try {
    const files = atlas.levels.map(({ bytes }, mip) => {
      const name = join(dir, mip + '.rgba');
      writeFileSync(name, bytes);
      return name;
    });
    for (const [first, name, compression] of [
      [0, 'leaf-sprays', ['--zlib', '9']],
      [1, 'leaf-sprays-small', ['--zlib', '9']],
      [1, 'leaf-sprays-raw', []],
    ]) {
      const { width, height } = atlas.levels[first];
      const target = fileURLToPath(new URL('../demo/' + name + '.ktx2', import.meta.url));
      const mips = files.slice(first);
      execFileSync('ktx', ['create', '--raw', '--format', 'R8G8B8A8_UNORM', '--width', String(width),
        '--height', String(height), '--levels', String(mips.length), ...compression, ...mips, target],
        { stdio: 'inherit' });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
