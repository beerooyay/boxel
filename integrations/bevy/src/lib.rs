//! boxel fields in Bevy.
//!
//! Put a [`BoxelField`] on an entity and add the [`BoxelPlugin`]. The plugin steps every field at its own fixed rate
//! and keeps an [`Image`] of a window of the plane up to date: the blocks the engine holds are copied in, the ones it
//! lets go are cleared, and nothing else is touched. Sample the image in any material (R8, one texel a cell) and drive
//! the field with [`BoxelField::deposit`], [`BoxelField::drain`] and [`BoxelField::rain`].
//!
//! ```no_run
//! use bevy::prelude::*;
//! use boxel::Spec;
//! use boxel_bevy::{BoxelField, BoxelPlugin};
//!
//! fn setup(mut commands: Commands, mut images: ResMut<Assets<Image>>) {
//!     // glow in the moss: D = 8 cells²/s, k = 0.3/s, stepped 60 times a second, seen over 1024 × 1024 cells
//!     let spec = Spec { spread: 8.0 / 60.0, fade: 0.3 / 60.0, tolerance: 1.0 / 255.0, events: 64 };
//!     let glow = BoxelField::new(spec, 60.0, IVec2::splat(-512), 1024, &mut images).unwrap();
//!     commands.spawn(glow);
//! }
//!
//! fn walk(mut fields: Query<&mut BoxelField>) {
//!     for mut f in &mut fields {
//!         f.deposit(IVec2::new(3, -8), 2, 0.8);
//!     }
//! }
//!
//! App::new().add_plugins((DefaultPlugins, BoxelPlugin)).add_systems(Startup, setup).add_systems(Update, walk).run();
//! ```

use bevy::app::{App, Plugin, Update};
use bevy::asset::{Assets, Handle, RenderAssetUsages};
use bevy::ecs::prelude::*;
use bevy::image::Image;
use bevy::math::IVec2;
use bevy::time::Time;
use boxel::{Error, Field, Spec, Stats};
use wgpu_types::{Extent3d, TextureDimension, TextureFormat};

/// Steps every [`BoxelField`] and keeps its image current.
pub struct BoxelPlugin;

impl Plugin for BoxelPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, advance);
    }
}

/// One certified field, the rate it steps at, and the image of the window it is seen through.
#[derive(Component)]
pub struct BoxelField {
    field: Field,
    hz: f32,
    owed: f32,
    image: Handle<Image>,
    origin: IVec2,
    side: u32,
    touched: bool,
}

impl BoxelField {
    /// A field stepped `hz` times a second, seen through a `side` × `side` image whose first texel is the cell
    /// `origin`. The field itself has no edge; the image is only what gets drawn.
    pub fn new(spec: Spec, hz: f32, origin: IVec2, side: u32, images: &mut Assets<Image>) -> Result<BoxelField, Error> {
        let field = Field::new(spec)?;
        let size = Extent3d { width: side, height: side, depth_or_array_layers: 1 };
        let image =
            Image::new_fill(size, TextureDimension::D2, &[0], TextureFormat::R8Unorm, RenderAssetUsages::default());
        Ok(BoxelField { field, hz, owed: 0.0, image: images.add(image), origin, side, touched: false })
    }

    /// The image to sample: R8, one texel a cell.
    pub fn image(&self) -> &Handle<Image> {
        &self.image
    }

    /// Add `amount` on a disc of `radius` cells around `cell`.
    pub fn deposit(&mut self, cell: IVec2, radius: u32, amount: f32) {
        self.field.deposit(cell.x, cell.y, radius, amount);
        self.touched = true;
    }

    /// Take away up to `amount` on a disc of `radius` cells around `cell`.
    pub fn drain(&mut self, cell: IVec2, radius: u32, amount: f32) {
        self.field.drain(cell.x, cell.y, radius, amount);
        self.touched = true;
    }

    /// Add `amount` everywhere at once.
    pub fn rain(&mut self, amount: f32) {
        self.field.rain(amount);
        self.touched = true;
    }

    /// The field's value at `cell`.
    pub fn sample(&self, cell: IVec2) -> f32 {
        self.field.sample(cell.x, cell.y)
    }

    /// The certified bound on the error, at this step.
    pub fn bound(&self) -> f64 {
        self.field.bound()
    }

    pub fn stats(&self) -> Stats {
        self.field.stats()
    }

    /// The engine underneath, for anything this wrapper does not cover.
    pub fn field(&self) -> &Field {
        &self.field
    }

    /// Take the steps owed for `seconds`, a few at most, so a long frame never turns into a long stall.
    fn advance(&mut self, seconds: f32) -> bool {
        self.owed = (self.owed + seconds * self.hz).min(4.0);
        let n = self.owed as u32;
        self.owed -= n as f32;
        for _ in 0..n {
            self.field.step();
        }
        n > 0 || core::mem::take(&mut self.touched)
    }

    /// Copy the blocks the engine holds into `texels`, clear the ones it let go.
    fn paint(&mut self, texels: &mut [u8]) {
        let side = self.side as i32;
        let mut put = |bx: i32, by: i32, values: Option<&[f32; 256]>| {
            let (x0, y0) = (bx * 16 - self.origin.x, by * 16 - self.origin.y);
            if x0 < 0 || y0 < 0 || x0 + 16 > side || y0 + 16 > side {
                return;
            }
            for r in 0..16 {
                let row = &mut texels[((y0 + r) * side + x0) as usize..][..16];
                match values {
                    Some(v) => {
                        for (t, &c) in row.iter_mut().zip(&v[r as usize * 16..][..16]) {
                            *t = (c * 255.0 + 0.5).min(255.0) as u8;
                        }
                    }
                    None => row.fill(0),
                }
            }
        };
        for &(bx, by) in self.field.freed() {
            put(bx, by, None);
        }
        for (bx, by, values) in self.field.blocks() {
            put(bx, by, Some(values));
        }
        self.field.forget_freed();
    }
}

fn advance(time: Res<Time>, mut fields: Query<&mut BoxelField>, mut images: ResMut<Assets<Image>>) {
    let seconds = time.delta_secs();
    for mut f in &mut fields {
        if !f.advance(seconds) {
            continue;
        }
        let handle = f.image.clone();
        if let Some(mut image) = images.get_mut(&handle)
            && let Some(texels) = image.data.as_mut()
        {
            f.paint(texels);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::time::Duration;

    #[test]
    fn the_image_follows_the_field() {
        let mut app = App::new();
        app.add_plugins(BoxelPlugin).init_resource::<Assets<Image>>().init_resource::<Time>();
        let spec = Spec { spread: 8.0 / 60.0, fade: 0.3 / 60.0, tolerance: 1.0 / 255.0, events: 64 };
        let mut images = app.world_mut().resource_mut::<Assets<Image>>();
        let mut glow = BoxelField::new(spec, 60.0, IVec2::splat(-128), 256, &mut images).unwrap();
        glow.deposit(IVec2::new(10, -20), 2, 0.8);
        let handle = glow.image().clone();
        let entity = app.world_mut().spawn(glow).id();

        for _ in 0..30 {
            app.world_mut().resource_mut::<Time>().advance_by(Duration::from_secs_f32(1.0 / 60.0));
            app.update();
        }
        let images = app.world().resource::<Assets<Image>>();
        let texels = images.get(&handle).unwrap().data.as_ref().unwrap();
        let at = |x: i32, y: i32| texels[((y + 128) * 256 + x + 128) as usize];
        let field = app.world().get::<BoxelField>(entity).unwrap();
        assert!(at(10, -20) > 0);
        assert_eq!(at(10, -20), (field.sample(IVec2::new(10, -20)) * 255.0 + 0.5).min(255.0) as u8);
        assert_eq!(at(-100, 100), 0);
        assert!(field.bound() <= 1.0 / 255.0);
    }
}
