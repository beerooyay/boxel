// One tileable rock surface for every stone in the valley, after the photogrammetry practice of capturing one good
// tileable rock and laying it over many simple forms rather than giving each rock its own texture. Here the "scan" is
// grown: broken facets meeting at cracks, smaller chips across them, pits, and grain. Each stone samples it in its own
// object space from three sides, and the same height pushes the stone's vertices out, so the silhouette and the
// shading agree.
//
// The texture holds the height's slopes (red, green), cavity (blue: cracks and pits, where light and rain reach least)
// and tone (alpha).

export const ROCK_SURFACE_SCALE = 0.9; // repeats per unit of a stone's own (unscaled) mesh

export function makeRockSurface(random, size = 256) {
  const count = size * size, half = size / 2;
  const wrap = (d) => d - size * Math.round(d / size);
  // value noise for grain and warping, tileable
  const noise = new Float32Array(count);
  for (let i = 0; i < count; i++) noise[i] = random();
  const at = (x, y) => noise[((y & (size - 1)) * size) + (x & (size - 1))];
  const grain = (x, y, step) => {
    const ix = Math.floor(x / step) * step, iy = Math.floor(y / step) * step, fx = (x - ix) / step, fy = (y - iy) / step;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return (1 - v) * ((1 - u) * at(ix, iy) + u * at(ix + step, iy)) + v * ((1 - u) * at(ix, iy + step) + u * at(ix + step, iy + step));
  };
  // Voronoi with a flat facet in every cell, its borders warped so no break runs straight; the gap between nearest
  // and second nearest marks the border
  function facets(n, tilt, crackWidth, warp) {
    const seeds = Array.from({ length: n }, () => ({
      x: random() * size, y: random() * size, gx: (random() - 0.5) * tilt, gy: (random() - 0.5) * tilt, h: random(), tone: random(),
    }));
    const height = new Float32Array(count), crack = new Float32Array(count), tone = new Float32Array(count);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let d1 = Infinity, d2 = Infinity, best = null;
      const wx = x + warp * (grain(x + 31, y, 32) - 0.5), wy = y + warp * (grain(x, y + 57, 32) - 0.5);
      for (const s of seeds) {
        const dx = wrap(wx - s.x), dy = wrap(wy - s.y), d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; best = s; } else if (d < d2) d2 = d;
      }
      const i = y * size + x, dx = wrap(wx - best.x), dy = wrap(wy - best.y);
      height[i] = best.h + best.gx * dx + best.gy * dy;
      const gap = Math.sqrt(d2) - Math.sqrt(d1);
      crack[i] = Math.max(0, 1 - gap / crackWidth);
      tone[i] = best.tone;
    }
    return { height, crack, tone };
  }
  const big = facets(26, 0.026, 2.2, 22), small = facets(150, 0.04, 1.1, 9);
  const pit = new Float32Array(count);
  for (let k = 0; k < 150; k++) {
    const cx = random() * size, cy = random() * size, r = 0.8 + 2.6 * random() ** 3, reach = Math.ceil(r + 1);
    for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) {
      const d = Math.hypot(Math.floor(cx) + i - cx, Math.floor(cy) + j - cy) / r;
      if (d >= 1) continue;
      const p = ((Math.floor(cy) + j) & (size - 1)) * size + ((Math.floor(cx) + i) & (size - 1));
      pit[p] = Math.max(pit[p], 1 - d * d);
    }
  }
  const height = new Float32Array(count), cavity = new Float32Array(count), tone = new Float32Array(count);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    const g = 0.3 * grain(x, y, 64) + 0.3 * grain(x, y, 16) + 0.22 * grain(x, y, 8) + 0.18 * grain(x, y, 4);
    // Only some borders opened into cracks; the rest are the steps between chips and facets.
    const open = Math.max(0, Math.min(1, (grain(x + 101, y + 13, 32) - 0.48) * 4.5));
    height[i] = 0.5 * big.height[i] + 0.2 * small.height[i] + 0.3 * g + 0.03 * noise[i]
      - 0.3 * big.crack[i] * open - 0.05 * small.crack[i] - 0.08 * pit[i];
    cavity[i] = Math.min(1, Math.max(big.crack[i] * open, 0.2 * small.crack[i], 0.5 * pit[i], 0.6 * Math.max(0, 0.45 - g)));
    tone[i] = 0.5 + 0.22 * (big.tone[i] - 0.5) + 0.12 * (small.tone[i] - 0.5) + 0.25 * (g - 0.5) + 0.08 * (noise[i] - 0.5);
  }
  // normalise the height to [0, 1]
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < count; i++) { lo = Math.min(lo, height[i]); hi = Math.max(hi, height[i]); }
  for (let i = 0; i < count; i++) height[i] = (height[i] - lo) / (hi - lo);
  const index = (x, y) => (y & (size - 1)) * size + (x & (size - 1));
  const pixels = new Uint8Array(count * 4);
  const slope = (n) => Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, n)));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = index(x, y), k = i * 4;
    pixels[k] = slope((height[index(x - 1, y)] - height[index(x + 1, y)]) * 9);
    pixels[k + 1] = slope((height[index(x, y - 1)] - height[index(x, y + 1)]) * 9);
    pixels[k + 2] = Math.round(255 * cavity[i]);
    pixels[k + 3] = Math.round(255 * Math.max(0, Math.min(1, tone[i])));
  }
  /** Bilinear height at texture coordinates (u, v), repeating. */
  function sample(u, v) {
    const x = u * size - 0.5, y = v * size - 0.5, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    return (1 - fy) * ((1 - fx) * height[index(ix, iy)] + fx * height[index(ix + 1, iy)])
      + fy * ((1 - fx) * height[index(ix, iy + 1)] + fx * height[index(ix + 1, iy + 1)]);
  }
  /** Height seen from three sides at a point of a stone's mesh with normal n, as the shader blends it. */
  function triplanar(p, n) {
    let wx = n[0] ** 4, wy = n[1] ** 4, wz = n[2] ** 4;
    const total = wx + wy + wz; wx /= total; wy /= total; wz /= total;
    const s = ROCK_SURFACE_SCALE;
    return wx * sample(p[2] * s, p[1] * s) + wy * sample(p[0] * s, p[2] * s) + wz * sample(p[0] * s, p[1] * s);
  }
  return { size, pixels, sample, triplanar, half };
}

export function uploadRockSurface(gl, surface, unit) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, surface.size, surface.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, surface.pixels);
  gl.generateMipmap(gl.TEXTURE_2D);
  const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
  if (anisotropy) gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
    Math.min(4, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
}
