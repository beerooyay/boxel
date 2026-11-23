//! The full computation: every cell of a square region, every step.
//!
//! This is what a certified field promises to stay within tolerance of, so it uses the same
//! arithmetic in the same order: inside the window the two agree bit for bit, and any
//! difference between them is the window's doing and nothing else. Outside the region the
//! plane is held at zero, so keep events well inside it when comparing.
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
        Ok(Grid {
            x0,
            y0,
            side,
            now: vec![0.0; w * w],
            next: vec![0.0; w * w],
            spread: spec.spread,
            centre: 1.0 - 4.0 * spec.spread - spec.fade,
            sheet: 0.0,
        })
    }

    #[inline]
    fn at(&self, x: i32, y: i32) -> Option<usize> {
        let (cx, cy) = (x - self.x0, y - self.y0);
        let s = self.side as i32;
        (cx >= 0 && cy >= 0 && cx < s && cy < s).then(|| (cy as usize + 1) * (self.side + 2) + cx as usize + 1)
    }

    fn each_cell(&mut self, x: i32, y: i32, r: u32, mut f: impl FnMut(&mut f32)) {
        let r = r.min(crate::field::MAX_RADIUS) as i32;
        for dy in -r..=r {
            let span = ((r * r - dy * dy) as u64).isqrt() as i32;
            for dx in -span..=span {
                if let Some(i) = self.at(x + dx, y + dy) {
                    f(&mut self.now[i]);
                }
            }
        }
    }

    pub fn deposit(&mut self, x: i32, y: i32, radius: u32, amount: f32) {
        let amount = amount.min(1.0);
        if amount > 0.0 {
            let room = 1.0 - self.sheet;
            self.each_cell(x, y, radius, |v| *v = (*v + amount).min(room));
        }
    }

    pub fn drain(&mut self, x: i32, y: i32, radius: u32, amount: f32) {
        self.each_cell(x, y, radius, |v| *v = (*v - amount).max(0.0));
    }

    pub fn rain(&mut self, amount: f32) {
        if amount > 0.0 {
            self.sheet += amount;
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
        self.sheet = flush(c0 * s + a * (s + s + s + s));
    }

    /// The field at a cell, sheet included.
    pub fn sample(&self, x: i32, y: i32) -> f32 {
        self.at(x, y).map_or(0.0, |i| self.now[i]) + self.sheet
    }

    /// Row `y` of the region, `side` cells from `x0`, without the sheet.
    pub fn row(&self, y: i32) -> &[f32] {
        let i = self.at(self.x0, y).expect("row inside the region");
        &self.now[i..i + self.side]
    }

    pub fn origin(&self) -> (i32, i32) {
        (self.x0, self.y0)
    }

    pub fn side(&self) -> usize {
        self.side
    }
}
