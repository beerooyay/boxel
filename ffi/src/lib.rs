//! The C ABI: what Unity, Unreal, Godot, a browser or anything else with a foreign function
//! interface links against. Handles are opaque pointers; every function takes plain numbers
//! and returns plain numbers or pointers into the field's own storage, valid until the next
//! call that changes the field. Null handles are refused by returning zero.

use boxel::{Field, Grid, Spec};

pub struct BoxelField {
    field: Field,
    stats: BoxelStats,
}

/// Counters, all as doubles so a JavaScript host can read them through one `Float64Array`.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct BoxelStats {
    pub steps: f64,
    pub deposits: f64,
    pub merged: f64,
    pub retired: f64,
    pub stepped: f64,
    pub violations: f64,
    pub blocks: f64,
    pub peak_blocks: f64,
    pub live: f64,
    pub bytes: f64,
    pub bound: f64,
    pub sheet: f64,
}

fn spec(spread: f32, fade: f32, tolerance: f32, events: u32) -> Spec {
    Spec { spread, fade, tolerance, events: events as usize }
}

/// A new field, or null if the spec is unstable or cannot be certified.
#[unsafe(no_mangle)]
pub extern "C" fn boxel_field_new(spread: f32, fade: f32, tolerance: f32, events: u32) -> *mut BoxelField {
    match Field::new(spec(spread, fade, tolerance, events)) {
        Ok(field) => Box::into_raw(Box::new(BoxelField { field, stats: BoxelStats::default() })),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `f` must come from `boxel_field_new` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_field_free(f: *mut BoxelField) {
    if !f.is_null() {
        drop(unsafe { Box::from_raw(f) });
    }
}

macro_rules! field {
    ($f:ident) => {
        match unsafe { $f.as_mut() } {
            Some(h) => &mut h.field,
            None => return Default::default(),
        }
    };
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_deposit(f: *mut BoxelField, x: i32, y: i32, radius: u32, amount: f32) {
    field!(f).deposit(x, y, radius, amount)
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_drain(f: *mut BoxelField, x: i32, y: i32, radius: u32, amount: f32) {
    field!(f).drain(x, y, radius, amount)
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_rain(f: *mut BoxelField, amount: f32) {
    field!(f).rain(amount)
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_step(f: *mut BoxelField, steps: u32) {
    let field = field!(f);
    for _ in 0..steps {
        field.step();
    }
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_sample(f: *mut BoxelField, x: i32, y: i32) -> f32 {
    field!(f).sample(x, y)
}

/// The uniform part of the field, which every cell adds.
///
/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_sheet(f: *mut BoxelField) -> f32 {
    field!(f).sheet()
}

/// Blocks in the window. Index them with `boxel_block_*` until the next step or deposit.
///
/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_blocks(f: *mut BoxelField) -> u32 {
    field!(f).awake() as u32
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_block_x(f: *mut BoxelField, i: u32) -> i32 {
    field!(f).block_at(i as usize).map_or(0, |b| b.0)
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_block_y(f: *mut BoxelField, i: u32) -> i32 {
    field!(f).block_at(i as usize).map_or(0, |b| b.1)
}

/// The 256 values of block `i`, row by row, sheet not included.
///
/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_block_data(f: *mut BoxelField, i: u32) -> *const f32 {
    match unsafe { f.as_ref() }.and_then(|h| h.field.block_at(i as usize)) {
        Some(b) => b.2.as_ptr(),
        None => std::ptr::null(),
    }
}

/// Blocks that left the window since `boxel_forget_freed`. Clear these before drawing the
/// blocks in the window.
///
/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_freed(f: *mut BoxelField) -> u32 {
    field!(f).freed().len() as u32
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_freed_x(f: *mut BoxelField, i: u32) -> i32 {
    field!(f).freed().get(i as usize).map_or(0, |b| b.0)
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_freed_y(f: *mut BoxelField, i: u32) -> i32 {
    field!(f).freed().get(i as usize).map_or(0, |b| b.1)
}

/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_forget_freed(f: *mut BoxelField) {
    field!(f).forget_freed()
}

/// The field's counters, refreshed by this call, in storage the handle owns.
///
/// # Safety
/// `f` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_stats(f: *mut BoxelField) -> *const BoxelStats {
    let Some(h) = (unsafe { f.as_mut() }) else { return std::ptr::null() };
    let (s, field) = (h.field.stats(), &h.field);
    h.stats = BoxelStats {
        steps: s.steps as f64,
        deposits: s.deposits as f64,
        merged: s.merged as f64,
        retired: s.retired as f64,
        stepped: s.stepped as f64,
        violations: s.violations as f64,
        blocks: field.awake() as f64,
        peak_blocks: s.peak_blocks as f64,
        live: field.live() as f64,
        bytes: field.bytes() as f64,
        bound: field.bound(),
        sheet: field.sheet() as f64,
    };
    &h.stats
}

// ---- the full computation, for checking and for comparison ---------------------------------

/// A dense reference over the cells `[x0, x0 + side)²`, or null if the spec is unstable.
#[unsafe(no_mangle)]
pub extern "C" fn boxel_grid_new(spread: f32, fade: f32, x0: i32, y0: i32, side: u32) -> *mut Grid {
    match Grid::new(spec(spread, fade, 0.5, 1), x0, y0, side as usize) {
        Ok(g) => Box::into_raw(Box::new(g)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `g` must come from `boxel_grid_new` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_grid_free(g: *mut Grid) {
    if !g.is_null() {
        drop(unsafe { Box::from_raw(g) });
    }
}

macro_rules! grid {
    ($g:ident) => {
        match unsafe { $g.as_mut() } {
            Some(g) => g,
            None => return Default::default(),
        }
    };
}

/// # Safety
/// `g` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_grid_deposit(g: *mut Grid, x: i32, y: i32, radius: u32, amount: f32) {
    grid!(g).deposit(x, y, radius, amount)
}

/// # Safety
/// `g` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_grid_rain(g: *mut Grid, amount: f32) {
    grid!(g).rain(amount)
}

/// # Safety
/// `g` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_grid_step(g: *mut Grid, steps: u32) {
    let g = grid!(g);
    for _ in 0..steps {
        g.step();
    }
}

/// Row `y` of the region (`side` values), sheet not included.
///
/// # Safety
/// `g` must be a live handle and `y` inside its region.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_grid_row(g: *mut Grid, y: i32) -> *const f32 {
    match unsafe { g.as_ref() } {
        Some(g) => g.row(y).as_ptr(),
        None => std::ptr::null(),
    }
}

/// # Safety
/// `g` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxel_grid_sheet(g: *mut Grid) -> f32 {
    grid!(g).sheet()
}
