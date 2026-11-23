//! The promise, checked against the full computation on random histories.

use boxel::{Error, Field, Grid, Spec};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    fn int(&mut self, lo: i32, hi: i32) -> i32 {
        lo + (self.next() * (hi - lo + 1) as f64) as i32
    }
}

struct Outcome {
    worst: f64,
    above: f64,
    field: Field,
}

/// Run the same history through a field and a grid, comparing well inside the grid, whose edge
/// holds the plane at zero.
fn run(spec: Spec, steps: usize, seed: u64, rain: bool) -> Outcome {
    let mut field = Field::new(spec).unwrap();
    let mut grid = Grid::new(spec, -256, -256, 512).unwrap();
    let mut rng = Rng(seed);
    let (mut worst, mut above) = (0.0f64, 0.0f64);
    for s in 0..steps {
        if s % 5 == 0 && s < steps * 2 / 3 {
            let (x, y) = (rng.int(-40, 40), rng.int(-40, 40));
            let (r, a) = (rng.int(0, 9) as u32, 0.1 + 0.9 * rng.next() as f32);
            field.deposit(x, y, r, a);
            grid.deposit(x, y, r, a);
        }
        if s % 97 == 0 {
            let (x, y) = (rng.int(-40, 40), rng.int(-40, 40));
            field.drain(x, y, 4, 0.3);
            grid.drain(x, y, 4, 0.3);
        }
        if rain && s == steps / 3 {
            field.rain(0.2);
            grid.rain(0.2);
        }
        field.step();
        grid.step();
        if s % 25 == 0 {
            for y in -192..192 {
                for x in -192..192 {
                    let (v, u) = (field.sample(x, y) as f64, grid.sample(x, y) as f64);
                    worst = worst.max((v - u).abs());
                    above = above.max(v - u);
                }
            }
            assert!(field.bound() <= spec.tolerance as f64 + 1e-12, "bound {} over tolerance", field.bound());
        }
    }
    Outcome { worst, above, field }
}

fn glow() -> Spec {
    Spec { spread: 8.0 / 60.0, fade: 0.3 / 60.0, tolerance: 1.0 / 255.0, events: 16 }
}

#[test]
fn glow_stays_within_tolerance() {
    let out = run(glow(), 3000, 1, false);
    let s = out.field.stats();
    assert!(s.merged > 0 && s.retired > 0, "the history should exercise merging and retirement: {s:?}");
    assert_eq!(s.violations, 0);
    assert!(out.worst <= glow().tolerance as f64, "worst error {}", out.worst);
    // the window only ever removes mass: the field never reads above the full computation
    assert!(out.above <= 0.0, "field above the grid by {}", out.above);
}

#[test]
fn slow_ground_with_rain_stays_within_tolerance() {
    let spec = Spec { spread: 0.2, fade: 0.04 / 15.0, tolerance: 1.0 / 255.0, events: 16 };
    let out = run(spec, 3000, 2, true);
    assert_eq!(out.field.stats().violations, 0);
    assert!(out.worst <= spec.tolerance as f64, "worst error {}", out.worst);
    assert!(out.above <= 0.0, "field above the grid by {}", out.above);
}

#[test]
fn still_fields_fade_in_place() {
    let spec = Spec { spread: 0.0, fade: 0.002, tolerance: 1.0 / 255.0, events: 8 };
    let out = run(spec, 4000, 3, false);
    assert_eq!(out.field.stats().violations, 0);
    assert!(out.worst <= spec.tolerance as f64, "worst error {}", out.worst);
}

#[test]
fn many_seeds_never_break_the_promise() {
    for seed in 10..16 {
        let spec = Spec { events: 4 + seed as usize % 5, ..glow() };
        let out = run(spec, 1200, seed, seed % 2 == 0);
        assert_eq!(out.field.stats().violations, 0, "seed {seed}");
        assert!(out.worst <= spec.tolerance as f64, "seed {seed}: worst error {}", out.worst);
    }
}

#[test]
fn work_stops_when_nothing_happens() {
    let mut field = Field::new(glow()).unwrap();
    field.deposit(0, 0, 3, 1.0);
    for _ in 0..20_000 {
        field.step();
    }
    assert_eq!(field.awake(), 0);
    assert_eq!(field.live(), 0);
    assert!(!field.freed().is_empty());
}

#[test]
fn far_apart_is_free() {
    // two events a hundred thousand cells apart cost what two events cost
    let mut near = Field::new(glow()).unwrap();
    let mut far = Field::new(glow()).unwrap();
    near.deposit(0, 0, 2, 1.0);
    near.deposit(40, 0, 2, 1.0);
    far.deposit(0, 0, 2, 1.0);
    far.deposit(100_000, -70_000, 2, 1.0);
    for _ in 0..30 {
        near.step();
        far.step();
    }
    assert!(far.awake() <= 2 * near.awake());
    assert!(far.sample(100_000, -70_000) > 0.0);
}

#[test]
fn unstable_specs_are_refused() {
    let bad = Spec { spread: 0.3, ..glow() };
    assert_eq!(Field::new(bad).err(), Some(Error::NotMonotone));
}
