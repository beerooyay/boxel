//! The same field on one thread and on many holds the same bits, every step.
#![cfg(feature = "parallel")]

use boxel::{Field, Spec};

#[test]
fn threads_change_nothing() {
    let spec = Spec { spread: 0.2, fade: 0.004, tolerance: 1.0 / 255.0, events: 1024 };
    let (mut one, mut many) = (Field::new(spec).unwrap(), Field::new(spec).unwrap());
    one.set_threads(1);
    many.set_threads(8);
    let mut s = 0x9e37_79b9_7f4a_7c15u64;
    let mut rnd = move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let mut peak = 0;
    for step in 0..300 {
        for _ in 0..24 {
            let (x, y) = ((rnd() % 4096) as i32 - 2048, (rnd() % 4096) as i32 - 2048);
            let (r, a) = ((rnd() % 4) as u32, (rnd() % 1000) as f32 / 1000.0);
            one.deposit(x, y, r, a);
            many.deposit(x, y, r, a);
        }
        one.step();
        many.step();
        peak = peak.max(many.awake());
        if step % 30 == 29 {
            assert_eq!(one.awake(), many.awake());
            for ((ax, ay, av), (bx, by, bv)) in one.blocks().zip(many.blocks()) {
                assert_eq!((ax, ay), (bx, by));
                assert!(
                    av.iter().zip(bv.iter()).all(|(p, q)| p.to_bits() == q.to_bits()),
                    "block ({ax}, {ay}) differs"
                );
            }
            assert_eq!(one.bound().to_bits(), many.bound().to_bits());
        }
    }
    assert!(peak >= 8 * 96, "the field never split across eight threads: {peak} blocks at most");
}
