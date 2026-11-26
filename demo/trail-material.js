// A repeatable patch of packed earth. Embedded stones raise the same height
// surface that supplies the lighting normal, with a contact rim in the colour.
export function bakeTrailMaterial(gl, random) {
  const size = 256,
    mask = size - 1,
    count = size * size;
  const height = new Float32Array(count),
    stone = new Float32Array(count),
    tone = new Float32Array(count);
  const noise = new Float32Array(count);
  for (let i = 0; i < count; i++) noise[i] = random();
  const index = (x, y) => (y & mask) * size + (x & mask);
  function grain(x, y, step) {
    const ix = Math.floor(x / step) * step,
      iy = Math.floor(y / step) * step;
    const fx = (x - ix) / step,
      fy = (y - iy) / step,
      u = fx * fx * (3 - 2 * fx),
      v = fy * fy * (3 - 2 * fy);
    return (
      (1 - v) * ((1 - u) * noise[index(ix, iy)] + u * noise[index(ix + step, iy)]) +
      v * ((1 - u) * noise[index(ix, iy + step)] + u * noise[index(ix + step, iy + step)])
    );
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = index(x, y);
      const grit = 0.33 * grain(x, y, 16) + 0.29 * grain(x, y, 8) + 0.23 * grain(x, y, 4) + 0.15 * noise[i];
      const compressed = grain(x + Math.floor(grain(x,y,64)*9), y, 32);
      height[i] = 2.45 * grit + 0.9 * compressed;
      tone[i] = 0.06 + 0.61 * grit + 0.23 * compressed + 0.12 * noise[i];
    }
  for (let k = 0; k < 1650; k++) {
    const x = random() * size,
      y = random() * size,
      radius = 0.65 + 3.35 * random() ** 4;
    const aspect = 0.45 + 0.48 * random(),
      a = random() * Math.PI,
      c = Math.cos(a),
      s = Math.sin(a);
    const chip = 0.4 + 0.55 * random(),
      tilt = 0.33 * (random() - 0.5),
      reach = Math.ceil(radius * 1.45);
    for (let j = -reach; j <= reach; j++)
      for (let i = -reach; i <= reach; i++) {
        const dx = Math.floor(x) + i - x,
          dy = Math.floor(y) + j - y;
        const u = (dx * c + dy * s) / radius,
          v = (dy * c - dx * s) / (radius * aspect);
        const d = Math.max(Math.abs(u * 0.93 + v * 0.16), Math.abs(v - u * 0.24), 0.70*Math.abs(u+v), 0.63*Math.abs(u-v));
        if (d >= 1.3) continue;
        const at = index(Math.floor(x) + i, Math.floor(y) + j);
        const dome = Math.max(0, 1 - d * d),
          coverage = Math.min(1, dome * 5);
        height[at] += radius * 0.4 * dome * (1 + tilt * u);
        tone[at] *= 1 - 0.3 * Math.max(0, 1 - Math.abs(d - 0.99) * 3.3);
        stone[at] = Math.max(stone[at], coverage * chip);
      }
  }
  const pixels = new Uint8Array(count * 4);
  const slope = (n) => Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, n)));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = index(x, y),
        k = i * 4;
      pixels[k] = slope((height[index(x - 1, y)] - height[index(x + 1, y)]) * 0.55);
      pixels[k + 1] = slope((height[index(x, y - 1)] - height[index(x, y + 1)]) * 0.55);
      pixels[k + 2] = Math.round(255 * stone[i]);
      pixels[k + 3] = Math.round(255 * tone[i]);
    }
  gl.activeTexture(gl.TEXTURE0 + 17);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.generateMipmap(gl.TEXTURE_2D);
  const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
  if (anisotropy) gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
    Math.min(4, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
}
