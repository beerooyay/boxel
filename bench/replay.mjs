// The replay of `boxel-bench replay`, run on the wasm build: the hash must match the native one.
//
//   cargo run --release -p boxel-bench -- replay /tmp/replay.json
//   cargo build --release --target wasm32-unknown-unknown -p boxel-ffi
//   node bench/replay.mjs /tmp/replay.json target/wasm32-unknown-unknown/release/boxel_ffi.wasm

import { readFile } from 'node:fs/promises';
import { load } from '../ffi/boxel.js';

const [script, wasm] = process.argv.slice(2);
const { spec, rain, frames, drops } = JSON.parse(await readFile(script, 'utf8'));
const f32 = (bits) => new Float32Array(new Uint32Array([bits]).buffer)[0];
const boxel = await load(await readFile(wasm));
const field = boxel.field({ spread: f32(spec[0]), fade: f32(spec[1]), tolerance: f32(spec[2]), events: spec[3] });

let q = 0;
for (let frame = 0; frame < frames; frame++) {
  while (q < drops.length && drops[q][0] === frame) {
    const [, x, y, r, a] = drops[q++];
    field.deposit(x, y, r, f32(a));
  }
  if (frame === rain[0]) field.rain(f32(rain[1]));
  field.step();
  field.forgetFreed();
}

const blocks = [];
field.blocks((x, y, v) => blocks.push([x, y, new Uint8Array(v.buffer, v.byteOffset, 1024).slice()]));
blocks.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
let h = 0xcbf29ce484222325n;
const eat = (bytes) => { for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn; };
const word = (n) => new Uint8Array(new Int32Array([n]).buffer);
for (const [x, y, bytes] of blocks) { eat(word(x)); eat(word(y)); eat(bytes); }
eat(new Uint8Array(new Float32Array([field.stats().sheet]).buffer));
console.log(`wasm:   ${blocks.length} blocks, hash ${h.toString(16).padStart(16, '0')}`);
