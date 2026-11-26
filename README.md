# boxel

Boxel runs persistent, two-dimensional diffusion fields for games. A footstep can wake moss,
rain can wet a whole valley, and both effects can keep evolving after the camera leaves.

The engine computes a conservative envelope for a disturbance on its actual five-point grid.
It uses those envelopes to decide which 16 × 16 blocks need storage and tracks the error that
can remain in cells it skips. Call `field.bound()` for the current upper bound against the full
calculation. The requested tolerance is a target. Concentrated events or accumulated rounding
can exhaust its budget, in which case the reported bound can exceed the target. The retirement
audit separately counts blocks observed above their allowance. [Certificate and assumptions](docs/certificate.md)

Blaize Rouyea and Corey Bourgeois developed the underlying theory in their October 2026 alphaXiv preprint. [*Certified Locality in Diffusive Simulation*](https://www.alphaxiv.org/abs/2610.diffusive-simulation-tolerance-footprints)

## What distinguishes Boxel

Museth’s VDB stores sparse, changing volumes. Kloster and Gleich gave a deterministic local
method for graph heat diffusion. Boxel combines a computed lattice envelope, regional accounting for live and
retired events, a rounding allowance for the actual f32 update, and deterministic event replay in
native code and WebAssembly. The same renderer can run the sparse and dense simulations so
their fields and pictures can be compared directly. [Museth on sparse volumes](https://www.museth.org/Ken/Publications_files/Museth_TOG13.pdf) · [Kloster and Gleich on local graph diffusion](https://arxiv.org/abs/1403.3148)

**The measured advantage is strongest on quiet ground.** In the 512 × 512 walking-glow
fixture, Boxel stepped 13,723 cells per frame on average and the dense reference stepped
262,144. On an Apple M4 Max, deposits and field stepping took 0.004 ms versus 0.036 ms.
In the spore storm, Boxel took 0.051 ms and dense took 0.036 ms. Rendering has its own
frame budget. [One-acre measurements](docs/results.md#the-demos-fields-on-one-acre)

**Scaling with activity.** An earlier single-core cloud run put 1,000 walkers on maps of
increasing size with 12.5 cm cells. The sparse field took 22–24 ms per step across the
three maps. The dense estimates extrapolate 0.53 ns per cell per step from a timed 2048²
grid and assume two f32 buffers. [Open-world measurements](docs/results.md#open-worlds)

| square map, side | Boxel time | Boxel storage estimate | dense time estimate | dense buffers |
|---|---:|---:|---:|---:|
| 1,024 m | 22.2 ms | 91 MiB | 36 ms | 512 MiB |
| 4,096 m | 24.2 ms | 94 MiB | 569 ms | 8 GiB |
| 16,384 m | 24.1 ms | 94 MiB | 9.1 s | 128 GiB |

In a separate 256 m run with 1,000 walkers, every cell was compared with a running dense
reference once a second for 20 seconds. The largest observed error was 0.00033, about 8% of
the requested tolerance of 1/255.

**A tighter window on the actual grid.** For each supported fixed step, Boxel constructs
a conservative bound from the lattice impulse response. On three point-event fixtures
from Tables 2 and 4 of the preprint, its footprint contained 3.3–5.5% more cells than
the measured above-threshold footprint. These figures describe those three cases.
[Construction and assumptions](docs/certificate.md#3-the-computed-lattice-cone)

| fade | cells measured above ε | computed footprint | exponential diamond |
|---|---:|---:|---:|
| 0 | 845 | 889 | unavailable |
| 0.002 | 577 | 609 | 23,981 |
| 0.02 | 241 | 249 | 2,381 |

**Floating-point error is part of the budget.** Boxel builds the table from its f32 stencil
weights, allows for the table’s f64 rounding, and tracks the rounding introduced by edits
and simulation steps. The argument assumes IEEE-754 arithmetic. Dense regression fixtures
exercise its implementation. The analytical argument awaits independent formal verification.
[Arithmetic assumptions](docs/certificate.md#8-floating-point-accounting)

**Regional error accounting.** Boxel accumulates local event budgets in districts of 1024 × 1024
cells. A cell pays for its own district, eight neighbours and a bounded far-field term. Spreading
activity over more districts can therefore cost less of the local error budget than concentrating
the same activity in one district.

**Replay across builds.** A 30-second storm produced the same field hash on native ARM64
and WebAssembly. Earlier SSE2 and AVX2 runs on x86-64 reported the same hash. That makes
event replay worth testing for multiplayer replication. The replay script fails on a hash
mismatch. [Replay method and results](docs/results.md#cross-platform-replay)

**Storage follows the active area.** A field allocates pages as blocks wake and reuses them
after blocks retire. Two distant footprints can evolve without filling the space between
them. Peak allocations, event records and the certificate table also contribute to memory.

## The demo: Tarnished Promise

[Play Tarnished Promise in your browser](https://beerooyay.github.io/boxel/).

Tarn spans 256 × 256 metres, about 16 acres. Four connected upland walks add about 730 metres of trail
around the original lake. Follow the river north to a spring, take the west walk through the coilferns,
climb the eastern rock shelf or look back across the lake from the arrowleaf groves on the southern ridge.
Switchbacks cross the lake-facing hill with resting shelves on the way to the summit.
A separate Boxel field spreads and dissipates gusts in a moving air mass. The hills shelter the lee.
Grass, crowns, sailwings, the sound of wind and rough patches on the water sample the same fronts.
Grass and low leaves part as you pass. Wading, skimming sailwings and thrown stones send ripples
across the lake and downstream with the river current. Disturb the moss with a footstep or
glowstone and its filaments pick up the local glow field. Cloud shadows cross the valley by
day, and the pigments in leaves and wetland flowers set the colour of their light at night.
Spiral rosettes grow beside the paths and sheltered banks. Their folded leaves take a wet sheen
from moisture at the root. At night a nearby glowstone picks out the branching veins. Sailwings
glide between bursts of wingbeats, bank away from a nearby impact and skim again once settled.
Water and foliage show through the thinner parts of their wings.
Mist gathers over wet ground and water. At night, a fresh disturbance lights the mist above it
from the same Boxel field that lights the surface.
Four worlds share the same stellar light direction above the mountains. Press **N** for night
and **M** to restart the three surface fields under the other engine. Press **C** to let the day run: the star
crosses the sky about the same pole the stars turn on, its light reddens through the air toward a
sunset, and its shadows are baked again as it moves. Press **T** for a storm: rain rings the
water, lightning flashes the glow field and thunder arrives as late as the distance says. **V**
turns the sound, made as it plays, on or off. Touch controls offer each of these.

Above the valley, a separate Boxel field tracks cloud water in 32-metre cells. Humidity and
temperature set the condensation level. Heating drives the updrafts, and evaporation from the lake and spring feeds them downwind.
Broad updrafts grow taller crowns. The renderer integrates density toward the eye and toward the light. It reuses
that sky for the planets’ foreground, water reflections and moving shadows. Boxel reports its error bound for
horizontal condensate against the dense solver, with a target of 1/255. A separate browser test compares all four
rendered cloud channels with empty-space skipping enabled and disabled in three weather states.

The browser renderer uses WebGL2 and the Rust field engine compiled to WebAssembly.
Pages builds the engine from the published revision with Rust 1.92.0 and checks its native replay before deployment.
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

- **Rust**: depend on the crate. It is `no_std` with no dependencies. Turn on the `parallel`
  feature and a large window's blocks step across cores, on `std` threads, holding the same bits
  as on one: two to two and a half times faster on four cores for a crowd of a thousand to ten
  thousand walkers ([cores](docs/results.md#cores)).
- **Unity, Unreal, Godot, C, C++**: link `boxel_ffi` (static or shared) through
  [`ffi/boxel.h`](ffi/boxel.h). Upload `boxel_block_data` into a texture region per block.
- **The web**: [`ffi/boxel.js`](ffi/boxel.js) over the wasm build, about 63 KiB. The demo is the
  example.
- **Bevy** can step one field per entity in `FixedUpdate` with the optional
  [Boxel plugin](integrations/bevy/src/lib.rs). Match the fixed clock to the field spec.
  Fields step in parallel with each other, and a `BoxelImage` beside a field keeps a texture of
  its window current, block by block, to sample in any material. Run its tests with
  `cargo test --manifest-path integrations/bevy/Cargo.toml`.

Fields compose. Each one has its own spread and fade, so footprints, wetness, heat, scent and
fog of war are the same three calls with different numbers.

## Layout

| path | |
|---|---|
| `src/` | the engine: `cone` (the computed lattice cone), `ledger` (integer block ledger), `field` (events, window, pages, districts), `grid` (the full computation, as reference), `spec` |
| `tests/` | the promise against the full computation, on random histories; the same bits on one thread and on many; the demo's modules, under Node |
| `.github/` | the engine checks, browser picture regression, native/wasm replay and Pages deployment |
| `ffi/` | the C ABI, its header, and the JavaScript binding |
| `bench/` | native benchmark fixtures, wasm replay and browser picture check |
| `demo/` | Tarnished Promise |
| `integrations/bevy/` | standalone Bevy plugin: fields as components, windows as textures |
| `docs/` | [the certificate](docs/certificate.md), [results](docs/results.md) |

```sh
cargo test --release
node --test tests/*.mjs                        # demo modules and picture checks
cargo run --release -p boxel-bench -- cone      # compare lattice footprint counts with the preprint
cargo run --release -p boxel-bench -- acre      # the demo's fields: boxel, dense, guessing
cargo run --release -p boxel-bench -- world     # open worlds
cargo run --release -p boxel-bench --features parallel -- cores   # one thread against all of them
cargo run --release -p boxel-bench -- replay replay.json && node bench/replay.mjs replay.json target/wasm32-unknown-unknown/release/boxel_ffi.wasm
```

## Limits

- **The step is fixed per field.** The cone is computed for it at startup: a few ms for fast
  fields, around 30 ms for slow ones.
- **Linear spread and fade, nonnegative deposits.** Saturation and drains keep the bound.
  Wind, nonlinear reactions and negative sources are outside it.
- **Undamped fields can retain events longer.** An undamped point event’s footprint
  grows as the threshold falls. For a point event in the two-dimensional continuum its area is A/(eε).
- **Dense activity can favor a dense grid.** Stepping a block costs
  more per cell than a dense update in these fixtures. The M4 Max field timings above show the
  crossover between the walking and storm workloads.
- **The bookkeeping is serial.** Stepping blocks splits across cores, but placing events,
  ageing, retiring and closing blocks stay on one, which is what holds the speedup near 2.5× on
  four cores. The web build runs on one thread, since the page cannot share memory between
  workers without headers the host does not send.

## Credits

The mathematics is Blaize Rouyea and Corey Bourgeois's paper. Boxel grew out of the field
substrate in rawah (`cells.js`, `boxels.js`). The demo's grass and leaves are Corey's blade from
[ceeboozwah/grass](https://github.com/ceeboozwah/grass), and its post pipeline is his.
