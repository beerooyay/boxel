// The near terrain has two grid intervals per coarse quad. Keep every fine
// vertex on a patch edge so neighbouring patches can choose their levels independently.
export function coarsePatch(indices, cursor, positions, stride, x0, z0, x1, z1) {
  let error = 0;
  const height = vertex => positions[3 * vertex + 1];
  const triangle = (a, b, c) => {
    indices[cursor++] = a; indices[cursor++] = b; indices[cursor++] = c;
  };
  for (let z = z0; z < z1; z += 2) for (let x = x0; x < x1; x += 2) {
    const a = z * stride + x, b = a + 2, c = a + 2 * stride, e = c + 2, mid = a + stride + 1;
    const left = x === x0, right = x + 2 === x1, top = z === z0, bottom = z + 2 === z1;
    const ha = height(a), hb = height(b), hc = height(c), he = height(e);
    if (!left) error = Math.max(error, Math.abs(height(a + stride) - (ha + hc) / 2));
    if (!right) error = Math.max(error, Math.abs(height(b + stride) - (hb + he) / 2));
    if (!top) error = Math.max(error, Math.abs(height(a + 1) - (ha + hb) / 2));
    if (!bottom) error = Math.max(error, Math.abs(height(c + 1) - (hc + he) / 2));
    if (!left && !right && !top && !bottom) {
      triangle(a, c, b); triangle(b, c, e);
      error = Math.max(error, Math.abs(height(mid) - (hb + hc) / 2));
      continue;
    }
    // Two spokes cross a fine diagonal halfway through a cell. Include the
    // height difference there as well as at the omitted grid vertices.
    const hm = height(mid);
    error = Math.max(error, Math.abs(ha + hm - height(a + 1) - height(a + stride)) / 2,
      Math.abs(he + hm - height(c + 1) - height(b + stride)) / 2);
    if (left) { triangle(mid, a, a + stride); triangle(mid, a + stride, c); } else triangle(mid, a, c);
    if (bottom) { triangle(mid, c, c + 1); triangle(mid, c + 1, e); } else triangle(mid, c, e);
    if (right) { triangle(mid, e, b + stride); triangle(mid, b + stride, b); } else triangle(mid, e, b);
    if (top) { triangle(mid, b, a + 1); triangle(mid, a + 1, a); } else triangle(mid, b, a);
  }
  return { cursor, error };
}
