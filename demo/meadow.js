// Roots use one eight-byte record. Wind, pigment and bend parameters reuse one
// shuffled detail buffer across all tiles. Only visible tile prefixes are drawn.
const MEADOW_TILE = 16;
export const BLADE_HEIGHT_RANGE = 3.2;

// Grass grows in tufts. Tuft centres sit one to a cell of CLUMP metres, jittered by an integer hash that this module
// and the blade shader compute bit for bit alike, so the bake can gather sparse blades into the same tufts that the
// shader fans out.
export const CLUMP = 0.45;
function clumpHash(x, y) {
  let h = (Math.imul(x >>> 0, 1664525) + Math.imul(y >>> 0, 1013904223)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
// Save the neighbour containing the nearest tuft in four bits of the root.
export function readTuft(x, z, result, hashAt = clumpHash) {
  const qx = x/CLUMP, qz = z/CLUMP, ix = Math.floor(qx), iz = Math.floor(qz);
  let best = Infinity;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const h = hashAt(ix+i, iz+j);
    const dx = ix+i + 0.15 + 0.7*(h & 0xffff)/65536 - qx;
    const dz = iz+j + 0.15 + 0.7*(h >>> 16)/65536 - qz;
    const d2 = dx*dx + dz*dz;
    if (d2 < best) { best = d2; result.neighbour = 3*(j+1) + i+1; }
  }
  result.distance = Math.sqrt(best);
}
export const clumpGLSL = `
uint clumpHash(ivec2 c){
  uvec2 v = uvec2(c); uint h = v.x * 1664525u + v.y * 1013904223u;
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; return h ^ (h >> 16);
}
vec2 clumpOffset(uint h){ return 0.15 + 0.7 * vec2(float(h & 0xffffu), float(h >> 16)) / 65536.; }
`;

export function bakeMeadow({ gl, shader, half, density, heightRange, heightAt, habitatAt, outsideView, rng, touch }) {
  const tileSize = MEADOW_TILE, extent = 2 * half, side = extent + 1;
  // Habitat varies over metres. Evaluate it once per metre rather than running
  // the ground, slope and noise queries for every candidate blade.
  // per metre: cover, blade height, and nearness to a trodden tread
  const habitat = new Float32Array(side * side * 3);
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++)
    habitatAt(x - half, z - half, habitat, 3 * (z * side + x));

  const maxSide = Math.ceil(tileSize * Math.sqrt(density));
  const details = new Uint8Array(4 * maxSide * maxSide), detailRng = rng(9001);
  for (let i = 0; i < details.length; i++) details[i] = detailRng() * 256;
  const detailBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, detailBuffer); gl.bufferData(gl.ARRAY_BUFFER, details, gl.STATIC_DRAW);
  const detailLoc = gl.getAttribLocation(shader, 'aDetail'), rootLoc = gl.getAttribLocation(shader, 'aRoot');
  const scratch = new Uint16Array(details.length), orders = new Map(), tiles = [];
  const margin = Math.ceil(half/CLUMP) + 1, tuftSide = 2*margin + 1;
  const centres = new Uint32Array(tuftSide*tuftSide);
  for (let z = -margin, k = 0; z <= margin; z++)
    for (let x = -margin; x <= margin; x++) centres[k++] = clumpHash(x,z);
  const hashAt = (x,z) => centres[(z+margin)*tuftSide + x+margin];
  const tuft = { neighbour: 4, distance: 0 };
  let count = 0;
  for (let z0 = -half; z0 < half; z0 += tileSize) for (let x0 = -half; x0 < half; x0 += tileSize) {
    const minDistance = Math.max(x0, z0, -x0 - tileSize, -z0 - tileSize);
    const quality = Math.max(0.52, Math.min(1, 1 - (minDistance - 48) * 0.011));
    const n = Math.ceil(maxSide * Math.sqrt(quality)), cells = n * n;
    let order = orders.get(n);
    if (!order) {
      order = Uint16Array.from({ length: cells }, (_, i) => i);
      for (let i = cells - 1; i > 0; i--) {
        const j = Math.floor(detailRng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      orders.set(n, order);
    }
    const random = rng((x0 + half) * 1433 + (z0 + half) * 977 + 1234);
    const offsetX = Math.floor(random() * n), offsetZ = Math.floor(random() * n);
    let used = 0, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < cells; k++) {
      const cell = order[k];
      const x = x0 + ((cell % n + offsetX) % n + random()) * tileSize / n;
      const z = z0 + ((Math.floor(cell / n) + offsetZ) % n + random()) * tileSize / n;
      const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
      const a = 3 * ((iz + half) * side + ix + half), b = a + 3 * side;
      const w0 = (1 - fx) * (1 - fz), w1 = fx * (1 - fz), w2 = (1 - fx) * fz, w3 = fx * fz;
      let coverage = habitat[a] * w0 + habitat[a + 3] * w1 + habitat[b] * w2 + habitat[b + 3] * w3;
      const roll = random();
      if (roll >= coverage*(2-coverage)) continue;
      const rootX = Math.round((x/extent + 0.5)*65535), rootZ = Math.round((z/extent + 0.5)*65535);
      // Select the tuft at the position the GPU will decode.
      readTuft((rootX/65535 - 0.5)*extent, (rootZ/65535 - 0.5)*extent, tuft, hashAt);
      if (coverage < 0.98) coverage *= 1 + (1-coverage)*(1 - 3.4*Math.max(0, tuft.distance-0.12));
      if (roll >= coverage) continue;
      const blade = habitat[a+1]*w0 + habitat[a+4]*w1 + habitat[b+1]*w2 + habitat[b+4]*w3;
      const edge = habitat[a+2]*w0 + habitat[a+5]*w1 + habitat[b+2]*w2 + habitat[b+5]*w3;
      const y = heightAt(x, z) - 0.015;
      scratch[used++] = rootX;
      scratch[used++] = rootZ;
      scratch[used++] = Math.round((y-heightRange[0])*(65535/heightRange[1]));
      // Nine bits of height (6 mm increments), three of tread, four of tuft.
      scratch[used++] = Math.round(Math.min(1, blade*(0.91 + 0.18*random())/BLADE_HEIGHT_RANGE)*511)*128
        + Math.round(Math.min(1, Math.max(0,edge))*7)*16 + tuft.neighbour;
      y0 = Math.min(y, y0); y1 = Math.max(y, y1);
    }
    if (!used) continue;
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, scratch.subarray(0, used), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(rootLoc); gl.vertexAttribDivisor(rootLoc, 1);
    gl.vertexAttribPointer(rootLoc, 4, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, detailBuffer); gl.enableVertexAttribArray(detailLoc); gl.vertexAttribDivisor(detailLoc, 1);
    gl.vertexAttribPointer(detailLoc, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    tiles.push({ vao, x0, z0, y0: y0 - 0.1, y1: y1 + 2.2, pad: 2.2, count: used / 4 });
    count += used / 4;
  }
  gl.bindVertexArray(null); gl.useProgram(shader); gl.uniform2fv(shader.u('uGrassHeight'), heightRange);
  const widthLoc = shader.u('uLodW'), rowsLoc = shader.u('uBladeRows'), far = touch ? 72 : 84;
  return {
    count,
    draw(planes, eye, densityScale) {
      let drawn = 0;
      for (const tile of tiles) {
        const dx = Math.max(tile.x0 - eye[0], 0, eye[0] - tile.x0 - tileSize);
        const dz = Math.max(tile.z0 - eye[2], 0, eye[2] - tile.z0 - tileSize);
        const d2 = dx * dx + dz * dz;
        if (d2 >= far * far || outsideView(planes, tile, tileSize)) continue;
        const d = Math.sqrt(d2);
        const fade = Math.min(1, (far - d) / 22);
        // More blades near the eye, paid for by starting the thinning two metres sooner
        const fraction = Math.min(1, (15 / Math.max(1, d)) ** 1.8) * fade * densityScale;
        const n = Math.floor(tile.count * fraction);
        if (!n) continue;
        gl.bindVertexArray(tile.vao);
        gl.uniform1f(widthLoc, Math.min(2.2, 1 / Math.sqrt(fraction)));
        const rows = d < 9 ? 4 : d < 24 ? 3 : 2;
        gl.uniform1i(rowsLoc, rows);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, rows === 4 ? 27 : 2*rows + 1, n);
        drawn += n;
      }
      return drawn;
    },
  };
}
