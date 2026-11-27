// Small surface disturbances move with the current on a fixed wet grid. A dry bank,
// an emerged rock or a lip between two water levels reflects the outgoing wave.
const TILE = 16;
const DT = 1 / 30;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const basinGrid = { x0: -58, z0: -122, step: 0.24, width: 432, height: 736 };

export function createWaterSurface(grid, bedAt) {
  const { x0, z0, width, height, step } = grid;
  const tileCols = Math.ceil(width / TILE),
    tileRows = Math.ceil(height / TILE);
  const tiles = Array.from({ length: tileCols * tileRows }, () => []);
  const lookup = new Int32Array(width * height);
  const depths = [0],
    levels = [0],
    vx = [0],
    vz = [0],
    pixels = [0];
  const bed = {};
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      bedAt(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step, bed);
      if (!(bed.depth > 0.013)) continue;
      const id = depths.length,
        pixel = j * width + i;
      lookup[pixel] = id;
      pixels.push(pixel);
      depths.push(bed.depth);
      levels.push(bed.level);
      vx.push(bed.vx);
      vz.push(bed.vz);
      tiles[(j >> 4) * tileCols + (i >> 4)].push(id);
    }
  const count = depths.length,
    texel = Int32Array.from(pixels);
  const west = new Int32Array(count),
    east = west.slice(),
    north = west.slice(),
    south = west.slice();
  const c2 = new Float32Array(count),
    damping = c2.slice(),
    flowX = Float32Array.from(vx),
    flowZ = Float32Array.from(vz);
  const shore = c2.slice();
  function neighbour(id, pixel) {
    const other = lookup[pixel];
    return other && Math.abs(levels[id] - levels[other]) < 0.35 ? other : id;
  }
  for (let k = 1; k < count; k++) {
    const p = texel[k],
      i = p % width;
    west[k] = i === 0 ? k : neighbour(k, p - 1);
    east[k] = i === width - 1 ? k : neighbour(k, p + 1);
    north[k] = neighbour(k, p - width);
    south[k] = neighbour(k, p + width);
    c2[k] = (clamp(9.81 * depths[k], 0.32, 4.2) * DT) / (step * step);
    damping[k] = Math.exp(-DT * (0.54 + 0.15 / Math.max(0.1, depths[k])));
    shore[k] = Math.min(1, depths[k] * 2.3);
  }
  let h = c2.slice().fill(0),
    previous = h.slice(),
    v = h.slice(),
    vNext = h.slice();
  let light = h.slice(),
    oldLight = h.slice(),
    active = new Uint8Array(tiles.length),
    next = active.slice();
  const dirty = active.slice(),
    excitation = new Float32Array(count);
  let remainder = 0;
  function locate(x, z) {
    const i = Math.floor((x - x0) / step),
      j = Math.floor((z - z0) / step);
    return i >= 0 && j >= 0 && i < width && j < height ? lookup[j * width + i] : 0;
  }
  function touch(x, z, strength, emission = 0) {
    const source = locate(x, z);
    if (!source) return false;
    const radius = Math.max(0.3, Math.min(0.52, 0.3 + 0.11 * Math.abs(strength)));
    const minI = Math.max(0, Math.floor((x - x0 - radius) / step));
    const minJ = Math.max(0, Math.floor((z - z0 - radius) / step));
    const maxI = Math.min(width - 1, Math.floor((x - x0 + radius) / step));
    const maxJ = Math.min(height - 1, Math.floor((z - z0 + radius) / step));
    for (let j = minJ; j <= maxJ; j++)
      for (let i = minI; i <= maxI; i++) {
        const id = lookup[j * width + i];
        if (!id || Math.abs(levels[id] - levels[source]) >= 0.35) continue;
        const r2 = (((i + 0.5) * step + x0 - x) ** 2 + ((j + 0.5) * step + z0 - z) ** 2) / (radius * radius);
        if (r2 >= 1) continue;
        const weight = (1 - r2) ** 2;
        // A depression with a raised rim launches a signed wave packet.
        v[id] = clamp(v[id] - strength * 3.0 * weight * (1 - 3.8 * r2), -2.4, 2.4);
        excitation[id] = Math.min(1, excitation[id] + emission * weight);
        active[(j >> 4) * tileCols + (i >> 4)] = 1;
      }
    return true;
  }
  // A moving chest presses water down and out. Apply the discrete Laplacian of
  // its pressure footprint: every push down is balanced by a push into wet
  // neighbours. The wave solver carries the bow and stern waves after a turn.
  function swim(x, z, vx, vz, dt, body) {
    pressure(x,z,vx,vz,dt,body.halfLength,body.halfWidth,0.27*body.draft);
  }
  function pressure(x, z, vx, vz, dt, halfLength, halfWidth, headLimit) {
    const source = locate(x, z);
    if (!source) return;
    const dx = vx - flowX[source], dz = vz - flowZ[source];
    const speed = Math.hypot(dx, dz);
    if (speed < 0.04) return;
    const fx = dx / speed, fz = dz / speed;
    // Integrate over several samples even for the narrowest swimmer.
    const length = halfLength + 1.25 * step, widthAtChest = halfWidth + step;
    const head = Math.min(headLimit, speed * speed / (2 * 9.81));
    const impulse = c2[source] * head * (dt / DT);
    const reach = Math.max(length, 1.18 * widthAtChest);
    const minI = Math.max(0, Math.floor((x - reach - x0) / step));
    const maxI = Math.min(width - 1, Math.floor((x + reach - x0) / step));
    const minJ = Math.max(0, Math.floor((z - reach - z0) / step));
    const maxJ = Math.min(height - 1, Math.floor((z + reach - z0) / step));
    for (let j = minJ; j <= maxJ; j++) {
      const rz = z0 + (j + 0.5) * step - z;
      for (let i = minI; i <= maxI; i++) {
        const k = lookup[j * width + i];
        if (!k || Math.abs(levels[k] - levels[source]) >= 0.35) continue;
        const rx = x0 + (i + 0.5) * step - x;
        const along = (rx * fx + rz * fz) / length;
        const across = (rx * fz - rz * fx) / (widthAtChest * (1 + 0.18 * along));
        const kernel = 1 - along * along - across * across;
        if (kernel <= 0) continue;
        const push = impulse * kernel * kernel;
        v[k] -= 4 * push;
        v[west[k]] += push; v[east[k]] += push;
        v[north[k]] += push; v[south[k]] += push;
      }
    }
    // The four neighbours can belong to the next tile.
    const left = Math.max(0, minI - 1) >> 4, right = Math.min(width - 1, maxI + 1) >> 4;
    const bottom = Math.min(height - 1, maxJ + 1) >> 4;
    for (let j = Math.max(0, minJ - 1) >> 4; j <= bottom; j++) {
      active.fill(1, j * tileCols + left, j * tileCols + right + 1);
    }
  }
  function contactAt(x,z,out) {
    const k=locate(x,z);
    if (!k) return false;
    out.height=h[k];
    out.slopeX=(h[east[k]]-h[west[k]])/(2*step);
    out.slopeZ=(h[south[k]]-h[north[k]])/(2*step);
    out.vx=flowX[k]; out.vz=flowZ[k];
    return true;
  }
  function stir(x,z,amount) {
    const k=locate(x,z);
    if (!k) return;
    excitation[k]=Math.min(1,excitation[k]+amount);
    const p=texel[k], row=Math.floor(p/width);
    active[(row>>4)*tileCols+((p%width)>>4)]=1;
  }
  function tick(windX, windZ, windAt) {
    next.fill(0);
    for (let t = 0; t < tiles.length; t++) {
      if (!active[t]) continue;
      const left = x0 + (t % tileCols) * TILE * step,
        top = z0 + Math.floor(t / tileCols) * TILE * step,
        side = TILE * step;
      const nw = windAt ? windAt(left, top) : 1,
        ne = windAt ? windAt(left + side, top) : 1;
      const sw = windAt ? windAt(left, top + side) : 1,
        se = windAt ? windAt(left + side, top + side) : 1;
      let awake = false;
      dirty[t] = 1;
      for (const k of tiles[t]) {
        const l = west[k],
          r = east[k],
          n = north[k],
          s = south[k];
        const p = texel[k],
          i = p % width,
          j = Math.floor(p / width);
        const u = ((i & 15) + 0.5) / TILE,
          w = ((j & 15) + 0.5) / TILE;
        const gust = ((nw + (ne - nw) * u) * (1 - w) + (sw + (se - sw) * u) * w) * shore[k];
        const ax = ((flowX[k] + windX * gust) * DT) / step,
          az = ((flowZ[k] + windZ * gust) * DT) / step;
        const upX = ax < 0 ? r : l,
          upZ = az < 0 ? s : n,
          wx = Math.abs(ax),
          wz = Math.abs(az);
        const lap = h[l] + h[r] + h[n] + h[s] - 4 * h[k];
        const vel = (v[k] + wx * (v[upX] - v[k]) + wz * (v[upZ] - v[k]) + c2[k] * lap) * damping[k];
        const heightNext = h[k] + wx * (h[upX] - h[k]) + wz * (h[upZ] - h[k]) + DT * vel;
        const dye = Math.min(
          1,
          (light[k] + wx * (light[upX] - light[k]) + wz * (light[upZ] - light[k])) * 0.9802 + excitation[k]
        );
        excitation[k] = 0;
        previous[k] = heightNext;
        vNext[k] = vel;
        oldLight[k] = dye;
        if (Math.abs(vel) + Math.abs(heightNext) * 6 + dye < 0.0005) continue;
        awake = true;
        if ((i & 15) === 0 && l !== k) next[t - 1] = 1;
        if ((i & 15) === 15 && r !== k) next[t + 1] = 1;
        if ((j & 15) === 0 && n !== k) next[t - tileCols] = 1;
        if ((j & 15) === 15 && s !== k) next[t + tileCols] = 1;
      }
      if (awake) next[t] = 1;
      else for (const k of tiles[t]) h[k] = previous[k] = v[k] = vNext[k] = light[k] = oldLight[k] = 0;
    }
    [h, previous] = [previous, h];
    [v, vNext] = [vNext, v];
    [light, oldLight] = [oldLight, light];
    [active, next] = [next, active];
  }
  function advance(dt, windX = 0, windZ = 0, windAt = null) {
    remainder += dt;
    while (remainder + 1e-10 >= DT) {
      tick(windX, windZ, windAt);
      remainder = Math.max(0, remainder - DT);
    }
  }
  function pack(tile, bytes) {
    for (const k of tiles[tile]) {
      const p = texel[k] * 4,
        l = west[k],
        r = east[k],
        n = north[k],
        s = south[k];
      for (let frame = 0; frame < 2; frame++) {
        const f = frame ? h : previous,
          d = frame ? light : oldLight,
          i = p + frame * width * height * 4;
        bytes[i] = 128 + Math.round(clamp(720 * f[k], -127, 127));
        bytes[i + 1] = 128 + Math.round(clamp(((f[r] - f[l]) * 170) / step, -127, 127));
        bytes[i + 2] = 128 + Math.round(clamp(((f[s] - f[n]) * 170) / step, -127, 127));
        bytes[i + 3] = Math.round(clamp(d[k], 0, 1) * 255);
      }
    }
  }
  function reset() {
    h.fill(0);
    previous.fill(0);
    v.fill(0);
    vNext.fill(0);
    light.fill(0);
    oldLight.fill(0);
    for (let t = 0; t < tiles.length; t++) if (active[t]) dirty[t] = 1;
    active.fill(0);
    next.fill(0);
    excitation.fill(0);
    remainder = 0;
  }
  return {
    touch,
    swim,
    pressure,
    contactAt,
    stir,
    advance,
    reset,
    pack,
    grid,
    tileCols,
    tileRows,
    dirty,
    get fraction() {
      return remainder / DT;
    },
    sample(x, z) {
      const k = locate(x, z);
      return { wet: !!k, height: h[k], light: light[k] };
    }
  };
}

// Both fixed ticks are in the same array texture so crests can be interpolated at
// display rate. Upload adjoining dirty blocks as one run and leave dry land alone.
export function waterTexture(gl, surface, unit) {
  const { width, height } = surface.grid,
    data = new Uint8Array(width * height * 8);
  data.fill(128);
  for (let i = 3; i < data.length; i += 4) data[i] = 0;
  const tex = gl.createTexture(),
    target = gl.TEXTURE_2D_ARRAY;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(target, tex);
  gl.texStorage3D(target, 1, gl.RGBA8, width, height, 2);
  gl.texSubImage3D(target, 0, 0, 0, 0, width, height, 2, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return function upload() {
    const { dirty, tileCols, tileRows } = surface;
    if (!dirty.includes(1)) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, height);
    for (let row = 0; row < tileRows; row++)
      for (let col = 0; col < tileCols; ) {
        if (!dirty[row * tileCols + col]) {
          col++;
          continue;
        }
        const x = col * TILE,
          y = row * TILE;
        do {
          const tile = row * tileCols + col++;
          surface.pack(tile, data);
          dirty[tile] = 0;
        } while (col < tileCols && dirty[row * tileCols + col]);
        gl.texSubImage3D(
          target,
          0,
          x,
          y,
          0,
          Math.min(width, col * TILE) - x,
          Math.min(TILE, height - y),
          2,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          data,
          (y * width + x) * 4
        );
      }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
  };
}

export const waterSurfaceGLSL = `
uniform highp sampler2DArray uSurface;
uniform float uSurfaceMix;
vec4 surfaceAt(vec2 p) {
  vec2 uv=(p-vec2(${basinGrid.x0}.,${basinGrid.z0}.))/vec2(${basinGrid.width * basinGrid.step},${basinGrid.height * basinGrid.step});
  vec4 a=textureLod(uSurface,vec3(uv,0.),0.), b=textureLod(uSurface,vec3(uv,1.),0.);
  vec4 f=mix(a,b,uSurfaceMix);
  return vec4((f.rgb*255.-128.)/vec3(720.,340.,340.),f.a);
}`;
