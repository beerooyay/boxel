//! What a field is: how fast it spreads, how fast it fades, how much error it may carry.

use core::fmt;

/// The four numbers that define a field, all per fixed step.
///
/// The field obeys the explicit scheme of the paper (eq. 6.1) on the integer lattice:
///
/// ```text
/// u' = (1 - 4·spread - fade)·u + spread·(sum of the four neighbours)
/// ```
///
/// which is the heat equation with dissipation, `∂u/∂t = D∆u - ku`, at `spread = D·τ/h²` and
/// `fade = k·τ` for a step `τ` and cells `h` wide. Every guarantee in this crate is about
/// that scheme, step for step, so the step must stay fixed: a host that wants time to run
/// faster takes more steps, never longer ones.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    /// Diffusion per step, in cells². Zero is allowed: the field then only fades in place.
    pub spread: f32,
    /// Fraction of the field lost per step.
    pub fade: f32,
    /// The promise: no cell ever differs from the full computation by more than this.
    pub tolerance: f32,
    /// Live events a district (1024 × 1024 cells) keeps before its two closest merge.
    pub events: usize,
}

impl Spec {
    /// The scheme for physical units: diffusivity `d` in m²/s, dissipation `k` in 1/s,
    /// cells `cell` metres wide and a step of `step` seconds.
    pub fn physical(d: f64, k: f64, cell: f64, step: f64, tolerance: f32) -> Spec {
        Spec { spread: (d * step / (cell * cell)) as f32, fade: (k * step) as f32, tolerance, events: 64 }
    }

    /// The weights the machine actually steps with. The centre weight is rounded down into
    /// f32, so the five weights never sum past `1 - fade`: the scheme the field runs fades at
    /// least as fast as the one the spec names, and every bound built from `fade` holds for it.
    pub(crate) fn weights(&self) -> (f32, f32) {
        let a = self.spread as f64;
        let real = 1.0 - 4.0 * a - self.fade as f64;
        // two roundings in f64 can raise `real` by a few units in the last place; step under them
        let target = real - real.abs() * 1e-15;
        let mut centre = target as f32;
        if centre as f64 > target {
            centre = centre.next_down();
        }
        (self.spread, centre.max(0.0))
    }

    pub(crate) fn check(&self) -> Result<(), Error> {
        let (a, f) = (self.spread as f64, self.fade as f64);
        if !(a >= 0.0 && f >= 0.0 && 4.0 * a + f <= 1.0) {
            return Err(Error::NotMonotone);
        }
        if !(self.tolerance > 0.0 && self.tolerance < 1.0) || self.events == 0 {
            return Err(Error::NoBudget);
        }
        Ok(())
    }
}

/// How the tolerance is spent. The first three parts are the three error sources of the
/// paper's Theorem 6.7. The fourth is what f32 arithmetic can add on top of exact arithmetic,
/// and the last covers what districts too far away to count can still reach. They always sum
/// to the whole.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Budget {
    /// A block outside the window holds less than this, by the ledger.
    pub window: f64,
    /// What live events may drop beyond the edges of their ledger footprints, together, at any cell.
    pub tails: f64,
    /// What retired events may still put on any cell, together.
    pub retired: f64,
    /// What rounding can move the field by, relative to exact arithmetic, in steady state.
    pub rounding: f64,
    /// What every event further than a district away may put on any cell, together.
    pub slack: f64,
}

impl Budget {
    pub fn split(tolerance: f64) -> Budget {
        let slack = tolerance * 1e-6;
        Budget {
            window: tolerance * 0.5,
            tails: tolerance * 0.2,
            retired: tolerance * 0.2 - slack,
            rounding: tolerance * 0.1,
            slack,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// `4·spread + fade > 1`: the scheme stops being a weighted average and no certificate holds.
    NotMonotone,
    /// The tolerance must be in (0, 1) and at least one event must fit.
    NoBudget,
    /// The field remembers too long to certify at this tolerance: give it some fade.
    NeverForgets,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::NotMonotone => "4·spread + fade must not exceed 1",
            Error::NoBudget => "the tolerance must be in (0, 1) with room for one event",
            Error::NeverForgets => "the field keeps events too long to certify; raise fade or tolerance",
        })
    }
}
