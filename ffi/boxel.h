/* boxel: certified-locality diffusive fields.
 *
 * A field is a value on every cell of the integer plane that spreads to its four neighbours
 * and fades, stepped as  u' = (1 - 4*spread - fade)*u + spread*(sum of neighbours).
 * The reported bound limits the error against the full computation. Compare it with the
 * requested tolerance. The field steps only the 16 x 16 blocks inside its active window.
 *
 * Handles are opaque. Pointers returned into a field stay valid until the next call that
 * changes it (a deposit, drain, rain or step). Link against boxel_ffi (static or shared). */

#ifndef BOXEL_H
#define BOXEL_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BoxelField BoxelField;
typedef struct BoxelGrid BoxelGrid;

typedef struct BoxelStats {
    double steps, deposits, merged, retired, stepped, violations;
    double blocks, peak_blocks, live, bytes;
    double bound; /* current error bound; may exceed tolerance under heavy load */
    double sheet; /* the uniform part, added to every cell */
} BoxelStats;

/* spread: diffusion per step in cells^2 (D*dt/h^2); fade: fraction lost per step (k*dt);
 * 4*spread + fade must not exceed 1. events: live events per 1024 x 1024 district before
 * merging (64 is a good start). Returns NULL if the field cannot be certified. */
BoxelField *boxel_field_new(float spread, float fade, float tolerance, uint32_t events);
void boxel_field_free(BoxelField *f);

/* Amounts must be finite and positive. Other amounts leave the field unchanged. */
void boxel_deposit(BoxelField *f, int32_t x, int32_t y, uint32_t radius, float amount);
void boxel_drain(BoxelField *f, int32_t x, int32_t y, uint32_t radius, float amount);
void boxel_rain(BoxelField *f, float amount);
void boxel_step(BoxelField *f, uint32_t steps);
float boxel_sample(BoxelField *f, int32_t x, int32_t y);
float boxel_sheet(BoxelField *f);

/* The window: block i covers cells [16*x, 16*x + 16) x [16*y, 16*y + 16); data is 256 floats,
 * row by row, without the sheet. Freed blocks read zero now: clear them first. */
uint32_t boxel_blocks(BoxelField *f);
int32_t boxel_block_x(BoxelField *f, uint32_t i);
int32_t boxel_block_y(BoxelField *f, uint32_t i);
const float *boxel_block_data(BoxelField *f, uint32_t i);
uint32_t boxel_freed(BoxelField *f);
int32_t boxel_freed_x(BoxelField *f, uint32_t i);
int32_t boxel_freed_y(BoxelField *f, uint32_t i);
void boxel_forget_freed(BoxelField *f);

const BoxelStats *boxel_stats(BoxelField *f);

/* The full computation over [x0, x0 + side) by [y0, y0 + side), for checking and comparison. */
BoxelGrid *boxel_grid_new(float spread, float fade, int32_t x0, int32_t y0, uint32_t side);
void boxel_grid_free(BoxelGrid *g);
void boxel_grid_deposit(BoxelGrid *g, int32_t x, int32_t y, uint32_t radius, float amount);
void boxel_grid_rain(BoxelGrid *g, float amount);
void boxel_grid_step(BoxelGrid *g, uint32_t steps);
const float *boxel_grid_row(BoxelGrid *g, int32_t y);
float boxel_grid_sheet(BoxelGrid *g);

#ifdef __cplusplus
}
#endif

#endif
