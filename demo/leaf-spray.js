// Four individual shoots of the valley tree and four strap leaves of its understory.
// Each texel carries the leaf's slopes, pigment variation and coverage. The smaller
// mip levels preserve coverage so the same crown holds its silhouette across the lake.
export const SPRAY_COLUMNS = 4, SPRAY_ROWS = 2, SPRAY_MAX_LEVEL = 6;
export const STRAP_ASPECT = 0.20;
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
    let stem = null;
    if (row === 0) {
      const lean = (random() - 0.5) * 0.18, n = 5 + Math.floor(random() * 3);
      const stemAt = y => [lean * y * y, y];
      stem = { at: stemAt, end: 0.8, thick: 0.016 };
      for (let i = 0; i < n; i++) {
        const y = 0.1 + (stem.end - 0.14) * (i + 0.35 * random()) / n, side = i % 2 ? 1 : -1;
        const [sx, sy] = stemAt(y);
        const angle = side * (0.9 - 0.42 * y + 0.18 * (random() - 0.5));
        const length = 0.29 * (1.05 - 0.45 * y) * (0.85 + 0.3 * random());
        leaflets.push({ x: sx, y: sy, dx: Math.sin(angle), dy: Math.cos(angle), length, ratio: 0.42 + 0.1 * random(),
          ovate: true, curl: (random() - 0.5) * 0.25, tilt: side * (0.25 + 0.25 * random()), shade: 0.55 + 0.35 * random() - 0.12 * (1-y) });
      }
      const [tx, ty] = stemAt(stem.end);
      leaflets.push({ x: tx, y: ty - 0.02, dx: Math.sin(lean * 2), dy: Math.cos(lean * 2), length: 1-ty, ratio: 0.38,
        ovate: true, curl: (random() - 0.5) * 0.15, tilt: (random() - 0.5) * 0.3, shade: 0.72 + 0.2 * random() });
    } else {
      // a single strap leaf, a little asymmetric, from stalk to point
      const lean = (random() - 0.5) * 0.12;
      leaflets.push({ x: 0, y: 0.02, dx: Math.sin(lean), dy: Math.cos(lean), length: 0.96, ratio: aspect * (0.8 + 0.12 * random()),
        ovate: false, strap: true, curl: (random() - 0.5) * 0.1, tilt: (random() - 0.5) * 0.2, shade: 0.7 + 0.2 * random() });
    }

    // the stem under everything
    if (stem) {
      for (let k = 0; k <= 200; k++) {
        const y = stem.end * k / 200, [x] = stem.at(y), thick = stem.thick * (1 - 0.55 * y);
        const [cx, cy] = toPixel(x, y), reach = Math.ceil(thick / aspect * 0.5 * tile + 1.5);
        for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) {
          const X = ((Math.round(cx) + i + 0.5 - x0) / tile * 2 - 1) * aspect, d = Math.abs(X - x) - thick * 0.5;
          const a = Math.min(1, Math.max(0, 0.5 - d / px));
          const p = (Math.round(cy) + j) * width + Math.round(cx) + i;
          if (Math.round(cy) + j < y0 || Math.round(cy) + j >= y0 + tile || a <= cover[p]) continue;
          cover[p] = a; tone[p] = 0; slopeX[p] = (X - x) / (thick * 0.5) * 0.6; slopeY[p] = 0; owner[p] = -2;
        }
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
            : leaf.ratio * Math.pow(Math.sin(Math.PI * Math.pow(s, leaf.ovate ? 0.72 : 0.9)), leaf.ovate ? 0.8 : 0.7);
          if (w <= 1e-4) continue;
          const d = (Math.abs(t) - w) * l, a = Math.min(1, Math.max(0, 0.5 - d / px));
          if (a <= 0) continue;
          const p = py * width + pxl;
          if (a < 0.5 && cover[p] >= 0.5) continue;
          // the surface: cupped across, creased along the midrib, the lateral veins pressed in
          const q = t / w, across = -1.1 * q + 0.9 * Math.sign(q) * Math.exp(-(q * q) / 0.012) + leaf.tilt;
          const veins = Math.sin(2 * Math.PI * (s * (leaf.strap ? 11 : 6.5) - Math.abs(q) * 1.1));
          const along = 0.25 * (0.5 - s) + 0.08 * veins;
          slopeX[p] = across * perpX + along * leaf.dx;
          slopeY[p] = across * perpY + along * leaf.dy;
          const midrib = Math.exp(-(q * q) / 0.004), lateral = Math.max(0, veins) ** 6 * (1 - Math.abs(q));
          tone[p] = Math.min(1, Math.max(0.08, leaf.shade * (0.86 + 0.14 * s) + 0.12 * midrib + 0.06 * lateral + 0.07 * Math.max(0, Math.abs(q) - 0.8) / 0.2));
          cover[p] = Math.max(a, cover[p]);
          owner[p] = id;
        }
    }
    // a leaflet lying under another is shaded by it: look a little toward the light, which falls from above the card
    for (let py = y0; py < y0 + tile; py++) for (let pxl = x0; pxl < x0 + tile; pxl++) {
      const p = py * width + pxl, me = owner[p];
      if (me < 0) continue;
      const qy = Math.min(y0 + tile - 1, py + Math.round(tile * 0.02)), qx = Math.min(x0 + tile - 1, pxl + Math.round(tile * 0.012));
      const over = owner[qy * width + qx];
      if (over > me) tone[p] *= 0.68;
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

export function uploadLeafSprays(gl, sprays, unit) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, sprays.levels.length, gl.RGBA8, sprays.width, sprays.height);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  sprays.levels.forEach((l, i) => gl.texSubImage2D(gl.TEXTURE_2D, i, 0, 0, l.width, l.height, gl.RGBA, gl.UNSIGNED_BYTE, l.bytes));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, sprays.levels.length - 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

// Where a card's texel lies in the atlas: the family by kind, the variant by seed, inset so mips do not bleed.
export const sprayGLSL = `
uniform sampler2D uLeafSprays;
vec2 sprayUV(float u, float side, float row, float seed){
  float col = floor(fract(seed * 7.131) * ${SPRAY_COLUMNS}.);
  vec2 t = vec2(side * 0.5 + 0.5, u) * 0.96 + 0.02;
  return (vec2(col, row) + t) / vec2(${SPRAY_COLUMNS}., ${SPRAY_ROWS}.);
}`;

/** Bake off the main thread where a module worker is available; the valley keeps building meanwhile. */
export function bakeLeafSpraysAsync(seed, tile) {
  return new Promise((resolve) => {
    const fallback = () => { let s = seed >>> 0; resolve(makeLeafSprays(() => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296, tile)); };
    try {
      const worker = new Worker(new URL('./leaf-spray-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => { worker.terminate(); resolve(event.data); };
      worker.onerror = () => { worker.terminate(); fallback(); };
      worker.postMessage({ seed, tile });
    } catch { fallback(); }
  });
}
