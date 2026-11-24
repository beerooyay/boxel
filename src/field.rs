//! A certified field on the unbounded integer plane.
//!
//! Every deposit is an event. Its future is bounded by the cone, and the ledger adds those
//! bounds block by block. A block whose ledger reaches the window level is the only kind
//! that has storage, and the only kind that is stepped; everywhere else the field is zero,
//! exactly as in the windowed simulation of the paper (Theorem 6.5), and the ledger proves
//! the zero is within tolerance. Memory and work follow the window, and the window follows
//! what has happened.
//!
//! The paper's global error (Theorem 6.7) is a sum over every event there has ever been. On
//! an open world with a thousand walkers that sum is the whole problem, so here it is kept
//! per district of 1024 × 1024 cells: each district has its own event capacity and its own
//! retirement budget, and a cell only ever pays for the nine districts around it. Anything
//! further away is at least 896 cells off, where the cone has decayed past any mass a game
//! could deposit; that remainder is counted exactly and kept inside a sliver of the budget.

use alloc::vec;
use alloc::vec::Vec;

use crate::cone::Cone;
use crate::ledger::{Blocks, Entry, NONE, UNIT, key};
use crate::spec::{Budget, Error, Spec};

/// Cells on a side of a block. A block row is sixteen floats, one 64-byte cache line.
pub const SIDE: usize = 16;
const AREA: usize = SIDE * SIDE;

/// The widest disc a single deposit may cover. Wider areas are painted as several deposits.
pub const MAX_RADIUS: u32 = 24;

/// Cells on a side of a district, as a shift.
const DISTRICT: u32 = 10;

/// A district's events never grow wider than this by merging, so an event's support stays
/// within a quarter district of the district that holds it.
const WIDEST: u32 = 128;

/// Events in districts that are not neighbours of a cell's district are at least this far
/// from it: one district, less the widest support.
const FAR: u32 = (1 << DISTRICT) - WIDEST;

/// The cone is built so that an event this heavy fades below the tail cut by its end.
/// Heavier events stay certified with a wider, longer footprint.
const TYPICAL_MASS: f64 = 64.0;

/// Without fade the exterior bound never decays, so the field is one global district and
/// events are kept under this mass, which the cone is then built for.
const MASS_LIMIT: f64 = 4096.0;

/// Terms are kept from a hair under the cut, so a term the product rounded down past the cut
/// is still kept, and what is dropped is never above the cut.
const KEEP: f64 = 1.0 - 1e-12;

/// The unit roundoff of f32.
const U32: f64 = 1.0 / (1u64 << 24) as f64;

type Block = [f32; AREA];

const UP: usize = 0;
const DOWN: usize = 1;
const LEFT: usize = 2;
const RIGHT: usize = 3;
const OPPOSITE: [usize; 4] = [DOWN, UP, RIGHT, LEFT];
const STEP: [(i32, i32); 4] = [(0, -1), (0, 1), (-1, 0), (1, 0)];

#[derive(Clone, Copy, Debug)]
struct Event {
    x: i32,
    y: i32,
    /// Support: every cell within this Euclidean radius of (x, y).
    r: u32,
    mass: f64,
    /// Nothing the event ever does exceeds its densest deposit (the maximum principle).
    cap: f64,
    born: u64,
    bin: usize,
    /// Step at which the event enters its next age bin.
    rebin: u64,
}

struct District {
    key: u64,
    events: Vec<Event>,
    /// What events retired here may still put on any cell, at most. Decays with the field.
    pool: f64,
}

/// Counters for the instrument panel.
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub steps: u64,
    pub deposits: u64,
    pub merged: u64,
    pub retired: u64,
    /// Cells stepped, over the field's life.
    pub stepped: u64,
    /// Most blocks ever awake at once.
    pub peak_blocks: usize,
    /// Blocks that left the window holding more than the ledger allowed. Always zero; it
    /// is counted so that anyone can watch it stay there.
    pub violations: u64,
}

pub struct Field {
    spec: Spec,
    budget: Budget,
    cone: Cone,
    spread: f32,
    centre: f32,
    /// Ledger terms below this are dropped: the tail each live event may leave behind.
    cut: f64,
    /// A district retires events only while its pool stays under this.
    room: f64,
    /// Districts a cell pays for: nine, or one when the field is a single district.
    near: f64,
    /// A block is in the window from this many ledger units up.
    window: u64,
    /// Merges never produce an event heavier or wider than these.
    heaviest: f64,
    widest: u32,
    /// The most a unit of mass in a far district can ever put on a cell.
    far: f64,
    /// Total mass ever deposited: bounds what all far districts hold together.
    deposited: f64,
    /// Pools of districts that emptied and were dropped, still decaying.
    dust: f64,
    /// What f32 rounding can have moved this field from exact arithmetic, at most, so far.
    rounding: f64,
    /// Relative rounding of one step of the scheme.
    gamma: f64,
    /// Blocks each deposit or drain since the last step reached, one entry per reach.
    touched: Vec<u64>,
    blocks: Blocks,
    /// Page storage. Page 0 is all zeros, forever, and stands in for every missing neighbour.
    now: Vec<Block>,
    next: Vec<Block>,
    links: Vec<[u32; 4]>,
    home: Vec<(i32, i32)>,
    spot: Vec<u32>,
    spare: Vec<u32>,
    awake: Vec<u32>,
    districts: Vec<District>,
    falling: Vec<u64>,
    freed: Vec<(i32, i32)>,
    /// The uniform part of the field. Its laplacian is zero, so it only fades, and it never
    /// wakes a block.
    sheet: f32,
    step: u64,
    stats: Stats,
    #[cfg(feature = "parallel")]
    threads: usize,
}

/// Below this many awake blocks for each thread, starting the threads costs more than they save.
#[cfg(feature = "parallel")]
const PARALLEL_BLOCKS: usize = 96;
#[cfg(feature = "parallel")]
const MAX_THREADS: usize = 16;

/// The pages of `next`, handed to the threads that step them. See `Field::step_blocks`.
#[cfg(feature = "parallel")]
#[derive(Clone, Copy)]
struct Pages(*mut Block);
#[cfg(feature = "parallel")]
unsafe impl Send for Pages {}
#[cfg(feature = "parallel")]
unsafe impl Sync for Pages {}
#[cfg(feature = "parallel")]
impl Pages {
    /// # Safety
    /// `p` is in bounds, and no other reference to page `p` is alive while this one is.
    #[allow(clippy::mut_from_ref)]
    unsafe fn page(&self, p: usize) -> &mut Block {
        unsafe { &mut *self.0.add(p) }
    }
}

#[inline(always)]
fn flush(v: f32) -> f32 {
    if v < 1e-12 { 0.0 } else { v }
}

/// The scheme on one block: `c0·u + a·(left + right + up + down)`, each row padded with its
/// two horizontal neighbours so the inner loop is straight-line and vectorises.
#[inline]
#[allow(clippy::too_many_arguments)]
fn step_block(me: &Block, up: &Block, down: &Block, left: &Block, right: &Block, a: f32, c0: f32, out: &mut Block) {
    let mut row = [0.0f32; SIDE + 2];
    for y in 0..SIDE {
        let at = y * SIDE;
        let above = if y == 0 { &up[AREA - SIDE..] } else { &me[at - SIDE..at] };
        let below = if y == SIDE - 1 { &down[..SIDE] } else { &me[at + SIDE..at + 2 * SIDE] };
        row[0] = left[at + SIDE - 1];
        row[1..SIDE + 1].copy_from_slice(&me[at..at + SIDE]);
        row[SIDE + 1] = right[at];
        let (l, c, r) = (&row[..SIDE], &row[1..SIDE + 1], &row[2..]);
        let out = &mut out[at..at + SIDE];
        for x in 0..SIDE {
            out[x] = flush(c0 * c[x] + a * (l[x] + r[x] + above[x] + below[x]));
        }
    }
}

/// Cells of the disc of radius `r`.
fn disc(r: u32) -> u64 {
    let r = r as i64;
    (-r..=r).map(|dy| 2 * ((r * r - dy * dy) as u64).isqrt() + 1).sum()
}

impl Field {
    pub fn new(spec: Spec) -> Result<Field, Error> {
        spec.check()?;
        let budget = Budget::split(spec.tolerance as f64);
        let local = spec.fade > 0.0;
        let near = if local { 9.0 } else { 1.0 };
        let cut = budget.tails / (near * spec.events as f64);
        let typical = if local { TYPICAL_MASS } else { MASS_LIMIT };
        let (spread, centre) = spec.weights();
        let cone = Cone::weights(spread as f64, centre as f64, spec.fade as f64, cut / typical)?;
        let far = if local { cone.envelope(0, FAR) } else { 0.0 };
        Ok(Field {
            spec,
            budget,
            spread,
            centre,
            rounding: 0.0,
            // five roundings on the longest path of the stencil, or one when it has no spread
            gamma: if spread == 0.0 { U32 } else { 5.000001 * U32 },
            touched: Vec::new(),
            cut,
            room: budget.retired / near,
            near,
            window: (budget.window * UNIT) as u64,
            heaviest: if local { f64::INFINITY } else { MASS_LIMIT },
            widest: if local { WIDEST } else { u32::MAX },
            far,
            deposited: 0.0,
            dust: 0.0,
            cone,
            blocks: Blocks::new(),
            now: vec![[0.0; AREA]],
            next: vec![[0.0; AREA]],
            links: vec![[0; 4]],
            home: vec![(0, 0)],
            spot: vec![0],
            spare: Vec::new(),
            awake: Vec::new(),
            districts: Vec::new(),
            falling: Vec::new(),
            freed: Vec::new(),
            sheet: 0.0,
            step: 0,
            stats: Stats::default(),
            #[cfg(feature = "parallel")]
            threads: std::thread::available_parallelism().map_or(1, |n| n.get().min(MAX_THREADS)),
        })
    }

    pub fn spec(&self) -> &Spec {
        &self.spec
    }

    pub fn cone(&self) -> &Cone {
        &self.cone
    }

    /// Add `amount` to every cell within `radius` of (x, y). The field saturates at 1.
    pub fn deposit(&mut self, x: i32, y: i32, radius: u32, amount: f32) {
        let amount = amount.min(1.0);
        if amount.is_nan() || amount <= 0.0 {
            return;
        }
        let r = radius.min(MAX_RADIUS);
        let mass = amount as f64 * disc(r) as f64;
        let e = self.event(x, y, r, mass, amount as f64, self.step);
        // the ledger first, so every block the deposit can matter in has a page to land in
        self.imprint(&e, None, Some(e.bin));
        let d = self.district(x, y);
        self.districts[d].events.push(e);
        let room = (1.0 - self.sheet).max(0.0);
        self.each_cell(x, y, r, |v| *v = (*v + amount).min(room));
        self.deposited += mass;
        self.touch(x, y, r);
        self.stats.deposits += 1;
        if self.districts[d].events.len() > self.spec.events {
            self.merge(d);
        }
    }

    /// Take up to `amount` from every cell within `radius` of (x, y). Removing mass only
    /// lowers the field, so every bound still holds and the ledger is left alone.
    pub fn drain(&mut self, x: i32, y: i32, radius: u32, amount: f32) {
        let r = radius.min(MAX_RADIUS);
        self.each_cell(x, y, r, |v| *v = (*v - amount).max(0.0));
        self.touch(x, y, r);
    }

    /// A uniform deposit over the whole plane, kept in closed form as the sheet.
    pub fn rain(&mut self, amount: f32) {
        if amount > 0.0 {
            self.sheet += amount;
        }
    }

    /// Advance one step.
    pub fn step(&mut self) {
        self.age();
        self.retire();
        self.sweep();
        self.step_blocks();
        core::mem::swap(&mut self.now, &mut self.next);
        let (a, c0, s) = (self.spread, self.centre, self.sheet);
        self.sheet = flush(c0 * s + a * (s + s + s + s));
        // everything that only decays is rounded up as it decays, so it never decays too fast
        let keep = (1.0 - self.spec.fade as f64).next_up();
        for d in &mut self.districts {
            d.pool = (d.pool * keep).next_up();
        }
        self.dust = (self.dust * keep).next_up();
        // the windowed field and the full one each round every step, by at most gamma of a
        // value no larger than 1. A deposit or drain rounds each by at most one unit of f32,
        // since what it leaves is at most 1 or is clamped exactly; the flush to zero moves
        // either by at most 1e-12. All of it decays with the scheme.
        let injected = 2.0 * self.gamma * keep + 2.0 * U32 * self.crowding() as f64 + 2e-12;
        self.rounding = (self.rounding * keep + injected).next_up();
        self.stats.stepped += (self.awake.len() * AREA) as u64;
        self.stats.steps += 1;
        self.step += 1;
    }

    /// Step every awake block from `now` into `next`, on one core.
    fn step_serial(&mut self) {
        let (a, c0) = (self.spread, self.centre);
        for &p in &self.awake {
            let p = p as usize;
            let [u, d, l, r] = self.links[p];
            let n = &self.now;
            step_block(&n[p], &n[u as usize], &n[d as usize], &n[l as usize], &n[r as usize], a, c0, &mut self.next[p]);
        }
    }

    #[cfg(not(feature = "parallel"))]
    fn step_blocks(&mut self) {
        self.step_serial();
    }

    /// Step every awake block, split across threads when there is enough of them to pay for the
    /// threads. A block reads only `now` and writes only its own page of `next`, so the parts
    /// share nothing they write.
    #[cfg(feature = "parallel")]
    fn step_blocks(&mut self) {
        let threads = self.threads.min(self.awake.len() / PARALLEL_BLOCKS);
        if threads < 2 {
            return self.step_serial();
        }
        let (a, c0) = (self.spread, self.centre);
        let (now, links, next) = (&self.now, &self.links, Pages(self.next.as_mut_ptr()));
        std::thread::scope(|s| {
            for part in self.awake.chunks(self.awake.len().div_ceil(threads)) {
                s.spawn(move || {
                    for &p in part {
                        let p = p as usize;
                        let [u, d, l, r] = links[p];
                        let n = now;
                        // SAFETY: a page is awake at most once, so no two threads ever hold the same page of
                        // `next`, every awake page is in bounds of it, and nothing else touches `next` until the
                        // scope has joined every thread.
                        let out = unsafe { next.page(p) };
                        step_block(&n[p], &n[u as usize], &n[d as usize], &n[l as usize], &n[r as usize], a, c0, out);
                    }
                });
            }
        });
    }

    /// Step on at most `n` threads (at least one). Results do not depend on it.
    #[cfg(feature = "parallel")]
    pub fn set_threads(&mut self, n: usize) {
        self.threads = n.max(1);
    }

    /// The field at a cell, sheet included.
    pub fn sample(&self, x: i32, y: i32) -> f32 {
        let p = self.blocks.page(key(x >> 4, y >> 4));
        let v = if p == NONE { 0.0 } else { self.now[p as usize][((y & 15) * 16 + (x & 15)) as usize] };
        v + self.sheet
    }

    pub fn sheet(&self) -> f32 {
        self.sheet
    }

    /// Every block in the window: its coordinates (cells divided by 16) and its 256 values,
    /// row by row, without the sheet.
    pub fn blocks(&self) -> impl Iterator<Item = (i32, i32, &[f32; AREA])> + '_ {
        self.awake.iter().map(|&p| (self.home[p as usize].0, self.home[p as usize].1, &self.now[p as usize]))
    }

    /// The `i`th block in the window, as [`blocks`](Field::blocks) yields it. Indices are
    /// stable until the next step or deposit.
    pub fn block_at(&self, i: usize) -> Option<(i32, i32, &[f32; AREA])> {
        let p = *self.awake.get(i)? as usize;
        Some((self.home[p].0, self.home[p].1, &self.now[p]))
    }

    /// The values of one block, if it is in the window.
    pub fn block(&self, bx: i32, by: i32) -> Option<&[f32; AREA]> {
        match self.blocks.page(key(bx, by)) {
            NONE => None,
            p => Some(&self.now[p as usize]),
        }
    }

    /// Blocks that left the window since the last `forget_freed`: they read zero now. A block
    /// can leave and come back in between, so a host applies these before `blocks`.
    pub fn freed(&self) -> &[(i32, i32)] {
        &self.freed
    }

    pub fn forget_freed(&mut self) {
        self.freed.clear();
    }

    /// The certified bound right now: no cell differs from the full computation by more.
    /// Under the tolerance unless a district was pushed past its capacity with nothing it
    /// could merge, in which case this says by how much.
    pub fn bound(&self) -> f64 {
        self.budget.window + self.beyond_window()
    }

    /// What f32 rounding can have moved the field by, at most, so far. Part of [`bound`](Field::bound).
    pub fn rounding(&self) -> f64 {
        self.rounding
    }

    /// The bound less the window level: what a block outside the window may hold beyond its
    /// own ledger.
    fn beyond_window(&self) -> f64 {
        let (mut count, mut pool) = (0usize, 0.0f64);
        for d in &self.districts {
            count = count.max(d.events.len());
            pool = pool.max(d.pool);
        }
        (self.near * (count as f64 * self.cut + pool)
            + self.deposited * self.far * (1.0 + 1e-12)
            + self.dust
            + self.rounding)
            * (1.0 + 1e-15)
    }

    pub fn awake(&self) -> usize {
        self.awake.len()
    }

    pub fn live(&self) -> usize {
        self.districts.iter().map(|d| d.events.len()).sum()
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    /// Heap bytes held: pages, ledger, events.
    pub fn bytes(&self) -> usize {
        self.now.len() * (2 * core::mem::size_of::<Block>() + 32)
            + self.blocks.bytes()
            + self.districts.iter().map(|d| 64 + d.events.capacity() * core::mem::size_of::<Event>()).sum::<usize>()
    }

    /// Note the blocks a disc at (x, y) of radius r reaches, for the rounding account.
    fn touch(&mut self, x: i32, y: i32, r: u32) {
        let r = r as i32;
        for by in (y - r) >> 4..=(y + r) >> 4 {
            for bx in (x - r) >> 4..=(x + r) >> 4 {
                self.touched.push(key(bx, by));
            }
        }
    }

    /// The most deposits and drains that reached one block since the last step, and forget them.
    fn crowding(&mut self) -> usize {
        self.touched.sort_unstable();
        let (mut most, mut run) = (0, 0);
        for i in 0..self.touched.len() {
            run = if i > 0 && self.touched[i] == self.touched[i - 1] { run + 1 } else { 1 };
            most = most.max(run);
        }
        self.touched.clear();
        most
    }

    // ---- events -------------------------------------------------------------------------

    fn event(&self, x: i32, y: i32, r: u32, mass: f64, cap: f64, born: u64) -> Event {
        let bin = self.cone.bin(self.step - born);
        let rebin = self.cone.next_start(bin).map_or(u64::MAX, |s| born + s as u64);
        Event { x, y, r, mass, cap, born, bin, rebin }
    }

    /// The district holding cell (x, y), created if new.
    fn district(&mut self, x: i32, y: i32) -> usize {
        let k = if self.near > 1.0 { key(x >> DISTRICT, y >> DISTRICT) } else { 0 };
        match self.districts.binary_search_by_key(&k, |d| d.key) {
            Ok(i) => i,
            Err(i) => {
                self.districts.insert(i, District { key: k, events: Vec::new(), pool: 0.0 });
                i
            }
        }
    }

    /// What event `e`, in age bin `bin`, adds to the ledger of the block whose nearest cell to
    /// it is `d²` away: zero under the tail cut, else rounded up to the next unit.
    #[inline]
    fn term(&self, e: &Event, bin: usize, d2: u64) -> u64 {
        let rho = (d2.isqrt() as u32).saturating_sub(e.r);
        let v = e.cap.min(e.mass * self.cone.envelope(bin, rho));
        if v < self.cut * KEEP { 0 } else { (v * UNIT) as u64 + 1 }
    }

    /// Cells from the centre beyond which event `e` in `bin` adds nothing.
    fn reach(&self, e: &Event, bin: usize) -> Option<u32> {
        let keep = self.cut * KEEP;
        if e.cap.min(e.mass * self.cone.peak(bin)) < keep {
            return None;
        }
        let (mut lo, mut hi) = (0u32, 1u32);
        while e.mass * self.cone.envelope(bin, hi) >= keep {
            lo = hi;
            hi *= 2;
        }
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if e.mass * self.cone.envelope(bin, mid) >= keep { lo = mid } else { hi = mid }
        }
        Some(lo + e.r + 1)
    }

    /// Move event `e` in the ledger from age bin `from` to `to` (`None`: not in the ledger),
    /// block by block, touching only blocks whose term changes. Blocks that reach the window
    /// get a page at once; blocks that drop out of it are only noted, and lose their page in
    /// the next sweep, so that a merge (out, then in) never throws values away.
    fn imprint(&mut self, e: &Event, from: Option<usize>, to: Option<usize>) {
        let reach = match (from.and_then(|b| self.reach(e, b)), to.and_then(|b| self.reach(e, b))) {
            (None, None) => return,
            (a, b) => a.max(b).unwrap() as i32,
        };
        let (bx0, bx1) = ((e.x - reach) >> 4, (e.x + reach) >> 4);
        let (by0, by1) = ((e.y - reach) >> 4, (e.y + reach) >> 4);
        for by in by0..=by1 {
            let ny = e.y.clamp(by * 16, by * 16 + 15);
            for bx in bx0..=bx1 {
                let nx = e.x.clamp(bx * 16, bx * 16 + 15);
                let (dx, dy) = ((nx - e.x) as i64, (ny - e.y) as i64);
                let d2 = (dx * dx + dy * dy) as u64;
                let old = from.map_or(0, |b| self.term(e, b, d2));
                let new = to.map_or(0, |b| self.term(e, b, d2));
                if old != new {
                    self.post(bx, by, new as i64 - old as i64);
                }
            }
        }
    }

    fn post(&mut self, bx: i32, by: i32, delta: i64) {
        let k = key(bx, by);
        let slot = self.blocks.slot(k);
        let entry = self.blocks.get_mut(slot);
        entry.ledger = (entry.ledger as i64 + delta) as u64;
        let (ledger, page) = (entry.ledger, entry.page);
        if delta > 0 {
            if ledger >= self.window && page == NONE {
                let p = self.open(bx, by);
                let slot = self.blocks.find(k).unwrap();
                self.blocks.get_mut(slot).page = p;
            }
        } else if ledger < self.window {
            if page != NONE {
                self.falling.push(k);
            } else if ledger == 0 {
                self.blocks.remove(slot);
            }
        }
    }

    /// Move every event whose age crossed into a new bin: its bound shrinks.
    fn age(&mut self) {
        for d in 0..self.districts.len() {
            for i in 0..self.districts[d].events.len() {
                let e = self.districts[d].events[i];
                if self.step >= e.rebin {
                    let next = self.event(e.x, e.y, e.r, e.mass, e.cap, e.born);
                    self.imprint(&e, Some(e.bin), Some(next.bin));
                    self.districts[d].events[i] = next;
                }
            }
        }
    }

    /// Retire every event whose whole future fits in what is left of its district's budget,
    /// then forget districts with nothing left in them.
    fn retire(&mut self) {
        for d in 0..self.districts.len() {
            let mut i = 0;
            while i < self.districts[d].events.len() {
                let e = self.districts[d].events[i];
                let rest = e.cap.min(e.mass * self.cone.peak(e.bin)) * (1.0 + 1e-12);
                if self.districts[d].pool + rest <= self.room {
                    self.districts[d].pool = (self.districts[d].pool + rest).next_up();
                    self.imprint(&e, Some(e.bin), None);
                    self.districts[d].events.swap_remove(i);
                    self.stats.retired += 1;
                } else {
                    i += 1;
                }
            }
        }
        let floor = self.budget.slack * 1e-6;
        let mut dust = 0.0;
        self.districts.retain(|d| {
            let keep = !d.events.is_empty() || d.pool > floor;
            if !keep {
                dust += d.pool;
            }
            keep
        });
        self.dust += dust;
    }

    /// Over capacity: replace two events by one holding both (the paper's Proposition 4.2:
    /// one window for the summed event). The merged event takes the summed mass, the summed
    /// cap and the younger age, each an upper bound, so the oldest event goes first, into the
    /// partner whose enclosing disc grows least and whose age is closest. Old events have
    /// little left to bound, so merging them costs almost nothing; merging young ones, or an
    /// old one into a young one, would widen windows that are still awake.
    fn merge(&mut self, d: usize) {
        let events = &self.districts[d].events;
        let mut order: Vec<usize> = (0..events.len()).collect();
        order.sort_by_key(|&i| (events[i].born, i));
        let mut best: Option<(usize, usize, (i32, i32, u32))> = None;
        for &i in &order {
            let mut cheapest = u32::MAX;
            for j in 0..events.len() {
                let (a, b) = (&events[i], &events[j]);
                if i == j || a.mass + b.mass > self.heaviest {
                    continue;
                }
                let disc = enclose(a, b);
                let cost = disc.2.saturating_sub(a.r.max(b.r)) + 4 * a.bin.abs_diff(b.bin) as u32;
                if disc.2 <= self.widest && cost < cheapest {
                    cheapest = cost;
                    best = Some((i.min(j), i.max(j), disc));
                }
            }
            if best.is_some() {
                break;
            }
        }
        let Some((i, j, (x, y, r))) = best else { return };
        let (a, b) = (events[i], events[j]);
        let merged = self.event(x, y, r, a.mass + b.mass, a.cap + b.cap, a.born.max(b.born));
        self.imprint(&a, Some(a.bin), None);
        self.imprint(&b, Some(b.bin), None);
        self.imprint(&merged, None, Some(merged.bin));
        let events = &mut self.districts[d].events;
        events.swap_remove(j);
        events[i] = merged;
        self.stats.merged += 1;
    }

    // ---- the window -----------------------------------------------------------------------

    /// Give block (bx, by) a zeroed page and link it to its neighbours.
    fn open(&mut self, bx: i32, by: i32) -> u32 {
        let p = match self.spare.pop() {
            Some(p) => p,
            None => {
                self.now.push([0.0; AREA]);
                self.next.push([0.0; AREA]);
                self.links.push([0; 4]);
                self.home.push((0, 0));
                self.spot.push(0);
                (self.now.len() - 1) as u32
            }
        };
        let pi = p as usize;
        self.now[pi] = [0.0; AREA];
        self.home[pi] = (bx, by);
        for dir in 0..4 {
            let q = self.blocks.page(key(bx + STEP[dir].0, by + STEP[dir].1));
            if q == NONE {
                self.links[pi][dir] = 0;
            } else {
                self.links[pi][dir] = q;
                self.links[q as usize][OPPOSITE[dir]] = p;
            }
        }
        self.spot[pi] = self.awake.len() as u32;
        self.awake.push(p);
        self.stats.peak_blocks = self.stats.peak_blocks.max(self.awake.len());
        p
    }

    /// Close the pages of blocks whose ledger fell under the window level, auditing each on
    /// the way out: what it holds must sit under its ledger plus everything beyond it.
    fn sweep(&mut self) {
        if self.falling.is_empty() {
            return;
        }
        let beyond = self.beyond_window();
        while let Some(k) = self.falling.pop() {
            let Some(slot) = self.blocks.find(k) else { continue };
            let Entry { ledger, page, .. } = *self.blocks.get(slot);
            if page == NONE || ledger >= self.window {
                continue;
            }
            let p = page as usize;
            let most = self.now[p].iter().fold(0.0f32, |m, &v| m.max(v)) as f64;
            if most > (ledger as f64 / UNIT + beyond) * (1.0 + 1e-5) + 1e-7 {
                self.stats.violations += 1;
            }
            for (dir, &back) in OPPOSITE.iter().enumerate() {
                let q = self.links[p][dir] as usize;
                if q != 0 {
                    self.links[q][back] = 0;
                }
            }
            let at = self.spot[p] as usize;
            self.awake.swap_remove(at);
            if let Some(&moved) = self.awake.get(at) {
                self.spot[moved as usize] = at as u32;
            }
            self.spare.push(page);
            self.freed.push(self.home[p]);
            if ledger == 0 {
                self.blocks.remove(slot);
            } else {
                self.blocks.get_mut(slot).page = NONE;
            }
        }
    }

    /// Apply `f` to every stored cell of the disc; cells outside the window are skipped.
    fn each_cell(&mut self, x: i32, y: i32, r: u32, mut f: impl FnMut(&mut f32)) {
        let r = r as i32;
        for dy in -r..=r {
            let span = ((r * r - dy * dy) as u64).isqrt() as i32;
            let cy = y + dy;
            let mut cx = x - span;
            while cx <= x + span {
                let end = (cx | 15).min(x + span);
                let p = self.blocks.page(key(cx >> 4, cy >> 4));
                if p != NONE {
                    let row = &mut self.now[p as usize][((cy & 15) * 16) as usize..][..16];
                    for c in cx..=end {
                        f(&mut row[(c & 15) as usize]);
                    }
                }
                cx = end + 1;
            }
        }
    }
}

/// The smallest integer disc found that holds both events' supports.
fn enclose(a: &Event, b: &Event) -> (i32, i32, u32) {
    let (dx, dy) = ((b.x - a.x) as i64, (b.y - a.y) as i64);
    let d2 = (dx * dx + dy * dy) as u64;
    let d = if d2 == 0 { 0 } else { (d2 - 1).isqrt() + 1 } as i64;
    let (ra, rb) = (a.r as i64, b.r as i64);
    if d + rb <= ra {
        return (a.x, a.y, a.r);
    }
    if d + ra <= rb {
        return (b.x, b.y, b.r);
    }
    let r = (d + ra + rb + 1) / 2;
    let (x, y) = (a.x as i64 + dx * (r - ra) / d, a.y as i64 + dy * (r - ra) / d);
    // integer centre: grow the radius until both discs are inside
    let cover = |ox: i32, oy: i32, or: i64| {
        let q = ((x - ox as i64).pow(2) + (y - oy as i64).pow(2)) as u64;
        (if q == 0 { 0 } else { (q - 1).isqrt() + 1 }) as i64 + or
    };
    let r = cover(a.x, a.y, ra).max(cover(b.x, b.y, rb));
    (x as i32, y as i32, r as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enclosing_disc_holds_both() {
        let a = Event { x: 0, y: 0, r: 2, mass: 1.0, cap: 1.0, born: 0, bin: 0, rebin: 0 };
        let b = Event { x: 9, y: -4, r: 3, ..a };
        let (x, y, r) = enclose(&a, &b);
        for e in [a, b] {
            let d = (((x - e.x) as f64).hypot((y - e.y) as f64)) + e.r as f64;
            assert!(d <= r as f64 + 1e-9, "{d} > {r}");
        }
    }

    #[test]
    fn disc_counts_cells() {
        assert_eq!(disc(0), 1);
        assert_eq!(disc(1), 5);
        assert_eq!(disc(2), 13);
    }

    #[test]
    fn rounding_stays_inside_its_share() {
        for spec in [
            Spec { spread: 8.0 / 60.0, fade: 0.3 / 60.0, tolerance: 1.0 / 255.0, events: 64 },
            Spec { spread: 0.2, fade: 0.04 / 15.0, tolerance: 1.0 / 255.0, events: 64 },
            Spec { spread: 0.0, fade: 0.008 / 15.0, tolerance: 1.0 / 255.0, events: 64 },
        ] {
            let mut f = Field::new(spec).unwrap();
            // long enough for the slowest fade to reach 98% of its steady state, with one block
            // taking a footstep every other step, twice the demo's busiest
            for s in 0..8000 {
                if s % 2 == 0 {
                    f.deposit(s % 7, 0, 2, 0.8);
                }
                f.step();
            }
            assert!(f.rounding() < f.budget.rounding, "{spec:?}: {} of {}", f.rounding(), f.budget.rounding);
        }
    }

    #[test]
    fn far_districts_are_negligible() {
        let f = Field::new(Spec { spread: 0.2, fade: 0.04 / 15.0, tolerance: 1.0 / 255.0, events: 64 }).unwrap();
        // a teratonne of deposits still fits in the sliver
        assert!(1e12 * f.far < f.budget.slack, "{}", f.far);
    }
}
