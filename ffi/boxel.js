// boxel for the web: a thin ES module over the wasm build of the C ABI.
// Copyright (c) 2026 Blaize Rouyea and Corey Bourgeois. Business Source License 1.1; see LICENSE.
//
//   import { load } from './boxel.js';
//   const boxel = await load(fetch('boxel.wasm'));
//   const glow = boxel.field({ spread: 0.13, fade: 0.005, tolerance: 1 / 255 });
//   glow.deposit(x, y, 2, 0.8);
//   glow.step();
//   glow.freed((bx, by) => clearTile(bx, by));
//   glow.blocks((bx, by, values) => uploadTile(bx, by, values));   // values: 256 floats
//   glow.forgetFreed();

/** Instantiate from a Response, a promise of one, or raw bytes. */
export async function load(source) {
  source = await source;
  const { instance } = source instanceof Response
    ? await WebAssembly.instantiateStreaming(source, {}).catch(async () => WebAssembly.instantiate(await source.arrayBuffer(), {}))
    : await WebAssembly.instantiate(source, {});
  const ex = instance.exports;
  const floats = (ptr, n) => new Float32Array(ex.memory.buffer, ptr, n);

  class Field {
    constructor({ spread, fade, tolerance = 1 / 255, events = 64 }) {
      this.h = ex.boxel_field_new(spread, fade, tolerance, events);
      if (!this.h) throw new Error('boxel: this field cannot be certified (check 4*spread + fade <= 1, and give it some fade)');
    }
    deposit(x, y, radius, amount) { ex.boxel_deposit(this.h, x, y, radius, amount); }
    drain(x, y, radius, amount) { ex.boxel_drain(this.h, x, y, radius, amount); }
    rain(amount) { ex.boxel_rain(this.h, amount); }
    step(steps = 1) { ex.boxel_step(this.h, steps); }
    sample(x, y) { return ex.boxel_sample(this.h, x, y); }
    /** The uniform part every cell adds (rain), kept apart from the blocks. */
    get sheet() { return ex.boxel_sheet(this.h); }
    /** Blocks in the window right now. */
    get awake() { return ex.boxel_blocks(this.h); }
    /** Calls fn(bx, by, values) for every block in the window; `values` is a view, valid until the next change. */
    blocks(fn) {
      const n = ex.boxel_blocks(this.h);
      for (let i = 0; i < n; i++) fn(ex.boxel_block_x(this.h, i), ex.boxel_block_y(this.h, i), floats(ex.boxel_block_data(this.h, i), 256));
      return n;
    }
    /** Calls fn(bx, by) for every block that left the window since forgetFreed(). */
    freed(fn) {
      const n = ex.boxel_freed(this.h);
      for (let i = 0; i < n; i++) fn(ex.boxel_freed_x(this.h, i), ex.boxel_freed_y(this.h, i));
      return n;
    }
    forgetFreed() { ex.boxel_forget_freed(this.h); }
    stats() {
      const s = new Float64Array(ex.memory.buffer, ex.boxel_stats(this.h), 12);
      return { steps: s[0], deposits: s[1], merged: s[2], retired: s[3], stepped: s[4], violations: s[5], blocks: s[6], peakBlocks: s[7], live: s[8], bytes: s[9], bound: s[10], sheet: s[11] };
    }
    free() { ex.boxel_field_free(this.h); this.h = 0; }
  }

  class Grid {
    constructor({ spread, fade }, x0, y0, side) {
      Object.assign(this, { x0, y0, side });
      this.h = ex.boxel_grid_new(spread, fade, x0, y0, side);
      if (!this.h) throw new Error('boxel: 4*spread + fade must not exceed 1');
    }
    deposit(x, y, radius, amount) { ex.boxel_grid_deposit(this.h, x, y, radius, amount); }
    rain(amount) { ex.boxel_grid_rain(this.h, amount); }
    step(steps = 1) { ex.boxel_grid_step(this.h, steps); }
    /** Row y of the region, without the sheet: a view, valid until the next change. */
    row(y) { return floats(ex.boxel_grid_row(this.h, y), this.side); }
    get sheet() { return ex.boxel_grid_sheet(this.h); }
    free() { ex.boxel_grid_free(this.h); this.h = 0; }
  }

  return { field: (spec) => new Field(spec), grid: (spec, x0, y0, side) => new Grid(spec, x0, y0, side), exports: ex };
}
