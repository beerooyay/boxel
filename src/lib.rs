//! # boxel
//!
//! Diffusive fields that cost what happens in them, not what they cover, with a proof.
//!
//! A field is a value on every cell of the integer plane (glow, wetness, heat, scent) that
//! spreads to its neighbours and fades. Simulating it everywhere costs the whole world every
//! step. Simulating it only where something is going on is what games already do, by feel,
//! and by feel means nobody knows what was lost. Boxel does the second with the guarantee of
//! the first: no cell ever differs from the full computation by more than a tolerance you
//! choose, every step, however long it runs and however large the plane.
//!
//! The method is the certified locality of Rouyea & Bourgeois, *Certified Locality in
//! Diffusive Simulation* (2026), carried to a running engine:
//!
//! - [`Cone`] computes the tolerance light cone of the lattice scheme itself, which makes the
//!   paper's windows rigorous on the lattice, with or without dissipation, and within a few
//!   percent of the cells an event ever actually touches.
//! - [`Field`] keeps a ledger of those bounds per 16 × 16 block, gives storage only to blocks
//!   the ledger cannot clear, steps only those, retires events into a decaying budget and
//!   merges them when there are too many. Memory and work both follow the window.
//! - [`Grid`] is the full computation, in the same arithmetic, to check the promise against.
//!
//! The crate is `no_std`, has no dependencies, and uses no transcendental functions at run
//! time, so a field gives the same bits on every machine.
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
