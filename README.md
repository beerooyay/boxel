# boxel

Fields that cost what happens in them, not the size of the world they cover. With a proof.

A field is a number on every cell of a grid that spreads to its neighbours and fades: the glow
a footstep leaves in moss, how wet the ground is, heat, smoke, the scent a guard follows, the
noise a gunshot makes, fog of war. Games simulate fields like these in one of two ways.

- **Everywhere.** It's correct, but it costs the whole world every frame and stores every cell.
  So it only ever runs on a small square around the camera, and everything outside that square
  is forgotten.
- **Where it looks busy.** It's cheap, but nobody knows what was thrown away, and the errors
  show up as seams, pops and trails that stop dead.

Boxel does the second with the guarantee of the first. You pick a tolerance (1/255: one shade
of an 8-bit texture). No cell ever differs from computing every cell by more than that, on
every step, for as long as it runs and however large the world is. The cells it can prove
don't matter are never computed and never stored.

It's an engine for the certified locality of Rouyea & Bourgeois,
[*Certified Locality in Diffusive Simulation*](https://www.alphaxiv.org/abs/2610.diffusive-simulation-tolerance-footprints)
(2026), taken from the paper's theorems to something a game can ship.

## What it does that nothing else did

**Open worlds stop costing their size.** A thousand walkers leave glowing trails on worlds of
every size: [results](docs/results.md#open-worlds), one core, 12.5 cm cells. The last two columns
are extrapolated from a measured 2048² grid (0.53 ns per cell per step, two f32 buffers), since
nothing here could hold 128 GB.

| world | boxel | memory | computing every cell | its memory |
|---|---|---|---|---|
| 1 km × 1 km | 22.2 ms | 91 MB | 36 ms | 512 MB |
| 4 km × 4 km | 24.2 ms | 94 MB | 569 ms | 8 GB |
| 16 km × 16 km | 24.1 ms | 94 MB | 9.1 s | 128 GB |

The cost grows with the number of walkers and nothing else: 10 walkers cost 0.07 ms, 100 cost
1.7 ms, and 10 000 on 4 km still beat computing every cell (401 ms in 894 MB, against 569 ms in
8 GB). The certified bound stayed under the tolerance in every run, no block was ever caught
over its bound, and checked cell by cell against a full grid that was actually run (a thousand
walkers on 256 m), the largest error was 0.08 of the tolerance.

**The lattice certificate the paper left open.** The paper proves tight windows in the
continuum. On the actual grid it either proves loose ones (10 to 40 times too large) or proves
nothing (without fade). Boxel computes the cone of the grid scheme itself and makes that
computation a proof. On the paper's own test cases it certifies within 3 to 6% of the cells
an event ever touches: [docs/certificate.md](docs/certificate.md#3-the-cone-computed-new-the-papers-open-problems-2-and-3).

| fade | cells ever above ε | boxel, certified | the paper's diamond, certified |
|---|---|---|---|
| 0 | 845 | 889 | none |
| 0.002 | 577 | 609 | 23 981 |
| 0.02 | 241 | 249 | 2 381 |

**A proof that survives the machine.** The theorems are about exact arithmetic; a game runs in
f32. Boxel builds its table from the exact f32 weights it steps with, bounds the table's own
f64 rounding, and carries a live rounding term inside the promise. So the guarantee is about
the numbers a game holds: the field never reads above computing every cell in the same
arithmetic, and never below it by more than the bound. What is assumed is IEEE-754 doing what
it says. Nothing here is machine-checked; interval arithmetic over the table is the step that
would make it so. [Section 8](docs/certificate.md#8-floating-point-accounted-for-new) has the
analysis.

**A bound that does not grow with the number of events.** The paper's global error is a sum
over every event ever made. Boxel keeps that sum per district of 1024 × 1024 cells and proves
that a cell only pays for the nine around it. Ten thousand walkers carry the same guarantee as
ten.

**The same bits everywhere.** No transcendental functions at run time, an integer ledger, the
same float operations in the same order. One session hashes identically on x86 with SSE2, x86
with AVX2 and FMA, and wasm. Two machines that see the same events hold the same field, so a
multiplayer game can send the events and not the field. In the storm test that is 237
bytes a second against 12.6 MB a second of texture tiles.

**Memory follows the window.** Blocks outside the window have no storage at all: that is the
paper's windowed simulation (Theorem 6.5) taken literally. The plane has no edge. Two events a
hundred thousand cells apart cost what two events cost.

## The demo: Tarnished Promise

Tarn is a four-acre lakeshore beneath an amber giant, a rose giant and an ocean world with
crossed rings. A river carries glowing pods down to the lake. A winding trail climbs the
western hill to a 26 m lookout. Walk, wade or throw a glowstone to disturb the glow, moisture
and wear fields. Press **N** for night and **M** to restart the fields under the other engine.

The browser renderer uses WebGL2 and the Rust field engine compiled to WebAssembly.
The [river comparison](docs/results.md#the-picture) includes a repeatable full-map field check.

```sh
cargo build --release --target wasm32-unknown-unknown -p boxel-ffi
cp target/wasm32-unknown-unknown/release/boxel_ffi.wasm demo/boxel.wasm
python3 -m http.server     # then open http://localhost:8000/demo/
```

## Using it

```rust
use boxel::{Field, Spec};

// glow in the moss: D = 8 cells²/s, k = 0.3/s, stepped 60 times a second
let mut glow = Field::new(Spec { spread: 8.0 / 60.0, fade: 0.3 / 60.0, tolerance: 1.0 / 255.0, events: 64 })?;

glow.deposit(x, y, 2, 0.8);          // a footstep: radius 2 cells, +0.8
glow.step();                          // one fixed step; take more for faster time, never longer ones

for &(bx, by) in glow.freed() { /* clear that 16 × 16 tile */ }
glow.forget_freed();
for (bx, by, values) in glow.blocks() { /* upload 256 floats to tile (bx, by) */ }
```

The whole interface is deposit, drain, rain, step, sample, and the blocks in the window. A
host maps world positions to integer cells, steps at a fixed rate, and copies blocks into
whatever it draws with.

- **Rust and Bevy**: depend on the crate. It is `no_std` with no dependencies.
- **Unity, Unreal, Godot, C, C++**: link `boxel_ffi` (static or shared) through
  [`ffi/boxel.h`](ffi/boxel.h). Upload `boxel_block_data` into a texture region per block.
- **The web**: [`ffi/boxel.js`](ffi/boxel.js) over the wasm build, about 60 KB. The demo is the
  example.
- **Bevy** can step one field per entity in `FixedUpdate` with the optional
  [Boxel plugin](integrations/bevy/src/lib.rs). Match the fixed clock to the field spec.
  Run its example as a doctest with `cargo test --manifest-path integrations/bevy/Cargo.toml`.

Fields compose. Each one has its own spread and fade, so footprints, wetness, heat, scent and
fog of war are the same three calls with different numbers.

## Layout

| path | |
|---|---|
| `src/` | the engine: `cone` (the computed lattice cone), `ledger` (integer block ledger), `field` (events, window, pages, districts), `grid` (the full computation, as reference), `spec` |
| `tests/` | the promise against the full computation, on random histories |
| `ffi/` | the C ABI, its header, and the JavaScript binding |
| `bench/` | every number in `docs/results.md`, and the wasm replay |
| `demo/` | Tarnished Promise |
| `integrations/bevy/` | standalone Bevy ECS adapter |
| `docs/` | [the certificate](docs/certificate.md), [results](docs/results.md) |

```sh
cargo test --release
cargo run --release -p boxel-bench -- cone      # the paper's tables, certified
cargo run --release -p boxel-bench -- acre      # the demo's fields: boxel, dense, guessing
cargo run --release -p boxel-bench -- world     # open worlds
cargo run --release -p boxel-bench -- replay replay.json && node bench/replay.mjs replay.json target/wasm32-unknown-unknown/release/boxel_ffi.wasm
```

## Limits

- **The step is fixed per field.** The cone is computed for it at startup: a few ms for fast
  fields, around 30 ms for slow ones.
- **Linear spread and fade, nonnegative deposits.** Saturation and drains keep the bound.
  Wind, nonlinear reactions and negative sources are outside it.
- **No fade makes everything expensive.** That is the physics: an undamped event's footprint
  is A/(eε) cells however slowly it spreads.
- **Where activity covers the whole world, computing everything wins.** A block costs about
  twice what a dense cell row does per cell. In a spore storm over an entire acre boxel takes
  0.15 ms against 0.09 ms, and a thousand walkers crammed onto 256 m cost it 11 ms against 2.
  The promise holds either way.
- **One thread.** Awake blocks are independent within a step, so they split across cores
  cleanly; that is next.

## Credits

The mathematics is Blaize Rouyea and Corey Bourgeois's paper. Boxel grew out of the field
substrate in rawah (`cells.js`, `boxels.js`). The demo's grass and leaves are Corey's blade from
[ceeboozwah/grass](https://github.com/ceeboozwah/grass), and its post pipeline is his.
