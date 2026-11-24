//! Advance each Boxel field once per Bevy fixed tick. Configure the host's fixed clock to
//! match the step used to construct the field spec. Schedule deposits before [BoxelStep]
//! and readers after it.
//!
//! Fields step in parallel with each other on Bevy's task pool, and each large window splits
//! its own blocks across cores too; a field holds the same bits either way.
//!
//! With the `image` feature (on by default), give an entity a [BoxelImage] beside its field and
//! the plugin keeps an R8 texture of a window of the plane current, one 16 × 16 block at a time:
//! the blocks the engine holds are copied in, the ones it lets go are cleared. Sample it in any
//! material. A host that keeps its own tile cache instead reads `freed()` and calls
//! `forget_freed()` itself.
//!
//! ```
//! use bevy_app::{App, FixedUpdate};
//! use boxel::{Field, Spec};
//! use boxel_bevy::{BoxelField, BoxelPlugin};
//!
//! let mut app = App::new();
//! app.add_plugins(BoxelPlugin);
//! let mut glow = Field::new(Spec::physical(0.1, 0.3, 0.125, 1.0 / 60.0, 1.0 / 255.0)).unwrap();
//! glow.deposit(2, -4, 1, 0.8);
//! let id = app.world_mut().spawn(BoxelField(glow)).id();
//! app.world_mut().run_schedule(FixedUpdate);
//! assert_eq!(app.world().get::<BoxelField>(id).unwrap().0.stats().steps, 1);
//! ```
use bevy_app::{App, FixedUpdate, Plugin};
use bevy_ecs::prelude::*;

/// A certified Boxel field in cell coordinates.
#[derive(Component)]
pub struct BoxelField(pub boxel::Field);

/// Systems can order their deposits and reads around the simulation step.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct BoxelStep;

pub struct BoxelPlugin;

impl Plugin for BoxelPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(FixedUpdate, step_fields.in_set(BoxelStep));
        #[cfg(feature = "image")]
        app.add_systems(bevy_app::PostUpdate, image::paint);
    }
}

fn step_fields(mut fields: Query<&mut BoxelField>) {
    fields.par_iter_mut().for_each(|mut field| field.0.step());
}

#[cfg(feature = "image")]
pub use image::BoxelImage;

#[cfg(feature = "image")]
mod image {
    use super::BoxelField;
    use bevy_asset::{Assets, Handle, RenderAssetUsages};
    use bevy_ecs::prelude::*;
    use bevy_image::Image;
    use bevy_math::IVec2;
    use wgpu_types::{Extent3d, TextureDimension, TextureFormat};

    /// The texture of a window of a field: R8, one texel a cell, `side` cells a side, its first
    /// texel the cell `origin`. The field has no edge; the image is only what gets drawn.
    #[derive(Component)]
    pub struct BoxelImage {
        pub image: Handle<Image>,
        pub origin: IVec2,
        pub side: u32,
    }

    impl BoxelImage {
        /// A cleared texture for the window, added to `images`.
        pub fn new(origin: IVec2, side: u32, images: &mut Assets<Image>) -> BoxelImage {
            let size = Extent3d { width: side, height: side, depth_or_array_layers: 1 };
            let image =
                Image::new_fill(size, TextureDimension::D2, &[0], TextureFormat::R8Unorm, RenderAssetUsages::default());
            BoxelImage { image: images.add(image), origin, side }
        }

        /// Copy the blocks the engine holds into `texels`, clear the ones it let go.
        fn paint(&self, field: &mut boxel::Field, texels: &mut [u8]) {
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
            for &(bx, by) in field.freed() {
                put(bx, by, None);
            }
            for (bx, by, values) in field.blocks() {
                put(bx, by, Some(values));
            }
            field.forget_freed();
        }
    }

    /// Bring every window up to date, once a frame, after whatever steps the frame took.
    pub(crate) fn paint(mut fields: Query<(&mut BoxelField, &BoxelImage)>, mut images: ResMut<Assets<Image>>) {
        for (mut field, window) in &mut fields {
            if let Some(mut image) = images.get_mut(&window.image)
                && let Some(texels) = image.data.as_mut()
            {
                window.paint(&mut field.0, texels);
            }
        }
    }
}

#[cfg(all(test, feature = "image"))]
mod tests {
    use super::*;
    use bevy_app::PostUpdate;
    use bevy_asset::Assets;
    use bevy_image::Image;
    use bevy_math::IVec2;
    use boxel::{Field, Spec};

    #[test]
    fn the_image_follows_the_field() {
        let mut app = App::new();
        app.add_plugins(BoxelPlugin).init_resource::<Assets<Image>>();
        let spec = Spec { spread: 8.0 / 60.0, fade: 0.3 / 60.0, tolerance: 1.0 / 255.0, events: 64 };
        let mut glow = Field::new(spec).unwrap();
        glow.deposit(10, -20, 2, 0.8);
        let window = BoxelImage::new(IVec2::splat(-128), 256, &mut app.world_mut().resource_mut::<Assets<Image>>());
        let handle = window.image.clone();
        let entity = app.world_mut().spawn((BoxelField(glow), window)).id();
        for _ in 0..30 {
            app.world_mut().run_schedule(FixedUpdate);
        }
        app.world_mut().run_schedule(PostUpdate);
        let texels = app.world().resource::<Assets<Image>>().get(&handle).unwrap().data.clone().unwrap();
        let at = |x: i32, y: i32| texels[((y + 128) * 256 + x + 128) as usize];
        let field = &app.world().get::<BoxelField>(entity).unwrap().0;
        assert!(at(10, -20) > 0);
        assert_eq!(at(10, -20), (field.sample(10, -20) * 255.0 + 0.5).min(255.0) as u8);
        assert_eq!(at(-100, 100), 0);
        assert!(field.bound() <= 1.0 / 255.0);
    }
}
