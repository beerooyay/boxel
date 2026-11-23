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
what computing every cell would cost: 0.6 ns per cell per step, measured on a 2048² grid, and
two f32 buffers.

| world | walkers | certified ms / frame | blocks awake | memory | dense ms / frame | dense memory | bound / tolerance | violations |
|---|---|---|---|---|---|---|---|---|
| 256 m | 1000 | 12.669 | 16831 | 36 MB | 2 | 32 MB | 0.7500 | 0 |
| 1024 m | 1000 | 21.858 | 36997 | 91 MB | 40 | 512 MB | 0.9987 | 0 |
| 4096 m | 1000 | 23.310 | 39073 | 94 MB | 640 | 8192 MB | 0.8095 | 0 |
| 16384 m | 1000 | 23.754 | 39222 | 94 MB | 10236 | 131072 MB | 0.7832 | 0 |
| 4096 m | 10 | 0.067 | 392 | 956 KB | 640 | 8192 MB | 0.7590 | 0 |
| 4096 m | 100 | 1.437 | 3917 | 9972 KB | 640 | 8192 MB | 0.7717 | 0 |
| 4096 m | 10000 | 402.374 | 379076 | 893 MB | 640 | 8192 MB | 0.9987 | 0 |

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
| walk, glow | dense | 0.093 | 262144 | 0 | 0 | | | 2048 KB |
| | guessing | 0.049 | 2989 | 0.00990 | 3 | | | 1290 KB |
| | **certified** | **0.007** | 13722 | 0.00128 | 1 | 0 | 75 | 193 KB |
| walk, moisture | dense | 0.024 | 65536 | 0 | 0 | | | 2048 KB |
| | guessing | 0.065 | 3807 | 0.01510 | 4 | | | 1290 KB |
| | **certified** | **0.008** | 13270 | 0.00148 | 1 | 0 | 325 | 728 KB |
| storm, glow | dense | 0.106 | 262144 | 0 | 0 | | | 2048 KB |
| | guessing | 0.258 | 17519 | 0.01360 | 4 | | | 1290 KB |
| | **certified** | **0.134** | 184079 | 0.00170 | 1 | 0 | 1282 | 2826 KB |
| burst, glow | dense | 0.094 | 262144 | 0 | 0 | | | 2048 KB |
| | guessing | 0.007 | 647 | 0.01006 | 3 | | | 1290 KB |
| | **certified** | **0.006** | 5648 | 0.00041 | 1 | 0 | 37 | 108 KB |

The certified field is never over tolerance and reads one 8-bit level from the reference at
most. Guessing is 2.5 to 3.9 times over tolerance. On a quiet acre the certified field is
10 to 15 times cheaper than dense. In a storm that covers the entire acre it is about 1.3 times
dearer: the window holds 70% of the acre, and a block costs more per cell than a dense row.

## The picture

`demo/` with `?test`: a scripted 15 s session (a hiker into the shallows and out, two stones,
spore rain, a landing splash) rendered from a fixed camera under the certified engine and under
dense, then compared.

| | |
|---|---|
| PSNR, certified vs dense | 61.2 dB |
| pixels more than 2 levels apart | 0.047% (grass-blade edges, moved by sub-tolerance wetness and trampling) |
| cells stepped over the session | 85.7 M certified, 353.9 M dense |
| field memory at the end | 1.8 MB certified, 6.3 MB dense |

## Same bits everywhere

`boxel-bench replay` writes a 30 s storm session as events (f32 bit patterns) and hashes the
resulting field. `bench/replay.mjs` replays it through the wasm build in Node.

| build | hash |
|---|---|
| x86-64, baseline (SSE2) | `6cea2d93572b217a` |
| x86-64, `target-cpu=native` (AVX2, FMA) | `6cea2d93572b217a` |
| wasm32 with SIMD128, Node 22 | `6cea2d93572b217a` |

The session's events are 237 bytes a second. Sending the field itself as 8-bit tiles would be
12.6 MB a second.
