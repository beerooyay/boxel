//! The usual way: step the cells that look busy and their neighbours, and nothing else.
//! Same storage as the grid, same arithmetic in the same order, no guarantee.

use boxel::Spec;

pub struct Guess {
    x0: i32,
    side: usize,
    now: Vec<f32>,
    fresh: Vec<f32>,
    active: Vec<u32>,
    next: Vec<u32>,
    mark: Vec<u8>,
    spread: f32,
    centre: f32,
    level: f32,
    pub stepped: u64,
}

impl Guess {
    /// The cells `[x0, x0 + side)` on both axes; a cell sleeps once it and its neighbours are under `level`.
    pub fn new(spec: Spec, x0: i32, side: usize) -> Guess {
        let w = side + 2;
        Guess {
            x0,
            side,
            now: vec![0.0; w * w],
            fresh: Vec::new(),
            active: Vec::new(),
            next: Vec::new(),
            mark: vec![0; w * w],
            spread: spec.spread,
            centre: 1.0 - 4.0 * spec.spread - spec.fade,
            level: spec.tolerance,
            stepped: 0,
        }
    }

    fn at(&self, x: i32, y: i32) -> Option<usize> {
        let (cx, cy) = (x - self.x0, y - self.x0);
        let s = self.side as i32;
        (cx >= 0 && cy >= 0 && cx < s && cy < s).then(|| (cy as usize + 1) * (self.side + 2) + cx as usize + 1)
    }

    fn wake(&mut self, i: usize) {
        let w = self.side + 2;
        for j in [i, i - 1, i + 1, i - w, i + w] {
            let (x, y) = (j % w, j / w);
            if x >= 1 && y >= 1 && x <= self.side && y <= self.side && self.mark[j] == 0 {
                self.mark[j] = 1;
                self.active.push(j as u32);
            }
        }
    }

    pub fn deposit(&mut self, x: i32, y: i32, r: u32, amount: f32) {
        let r = r as i32;
        for dy in -r..=r {
            let span = ((r * r - dy * dy) as u64).isqrt() as i32;
            for dx in -span..=span {
                if let Some(i) = self.at(x + dx, y + dy) {
                    self.now[i] = (self.now[i] + amount).min(1.0);
                    self.wake(i);
                }
            }
        }
    }

    pub fn step(&mut self) {
        let (w, a, c0) = (self.side + 2, self.spread, self.centre);
        self.fresh.clear();
        for &i in &self.active {
            let i = i as usize;
            let n = &self.now;
            let v = c0 * n[i] + a * (n[i - 1] + n[i + 1] + n[i - w] + n[i + w]);
            self.fresh.push(if v < 1e-12 { 0.0 } else { v });
        }
        for (k, &i) in self.active.iter().enumerate() {
            self.now[i as usize] = self.fresh[k];
            self.mark[i as usize] = 0;
        }
        self.stepped += self.active.len() as u64;
        // what stays busy, and its neighbours, is stepped next time
        std::mem::swap(&mut self.active, &mut self.next);
        self.active.clear();
        for k in 0..self.next.len() {
            let i = self.next[k] as usize;
            if self.now[i] > self.level {
                self.wake(i);
            }
        }
    }

    pub fn sample(&self, x: i32, y: i32) -> f32 {
        self.at(x, y).map_or(0.0, |i| self.now[i])
    }

    pub fn bytes(&self) -> usize {
        self.now.len() * 5
    }
}
