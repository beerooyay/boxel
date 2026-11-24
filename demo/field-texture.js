// The engine owns the floats. This cache owns the R8 bytes the renderer actually sees.
export class FieldTexture {
  constructor(size) {
    this.size = size;
    this.bytes = new Uint8Array(size * size);
    // One upload can join nearby changes, but never span a whole lake for two distant splashes.
    this.strips = Math.ceil(size / 128);
    const regions = this.strips * (size / 16);
    this.left = new Uint16Array(regions);
    this.right = new Uint16Array(regions);
    this.top = new Uint16Array(regions);
    this.bottom = new Uint16Array(regions);
  }

  uploadSparse(gl, field) {
    const { size, strips, left, right, top, bottom, bytes } = this;
    left.fill(size); right.fill(0); top.fill(size); bottom.fill(0);
    const visit = (bx, by, values) => {
      const x = bx * 16 + size / 2, y = by * 16 + size / 2;
      if (x < 0 || x >= size || y < 0 || y >= size) return;
      const region = (y / 16) * strips + Math.floor(x / 128);
      let x0 = 16, x1 = 0, y0 = 16, y1 = 0;
      for (let row = 0; row < 16; row++) {
        const dest = (y + row) * size + x;
        let changed = false;
        for (let col = 0; col < 16; col++) {
          const value = values ? (Math.min(255, values[row * 16 + col] * 255 + 0.5) | 0) : 0;
          if (bytes[dest + col] === value) continue;
          bytes[dest + col] = value;
          x0 = Math.min(x0, col); x1 = Math.max(x1, col + 1);
          changed = true;
        }
        if (changed) { y0 = Math.min(y0, row); y1 = row + 1; }
      }
      if (x1 === 0) return;
      left[region] = Math.min(left[region], x + x0); right[region] = Math.max(right[region], x + x1);
      top[region] = Math.min(top[region], y + y0); bottom[region] = Math.max(bottom[region], y + y1);
    };
    // A retired block may already have been reused since the last render.
    field.freed((bx, by) => visit(bx, by, null));
    field.forgetFreed();
    field.blocks(visit);
    let sent = 0;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, size);
    for (let i = 0; i < left.length; i++) {
      if (!right[i]) continue;
      const width = right[i] - left[i], height = bottom[i] - top[i];
      gl.texSubImage2D(gl.TEXTURE_2D, 0, left[i], top[i], width, height, gl.RED, gl.UNSIGNED_BYTE, bytes, top[i] * size + left[i]);
      sent += width * height;
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    return sent;
  }

  uploadDense(gl, grid) {
    const { size, bytes } = this;
    for (let y = 0; y < size; y++) {
      const row = grid.row(y - size / 2);
      for (let x = 0; x < size; x++) bytes[y * size + x] = Math.min(255, row[x] * 255 + 0.5);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED, gl.UNSIGNED_BYTE, bytes);
    return bytes.length;
  }
}
