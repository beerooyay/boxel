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
            let bound = field.bound();
            let mut max_now = 0.0f64;
            for y in -192..192 {
                for x in -192..192 {
                    let (v, u) = (field.sample(x, y) as f64, grid.sample(x, y) as f64);
                    max_now = max_now.max((v - u).abs());
                    above = above.max(v - u);
                }
            }
            worst = worst.max(max_now);
            assert!(max_now <= bound, "step {s}: sampled error {max_now} exceeds reported bound {bound}");
            assert!(bound <= spec.tolerance as f64 + 1e-12, "bound {bound} over tolerance");
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

#[test]
fn amount_inputs_preserve_the_one_sided_field() {
    let mut f = Field::new(glow()).unwrap();
    let mut g = Grid::new(glow(), -16, -16, 32).unwrap();
    f.deposit(0, 0, 0, 0.25);
    g.deposit(0, 0, 0, 0.25);
    for a in [0.0, -1.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        f.deposit(1, 1, 0, a);
        g.deposit(1, 1, 0, a);
        f.drain(0, 0, 0, a);
        g.drain(0, 0, 0, a);
        f.rain(a);
        g.rain(a);
    }
    assert_eq!(f.stats().deposits, 1);
    assert_eq!(f.sample(0, 0), 0.25);
    assert_eq!(g.sample(0, 0), 0.25);
    assert_eq!(f.sample(1, 1), 0.0);
    assert_eq!(g.sample(1, 1), 0.0);
    for _ in 0..2 {
        f.rain(f32::MAX);
        g.rain(f32::MAX);
    }
    f.step();
    g.step();
    assert!(f.sheet().is_finite() && f.bound().is_finite());
    assert_eq!(f.sheet(), g.sheet());
}

#[test]
fn cell_limits_preserve_local_coordinates() {
    let (x, y) = (i32::MAX, i32::MIN);
    let mut edge = Field::new(glow()).unwrap();
    let mut local = Field::new(glow()).unwrap();
    let mut grid = Grid::new(glow(), x - 63, y, 64).unwrap();
    edge.deposit(x, y, 4, 0.75);
    local.deposit(-1, 0, 4, 0.75);
    grid.deposit(x, y, 4, 0.75);
    assert_eq!(grid.sample(x, y), 0.75);
    assert_eq!(grid.sample(i32::MIN, i32::MAX), 0.0);
    edge.drain(x, y, 1, 0.25);
    local.drain(-1, 0, 1, 0.25);
    for _ in 0..40 {
        edge.step();
        local.step();
        for j in 0..6 {
            for i in 0..6 {
                assert_eq!(edge.sample(x - i, y + j), local.sample(-1 - i, j));
            }
        }
    }
}

#[test]
fn retiring_an_overloaded_district_preserves_propagated_uncertainty() {
    let mut f = Field::new(Spec { events: 1, ..glow() }).unwrap();
    for y in [0, 400, 800] {
        for x in [0, 400, 800] {
            f.deposit(x, y, 0, 1e-6);
        }
    }
    let before = f.bound();
    assert!(before > f.spec().tolerance as f64);
    f.step();
    assert_eq!(f.live(), 0);
    assert!(f.bound() >= before * 0.99);
    for _ in 0..450 {
        f.step();
    }
    assert!(f.bound() < f.spec().tolerance as f64);
}
