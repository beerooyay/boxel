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

// The close inspection plot draws one strip per real leaf. Dormant siblings
// need no vertices, and two-metre bins can leave the view independently.
function plotBatch(gl, roots, details, order, grid, x0, z0, y0, y1) {
  const bytes=new Uint8Array(order.length*3*16);
  const words=new Uint16Array(bytes.buffer);
  let stems=0;
  for (const i of order) {
    const choice=details[4*i+3]/255;
    const leaves=choice<=0.28 ? 1 : choice<=0.52 ? 2 : 3;
    for(let sibling=0;sibling<leaves;sibling++,stems++) {
      words.set(roots.subarray(4*i,4*i+4),8*stems);
      bytes.set(details.subarray(4*i,4*i+4),16*stems+8);
      bytes[16*stems+12]=sibling;
    }
  }
  const vao=gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER,bytes.subarray(0,16*stems),gl.STATIC_DRAW);
  gl.vertexAttribPointer(0,4,gl.UNSIGNED_SHORT,true,16,0);
  gl.vertexAttribPointer(1,4,gl.UNSIGNED_BYTE,true,16,8);
  gl.vertexAttribPointer(2,1,gl.UNSIGNED_BYTE,false,16,12);
  for(let slot=0;slot<3;slot++) { gl.enableVertexAttribArray(slot); gl.vertexAttribDivisor(slot,1); }
  return {vao,grid,x0,z0,y0,y1,pad:0.85,count:order.length,stems};
}

export function bakeMeadow({ gl, shader, half, density, heightRange, heightAt, habitatAt, outsideView, rng, touch, plot, contact }) {
  const tileSize = MEADOW_TILE, extent = 2 * half, side = extent + 1;
  // Quantization must preserve the stratum. It supplies each actual root's stable GPU address.
  function encodeRoot(value, origin, n) {
    const lane = Math.floor((value-origin)*n/tileSize);
    const first = (origin+half + lane*tileSize/n)*65535/extent;
    const last = first + tileSize/n*65535/extent;
    return Math.max(Math.ceil(first+0.008), Math.min(Math.floor(last-0.008), Math.round((value+half)*65535/extent)));
  }
  // Habitat varies over metres. Evaluate it once per metre rather than running
  // the ground, slope and noise queries for every candidate blade.
  // per metre: cover, blade height, and nearness to a trodden tread
  const habitat = new Float32Array(side * side * 3);
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++)
    habitatAt(x - half, z - half, habitat, 3 * (z * side + x));

  const contactBins = new Map(), binSize = 2, binsPerTile = tileSize/binSize;
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
  const binCounts = new Uint16Array(binsPerTile*binsPerTile), binIds=new Uint8Array(maxSide*maxSide);
  let count = 0;
  for (let z0 = -half; z0 < half; z0 += tileSize) for (let x0 = -half; x0 < half; x0 += tileSize) {
    if (plot && (x0 >= plot.x+plot.half || x0+tileSize <= plot.x-plot.half ||
                 z0 >= plot.z+plot.half || z0+tileSize <= plot.z-plot.half)) continue;
    const minDistance = Math.max(x0, z0, -x0 - tileSize, -z0 - tileSize);
    const quality = Math.max(0.52, Math.min(1, 1 - (minDistance - 48) * 0.011));
    const n = plot ? maxSide : Math.ceil(maxSide * Math.sqrt(quality)), cells = n * n;
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
    binCounts.fill(0);
    let used = 0, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < cells; k++) {
      const cell = order[k];
      const x = x0 + ((cell % n + offsetX) % n + random()) * tileSize / n;
      const z = z0 + ((Math.floor(cell / n) + offsetZ) % n + random()) * tileSize / n;
      if (plot && (Math.abs(x-plot.x) >= plot.half || Math.abs(z-plot.z) >= plot.half)) continue;
      const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
      const a = 3 * ((iz + half) * side + ix + half), b = a + 3 * side;
      const w0 = (1 - fx) * (1 - fz), w1 = fx * (1 - fz), w2 = (1 - fx) * fz, w3 = fx * fz;
      let coverage = habitat[a] * w0 + habitat[a + 3] * w1 + habitat[b] * w2 + habitat[b + 3] * w3;
      const roll = random();
      if (roll >= coverage*(2-coverage)) continue;
      const rootX = encodeRoot(x,x0,n), rootZ = encodeRoot(z,z0,n);
      // Select the tuft at the position the GPU will decode.
      readTuft((rootX/65535 - 0.5)*extent, (rootZ/65535 - 0.5)*extent, tuft, hashAt);
      if (coverage < 0.98) coverage *= 1 + (1-coverage)*(1 - 3.4*Math.max(0, tuft.distance-0.12));
      if (roll >= coverage) continue;
      const blade = habitat[a+1]*w0 + habitat[a+4]*w1 + habitat[b+1]*w2 + habitat[b+4]*w3;
      const edge = habitat[a+2]*w0 + habitat[a+5]*w1 + habitat[b+2]*w2 + habitat[b+5]*w3;
      const y = heightAt(x, z) - 0.015;
      if (contact) {
        const bin=Math.floor((x-x0)/binSize) + binsPerTile*Math.floor((z-z0)/binSize);
        binIds[used/4]=bin; binCounts[bin]++;
      }
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
    const rootBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, rootBuffer); gl.bufferData(gl.ARRAY_BUFFER, scratch.subarray(0, used), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(rootLoc); gl.vertexAttribDivisor(rootLoc, 1);
    gl.vertexAttribPointer(rootLoc, 4, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, detailBuffer); gl.enableVertexAttribArray(detailLoc); gl.vertexAttribDivisor(detailLoc, 1);
    gl.vertexAttribPointer(detailLoc, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    const grid=[x0,z0,n/tileSize,maxSide/tileSize];
    if (contact) {
      // An index per real root is the only additional world-sized storage.
      // The physics pass visits contiguous runs in occupied two-metre bins.
      const siteVao=gl.createVertexArray();
      gl.bindVertexArray(siteVao); gl.bindBuffer(gl.ARRAY_BUFFER,rootBuffer);
      gl.enableVertexAttribArray(rootLoc); gl.vertexAttribPointer(rootLoc,4,gl.UNSIGNED_SHORT,true,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER,detailBuffer);
      gl.enableVertexAttribArray(detailLoc); gl.vertexAttribPointer(detailLoc,4,gl.UNSIGNED_BYTE,true,0,0);
      const next=new Uint16Array(binCounts.length);
      let base=0;
      for(let bin=0;bin<next.length;bin++) {
        next[bin]=base;
        const size=binCounts[bin];
        if (size) {
          const bx=x0/binSize + bin%binsPerTile, bz=z0/binSize + Math.floor(bin/binsPerTile);
          contactBins.set(bx+4096*bz,{vao:siteVao,grid,base,size});
        }
        base+=size;
      }
      const sorted=new Uint16Array(used/4);
      for(let i=0;i<sorted.length;i++) sorted[next[binIds[i]]++]=i;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,sorted,gl.STATIC_DRAW);
      if (plot) {
        for(let bin=0;bin<next.length;bin++) {
          if(!binCounts[bin]) continue;
          const members=sorted.subarray(next[bin]-binCounts[bin],next[bin]);
          tiles.push(plotBatch(gl,scratch,details,members,grid,x0+(bin%binsPerTile)*binSize,
            z0+Math.floor(bin/binsPerTile)*binSize,y0-0.1,y1+1.0));
        }
        gl.deleteVertexArray(vao);
      }
    }
    if (!plot) tiles.push({ vao, grid, x0, z0, y0: y0 - 0.1, y1: y1 + 2.2, pad: 2.2, count: used / 4 });
    count += used / 4;
  }
  gl.bindVertexArray(null); gl.useProgram(shader); gl.uniform2fv(shader.u('uGrassHeight'), heightRange);
  const widthLoc = shader.u('uLodW'), rowsLoc = shader.u('uBladeRows'), far = touch ? 72 : 84;
  return {
    count, heightRange, siteRate:maxSide/tileSize,
    nearRoots(x,z,reach) {
      const groups=[];
      for(let iz=Math.floor((z-reach)/binSize);iz<=Math.floor((z+reach)/binSize);iz++)
        for(let ix=Math.floor((x-reach)/binSize);ix<=Math.floor((x+reach)/binSize);ix++) {
          const group=contactBins.get(ix+4096*iz);
          if(!group) continue;
          const prior=groups[groups.length-1];
          if(prior && prior.vao===group.vao && prior.base+prior.size===group.base) prior.size+=group.size;
          else groups.push({...group});
        }
      return groups;
    },
    drawRoots(p,groups,instances) {
      let count=0, last=null;
      for (const group of groups) {
        if (group.vao!==last) {
          gl.bindVertexArray(group.vao); gl.uniform4fv(p.u('uRootGrid'),group.grid);
          last=group.vao;
        }
        gl.drawElementsInstanced(gl.POINTS,group.size,gl.UNSIGNED_SHORT,group.base*2,instances);
        count+=group.size;
      }
      return count;
    },
    draw(planes, eye, densityScale) {
      let drawn = 0;
      const width=plot ? binSize : tileSize;
      for (const tile of tiles) {
        const dx = Math.max(tile.x0 - eye[0], 0, eye[0] - tile.x0 - width);
        const dz = Math.max(tile.z0 - eye[2], 0, eye[2] - tile.z0 - width);
        const dy = Math.max(tile.y0 - eye[1], 0, eye[1] - tile.y1);
        const d2 = dx*dx + dz*dz + dy*dy;
        if (d2 >= far * far || outsideView(planes, tile, width)) continue;
        const d = Math.sqrt(d2);
        const fade = Math.min(1, (far - d) / 22);
        // More blades near the eye, paid for by starting the thinning two metres sooner
        const fraction = plot ? densityScale : Math.min(1, (15 / Math.max(1, d)) ** 1.8) * fade * densityScale;
        const n = Math.floor(tile.count * fraction);
        if (!n) continue;
        gl.bindVertexArray(tile.vao);
        if (contact) gl.uniform4fv(shader.u('uRootGrid'),tile.grid);
        gl.uniform1f(widthLoc, Math.min(2.2, 1 / Math.sqrt(fraction)));
        const rows = plot ? (d < 2.4 ? 5 : d < 6 ? 3 : 2) : (d < 9 ? 4 : d < 24 ? 3 : 2);
        gl.uniform1i(rowsLoc, rows);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, !plot && rows === 4 ? 27 : 2*rows + 1, plot ? Math.floor(tile.stems*fraction) : n);
        drawn += n;
      }
      return drawn;
    },
  };
}
