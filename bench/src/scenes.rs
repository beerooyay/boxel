//! The histories every engine is fed, in cells of 12.5 cm and frames of 1/60 s.

pub const FPS: f64 = 60.0;
pub const CELL: f64 = 0.125;

#[derive(Clone, Copy)]
pub struct Drop {
    pub frame: u32,
    pub x: i32,
    pub y: i32,
    pub r: u32,
    pub a: f32,
}

pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn cell(m: f64) -> i32 {
    (m / CELL).floor() as i32
}

/// A hiker circling the lake at 1.4 m/s, a footstep every half second, a stone into the
/// water every fifteen.
pub fn walk(seconds: f64, radius: f64) -> Vec<Drop> {
    let mut out = Vec::new();
    let mut rng = Rng(3);
    let (mut t, mut left) = (0.0, true);
    while t < seconds {
        let ang = t * 1.4 / radius;
        let wob = 1.0 + 0.08 * (t * 0.7).sin();
        let (cx, cz) = (radius * wob * ang.cos(), radius * wob * ang.sin());
        let side = if left { 0.15 } else { -0.15 };
        let frame = (t * FPS) as u32;
        out.push(Drop { frame, x: cell(cx + side * ang.cos()), y: cell(cz + side * ang.sin()), r: 2, a: 0.8 });
        left = !left;
        if (t / 15.0).fract() < 0.5 / 15.0 && t > 1.0 {
            let k = 0.4 + 0.2 * rng.next();
            out.push(Drop { frame, x: cell(cx * k), y: cell(cz * k), r: 6, a: 1.0 });
        }
        t += 0.5;
    }
    out
}

/// Spore rain: drops scattered over a square for `rain` seconds while the hiker walks.
pub fn storm(seconds: f64, rain: f64, rate: f64, half: f64) -> Vec<Drop> {
    let mut out = walk(seconds, 15.0);
    let mut rng = Rng(77);
    for frame in 0..(rain * FPS) as u32 {
        let mut p = rate / FPS;
        while p > 0.0 {
            if rng.next() < p.min(1.0) {
                let (x, z) = ((rng.next() * 2.0 - 1.0) * half, (rng.next() * 2.0 - 1.0) * half);
                out.push(Drop { frame, x: cell(x), y: cell(z), r: 1 + (rng.next() * 3.0) as u32, a: 0.5 });
            }
            p -= 1.0;
        }
    }
    out.sort_by_key(|d| d.frame);
    out
}

/// The paper's Remark 4.3 made sharp: 200 drops into one 2 m patch within a second.
pub fn burst() -> Vec<Drop> {
    let mut rng = Rng(5);
    (0..200)
        .map(|q| {
            let (rr, th) = (rng.next().sqrt(), rng.next() * std::f64::consts::TAU);
            Drop { frame: 30 + q * 60 / 200, x: cell(3.0 + rr * th.cos()), y: cell(-2.0 + rr * th.sin()), r: 2, a: 0.4 }
        })
        .collect()
}

/// Walkers on an open world `side` cells across, each starting somewhere random and wandering
/// at walking pace, a footstep every half second.
pub struct Crowd {
    walkers: Vec<[f64; 4]>,
    side: f64,
    rng: Rng,
}

impl Crowd {
    pub fn new(count: usize, side: i64, seed: u64) -> Crowd {
        let mut rng = Rng(seed);
        let side = side as f64;
        let walkers = (0..count)
            .map(|_| {
                [
                    rng.next() * side - side / 2.0,
                    rng.next() * side - side / 2.0,
                    rng.next() * std::f64::consts::TAU,
                    rng.next() * 0.5,
                ]
            })
            .collect();
        Crowd { walkers, side, rng }
    }

    /// Footsteps for one frame.
    pub fn frame(&mut self, out: &mut Vec<Drop>) {
        let dt = 1.0 / FPS;
        let speed = 1.4 / CELL;
        let half = self.side / 2.0;
        for w in &mut self.walkers {
            w[2] += (self.rng.next() - 0.5) * 0.6 * dt * 4.0;
            w[0] += w[2].cos() * speed * dt;
            w[1] += w[2].sin() * speed * dt;
            for k in 0..2 {
                if w[k].abs() > half - 64.0 {
                    w[k] = w[k].clamp(-half + 64.0, half - 64.0);
                    w[2] += std::f64::consts::PI;
                }
            }
            w[3] -= dt;
            if w[3] <= 0.0 {
                w[3] += 0.5;
                out.push(Drop { frame: 0, x: w[0].floor() as i32, y: w[1].floor() as i32, r: 2, a: 0.8 });
            }
        }
    }
}
