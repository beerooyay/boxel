# The certificate

This is what boxel promises, the assumptions under it, and why it holds. It follows
*Certified Locality in Diffusive Simulation: Tolerance Light Cones and Logarithmic Event
Footprints* (Rouyea & Bourgeois, 2026), cited below by theorem number. Sections 3 to 9 below
are new; each says what it adds to the paper.

The promise is made twice. First about exact arithmetic, the setting of the paper's theorems.
Then about the machine: the f32 numbers a game actually holds and the f64 table the
certificate is built from. Section 8 shows that the second follows from the first with a
rounding term that is tracked live and budgeted.

## 1. The scheme

A field is a value `u(x)` on every cell `x` of the integer plane, advanced by the explicit
scheme of the paper (eq. 6.1) at a fixed step:

```
u'(x) = (1 - 4a - f)·u(x) + a·(u(x+e₁) + u(x-e₁) + u(x+e₂) + u(x-e₂))
```

`a` is `spread` (D·τ/h²) and `f` is `fade` (k·τ). We require `4a + f ≤ 1`. Every weight is then
nonnegative and they sum to `1 - f`, so the step is order preserving and never grows the
maximum. That monotone structure is everything Lemma 6.2 and Theorems 6.5 to 6.7 use.

Between steps the world acts on the field:

- **deposit**: add `h ≤ 1` on every cell of a disc of radius `r ≤ 24`; the total saturates at 1.
- **drain**: subtract on a disc, never below zero.
- **rain**: add a constant to every cell. A constant has zero laplacian, so the scheme maps it
  to `(1 - f)` times itself. It is kept as one number, the **sheet**, in both the field and the
  reference, and every cell reads it.

The **full computation** `u` applies all of this to every cell. The boxel field `v` applies it
only inside a window and holds zero outside. The promise compares the two.

## 2. The promise

> For every cell `x` and every step `n`:  `0 ≤ uⁿ(x) - vⁿ(x) ≤ B ≤ ε`,
>
> where `u` is the full computation and `v` the boxel field, both in exact arithmetic, or both
> in the same f32 arithmetic (section 8).

`ε` is the tolerance. `B` is reported live by `Field::bound()` and is built from five parts:
Theorem 6.7's three, and two that are new.

| part | default share | what it covers |
|---|---|---|
| window level `θ` | ε/2 | a block outside the window holds less than its ledger, which is under `θ` |
| tails | ε/5 | ledger terms under the cut `c` are dropped; at most `9·C` live events can drop one at any cell |
| retired | ε/5 − slack | what retired events can still put on any cell, per district pool |
| rounding | ε/10 | what f32 arithmetic can move either field by, relative to exact arithmetic |
| far | ε·10⁻⁶ | everything held by districts that are not neighbours of the cell |

The field only ever reads low: outside the window it is zero, and inside it the error is a
weighted average of errors that are already in `[0, B]`.

## 3. The cone, computed (new: the paper's open problems 2 and 3)

Every event of mass `A` evolves as `A·Kₙ`, with `Kₙ` the scheme's point kernel. The certificate
needs its future envelope `Eₘ(z) = sup over n ≥ m of Kₙ(z)`. The paper offers two closed forms.
The continuum envelope (Theorems 3.1 and 5.1) is tight but unproved on the lattice (Remark 6.10).
The diamond (Theorem 6.4) is proved but covers 10 to 40 times the cells ever touched (Table 4),
and nothing at all when `f = 0`.

For a fixed step, `Cone` computes the envelope instead, by running the scheme from a unit
impulse. Four facts make the computed table an upper bound for every cell at every age:

1. **Reflection only adds.** On the box `|z|∞ ≤ R` with reflecting walls, the solution is the
   free kernel plus its mirror images, all nonnegative. Inside the box it bounds the free kernel.
2. **A wall of exponentials outside.** Let `β` be the most the box ever holds on its outer
   ring. Make that ring driven cells. Take `q = e^-s` where `2a(cosh s - 1) = f`. Each
   `β·q^(±zᵢ - R)` is a supersolution (Lemma 6.3a), and so is their minimum (6.3c). It covers
   the ring, and the exterior starts at zero. So by Lemma 6.2 the free kernel is at most
   `β·q^(|z|∞ - R)` outside the box, at all times. With `f = 0`, `q = 1` and the bound is `β`.
3. **The past bounds the future.** `‖Kₙ‖∞` never increases. Once the whole box is under the
   floor at step `M`, it stays there.
4. **Coarsening only loosens.** Ages fall into geometric bins and each bin keeps the bound of
   its first age. Cells are folded into rings by integer distance, taking a running maximum
   outward. Any lower bound on age or distance then reads an upper bound on the envelope.

The box grows until `β` is under the floor; the run continues until the box is.

The table is computed in f64, and its rounding is part of the proof (section 8): every stored
value is the computed one times `1 + 10⁻⁹`, plus `10⁻³⁰⁰`. The run uses the field's own
weights, the f32 numbers it actually steps with, so the table certifies the scheme the machine
runs and not a neighbour of it.

On the paper's own test cases (D = 0.2, A = 9, ε = 1/255; `boxel-bench cone`):

| k | cells ever above ε (measured; the paper's count) | computed cone, certified | diamond, certified |
|---|---|---|---|
| 0 | 845 | 889 (1.05×) | none |
| 0.002 | 577 | 609 (1.06×) | 23 981 (42×) |
| 0.02 | 241 | 249 (1.03×) | 2 381 (10×) |

The undamped lattice, where the paper proves nothing, now has a certificate. It is
computer-assisted and holds for one step size, not a closed form; within that scope it is
within 6% of the truth.

## 4. Events and the ledger

**An event** is a deposit: a disc support, a mass `A`, a cap `h` and a birth step. By support
dilation (Proposition 4.2a), cell `x` at age `m` receives at most `A·E_m(ρ)`, where `ρ` is any
lower bound on the distance from `x` to the support. By the maximum principle it also receives
at most `h`. The engine takes `ρ = ⌊|x - centre|⌋ - r`, computed with integer square roots.

**The ledger** keeps one entry per 16 × 16 block. Each event adds its bound at the block's
nearest cell. The bound falls with distance, so this is the block's maximum and covers every
cell in it (new). Terms under the cut `c` are dropped. Each kept term is rounded up to the next
2⁻⁴⁰ and stored as an integer. Removing an event subtracts exactly what it added, so the ledger
never drifts and an untouched block reads exactly zero (new).

**Ageing** (new): when an event's age crosses into the next bin, its terms are re-imprinted
from the new bin. Windows shrink as events age, which is the lattice version of the active set
Ω_ε of Theorem 3.1(v), rather than staying at their all-time size until retirement.

**Superposition**: the ledger sums envelopes pointwise. This is Proposition 4.2(b)'s first
alternative ("summing") applied cell by cell. It is never looser than summing masses over a
union of supports, and it handles Remark 4.3's ghost bridges without special cases.

## 5. The window, stored literally (new)

A block is in the window exactly when its ledger reaches `θ`. Only blocks in the window have
storage, and only they are stepped. Everywhere else the field is zero, which is precisely the
windowed solution of Theorem 6.5 (`v = 0` off the window). The theorem's error bound is the sup
of `u` outside the window. Outside, `u` is at most the ledger plus the dropped tails, the
retired pools and the far part. That is `B`.

So memory is proportional to the window, as well as work. A block that leaves the window is
audited on the way out: its largest value must sit under its ledger plus `B - θ`. The count of
failures is `Stats::violations`. It has been zero in every run.

## 6. Retirement and merging

**Retirement** (Theorem 6.7's `ρᵢ`): an event leaves the ledger once its whole future,
`min(h, A·peak(bin))`, fits in what is left of its district's pool. The pool is multiplied by
`1 - f` every step. That is valid because `‖Su‖∞ ≤ (1 - f)‖u‖∞`, so everything retired shrinks
at least that fast. Retirement is greedy: under light load events leave early.

**Merging** (Proposition 4.2, "one window for the summed event"): when a district holds more
than `C` live events, the oldest is merged with the partner whose enclosing disc grows least and
whose age is closest. The merged event takes the enclosing disc, the summed mass, the summed cap
and the younger age, each an upper bound. Old events have little left to bound, so merging them
is nearly free. Merges never produce a disc wider than 128 cells. Without fade, they never
produce a mass over 4096.

## 7. Districts: a bound that does not grow with the number of events (new)

Theorem 6.7 bounds the error by a sum over every event there has ever been. On an open world
with thousands of walkers that sum is the whole problem. Boxel keeps the tail and retirement
budgets per district of 1024 × 1024 cells. Each district has its own capacity `C` and its own
pool. A cell pays for the nine districts around its own:

```
B = θ + 9·(max events in a district · c + max pool) + far + dust + ρ,   c = (ε/5) / (9C)
```

An event's support stays within 128 cells of its district. So anything in a district that is
not a neighbour is at least 896 cells away, where the cone is below `E₀(896)`: 5·10⁻³⁴ for the
demo's moisture, 10⁻⁵⁴ for its glow. `far` is that number times the total mass ever deposited. It is tracked
exactly and must stay under a sliver of 10⁻⁶ ε. `dust` holds the pools of districts that
emptied and were dropped, still decaying. Without fade the exterior bound never decays, so the
field is a single district and the bound is the paper's.

## 8. Floating point, accounted for (new)

The theorems above are about exact arithmetic. A game runs in f32, and the table is built in
f64. Four facts carry the promise across, assuming IEEE-754 round-to-nearest. Rust never
contracts into fused multiply-adds on its own, and wasm forbids flush-to-zero.

1. **The weights the machine uses are the weights certified.** `Spec::weights` rounds the centre
   weight `1 - 4·spread - fade` *down* into f32, so the five weights the field steps with never
   sum past `1 - fade`. The scheme that runs fades at least as fast as the one specified, and
   the cone is computed from exactly these f32 weights.
2. **The table is an upper bound in f64.** A new kernel value is `c0·c + a·(((l + r) + u) + d)`
   over nonnegative numbers: five roundings on the longest path. While normal, each loses at
   most a factor `1 - 2⁻⁵³`; once subnormal, at most `2⁻¹⁰⁷⁵`. By induction over `n` steps, the
   exact kernel is at most the computed one times `(1 - 2⁻⁵³)^(-5n)`, plus `5n·2⁻¹⁰⁷⁵` times
   that. At the step limit, 2¹⁷, the factor is under `1 + 8·10⁻¹¹`. The stored headroom
   `1 + 10⁻⁹`, plus an absolute `10⁻³⁰⁰`, covers it, and covers the roundings of the headroom
   itself. The exterior factor `q` is found by Newton iteration from below on a rounded-down
   `cosh`, then raised by `1 + 10⁻¹²`. Its powers are raised the same way. Every number that
   only decays is rounded up as it decays: pools, dust, the rounding account. A ledger term is
   rounded up to the next 2⁻⁴⁰. A term is dropped only if it is under the cut by more than one
   part in 10¹², so a product that rounded down past the cut is still kept.
3. **The field never reads above the full computation, in floating point too.** The field and
   the reference apply the same f32 operations to the same inputs. Outside the window the
   field's inputs are zero, which is never larger. Rounding to nearest is monotone, and so are
   saturation, drains and the flush to zero. By induction `v̂ ≤ û` cell by cell, exactly.
4. **Rounding is a tracked term, not an assumption.** One step of either field rounds each new
   value by at most a factor `1 ± γ`, with `γ = 5.000001·2⁻²⁴` (one rounding, `2⁻²⁴`, without
   spread). Values are at most 1. A deposit or drain rounds a cell by at most `2⁻²⁴`: what it
   leaves is at most 1, or is clamped exactly. The flush to zero moves a value by at most
   `10⁻¹²`. The scheme contracts by `1 - fade` every step, so the gap from exact arithmetic is
   under the sum `ρ` defined by
   `ρ' = (1 - fade)·ρ + 2γ·(1 - fade) + 2·2⁻²⁴·m + 2·10⁻¹²`, where `m` is the most deposits and
   drains that reached any one block that step. `Field::rounding()` keeps `ρ` and `bound()`
   includes it. In steady state it is `2γ/fade` plus the deposit term: for the demo's fields
   about 3% to 6% of 1/255, inside the tenth of the tolerance it is given
   (`rounding_stays_inside_its_share`). A field that deposits on one block far faster than it
   fades will see `bound()` report more than the tolerance. Without fade, `ρ` grows without
   limit. Both are the paper's own caveats about undamped accumulation.

Together: `0 ≤ û - v̂ ≤ B`, with `û` the full computation in f32 and `v̂` the field. Fact 3 gives
the left side exactly. The right side is the exact-arithmetic theorem plus fact 4, since
`û - v̂ = (û - u) + (u - v) + (v - v̂)`. What remains assumed is the hardware and the compiler
honouring IEEE-754, which is the same assumption every float result makes. Interval
arithmetic over the table would remove the analysis in fact 2, at the price of directed
rounding, which Rust does not expose. That is the next step if a machine-checked certificate
is wanted.

## 9. Determinism (new)

Nothing at run time uses a transcendental function. The cone's exterior factor comes from
Newton iterations on a quadratic. Distances use integer square roots. The ledger is integer.
Field values go through the same f32 operations in the same order on every target, and Rust
never fuses them into FMAs on its own. A field is therefore a pure function of its spec and its
event history. The same 30-second session hashes to `0b94e72ee0ea0c34` on x86-64 with SSE2, on
x86-64 with AVX2 and FMA, and on wasm32 with SIMD128 (`boxel-bench replay`, `bench/replay.mjs`).

## 10. What is not covered

- **The step is fixed.** The cone is computed for one `(spread, fade)`. A host that wants time
  to run faster takes more steps. The paper's forcing invariance (Corollary 6.6) then holds
  trivially: forcing changes how many steps are taken, never their size.
- **Linear diffusion with linear dissipation, nonnegative deposits.** Saturation and drains are
  monotone and only lower the field, so they keep the bound. Advection, nonlinear reactions and
  negative sources are outside it, as in the paper's §9.
- **Without fade**, retired mass never decays, so a busy undamped field gradually keeps more
  events live. It stays certified and costs more, until the rounding account outgrows its
  share; `bound()` says when.
- **Quantized sleep** (Theorem 7.2) is not used. Inside the window every cell is stepped.
