//! The measurements behind docs/results.md.
//!
//!   cargo run --release -p boxel-bench -- acre      the game's fields: certified, dense, guessing
//!   cargo run --release -p boxel-bench -- world     open worlds: walkers × world size
//!   cargo run --release -p boxel-bench -- cone      the paper's Tables 2 and 4, certified on the lattice
//!   cargo run --release -p boxel-bench -- replay    a session's hash and bytes, to compare with wasm
//!
//! Every engine gets the same history, frame by frame, at 60 frames a second.

mod guess;
mod scenes;

use std::time::Instant;

use boxel::{Field, Grid, Spec};
use guess::Guess;
use scenes::{Crowd, Drop, FPS};

/// Bioluminescence: D = 8 cells²/s, k = 0.3/s, stepped every frame.
fn glow() -> Spec {
    Spec { spread: 8.0 / 60.0, fade: 0.3 / 60.0, tolerance: 1.0 / 255.0, events: 64 }
}

/// Moisture: D = 3 cells²/s, k = 0.04/s, stepped every fourth frame.
fn ground() -> Spec {
    Spec { spread: 0.2, fade: 0.04 / 15.0, tolerance: 1.0 / 255.0, events: 64 }
}

fn main() {
    let what = std::env::args().nth(1).unwrap_or_default();
    match what.as_str() {
        "acre" => acre(),
        "world" => world(),
        "cores" => cores(),
        "cone" => cone(),
        "replay" => replay(),
        _ => eprintln!("usage: boxel-bench acre | world | cone | replay"),
    }
}

// ---- acre: one lake shore, three engines ------------------------------------------------------

fn acre() {
    let scenes: [(&str, Vec<Drop>, f64, Spec, u32); 4] = [
        ("walk, glow", scenes::walk(90.0, 15.0), 90.0, glow(), 1),
        ("walk, moisture", scenes::walk(90.0, 15.0), 90.0, ground(), 4),
        ("storm, glow", scenes::storm(60.0, 30.0, 25.0, 30.0), 60.0, glow(), 1),
        ("burst, glow", scenes::burst(), 30.0, glow(), 1),
    ];
    println!(
        "| scene | engine | ms / frame | cells stepped / frame | max error | 8-bit levels | violations | peak blocks | memory |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");
    for (name, drops, seconds, spec, every) in scenes {
        let frames = (seconds * FPS) as u32;
        // accuracy: all three side by side against a grid twice the acre's width
        let mut field = Field::new(spec).unwrap();
        let mut guess = Guess::new(spec, -512, 1024);
        let mut truth = Grid::new(spec, -512, -512, 1024).unwrap();
        let (mut err_field, mut err_guess) = (0.0f64, 0.0f64);
        let mut q = 0;
        for frame in 0..frames {
            while q < drops.len() && drops[q].frame == frame {
                let d = drops[q];
                field.deposit(d.x, d.y, d.r, d.a);
                guess.deposit(d.x, d.y, d.r, d.a);
                truth.deposit(d.x, d.y, d.r, d.a);
                q += 1;
            }
            if frame % every == 0 {
                field.step();
                guess.step();
                truth.step();
            }
            if frame % 15 == 0 {
                for y in -256..256 {
                    for x in -256..256 {
                        let u = truth.sample(x, y) as f64;
                        err_field = err_field.max((field.sample(x, y) as f64 - u).abs());
                        err_guess = err_guess.max((guess.sample(x, y) as f64 - u).abs());
                    }
                }
            }
        }
        let s = field.stats();
        let levels = |e: f64| (e * 255.0).ceil() as u32;
        // speed: each engine alone, the dense one over just the acre, as a game would run it
        let t_field = time(
            &drops,
            frames,
            every,
            || Field::new(spec).unwrap(),
            |f, d| f.deposit(d.x, d.y, d.r, d.a),
            |f| f.step(),
        );
        let t_dense = time(
            &drops,
            frames,
            every,
            || Grid::new(spec, -256, -256, 512).unwrap(),
            |g, d| g.deposit(d.x, d.y, d.r, d.a),
            |g| g.step(),
        );
        let t_guess = time(
            &drops,
            frames,
            every,
            || Guess::new(spec, -256, 512),
            |g, d| g.deposit(d.x, d.y, d.r, d.a),
            |g| g.step(),
        );
        let mut g2 = Guess::new(spec, -256, 512);
        let mut q = 0;
        for frame in 0..frames {
            while q < drops.len() && drops[q].frame == frame {
                g2.deposit(drops[q].x, drops[q].y, drops[q].r, drops[q].a);
                q += 1;
            }
            if frame % every == 0 {
                g2.step();
            }
        }
        let steps = frames.div_ceil(every) as f64;
        let per = |cells: f64| cells * steps / frames as f64;
        println!("| {name} | dense | {t_dense:.3} | {:.0} | 0 | 0 | | | {} |", per(512.0 * 512.0), kb(512 * 512 * 8));
        println!(
            "| | guessing | {t_guess:.3} | {:.0} | {err_guess:.5} | {} | | | {} |",
            g2.stepped as f64 / frames as f64,
            levels(err_guess),
            kb(g2.bytes())
        );
        println!(
            "| | **boxel** | **{t_field:.3}** | {:.0} | {err_field:.5} | {} | {} | {} | {} |",
            s.stepped as f64 / frames as f64,
            levels(err_field),
            s.violations,
            s.peak_blocks,
            kb(peak_bytes(&drops, frames, every, spec))
        );
    }
}

/// Milliseconds per frame of one engine alone on a history, the best of three runs.
fn time<E>(
    drops: &[Drop],
    frames: u32,
    every: u32,
    make: impl Fn() -> E,
    deposit: impl Fn(&mut E, &Drop),
    step: impl Fn(&mut E),
) -> f64 {
    let mut best = f64::INFINITY;
    for _ in 0..3 {
        let mut e = make();
        let t0 = Instant::now();
        let mut q = 0;
        for frame in 0..frames {
            while q < drops.len() && drops[q].frame == frame {
                deposit(&mut e, &drops[q]);
                q += 1;
            }
            if frame % every == 0 {
                step(&mut e);
            }
        }
        best = best.min(t0.elapsed().as_secs_f64() * 1e3 / frames as f64);
    }
    best
}

fn peak_bytes(drops: &[Drop], frames: u32, every: u32, spec: Spec) -> usize {
    let mut f = Field::new(spec).unwrap();
    let (mut q, mut most) = (0, 0);
    for frame in 0..frames {
        while q < drops.len() && drops[q].frame == frame {
            f.deposit(drops[q].x, drops[q].y, drops[q].r, drops[q].a);
            q += 1;
        }
        if frame % every == 0 {
            f.step();
        }
        most = most.max(f.bytes());
    }
    most
}

fn kb(bytes: usize) -> String {
    if bytes >= 10 << 20 {
        format!("{:.0} MB", bytes as f64 / (1 << 20) as f64)
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

// ---- world: walkers on open worlds -------------------------------------------------------------

/// Walkers on an open world: glow with room for crowds, 1024 live events per district.
fn trails() -> Spec {
    Spec { events: 1024, ..glow() }
}

struct Open {
    ms: f64,
    blocks: f64,
    bytes: usize,
    bound: f64,
    violations: u64,
    merged: u64,
    deposits: u64,
}

fn crowd(side: i64, walkers: usize, seconds: f64) -> Open {
    crowd_on(side, walkers, seconds, None).0
}

/// The crowd on a given number of threads (the build's default when `None`), and a hash of the
/// field it ends with.
fn crowd_on(side: i64, walkers: usize, seconds: f64, threads: Option<usize>) -> (Open, u64) {
    let mut field = Field::new(trails()).unwrap();
    #[cfg(feature = "parallel")]
    if let Some(n) = threads {
        field.set_threads(n);
    }
    #[cfg(not(feature = "parallel"))]
    let _ = threads;
    let mut people = Crowd::new(walkers, side, 9);
    let mut drops = Vec::new();
    let frames = (seconds * FPS) as u32;
    let settle = frames / 2;
    let (mut ms, mut blocks, mut bytes, mut bound) = (0.0, 0.0, 0usize, 0.0f64);
    for frame in 0..frames {
        drops.clear();
        people.frame(&mut drops);
        let t0 = Instant::now();
        for d in &drops {
            field.deposit(d.x, d.y, d.r, d.a);
        }
        field.step();
        if frame >= settle {
            ms += t0.elapsed().as_secs_f64() * 1e3;
            blocks += field.awake() as f64;
        }
        bytes = bytes.max(field.bytes());
        bound = bound.max(field.bound());
    }
    let n = (frames - settle) as f64;
    let s = field.stats();
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for (bx, by, values) in field.blocks() {
        for v in [bx as u32, by as u32].into_iter().chain(values.iter().map(|v| v.to_bits())) {
            hash = (hash ^ v as u64).wrapping_mul(0x100_0000_01b3);
        }
    }
    let open = Open {
        ms: ms / n,
        blocks: blocks / n,
        bytes,
        bound,
        violations: s.violations,
        merged: s.merged,
        deposits: s.deposits,
    };
    (open, hash)
}

fn world() {
    // what the full computation costs per cell: the best of five runs of a 2048² grid
    let mut ns = f64::INFINITY;
    for _ in 0..5 {
        let mut g = Grid::new(glow(), 0, 0, 2048).unwrap();
        g.deposit(1024, 1024, 8, 1.0);
        let t0 = Instant::now();
        for _ in 0..40 {
            g.step();
        }
        ns = ns.min(t0.elapsed().as_secs_f64() * 1e9 / (40.0 * 2048.0 * 2048.0));
    }
    println!("dense: {ns:.3} ns per cell per step\n");
    let metres = |side: i64| side as f64 * scenes::CELL;
    println!(
        "| world | walkers | boxel ms / frame | blocks awake | memory | dense ms / frame (extrapolated) | dense memory (extrapolated) | bound / tolerance | violations |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");
    let row = |side: i64, walkers: usize, seconds: f64| {
        let o = crowd(side, walkers, seconds);
        let cells = (side * side) as f64;
        println!(
            "| {:.0} m | {walkers} | {:.3} | {:.0} | {} | {:.0} | {} | {:.4} | {} |",
            metres(side),
            o.ms,
            o.blocks,
            kb(o.bytes),
            cells * ns / 1e6,
            kb((cells * 8.0) as usize),
            o.bound / trails().tolerance as f64,
            o.violations
        );
        eprintln!("  {side} cells, {walkers} walkers: {} deposits, {} merges", o.deposits, o.merged);
    };
    for side in [1i64 << 11, 1 << 13, 1 << 15, 1 << 17] {
        row(side, 1000, 30.0);
    }
    for walkers in [10, 100, 10_000] {
        row(1 << 15, walkers, 30.0);
    }
    // and the promise at scale: a thousand walkers on a quarter kilometre, against the full grid
    let (side, walkers) = (2048i64, 1000usize);
    let mut field = Field::new(trails()).unwrap();
    let mut truth = Grid::new(trails(), -1024, -1024, 2048).unwrap();
    let mut people = Crowd::new(walkers, side - 256, 4);
    let mut drops = Vec::new();
    let mut worst = 0.0f64;
    for frame in 0..(20.0 * FPS) as u32 {
        drops.clear();
        people.frame(&mut drops);
        for d in &drops {
            field.deposit(d.x, d.y, d.r, d.a);
            truth.deposit(d.x, d.y, d.r, d.a);
        }
        field.step();
        truth.step();
        if frame % 60 == 59 {
            for y in -1024..1024 {
                for x in -1024..1024 {
                    worst = worst.max((field.sample(x, y) - truth.sample(x, y)).abs() as f64);
                }
            }
        }
    }
    println!(
        "\n{walkers} walkers on {:.0} m for 20 s against the full grid: max error {worst:.5} ({:.2} of the tolerance), {} violations",
        metres(side),
        worst / glow().tolerance as f64,
        field.stats().violations
    );
}

// ---- cores: the same crowds on one thread and on all of them ---------------------------------

#[cfg(feature = "parallel")]
fn cores() {
    let all = std::thread::available_parallelism().map_or(1, |n| n.get());
    println!(
        "| world | walkers | blocks awake | 1 thread, ms / frame | {all} threads, ms / frame | speedup | same bits |"
    );
    println!("|---|---|---|---|---|---|---|");
    for (side, walkers) in [(1i64 << 13, 1000usize), (1 << 15, 1000), (1 << 15, 4000), (1 << 15, 10_000)] {
        let (one, h1) = crowd_on(side, walkers, 20.0, Some(1));
        let (many, hn) = crowd_on(side, walkers, 20.0, Some(all));
        println!(
            "| {:.0} m | {walkers} | {:.0} | {:.2} | {:.2} | {:.2}× | {} |",
            side as f64 * scenes::CELL,
            one.blocks,
            one.ms,
            many.ms,
            one.ms / many.ms,
            if h1 == hn { "yes" } else { "NO" }
        );
    }
}

#[cfg(not(feature = "parallel"))]
fn cores() {
    eprintln!("cores compares threads: build with --features parallel");
}

// ---- cone: the paper's lattice footprints, certified -------------------------------------------

fn cone() {
    let (spread, mass, eps) = (0.2f64, 9.0f64, 1.0f64 / 255.0);
    println!(
        "| k | cells ever above ε (measured) | paper | computed cone (certified) | diamond, Thm 6.4 (certified) | continuum, Thm 3.1/5.1 (not a lattice proof) |"
    );
    println!("|---|---|---|---|---|---|");
    for (k, paper) in [(0.0, "845"), (0.002, "577"), (0.02, "241")] {
        let measured = lattice_footprint(spread, k, mass, eps);
        let t0 = Instant::now();
        let c = boxel::Cone::new(spread, k, eps / mass / 4.0).unwrap();
        let ms = t0.elapsed().as_secs_f64() * 1e3;
        let certified = c.footprint(mass, eps);
        let diamond = if k > 0.0 {
            let a = (1.0 + k / (4.0 * spread)).acosh();
            let r = (mass / eps).ln() / a;
            let n = r.floor() as i64;
            format!("{} ({:.0}×)", 2 * n * n + 2 * n + 1, (2 * n * n + 2 * n + 1) as f64 / measured as f64)
        } else {
            "none".into()
        };
        let continuum = continuum_footprint(spread, k, mass, eps);
        println!(
            "| {k} | {measured} | {paper} | **{certified}** ({:.2}×, {ms:.0} ms) | {diamond} | {continuum:.1} |",
            certified as f64 / measured as f64
        );
    }
}

/// Run a point event on the lattice until it is under 10⁻³ε everywhere, the paper's criterion,
/// and count the cells whose running maximum went above ε.
fn lattice_footprint(spread: f64, k: f64, mass: f64, eps: f64) -> usize {
    let n = 161usize;
    let c = n / 2;
    let (mut u, mut v, mut best) = (vec![0.0f64; n * n], vec![0.0f64; n * n], vec![0.0f64; n * n]);
    u[c * n + c] = mass;
    let c0 = 1.0 - 4.0 * spread - k;
    loop {
        let mut top = 0.0f64;
        for y in 1..n - 1 {
            for x in 1..n - 1 {
                let i = y * n + x;
                v[i] = c0 * u[i] + spread * (u[i - 1] + u[i + 1] + u[i - n] + u[i + n]);
                best[i] = best[i].max(v[i]);
                top = top.max(v[i]);
            }
        }
        std::mem::swap(&mut u, &mut v);
        if top < 1e-3 * eps {
            break;
        }
    }
    best[c * n + c] = mass;
    best.iter().filter(|&&b| b > eps).count()
}

/// π R² for the continuum radius where the point envelope reaches ε (Theorem 5.1).
fn continuum_footprint(d: f64, k: f64, mass: f64, eps: f64) -> f64 {
    let env = |r: f64| {
        let t = if k > 0.0 { ((1.0f64 + r * r * k / d).sqrt() - 1.0) / (2.0 * k) } else { r * r / (4.0 * d) };
        mass * (-k * t - r * r / (4.0 * d * t)).exp() / (4.0 * std::f64::consts::PI * d * t)
    };
    let (mut lo, mut hi) = (0.01, 1000.0);
    for _ in 0..200 {
        let mid = (lo + hi) / 2.0;
        if env(mid) > eps { lo = mid } else { hi = mid }
    }
    std::f64::consts::PI * lo * lo
}

// ---- replay: the same session, bit for bit, anywhere -------------------------------------------

fn replay() {
    let drops = scenes::storm(30.0, 20.0, 25.0, 30.0);
    let path = std::env::args().nth(2).unwrap_or_else(|| "replay.json".into());
    let spec = glow();
    // numbers travel as f32 bit patterns, so nothing is rounded twice on the way
    let bits = |v: f32| v.to_bits();
    let script: Vec<String> =
        drops.iter().map(|d| format!("[{},{},{},{},{}]", d.frame, d.x, d.y, d.r, bits(d.a))).collect();
    let mut field = Field::new(spec).unwrap();
    let (mut q, mut moved) = (0, 0u64);
    for frame in 0..(30.0 * FPS) as u32 {
        while q < drops.len() && drops[q].frame == frame {
            let d = drops[q];
            field.deposit(d.x, d.y, d.r, d.a);
            q += 1;
        }
        if frame == 600 {
            field.rain(0.1);
        }
        field.step();
        moved += field.awake() as u64 + field.freed().len() as u64;
        field.forget_freed();
    }
    let mut blocks: Vec<(i32, i32, &[f32; 256])> = field.blocks().collect();
    blocks.sort_by_key(|b| (b.1, b.0));
    let mut h = Fnv::new();
    for (x, y, v) in &blocks {
        h.eat(&x.to_le_bytes());
        h.eat(&y.to_le_bytes());
        for f in v.iter() {
            h.eat(&f.to_bits().to_le_bytes());
        }
    }
    h.eat(&field.sheet().to_bits().to_le_bytes());
    std::fs::write(
        &path,
        format!(
            "{{\"spec\":[{},{},{},{}],\"rain\":[600,{}],\"frames\":{},\"drops\":[{}],\"hash\":\"{:016x}\"}}",
            bits(spec.spread),
            bits(spec.fade),
            bits(spec.tolerance),
            spec.events,
            bits(0.1),
            (30.0 * FPS) as u32,
            script.join(","),
            h.0
        ),
    )
    .unwrap();
    println!("native: {} blocks, hash {:016x}", blocks.len(), h.0);
    let event_bytes = drops.len() as f64 * 13.0 / 30.0;
    let state_bytes = moved as f64 * 256.0 / 30.0;
    println!(
        "events: {event_bytes:.0} bytes/s; the same state sent as 8-bit tiles: {state_bytes:.0} bytes/s ({:.0}x)",
        state_bytes / event_bytes
    );
}

struct Fnv(u64);

impl Fnv {
    fn new() -> Fnv {
        Fnv(0xcbf29ce484222325)
    }
    fn eat(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
}
