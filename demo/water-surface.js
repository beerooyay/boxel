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
  const shore = c2.slice(), localCell = new Uint8Array(count);
  function neighbour(id, pixel) {
    const other = lookup[pixel];
    return other && Math.abs(levels[id] - levels[other]) < 0.35 ? other : id;
  }
  for (let k = 1; k < count; k++) {
    const p = texel[k],
      i = p % width;
    localCell[k] = (Math.floor(p / width) & 15) * TILE + (i & 15);
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
  // Bit 0 advances waves. Bit 1 also transports light on that wet tile.
  const dirty = active.slice(),
    excitation = new Float32Array(count);
  let remainder = 0, currentLayer = 1;
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
        active[(j >> 4) * tileCols + (i >> 4)] |= emission > 0 ? 3 : 1;
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
      for (let tile=j*tileCols+left; tile<=j*tileCols+right; tile++) active[tile] |= 1;
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
  function chargeCell(k,amount) {
    if (amount===0) return;
    excitation[k]=Math.min(1,excitation[k]+amount);
    const p=texel[k], row=Math.floor(p/width);
    active[(row>>4)*tileCols+((p%width)>>4)] |= 3;
  }
  function chargeRow(k, amount, left, centre, right) {
    chargeCell(west[k],amount*left);
    chargeCell(k,amount*centre);
    chargeCell(east[k],amount*right);
  }
  function stir(x,z,amount) {
    const k=locate(x,z);
    if (!k || amount<=0) return;
    // Quadratic B-spline weights share the charge across three cells on each
    // axis. The local peak rounds off smoothly as the contact crosses a centre.
    // Blocked neighbours return their share to the contacted reach.
    const pixel=texel[k];
    const fx=(x-x0)/step-(pixel%width+0.5);
    const fz=(z-z0)/step-(Math.floor(pixel/width)+0.5);
    const left=0.5*(0.5-fx)**2, right=0.5*(0.5+fx)**2, centre=0.75-fx*fx;
    chargeRow(north[k],amount*0.5*(0.5-fz)**2,left,centre,right);
    chargeRow(k,amount*(0.75-fz*fz),left,centre,right);
    chargeRow(south[k],amount*0.5*(0.5+fz)**2,left,centre,right);
  }
  function tick(windX, windZ, windAt) {
    currentLayer = 1 - currentLayer;
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
      const luminous = active[t] & 2;
      let awake = 0;
      dirty[t] |= 1 << currentLayer;
      for (const k of tiles[t]) {
        const l = west[k],
          r = east[k],
          n = north[k],
          s = south[k];
        const i = localCell[k] & 15, j = localCell[k] >> 4;
        const u = (i + 0.5) / TILE, w = (j + 0.5) / TILE;
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
        // Fresh charge releases half its light in about four water ticks.
        // The current transports the afterglow on its own, slower timescale.
        let glow = 0;
        if (luminous) {
          const lit = light[k], charge = excitation[k], release = 0.17 * charge;
          excitation[k] = charge - release;
          const advected = lit + wx*(light[upX]-lit) + wz*(light[upZ]-lit);
          // Turbulent mixing broadens the trace. An arriving ripple can excite
          // adjacent plankton along the same connected wet edges as the wave.
          const adjacent = light[l] + light[r] + light[n] + light[s];
          const difference = adjacent - 4*lit;
          const mixing = 0.032 * Math.max(0, 1-wx-wz);
          const strain = Math.min(0.36, 4.2 * Math.abs(vel));
          glow = Math.min(1, 0.968 * (advected + mixing*difference + strain*Math.max(0,difference)) + release);
        }
        previous[k] = heightNext;
        vNext[k] = vel;
        oldLight[k] = glow;
        const stillLit = luminous && glow + excitation[k] >= 0.00025;
        if (!stillLit && Math.abs(vel) + Math.abs(heightNext) * 6 < 0.0005) continue;
        const mask = stillLit ? 3 : 1;
        awake |= mask;
        if (i === 0 && l !== k) next[t - 1] |= mask;
        if (i === 15 && r !== k) next[t + 1] |= mask;
        if (j === 0 && n !== k) next[t - tileCols] |= mask;
        if (j === 15 && s !== k) next[t + tileCols] |= mask;
      }
      if (awake) next[t] |= awake;
      else {
        dirty[t] = 3;
        for (const k of tiles[t]) h[k] = previous[k] = v[k] = vNext[k] = light[k] = oldLight[k] = excitation[k] = 0;
      }
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
  function pack(tile, layer, bytes) {
    const f = layer === currentLayer ? h : previous;
    const d = layer === currentLayer ? light : oldLight;
    const base = layer * width * height;
    let changed = false;
    for (const k of tiles[tile]) {
      const i = (base + texel[k]) * 4;
      const red = 128 + Math.round(clamp(720 * f[k], -127, 127));
      const green = 128 + Math.round(clamp(((f[east[k]] - f[west[k]]) * 170) / step, -127, 127));
      const blue = 128 + Math.round(clamp(((f[south[k]] - f[north[k]]) * 170) / step, -127, 127));
      const alpha = Math.round(clamp(d[k], 0, 1) * 255);
      if (red === bytes[i] && green === bytes[i+1] && blue === bytes[i+2] && alpha === bytes[i+3]) continue;
      bytes[i] = red;
      bytes[i+1] = green;
      bytes[i+2] = blue;
      bytes[i+3] = alpha;
      changed = true;
    }
    return changed;
  }
  function reset() {
    h.fill(0);
    previous.fill(0);
    v.fill(0);
    vNext.fill(0);
    light.fill(0);
    oldLight.fill(0);
    for (let t = 0; t < tiles.length; t++) if (active[t] || dirty[t]) dirty[t] = 3;
    active.fill(0);
    next.fill(0);
    excitation.fill(0);
    remainder = 0;
    currentLayer = 1;
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
    get textureMix() {
      return currentLayer === 1 ? remainder / DT : 1 - remainder / DT;
    },
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
    let layers = 0;
    for (let tile = 0; tile < dirty.length; tile++) {
      const mask = dirty[tile];
      if (!mask) continue;
      let changed = 0;
      if ((mask & 1) && surface.pack(tile, 0, data)) changed |= 1;
      if ((mask & 2) && surface.pack(tile, 1, data)) changed |= 2;
      dirty[tile] = changed;
      layers |= changed;
    }
    if (!layers) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
    for (let layer = 0; layer < 2; layer++) {
      const bit = 1 << layer;
      if (!(layers & bit)) continue;
      for (let row = 0; row < tileRows; row++) {
        const rowStart = row * tileCols;
        for (let col = 0; col < tileCols;) {
          if (!(dirty[rowStart + col] & bit)) { col++; continue; }
          const x = col * TILE, y = row * TILE;
          do { col++; } while (col < tileCols && (dirty[rowStart + col] & bit));
          gl.texSubImage3D(target, 0, x, y, layer, Math.min(width, col * TILE) - x,
            Math.min(TILE, height - y), 1, gl.RGBA, gl.UNSIGNED_BYTE, data,
            ((layer * height + y) * width + x) * 4);
        }
      }
    }
    dirty.fill(0);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
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
