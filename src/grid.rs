//! The full computation: every cell of a square region, every step.
//!
//! The dense reference applies the same stencil operations in the same order as the sparse
//! field. An omitted neighbor can influence later steps inside the active window. The
//! reference holds its own exterior at zero, so keep events well inside it when comparing.
//!
//! Uniform rain is kept as a sheet here too. A uniform field has zero laplacian, so stepping
//! it cell by cell and stepping it once give the same numbers; keeping it apart only spares
//! the reference from draining it out of its own edges. Deposits saturate the total at 1 and
//! drains take back what was deposited, exactly as in a field.

use alloc::vec;
use alloc::vec::Vec;

use crate::spec::{Error, Spec};

pub struct Grid {
    x0: i32,
    y0: i32,
    side: usize,
    /// Rows with a zero border all round, so the stencil never branches.
    now: Vec<f32>,
    next: Vec<f32>,
    spread: f32,
    centre: f32,
    sheet: f32,
}

#[inline(always)]
fn flush(v: f32) -> f32 {
    if v < 1e-12 { 0.0 } else { v }
}

impl Grid {
    /// The cells `[x0, x0 + side) × [y0, y0 + side)`.
    pub fn new(spec: Spec, x0: i32, y0: i32, side: usize) -> Result<Grid, Error> {
        spec.check()?;
        let w = side + 2;
        let (spread, centre) = spec.weights();
        Ok(Grid { x0, y0, side, now: vec![0.0; w * w], next: vec![0.0; w * w], spread, centre, sheet: 0.0 })
    }

    #[inline]
    fn at(&self, x: i64, y: i64) -> Option<usize> {
        let (cx, cy) = (x - i64::from(self.x0), y - i64::from(self.y0));
        let s = self.side as i64;
        (cx >= 0 && cy >= 0 && cx < s && cy < s).then(|| (cy as usize + 1) * (self.side + 2) + cx as usize + 1)
    }

    fn each_cell(&mut self, x: i32, y: i32, r: u32, mut f: impl FnMut(&mut f32)) {
        let (x, y, r) = (i64::from(x), i64::from(y), i64::from(r.min(crate::field::MAX_RADIUS)));
        for dy in -r..=r {
            let span = ((r * r - dy * dy) as u64).isqrt() as i64;
            for dx in -span..=span {
                if let Some(i) = self.at(x + dx, y + dy) {
                    f(&mut self.now[i]);
                }
            }
        }
    }

    pub fn deposit(&mut self, x: i32, y: i32, radius: u32, amount: f32) {
        if amount.is_finite() && amount > 0.0 {
            let amount = amount.min(1.0);
            let room = (1.0 - self.sheet).max(0.0);
            self.each_cell(x, y, radius, |v| *v = (*v + amount).min(room));
        }
    }

    pub fn drain(&mut self, x: i32, y: i32, radius: u32, amount: f32) {
        if amount.is_finite() && amount > 0.0 {
            self.each_cell(x, y, radius, |v| *v = (*v - amount).max(0.0));
        }
    }

    pub fn rain(&mut self, amount: f32) {
        if amount.is_finite() && amount > 0.0 {
            self.sheet = (self.sheet + amount).min(f32::MAX);
        }
    }

    pub fn sheet(&self) -> f32 {
        self.sheet
    }

    pub fn step(&mut self) {
        let (n, w, a, c0) = (self.side, self.side + 2, self.spread, self.centre);
        for y in 1..=n {
            let row = y * w;
            let (up, mid, down) = (&self.now[row - w..row], &self.now[row..row + w], &self.now[row + w..row + 2 * w]);
            let (l, c, r) = (&mid[..n], &mid[1..n + 1], &mid[2..n + 2]);
            let (u, d) = (&up[1..n + 1], &down[1..n + 1]);
            let out = &mut self.next[row + 1..row + 1 + n];
            for x in 0..n {
                out[x] = flush(c0 * c[x] + a * (l[x] + r[x] + u[x] + d[x]));
            }
        }
        core::mem::swap(&mut self.now, &mut self.next);
        let s = self.sheet;
        self.sheet = crate::spec::step_sheet(s, c0, a);
    }

    /// The field at a cell, sheet included.
    pub fn sample(&self, x: i32, y: i32) -> f32 {
        self.at(x.into(), y.into()).map_or(0.0, |i| self.now[i]) + self.sheet
    }

    /// Row `y` of the region, `side` cells from `x0`, without the sheet.
    pub fn row(&self, y: i32) -> &[f32] {
        let i = self.at(self.x0.into(), y.into()).expect("row inside the region");
        &self.now[i..i + self.side]
    }
}
