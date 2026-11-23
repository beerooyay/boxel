//! Advance each Boxel field once per Bevy fixed tick. Configure the host's fixed clock to
//! match the step used to construct the field spec. Schedule deposits before [BoxelStep]
//! and readers after it. A consumer of retired tiles should call `forget_freed()` after
//! handling the removal list. A host without a tile cache can clear the list after every tick.
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
    }
}

fn step_fields(mut fields: Query<&mut BoxelField>) {
    for mut field in &mut fields {
        field.0.step();
    }
}
