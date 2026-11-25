// Project each visible patch, including the edges sliced by the near plane.
// A patch under the player's feet can cross the eye in a single walking frame.
const corners = new Float64Array(8 * 3);
export function waterBounds(patches, vp, planes, outsideView, near, width, height) {
  let left = 1, bottom = 1, right = -1, top = -1;
  function include(x, y, w) {
    const u = x / w, v = y / w;
    left = Math.min(left, u); right = Math.max(right, u);
    bottom = Math.min(bottom, v); top = Math.max(top, v);
  }
  for (const patch of patches) {
    if (outsideView(planes, patch, patch.width, patch.depth)) continue;
    let front = 0;
    for (let i = 0; i < 8; i++) {
      const x = patch.x0 + (i & 1) * patch.width, y = i & 2 ? patch.y1 : patch.y0;
      const z = patch.z0 + (i >> 2) * patch.depth, k = 3 * i;
      const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
      const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
      const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      corners[k] = cx; corners[k + 1] = cy; corners[k + 2] = w;
      if (w >= near) { include(cx, cy, w); front++; }
    }
    if (!front || front === 8) continue;
    for (let i = 0; i < 8; i++) for (const axis of [1, 2, 4]) {
      if (i & axis) continue;
      const a = 3 * i, b = 3 * (i | axis), w = corners[a + 2], next = corners[b + 2];
      if ((w >= near) === (next >= near)) continue;
      const t = (near - w) / (next - w);
      include(corners[a] + t * (corners[b] - corners[a]), corners[a + 1] + t * (corners[b + 1] - corners[a + 1]), near);
    }
  }
  if (left > right || bottom > top) return null;
  // The water shader bends a lookup by at most 0.16 screen heights.
  // Allow two half-resolution texels for bilinear filtering and rounding.
  const pad = 0.16 * height + 4;
  return [Math.max(0, 0.5 + 0.5 * left - pad / width), Math.max(0, 0.5 + 0.5 * bottom - pad / height),
    Math.min(1, 0.5 + 0.5 * right + pad / width), Math.min(1, 0.5 + 0.5 * top + pad / height)];
}
