# Results

Everything here was measured on a shared 4-core cloud container, on one core, with
`cargo run --release -p boxel-bench -- <name>`. Browser figures are headless Chromium with
software WebGL. Times move by ten or twenty percent from run to run on this machine; the
ratios are what to read.

## The paper's lattice footprints, certified

`boxel-bench cone`. A point event of mass 9 with D = 0.2 per unit step, at ε = 1/255. The
measured column is the paper's own experiment rerun: step the event until it is under 10⁻³ε
everywhere and count the cells whose running maximum went above ε. It reproduces the paper's
Tables 2 and 4 exactly.

| fade | cells ever above ε | the paper | computed cone, certified | the diamond (Thm 6.4), certified | continuum ball (Thm 3.1/5.1), no lattice proof |
|---|---|---|---|---|---|
| 0 | 845 | 845 | **889** (1.05×) | none exists | 844.3 |
| 0.002 | 577 | 577 | **609** (1.06×) | 23 981 (42×) | 573.0 |
| 0.02 | 241 | 241 | **249** (1.03×) | 2 381 (10×) | 239.6 |

Computing the cone takes 0 to 15 ms here. The demo's fields take 6 ms (glow) and about 30 ms
(moisture) natively, and around 200 ms for all three in a browser.

## Open worlds

`boxel-bench world`. Walkers start anywhere on the world and wander at 1.4 m/s, leaving a
glowing footstep every half second (radius 2 cells, +0.8). Glow is D = 8 cells²/s and
k = 0.3/s at 12.5 cm cells, stepped 60 times a second, with 1024 live events per district.
Each run lasts 30 s; times and blocks are averaged over the second half. The dense columns are
extrapolated, not run: what computing every cell would cost at 0.53 ns per cell per step (the
best of five runs of a 2048² grid on an idle machine; runs alongside other work measured up to
1.05), with two f32 buffers per cell. The boxel columns are measured.

| world | walkers | boxel ms / frame | blocks awake | memory | dense ms / frame (extrapolated) | dense memory (extrapolated) | bound / tolerance | violations |
|---|---|---|---|---|---|---|---|---|
| 256 m | 1000 | 11.3 | 16 831 | 36 MB | 2.2 | 32 MB | 0.74 | 0 |
| 1 km | 1000 | 22.2 | 36 998 | 91 MB | 36 | 512 MB | 0.94 | 0 |
| 4 km | 1000 | 24.2 | 39 074 | 94 MB | 569 | 8 GB | 0.78 | 0 |
| 16 km | 1000 | 24.1 | 39 223 | 94 MB | 9 105 | 128 GB | 0.76 | 0 |
| 4 km | 10 | 0.065 | 392 | 0.9 MB | 569 | 8 GB | 0.74 | 0 |
| 4 km | 100 | 1.7 | 3 918 | 9.7 MB | 569 | 8 GB | 0.75 | 0 |
| 4 km | 10 000 | 401 | 379 079 | 894 MB | 569 | 8 GB | 0.94 | 0 |

Across 1 km, 4 km and 16 km the certified cost is flat, and it is linear in the number of
walkers: about 38 blocks and 20 to 40 µs per walker per frame, the higher figure once the
working set is far past the caches. On the 256 m world a thousand walkers cover the whole map,
and computing every cell is cheaper there.

**Checked against the full computation**: 1000 walkers on 256 m for 20 s, every cell compared
once a second. The largest error was 0.00033, which is 0.08 of the tolerance, with 0 violations.

## The demo's fields on one acre

`boxel-bench acre`. The scenes the old tarn benchmark used, rerun: a hiker circling the lake
(footsteps every 0.5 s, a stone every 15 s), a spore storm over the whole acre (25 drops a
second for 30 s), and a burst of 200 drops into one 2 m patch within a second. Glow steps every
frame; moisture (D = 3 cells²/s, k = 0.04/s) steps every fourth. *Dense* is the full computation
over the 512 × 512 acre with the same arithmetic. *Guessing* steps cells above the tolerance and
their neighbours: the usual engine heuristic, with no guarantee. Errors are measured against a
dense grid twice the acre's width.

| scene | engine | ms / frame | cells stepped / frame | max error | 8-bit levels | violations | peak blocks | memory |
|---|---|---|---|---|---|---|---|---|
| walk, glow | dense | 0.100 | 262144 | 0 | 0 | | | 2048 KB |
| | guessing | 0.037 | 2989 | 0.00990 | 3 | | | 1290 KB |
| | **boxel** | **0.007** | 13723 | 0.00128 | 1 | 0 | 75 | 193 KB |
| walk, moisture | dense | 0.036 | 65536 | 0 | 0 | | | 2048 KB |
| | guessing | 0.049 | 3807 | 0.01510 | 4 | | | 1290 KB |
| | **boxel** | **0.008** | 13269 | 0.00148 | 1 | 0 | 325 | 728 KB |
| storm, glow | dense | 0.094 | 262144 | 0 | 0 | | | 2048 KB |
| | guessing | 0.318 | 17519 | 0.01360 | 4 | | | 1290 KB |
| | **boxel** | **0.150** | 184102 | 0.00170 | 1 | 0 | 1282 | 2826 KB |
| burst, glow | dense | 0.122 | 262144 | 0 | 0 | | | 2048 KB |
| | guessing | 0.018 | 647 | 0.01006 | 3 | | | 1290 KB |
| | **boxel** | **0.006** | 5640 | 0.00049 | 1 | 0 | 37 | 108 KB |

Boxel is never over tolerance and reads one 8-bit level from the reference at most. Guessing
is 2.5 to 3.9 times over tolerance. On a quiet acre boxel is 4 to 20 times cheaper than dense.
In a storm that covers the entire acre it is about 1.6 times dearer: the window holds 70% of the
acre, and a block costs more per cell than a dense row.

## The picture

`demo/` with `?test`: a scripted 15 s session (a hiker into the shallows and out, two stones,
spore rain, a landing splash) on the demo's four-acre map, while the world runs its own events
(a pilgrim walking the summit trail, eight seed pods drifting down the river, spray from the
rapids), rendered from a fixed camera under boxel and under dense, then compared. Stepping time
is the three fields' steps only, wasm in headless Chromium, one core.

| | |
|---|---|
| PSNR, boxel vs dense | 64.7 dB |
| pixels more than 2 levels apart | 0.06% (tips of glowing plants and specks on the water, where the shaders steepen sub-tolerance glow) |
| cells stepped over the session | 134 M boxel, 1 416 M dense |
| stepping time over the session | 270 ms boxel, 687 ms dense |
| field memory at the end | 3.4 MB boxel, 25.2 MB dense |

The glow and wear fields are budgeted for 1024 events a district, as the world bench budgets for
crowds. At 64, the pods' steady stream of small deposits keeps the district merging, the glow
window grows to half the map, and boxel steps slower than dense; the promise holds either way.

## Same bits everywhere

`boxel-bench replay` writes a 30 s storm session as events (f32 bit patterns) and hashes the
resulting field. `bench/replay.mjs` replays it through the wasm build in Node.

| build | hash |
|---|---|
| x86-64, baseline (SSE2) | `0b94e72ee0ea0c34` |
| x86-64, `target-cpu=native` (AVX2, FMA) | `0b94e72ee0ea0c34` |
| wasm32 with SIMD128, Node 22 | `0b94e72ee0ea0c34` |

The session's events are 237 bytes a second. Sending the field itself as 8-bit tiles would be
12.6 MB a second.
