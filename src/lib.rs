//! # boxel
//!
//! Sparse diffusion fields with a computable error bound.
//!
//! A field is a value on every cell of the integer plane (glow, wetness, heat, scent) that
//! spreads to its neighbours and fades. Simulating it everywhere costs the whole world every
//! step. Boxel allocates blocks around disturbances and lets quiet blocks retire.
//! Boxel computes a conservative error bound for the omitted cells and tracks it through
//! each step. Compare [`Field::bound`] with the requested tolerance to check the current
//! guarantee, including the effect of rounding and event crowding.
//!
//! The method is the certified locality of Rouyea & Bourgeois, *Certified Locality in
//! Diffusive Simulation* (2026), carried to a running engine:
//!
//! - [`Cone`] bounds the impulse response of a fixed lattice step with or without dissipation.
//!   On three point-event fixtures its footprint contained 3.3–5.5% more cells than the
//!   measured above-threshold footprint.
//! - [`Field`] keeps a ledger of those bounds per 16 × 16 block, gives storage only to blocks
//!   the ledger cannot clear, steps only those, retires events into a decaying budget and
//!   merges them when there are too many. Memory and work both follow the window.
//! - [`Grid`] is the full computation, in the same arithmetic, to check the promise against.
//!
//! The default crate is `no_std` and dependency-free. The replay fixture checks field bits
//! across native and WebAssembly builds using the same event history.
//!
//! With the `parallel` feature it uses `std` threads to step a large window's blocks across
//! cores. Every block is computed exactly as it is on one core and the bookkeeping stays serial,
//! so the field holds the same bits on any number of threads.
//!
//! ```
//! use boxel::{Field, Spec};
//!
//! let mut glow = Field::new(Spec { spread: 0.13, fade: 0.005, tolerance: 1.0 / 255.0, events: 64 }).unwrap();
//! glow.deposit(10, -4, 2, 0.8);
//! for _ in 0..60 {
//!     glow.step();
//! }
//! assert!(glow.sample(10, -4) > 0.0);
//! assert!(glow.bound() <= 1.0 / 255.0);
//! ```

#![cfg_attr(not(test), no_std)]
extern crate alloc;
#[cfg(feature = "parallel")]
extern crate std;

pub mod cone;
pub mod field;
pub mod grid;
mod ledger;
pub mod spec;

pub use cone::Cone;
pub use field::{Field, Stats};
pub use grid::Grid;
pub use spec::{Budget, Error, Spec};
