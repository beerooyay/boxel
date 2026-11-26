// A world-aligned eight-metre patch stores the horizontal deflection of flexible
// vegetation. Only touched cells carry springs. The renderer samples the same
// bilinear field for grass, fronds and leaves in both views.
const SIZE = 32, PER_METRE = 4, STEP = 1 / 30;
export class BrushField {
  size = SIZE;
  bytes = new Uint8Array(SIZE * SIZE * 4);
  cells = new Map();
  dirty = true;
  carry = 0;
  last = null;

  constructor() { this.reset(); }
  reset() {
    this.cells.clear();
    this.last = null;
    this.carry = 0;
    for (let i = 0; i < this.bytes.length; i += 4) {
      this.bytes[i] = this.bytes[i + 1] = 128;
      this.bytes[i + 2] = this.bytes[i + 3] = 0;
    }
    this.dirty = true;
  }

  advance(x, y, z, dt) {
    if (this.last && Math.hypot(x - this.last.x, z - this.last.z) > 2) this.reset();
    const last = this.last ??= { x, y, z };
    const dx = x - last.x, dz = z - last.z, distance = Math.hypot(dx, dz);
    const speed = distance / Math.max(dt, 0.001), weight = Math.min(0.35, speed * 0.12) / Math.max(0.001, distance);
    this.carry += dt;
    while (this.carry + 1e-9 >= STEP) {
      this.carry = Math.max(0, this.carry - STEP);
      const u = Math.min(1, Math.max(0, 1 - this.carry / dt));
      this.step(last.x + dx * u, last.y + (y - last.y) * u, last.z + dz * u, dx * weight, dz * weight);
    }
    last.x = x; last.y = y; last.z = z;
  }

  step(x, y, z, pushX, pushZ) {
    const radius = 0.69, cx = Math.floor(x * PER_METRE), cz = Math.floor(z * PER_METRE);
    for (let iz = cz - 3; iz <= cz + 3; iz++) for (let ix = cx - 3; ix <= cx + 3; ix++) {
      const wx = (ix + 0.5) / PER_METRE, wz = (iz + 0.5) / PER_METRE;
      if ((wx - x) ** 2 + (wz - z) ** 2 >= radius * radius) continue;
      const key = (iz & (SIZE - 1)) * SIZE + (ix & (SIZE - 1)), old = this.cells.get(key);
      if (!old || old.x !== wx || old.z !== wz) {
        this.cells.set(key, { x: wx, z: wz, y, bx: 0, bz: 0, vx: 0, vz: 0, press: 0 });
      }
    }
    for (const [key, c] of this.cells) {
      const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, dz);
      const f = Math.max(0, 1 - d / radius), pressure = f * f * (3 - 2 * f);
      const stiffness = pressure > 0 ? 245 : 72, damping = pressure > 0 ? 21 : 10;
      const radial = 0.93 / Math.max(0.17, d);
      c.vx = (c.vx + ((dx * radial + pushX) * pressure - c.bx) * stiffness * STEP) / (1 + damping * STEP);
      c.vz = (c.vz + ((dz * radial + pushZ) * pressure - c.bz) * stiffness * STEP) / (1 + damping * STEP);
      c.bx += c.vx * STEP; c.bz += c.vz * STEP;
      c.press += (pressure - c.press) * (pressure > c.press ? 0.54 : 0.16);
      if (pressure > 0) c.y = y;
      const resting = pressure === 0 && c.press < 0.004 && Math.abs(c.bx) + Math.abs(c.bz) < 0.004 && Math.abs(c.vx) + Math.abs(c.vz) < 0.03;
      const keep = !resting && Math.max(Math.abs(dx), Math.abs(dz)) < 3.75;
      const r = keep ? 128 + Math.round(Math.min(1, Math.max(-1, c.bx)) * 127) : 128;
      const g = keep ? 128 + Math.round(Math.min(1, Math.max(-1, c.bz)) * 127) : 128;
      // Alpha carries support and compression. Premultiply the contact height so
      // bilinear sampling at the edge of a footprint keeps the correct elevation.
      const a = keep ? Math.round(64 + 191 * c.press) : 0;
      const b = Math.round(Math.min(1, Math.max(0, (c.y + 8) / 48)) * a);
      const i = key * 4, bytes = this.bytes;
      if (bytes[i] !== r || bytes[i + 1] !== g || bytes[i + 2] !== b || bytes[i + 3] !== a) {
        bytes[i] = r; bytes[i + 1] = g; bytes[i + 2] = b; bytes[i + 3] = a; this.dirty = true;
      }
      if (!keep) this.cells.delete(key);
    }
  }
}
