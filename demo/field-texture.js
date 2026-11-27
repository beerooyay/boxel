// R8 texels only need a CPU mirror where a field has visible activity. One
// short row of blocks can share an upload without spanning distant splashes.
const BLOCK = 16, STRIP = 8 * BLOCK;
export class FieldTexture {
  constructor(size, tileCells = 4*BLOCK) {
    this.size = size;
    this.strips = Math.ceil(size / STRIP);
    this.pages = new Map();
    this.tileCells = tileCells;
    this.tilesAcross = Math.ceil(size/tileCells);
    this.tileBlocks = new Uint16Array(this.tilesAcross*this.tilesAcross);
  }

  reset() {
    this.pages.clear();
    this.tileBlocks.fill(0);
  }

  uploadSparse(gl, field) {
    const { size, strips, pages } = this;
    const visit = (bx, by, values) => {
      const x = bx * BLOCK + size / 2, y = by * BLOCK + size / 2;
      if (x < 0 || x >= size || y < 0 || y >= size) return;
      const strip = Math.floor(x / STRIP), offset = x - strip * STRIP;
      const key = y / BLOCK * strips + strip;
      let page = pages.get(key);
      const blockBit = 1 << (offset / BLOCK);
      // Certified support extends beyond what an R8 sample can show. Skip
      // black-to-black blocks even when another block already owns the strip.
      if (!(page && (page.visibleBlocks & blockBit))) {
        if (!values) return;
        let k = 0;
        while (k < BLOCK * BLOCK && values[k] < 0.5 / 255) k++;
        if (k === BLOCK * BLOCK) return;
      }
      if (!page) {
        page = { bytes: new Uint8Array(STRIP * BLOCK), x: x - offset, y, visibleBlocks: 0,
          left: STRIP, right: 0, top: BLOCK, bottom: 0 };
        pages.set(key, page);
      }
      const bytes = page.bytes;
      let visible = 0;
      for (let row = 0; row < BLOCK; row++) {
        const dest = row * STRIP + offset, start = row * BLOCK;
        let left = BLOCK, right = 0;
        for (let col = 0; col < BLOCK; col++) {
          const value = values ? (Math.min(255, values[start + col] * 255 + 0.5) | 0) : 0;
          visible |= value;
          if (bytes[dest + col] === value) continue;
          bytes[dest + col] = value;
          left = Math.min(left, col); right = col + 1;
        }
        if (right) {
          page.left = Math.min(page.left, offset + left); page.right = Math.max(page.right, offset + right);
          page.top = Math.min(page.top, row); page.bottom = Math.max(page.bottom, row + 1);
        }
      }
      if (Boolean(visible) !== Boolean(page.visibleBlocks & blockBit)) {
        // Bilinear samples just across a tile edge still see this block.
        const cells=this.tileCells, across=this.tilesAcross;
        const x0=Math.max(0,Math.floor((x-1)/cells)), x1=Math.min(across-1,Math.floor((x+BLOCK)/cells));
        const y0=Math.max(0,Math.floor((y-1)/cells)), y1=Math.min(across-1,Math.floor((y+BLOCK)/cells));
        for(let ty=y0; ty<=y1; ty++) for(let tx=x0; tx<=x1; tx++)
          this.tileBlocks[ty*across+tx] += visible ? 1 : -1;
      }
      if (visible) page.visibleBlocks |= blockBit;
      else page.visibleBlocks &= ~blockBit;
    };
    // A retired block may already have been reused since the last render.
    field.freed((bx, by) => visit(bx, by, null));
    field.forgetFreed();
    field.blocks(visit);
    let sent = 0;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, STRIP);
    for (const [key, page] of pages) {
      if (!page.right) continue;
      const width = page.right - page.left, height = page.bottom - page.top;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, page.x + page.left, page.y + page.top, width, height,
        gl.RED, gl.UNSIGNED_BYTE, page.bytes, page.top * STRIP + page.left);
      sent += width * height;
      if (!page.visibleBlocks) pages.delete(key);
      else { page.left = STRIP; page.right = 0; page.top = BLOCK; page.bottom = 0; }
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    return sent;
  }

  uploadDense(gl, grid, bytes) {
    const size = this.size;
    for (let y = 0; y < size; y++) {
      const row = grid.row(y - size / 2);
      for (let x = 0; x < size; x++) bytes[y * size + x] = Math.min(255, row[x] * 255 + 0.5);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED, gl.UNSIGNED_BYTE, bytes);
    return bytes.length;
  }
}
