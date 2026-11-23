//! The tolerance light cone of the lattice scheme, computed instead of bounded.
//!
//! An event of mass `A` deposited at the origin evolves as `A·Kₙ`, where `Kₙ` is the scheme's
//! point kernel after `n` steps. Everything the certificate needs is one number per cell and
//! age: the most `Kₙ` will ever put there from now on,
//!
//! ```text
//! Eₘ(z) = sup over n ≥ m of Kₙ(z)
//! ```
//!
//! The paper bounds this in closed form two ways. The continuum envelope (Theorem 5.1) is
//! tight but carries no proof on the lattice (Remark 6.10). The exponential diamond
//! (Theorem 6.4) is rigorous but certifies 10 to 40 times the cells that are ever touched
//! (Table 4), and nothing at all without dissipation. Open problems 2 and 3 ask for
//! something both tight and proved.
//!
//! For a fixed step there is a third way: run the scheme itself from a unit impulse and
//! record what it does. Four facts make the record a proof rather than a sample.
//!
//! 1. **Reflection only adds.** On the box `|z|∞ ≤ R` with reflecting walls, the solution is
//!    the free kernel plus its mirror images, all nonnegative, so inside the box it bounds
//!    the free kernel from above. The box is symmetric about the source, so a quadrant
//!    with mirrored axes computes it exactly.
//! 2. **Outside, a wall of exponentials.** Let `β` be the most the box ever shows on its
//!    outermost ring. Treat that ring as driven cells. For `q = e^-a` with
//!    `2·spread·(cosh a - 1) = fade`, each `β·q^(±zᵢ - R)` is a supersolution (Lemma 6.3a),
//!    so is their minimum (6.3c), it covers the ring, and the exterior starts empty. By
//!    comparison (Lemma 6.2) the free kernel is at most `β·q^(|z|∞ - R)` outside the box,
//!    forever. Without fade `q = 1` and the bound is the constant `β`.
//! 3. **The past bounds the future.** The scheme is a weighted average with weights summing
//!    to `1 - fade`, so `‖Kₙ‖∞` never grows. Once the box is under a floor at step `M`,
//!    every later step is too.
//! 4. **Shrinking only loosens.** Ages are binned geometrically and each bin keeps the bound
//!    for its first age; cells are folded into rings by integer distance with a running
//!    maximum outward. Any lower bound on age or distance then reads an upper bound.
//!
//! The box grows until `β` is under the floor, and the run continues until the whole box is.
//! The table holds for this step size only. That is the price of tightness, and it is why a
//! field never takes a step of any other length.

use alloc::vec;
use alloc::vec::Vec;

use crate::spec::Error;

/// Rounding, accounted for. Each new value is `c0·c + a·(((l + r) + u) + d)` over nonnegative
/// numbers: five roundings on the longest path, each losing at most a factor `1 - 2⁻⁵³` while
/// the result is normal, and at most `2⁻¹⁰⁷⁵` once it is subnormal. By induction over `n`
/// steps the exact kernel is at most the computed one times `(1 - 2⁻⁵³)^(-5n)`, plus
/// `5n·2⁻¹⁰⁷⁵` times that. At the step limit below the factor is under `1 + 8·10⁻¹¹`, so every
/// stored value is multiplied by `HEADROOM` and has `FLOOR` added, which covers both with room
/// for the roundings of those two operations themselves.
const HEADROOM: f64 = 1.0 + 1e-9;
const FLOOR: f64 = 1e-300;

/// No table is computed past this many steps: a field that still has visible mass after this
/// long fades too slowly to certify.
const MAX_STEPS: u32 = 1 << 17;

/// The quadrant is never grown past this half-width.
const MAX_RADIUS: usize = 2048;

pub struct Cone {
    /// First age of each bin, ascending, starting at 0.
    starts: Vec<u32>,
    /// `hull[bin * rings + ρ]`: the most the kernel will ever put on a cell at least `ρ` cells
    /// from the source, from the bin's first age on.
    hull: Vec<f64>,
    rings: usize,
    /// `β`: the most the box ever showed on its outermost ring.
    wall: f64,
    /// `q`: the exterior bound falls by this factor per cell beyond the box.
    falloff: f64,
    radius: u32,
}

impl Cone {
    /// The cone of the scheme with this `spread` and `fade`, computed until the kernel is
    /// under `floor` on and beyond the box, and at every later age. The centre weight
    /// `1 - 4·spread - fade` is rounded up, which can only raise the kernel.
    pub fn new(spread: f64, fade: f64, floor: f64) -> Result<Cone, Error> {
        Cone::weights(spread, (1.0 - 4.0 * spread - fade).next_up().next_up(), fade, floor)
    }

    /// The cone of the scheme with exactly these weights: `centre` on the cell itself and
    /// `spread` on each neighbour. `fade` must not exceed `1 - 4·spread - centre`; it sets how
    /// fast the bound outside the box falls off.
    pub fn weights(spread: f64, centre: f64, fade: f64, floor: f64) -> Result<Cone, Error> {
        if spread == 0.0 {
            return Cone::still(centre, floor);
        }
        let fade = fade.min(1.0 - 4.0 * spread - centre).max(0.0) * (1.0 - 1e-12);
        let mut radius = 24;
        loop {
            match Run::new(spread, centre, radius).go(floor, falloff(spread, fade)) {
                Ok(cone) => return Ok(cone),
                Err(Short::Wall) if radius < MAX_RADIUS => radius += radius / 2,
                Err(_) => return Err(Error::NeverForgets),
            }
        }
    }

    /// Without spread an event never leaves its cells; it fades in place by `keep` a step.
    fn still(keep: f64, floor: f64) -> Result<Cone, Error> {
        let (mut starts, mut hull) = (Vec::new(), Vec::new());
        let (mut age, mut peak) = (0u32, 1.0f64);
        while peak > floor {
            if age >= MAX_STEPS || keep >= 1.0 {
                return Err(Error::NeverForgets);
            }
            starts.push(age);
            hull.push(peak * HEADROOM + FLOOR);
            let next = next_start(age);
            for _ in age..next {
                peak *= keep;
            }
            age = next;
        }
        starts.push(age);
        hull.push(peak * HEADROOM + FLOOR);
        Ok(Cone { starts, hull, rings: 1, wall: 0.0, falloff: 0.0, radius: 0 })
    }

    /// The age bin holding `age`.
    pub fn bin(&self, age: u64) -> usize {
        let age = age.min(u32::MAX as u64) as u32;
        self.starts.partition_point(|&s| s <= age) - 1
    }

    /// The age at which the bin after `bin` begins, if there is one.
    pub fn next_start(&self, bin: usize) -> Option<u32> {
        self.starts.get(bin + 1).copied()
    }

    /// The most a unit impulse of an age in `bin` will ever put on a cell `ρ` or more cells
    /// away. Non-increasing in both arguments.
    #[inline]
    pub fn envelope(&self, bin: usize, rho: u32) -> f64 {
        if (rho as usize) < self.rings { self.hull[bin * self.rings + rho as usize] } else { self.outside(rho) }
    }

    /// The most it will ever put on any cell at all: its sup norm from this age on.
    #[inline]
    pub fn peak(&self, bin: usize) -> f64 {
        self.hull[bin * self.rings]
    }

    pub fn bins(&self) -> usize {
        self.starts.len()
    }

    /// Lattice cells a point event of `mass` is certified never to push above `level`.
    pub fn footprint(&self, mass: f64, level: f64) -> u64 {
        let mut reach = 0u32;
        while mass * self.envelope(0, reach) > level {
            reach += 1;
        }
        let r = reach as i64;
        let mut count = 0;
        for y in -r..=r {
            for x in -r..=r {
                if mass * self.envelope(0, ((x * x + y * y) as u64).isqrt() as u32) > level {
                    count += 1;
                }
            }
        }
        count
    }

    /// The exterior bound `β·q^(|z|∞ - R)` at the nearest exterior cell no closer than `ρ`.
    fn outside(&self, rho: u32) -> f64 {
        // the smallest |z|∞ among cells with |z| ≥ ρ is ⌈ρ/√2⌉
        let sq = rho as u64 * rho as u64;
        let mut t = sq.div_ceil(2).isqrt();
        if 2 * t * t < sq {
            t += 1;
        }
        let beyond = t.saturating_sub(self.radius as u64).max(1);
        // at most 128 roundings in the power and one in the product
        self.wall * pow(self.falloff, beyond) * (1.0 + 1e-12)
    }
}

fn pow(mut base: f64, mut exp: u64) -> f64 {
    let mut out = 1.0;
    while exp > 0 && out > 0.0 {
        if exp & 1 == 1 {
            out *= base;
        }
        base *= base;
        exp >>= 1;
    }
    out
}

/// `q = e^-a` for the steepest exponential `2·spread·(cosh a - 1) ≤ fade` allows:
/// the smaller root of `q² - 2cq + 1` with `c = cosh a`, rounded up. A smaller `c` gives a
/// larger root, so `c` is rounded down first.
fn falloff(spread: f64, fade: f64) -> f64 {
    let c = (1.0 + fade / (2.0 * spread)).next_down().next_down();
    if c <= 1.0 {
        return 1.0;
    }
    // Newton from zero climbs monotonically to the smaller root
    let mut q = 0.0f64;
    for _ in 0..200 {
        let step = (q * q - 2.0 * c * q + 1.0) / (2.0 * c - 2.0 * q);
        q += step;
        if step <= q * 1e-17 {
            break;
        }
    }
    (q * (1.0 + 1e-12)).min(1.0)
}

/// Bins grow by a quarter: an event re-imprints its ledger about ten times per tenfold of age.
fn next_start(age: u32) -> u32 {
    (age + age / 4).max(age + 1)
}

/// Why a run gave up: the kernel reached the wall, or outlived the step limit.
enum Short {
    Wall,
    Time,
}

/// One attempt at the table on a quadrant of half-width `radius`, with a ghost layer all
/// round so the stencil never branches: the inner ghosts mirror through the axes, the outer
/// ghosts copy the wall.
struct Run {
    radius: usize,
    width: usize,
    now: Vec<f64>,
    next: Vec<f64>,
    spread: f64,
    centre: f64,
}

impl Run {
    fn new(spread: f64, centre: f64, radius: usize) -> Run {
        let width = radius + 3;
        let mut now = vec![0.0; width * width];
        now[width + 1] = 1.0;
        Run { radius, width, next: now.clone(), now, spread, centre }
    }

    #[inline]
    fn at(&self, x: usize, y: usize) -> usize {
        (y + 1) * self.width + x + 1
    }

    fn ghosts(&mut self) {
        let (r, w) = (self.radius, self.width);
        for y in 0..=r {
            let row = (y + 1) * w;
            self.now[row] = self.now[row + 2];
            self.now[row + r + 2] = self.now[row + r + 1];
        }
        let (below, top) = (self.at(0, 1) - 1, self.at(0, r) - 1);
        self.now.copy_within(below..below + w, 0);
        self.now.copy_within(top..top + w, (r + 2) * w);
    }

    /// One step over the part of the quadrant the kernel can have reached by `age` (an
    /// impulse moves at most a cell a step), folding the new values into `best`.
    fn step(&mut self, age: usize, best: &mut [f64]) {
        self.ghosts();
        let (r, w) = (self.radius, self.width);
        let (a, c0) = (self.spread, self.centre);
        let n = r.min(age + 1) + 1;
        for y in 0..n {
            let row = (y + 1) * w;
            let (up, mid, down) = (&self.now[row - w..row], &self.now[row..row + w], &self.now[row + w..row + 2 * w]);
            let (left, centre, right) = (&mid[..n], &mid[1..n + 1], &mid[2..n + 2]);
            let (up, down) = (&up[1..n + 1], &down[1..n + 1]);
            let out = &mut self.next[row + 1..row + 1 + n];
            for x in 0..n {
                out[x] = c0 * centre[x] + a * (left[x] + right[x] + up[x] + down[x]);
            }
            for (b, &v) in best[y * (r + 1)..y * (r + 1) + n].iter_mut().zip(out.iter()) {
                if v > *b {
                    *b = v;
                }
            }
        }
        core::mem::swap(&mut self.now, &mut self.next);
    }

    /// The most the outermost ring holds now.
    fn wall(&self) -> f64 {
        let r = self.radius;
        let mut edge = 0.0f64;
        for y in 0..r {
            edge = edge.max(self.now[self.at(r, y)]);
        }
        for &v in &self.now[self.at(0, r)..=self.at(r, r)] {
            edge = edge.max(v);
        }
        edge
    }

    /// The most anywhere. The kernel peaks at the source, so this only runs once the source
    /// itself is under the floor.
    fn top(&self) -> f64 {
        let mut all = 0.0f64;
        for &v in &self.now {
            if v > all {
                all = v;
            }
        }
        all
    }

    fn go(mut self, floor: f64, falloff: f64) -> Result<Cone, Short> {
        let r = self.radius;
        let side = r + 1;
        let rings = ((2 * r * r) as u64).isqrt() as usize + 1;
        let ring: Vec<u32> =
            (0..side * side).map(|q| (((q % side).pow(2) + (q / side).pow(2)) as u64).isqrt() as u32).collect();
        let mut starts = vec![0u32];
        let mut bins: Vec<Vec<f64>> = Vec::new();
        let mut best = vec![0.0f64; side * side];
        best[0] = 1.0;
        let close = |best: &mut Vec<f64>, bins: &mut Vec<Vec<f64>>| {
            let mut most = vec![0.0f64; rings];
            for (q, &v) in best.iter().enumerate() {
                let k = ring[q] as usize;
                most[k] = most[k].max(v);
            }
            bins.push(most);
            best.fill(0.0);
        };
        let (mut wall, mut age, mut until) = (0.0f64, 0u32, next_start(0));
        let flat = loop {
            if age >= MAX_STEPS {
                return Err(Short::Time);
            }
            if age + 1 == until {
                close(&mut best, &mut bins);
                starts.push(until);
                until = next_start(until);
            }
            self.step(age as usize, &mut best);
            age += 1;
            wall = wall.max(self.wall());
            if wall > floor {
                return Err(Short::Wall);
            }
            if self.now[self.at(0, 0)] <= floor {
                let all = self.top();
                if all <= floor {
                    close(&mut best, &mut bins);
                    break all;
                }
            }
        };
        // after the horizon nothing in the box exceeds `flat`, and the wall saw no more either
        let wall = wall.max(flat);
        let mut cone = Cone {
            starts,
            hull: vec![0.0; bins.len() * rings],
            rings,
            wall: wall * HEADROOM + FLOOR,
            falloff,
            radius: r as u32,
        };
        // from bin j on: the max over that bin and every later one (suffix in age), at every
        // ring at least as far (suffix in distance), never below what the box can hold past
        // the horizon or what the exterior bound allows at that distance
        let mut later = vec![0.0f64; rings];
        for (j, most) in bins.iter().enumerate().rev() {
            let mut outward = 0.0f64;
            for k in (0..rings).rev() {
                later[k] = later[k].max(most[k]);
                outward = outward.max(later[k]);
                let exterior = cone.outside(k as u32);
                cone.hull[j * rings + k] = outward.max(flat).max(exterior) * HEADROOM + FLOOR;
            }
        }
        Ok(cone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_shrinks_with_age_and_distance() {
        let cone = Cone::new(0.13, 0.005, 1e-7).unwrap();
        for j in 1..cone.bins() {
            for rho in 0..200 {
                assert!(cone.envelope(j, rho) <= cone.envelope(j - 1, rho));
                assert!(cone.envelope(j, rho + 1) <= cone.envelope(j, rho));
            }
        }
        assert!(cone.peak(0) >= 1.0);
    }

    #[test]
    fn still_fields_fade_in_place() {
        let cone = Cone::new(0.0, 0.01, 1e-4).unwrap();
        assert_eq!(cone.envelope(0, 1), 0.0);
        assert!(cone.peak(cone.bins() - 1) <= 1e-4 * HEADROOM + FLOOR);
    }

    #[test]
    fn falloff_is_the_steepest_admissible_exponential() {
        let (a, f) = (0.13, 0.005);
        let q = falloff(a, f);
        // 2a(cosh s - 1) = f at s = -ln q, i.e. a(q + 1/q - 2) = f
        let lhs = a * (q + 1.0 / q - 2.0);
        assert!((lhs - f).abs() < 1e-12 && lhs <= f * (1.0 + 1e-9));
    }
}
