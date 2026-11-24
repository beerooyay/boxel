# Results

The native fixtures run with `cargo run --release -p boxel-bench -- <name>`.
The one-acre timings below are from an Apple M4 Max. Open-world and four-core timings
are historical results from a shared four-core cloud container. The browser comparison
has its own renderer, viewport and workload.

## Lattice footprints

`boxel-bench cone`. A point event of mass 9 with D = 0.2 per unit step, at ε = 1/255. The
measured column is the paper's own experiment rerun: step the event until it is under 10⁻³ε
everywhere and count the cells whose running maximum went above ε. The three measured footprint counts agree with the corresponding rows of Tables 2 and 4.
[Rouyea and Bourgeois, p. 19](https://www.alphaxiv.org/abs/2610.diffusive-simulation-tolerance-footprints.pdf#page=19)

| fade | cells ever above ε | the paper | computed cone, certified | the diamond (Thm 6.4), certified | continuum ball (Thm 3.1/5.1), no lattice proof |
|---|---|---|---|---|---|
| 0 | 845 | 845 | **889** (1.05×) | unavailable | 844.3 |
| 0.002 | 577 | 577 | **609** (1.06×) | 23 981 (42×) | 573.0 |
| 0.02 | 241 | 241 | **249** (1.03×) | 2 381 (10×) | 239.6 |

The three tables took approximately 6 ms, 1 ms and under 1 ms to construct on the M4 Max.

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
| 256 m | 1000 | 11.3 | 16 831 | 36 MiB | 2.2 | 32 MiB | 0.74 | 0 |
| 1,024 m | 1000 | 22.2 | 36 998 | 91 MiB | 36 | 512 MiB | 0.94 | 0 |
| 4,096 m | 1000 | 24.2 | 39 074 | 94 MiB | 569 | 8 GiB | 0.78 | 0 |
| 16,384 m | 1000 | 24.1 | 39 223 | 94 MiB | 9 105 | 128 GiB | 0.76 | 0 |
| 4,096 m | 10 | 0.065 | 392 | 0.9 MiB | 569 | 8 GiB | 0.74 | 0 |
| 4,096 m | 100 | 1.7 | 3 918 | 9.7 MiB | 569 | 8 GiB | 0.75 | 0 |
| 4,096 m | 10 000 | 401 | 379 079 | 894 MiB | 569 | 8 GiB | 0.94 | 0 |

With 1,000 walkers on the three largest maps, the measured sparse cost ranged from 22.2 to
24.2 ms. At a fixed width of 4,096 m, increasing the crowd from 100 to 10,000 took the
peak storage estimate from 9.7 to 894 MiB and the mean field time from 1.7 to 401 ms.
The dense estimate was cheaper for the tightly packed 256 m fixture.

**Dense reference check.** 1000 walkers on 256 m for 20 s, every cell compared
once a second. The largest error was 0.00033, which is 0.08 of the tolerance, with 0 violations.

## The demo's fields on one acre

The native `acre` fixture covers a 64 m square at 12.5 cm per cell. The dense timing updates a
512 × 512 grid. For the separate accuracy run, a 1024 × 1024 dense grid supplies a padded reference.
All 512 × 512 inner cells are checked every 15 frames. The “guessing” baseline updates cells above
the threshold and their neighbors. One frame is 1/60 of simulated time. Moisture steps every fourth
frame, glow every frame. Memory figures estimate field working storage.

Release build on an Apple M4 Max, single thread, November 23, 2026. Times cover event deposits
and field stepping only. Running the browser adds rendering and texture transfers.

| scene | engine | ms / frame | cell updates / frame | largest sampled error | peak storage estimate |
|---|---|---:|---:|---:|---:|
| walk, glow | dense | 0.036 | 262,144 | reference | 2,048 KiB |
| | guessing | 0.015 | 2,989 | 0.00990 | 1,290 KiB |
| | Boxel | 0.004 | 13,723 | 0.00128 | 193 KiB |
| walk, moisture | dense | 0.009 | 65,536 | reference | 2,048 KiB |
| | guessing | 0.020 | 3,807 | 0.01510 | 1,290 KiB |
| | Boxel | 0.004 | 13,269 | 0.00148 | 728 KiB |
| storm, glow | dense | 0.036 | 262,144 | reference | 2,048 KiB |
| | guessing | 0.093 | 17,519 | 0.01360 | 1,290 KiB |
| | Boxel | 0.051 | 184,102 | 0.00170 | 2,826 KiB |
| burst, glow | dense | 0.035 | 262,144 | reference | 2,048 KiB |
| | guessing | 0.003 | 647 | 0.01006 | 1,290 KiB |
| | Boxel | 0.002 | 5,640 | 0.00049 | 108 KiB |

Across the four fixtures, Boxel's largest sampled error was 0.00170 at a requested tolerance
of 1/255 (about 0.00392). Each fixture recorded zero retirement audit failures. During the
storm, sparse bookkeeping outweighed the saving in cell updates.

## The picture

The river fixture runs 900 frames of walking, impacts, spore rain, drifting river pods,
and sailwing skims, covering 15 seconds of simulation. The dense and sparse engines receive
the same events. At the final tick, the verifier compares all 1,048,576 cells in each of
three fields, including uniform rain. It also compares the two rendered RGB images.

Chrome on an Apple M4 Max, 720 × 480 pixels, both day and night:

| measurement | Boxel | dense |
|---|---:|---:|
| total cell updates | 129,889,024 | 1,415,577,600 |
| field storage estimate at the last step | 3,010,816 bytes | 25,165,824 bytes |
| final active blocks (glow, moisture, wear) | 610, 189, 25 | 4,096 per field |

| field | largest observed deficit | reported field bound |
|---|---:|---:|
| glow | 0.00185701 | 0.00335330 |
| moisture | 0.00026188 | 0.00276765 |
| wear | 0 | 0.00203862 |

Every sparse value was at or below its dense counterpart. Each measured deficit fit
its field's reported bound and each bound fit the requested 1/255 tolerance. Both runs
recorded zero block retirement audit failures. Pixel differences are a separate measurement
that also depends on camera, viewport, shading and tone mapping.

To repeat, open `/demo/?test` at 720 × 480 CSS pixels with device scale 1, then run:

```js
__game.setNight(1);
await __game.verify('river');
```

The result includes field errors and bounds, framebuffer PSNR, peak RGB channel difference,
and the share of pixels differing by more than two levels. The session timer covers the
simulation loop. Texture upload, rendering and readback occur outside that timer.
The field storage estimates exclude the renderer and the rest of the browser.

## Cores

`boxel-bench --features parallel cores`: the open-world crowds of the trails field, 20 s each,
on one thread and then on all four cores of the cloud container, ms per frame over the second half. The
last column compares a hash of every block at the end.

| world | walkers | blocks awake | 1 thread, ms / frame | 4 threads, ms / frame | speedup | same bits |
|---|---|---|---|---|---|---|
| 1024 m | 1000 | 35 357 | 11.96 | 5.91 | 2.03× | yes |
| 4096 m | 1000 | 37 566 | 13.13 | 6.48 | 2.03× | yes |
| 4096 m | 4000 | 148 698 | 89.93 | 36.90 | 2.44× | yes |
| 4096 m | 10 000 | 363 515 | 249.96 | 96.49 | 2.59× | yes |

Blocks only split across threads once there are 96 of them to each; below that, starting the
threads costs more than they save. `tests/cores.rs` steps a storm on one thread and on eight and
compares every block, bit for bit, as it goes.

## Cross-platform replay

`boxel-bench replay` writes a 30 s storm session as events (f32 bit patterns) and hashes the
sorted block coordinates, f32 cell values and final uniform rain sheet. `bench/replay.mjs`
replays it through the wasm build and checks that the resulting field hash matches.

| build | hash |
|---|---|
| x86-64, baseline (SSE2) | `0b94e72ee0ea0c34` |
| x86-64, `target-cpu=native` (AVX2, FMA) | `0b94e72ee0ea0c34` |
| Apple M4 Max, native ARM64 | `0b94e72ee0ea0c34` |
| wasm32 with SIMD128, Node 22 and 23 | `0b94e72ee0ea0c34` |

The benchmark estimates 237 bytes/s for deposits at an assumed 13 bytes per record. The
actual JSON fixture includes step numbers, settings, rain and other metadata. Sending a full
256-byte R8 tile for every active or freed block on every step would total 12.6 MB/s before
framing or compression. Neither figure measures network traffic or the demo’s quantized
texture-change uploads.
