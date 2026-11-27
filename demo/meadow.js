// Roots use one eight-byte record. Wind, pigment and bend parameters reuse one
// shuffled detail buffer across all tiles. Only visible tile prefixes are drawn.
export const MEADOW_TILE = 8;
const WAKE_SECONDS = 1.12;
export const GRASS_WAKE_SEGMENTS = 10;

// Store short stretches of actual travel. Every point along a stretch has its
// own contact time. The shoulders open farther behind an animal as it moves.
export class GrassWake {
  constructor(half) {
    this.half = half;
    this.side = Math.ceil(2 * half / MEADOW_TILE);
    this.tiles = new Uint16Array(this.side * this.side);
    this.segments = new Float32Array(8 * GRASS_WAKE_SEGMENTS);
    this.began = new Float64Array(GRASS_WAKE_SEGMENTS);
    this.ended = new Float64Array(GRASS_WAKE_SEGMENTS);
    this.reset();
  }
  reset() {
    this.ended.fill(-Infinity);
    this.tiles.fill(0);
    this.head = -1;
    this.active = false;
  }
  land(x, z, now) {
    // A straight-down landing has no heading. Keep its compact spring-back
    // on the same clock as a track, in a separate zero-length slot.
    const i = this.head = (this.head+1)%GRASS_WAKE_SEGMENTS, k = i*8;
    this.segments[k] = this.lastX = x;
    this.segments[k+1] = this.lastZ = z;
    this.segments.fill(0,k+2,k+7);
    this.segments[k+7] = 0.72;
    this.began[i] = this.ended[i] = now;
    this.active = true;
  }
  sweep(x0, z0, x1, z1, now, dt) {
    const dx = x1-x0, dz = z1-z0, distance = Math.hypot(dx,dz);
    if (dt <= 0 || distance < Math.max(0.0001,0.12*dt)) return;
    const s = this.segments;
    let i = this.head, k = i*8;
    // End the old strip on a turn, a break in contact, or a long step. Angular
    // and time limits preserve the curve and the animal's changing speed.
    if (i < 0 || Math.abs(now-dt-this.ended[i])>0.00001 ||
        Math.abs(x0-this.lastX)+Math.abs(z0-this.lastZ)>0.001 ||
        now-this.began[i]>0.22 || s[k+4]+distance>0.62 ||
        dx*s[k+2]+dz*s[k+3]<0.96*distance) {
      i = this.head = (i+1)%GRASS_WAKE_SEGMENTS;
      k = i*8;
      s[k] = x0; s[k+1] = z0;
      this.began[i] = now-dt;
    }
    const sx = x1-s[k], sz = z1-s[k+1], length = Math.hypot(sx,sz);
    // Root and heading, followed by length, endpoint ages and contact strength.
    s[k+2] = sx/length; s[k+3] = sz/length; s[k+4] = length;
    s[k+7] = Math.min(1, length / (now-this.began[i]));
    this.ended[i] = now;
    this.lastX = x1; this.lastZ = z1;
    this.active = true;
  }
  update(now) {
    if (!this.active) return false;
    this.tiles.fill(0);
    this.active = false;
    const s = this.segments;
    for (let i=0; i<GRASS_WAKE_SEGMENTS; i++) {
      const age = now-this.ended[i];
      if (age<0 || age>=WAKE_SECONDS) continue;
      this.active = true;
      const k = 8*i;
      s[k+5] = now-this.began[i]; s[k+6] = age;
      // Bound the widest feather and end caps at either end of this segment.
      const reach = 0.65+1.21*Math.min(WAKE_SECONDS,s[k+5]);
      const x = s[k]+this.half, z = s[k+1]+this.half;
      const dx = s[k+2]*s[k+4], dz = s[k+3]*s[k+4];
      const x0 = Math.max(0,Math.floor((x+Math.min(0,dx)-reach)/MEADOW_TILE));
      const z0 = Math.max(0,Math.floor((z+Math.min(0,dz)-reach)/MEADOW_TILE));
      const x1 = Math.min(this.side-1,Math.floor((x+Math.max(0,dx)+reach)/MEADOW_TILE));
      const z1 = Math.min(this.side-1,Math.floor((z+Math.max(0,dz)+reach)/MEADOW_TILE));
      for (let row=z0; row<=z1; row++)
        for (let col=x0; col<=x1; col++) this.tiles[row*this.side+col] |= 1<<i;
    }
    return this.active;
  }
}

// Project a blade root onto a stretch of the track and find when the animal
// passed it. Two widening shoulders follow the original turn as the light fades.
export const grassWakeGLSL = `
uniform vec4 uGrassWake[${2*GRASS_WAKE_SEGMENTS}];
float grassWakeLight(int mask, vec2 root, float tuft) {
  float light = 0.;
  for (int i=0; mask!=0; i++, mask>>=1) {
    if ((mask & 1)==0) continue;
    vec4 path = uGrassWake[2*i], timing = uGrassWake[2*i+1];
    vec2 delta = root-path.xy;
    float range = timing.x+2.01;
    if (dot(delta,delta)>range*range) continue;
    float along = dot(delta,path.zw);
    float excess = max(-along,along-timing.x);
    if (excess>0.46) continue;
    float age = mix(timing.y,timing.z,clamp(along/max(timing.x,0.0001),0.,1.));
    float life = 1.-smoothstep(0.04,${WAKE_SECONDS},age);
    float side = timing.x==0. ? 1.65*length(delta) : abs(dot(delta,vec2(-path.w,path.z)));
    float shoulder = 0.11+age*(0.83+0.16*tuft);
    float band = 1.-smoothstep(0.,0.40+0.20*age,abs(side-shoulder));
    float cap = 1.-smoothstep(0.,0.28+0.14*age,max(0.,excess));
    light = max(light, timing.w*life*band*cap*(0.10+0.12*tuft));
  }
  return light;
}
`;
export const SISTER_ONE = 0.16, SISTER_TWO = 0.40;
const FULL_COVER = 14, DETAIL_END = 18;
const ADAPT_START = 10, ADAPT_END = 30, FAR_FADE = 22;

// The CPU evaluates this at the nearest point in a tile to bound the draw.
// The shader uses the same curve at the exact root to feather its silhouette.
export function meadowFraction(distance, density, far) {
  const ratio = Math.min(1, FULL_COVER / Math.max(distance, 0.01));
  const t = Math.max(0, Math.min(1, (distance - ADAPT_START) / (ADAPT_END - ADAPT_START)));
  const fade = Math.max(0, Math.min(1, (far - distance) / FAR_FADE));
  return ratio * ratio * fade * (1 + (density - 1) * t*t*(3-2*t));
}

// A shared index strip per detail level. Primitive restart keeps the blades
// independent. Unused strips never connect to the next sheath.
function bladeStrips(gl) {
  const indices = [], levels = [];
  for (const [rows, blades] of [[4,3],[3,3],[3,1],[2,1]]) {
    const start = indices.length;
    for (let j=0; j<blades; j++) {
      if (j) indices.push(255);
      const segments = j ? Math.max(2,rows-1) : rows;
      for (let v=0; v<=2*segments; v++) indices.push(16*j+v);
    }
    levels.push({start, count:indices.length-start, rows});
  }
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint8Array(indices),gl.STATIC_DRAW);
  return {buffer, levels};
}

export const meadowLodGLSL = `
uniform vec3 uPopulation; // reciprocal tile count, distant density, far limit
float rootFraction(float d){
  float ratio = min(1., ${FULL_COVER}. / max(d,0.01));
  return ratio*ratio * clamp((uPopulation.z-d)/${FAR_FADE}.,0.,1.)
       * mix(1.,uPopulation.y,smoothstep(${ADAPT_START}.,${ADAPT_END}.,d));
}
`;
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
    const leaves=choice<=SISTER_ONE ? 1 : choice<=SISTER_TWO ? 2 : 3;
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
  const colours = new Uint8Array(side*side*4);
  for (let z=0; z<side; z++) for (let x=0; x<side; x++) {
    const post=z*side+x;
    habitatAt(x-half,z-half,habitat,3*post,colours,4*post);
  }
  gl.activeTexture(gl.TEXTURE0+30);
  gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,side,side,0,gl.RGBA,gl.UNSIGNED_BYTE,colours);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.bindVertexArray(null);
  const strips = plot ? null : bladeStrips(gl);

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
    if (strips) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,strips.buffer);
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
  const visible = [];
  let nearby = null;
  for(const tile of tiles)
    tile.fieldTile=Math.floor((tile.z0+half)/tileSize)*(extent/tileSize)+Math.floor((tile.x0+half)/tileSize);
  const signals = shader.u('uGrassFields');
  const population = shader.u('uPopulation'), rowsLoc = shader.u('uBladeRows'), far = touch ? 72 : 84;
  return {
    count, heightRange, siteRate:maxSide/tileSize,
    nearRoots(x,z,reach) {
      const x0=Math.floor((x-reach)/binSize), x1=Math.floor((x+reach)/binSize);
      const z0=Math.floor((z-reach)/binSize), z1=Math.floor((z+reach)/binSize);
      if (nearby && nearby.x0===x0 && nearby.x1===x1 && nearby.z0===z0 && nearby.z1===z1) return nearby.groups;
      const groups=[];
      nearby={x0,x1,z0,z1,groups};
      for(let iz=z0;iz<=z1;iz++)
        for(let ix=x0;ix<=x1;ix++) {
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
    draw(planes, eye, densityScale, fieldsAt) {
      let drawn = 0;
      const width=plot ? binSize : tileSize;
      visible.length=0;
      for (const tile of tiles) {
        const dx = Math.max(tile.x0 - eye[0], 0, eye[0] - tile.x0 - width);
        const dz = Math.max(tile.z0 - eye[2], 0, eye[2] - tile.z0 - width);
        const dy = Math.max(tile.y0 - eye[1], 0, eye[1] - tile.y1);
        const d2 = dx*dx + dz*dz + dy*dy;
        if (d2 >= far * far || outsideView(planes, tile, width)) continue;
        tile.distance = Math.sqrt(d2);
        visible.push(tile);
      }
      // An opaque blade in the foreground hides many layers of distant turf.
      visible.sort((a,b)=>a.distance-b.distance);
      let lastFields=-1;
      for (const tile of visible) {
        const d=tile.distance, fields=fieldsAt(tile.fieldTile);
        if(fields!==lastFields){ gl.uniform1i(signals,fields); lastFields=fields; }
        gl.bindVertexArray(tile.vao);
        if (contact) gl.uniform4fv(shader.u('uRootGrid'),tile.grid);
        if (plot) {
          const rows = d<2.4 ? 5 : d<6 ? 3 : 2;
          gl.uniform1i(rowsLoc,rows);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,2*rows+1,tile.stems);
          drawn += tile.count;
          continue;
        }
        // The nearest point bounds the work for the tile. Each root then
        // tapers its own width at its own distance, with stable shuffled rank.
        const n = Math.ceil(tile.count * meadowFraction(d,densityScale,far));
        const level = strips.levels[d<5 ? 0 : d<DETAIL_END ? 1 : d<29 ? 2 : 3];
        gl.uniform3f(population,1/tile.count,densityScale,far);
        gl.uniform1i(rowsLoc,level.rows);
        gl.drawElementsInstanced(gl.TRIANGLE_STRIP,level.count,gl.UNSIGNED_BYTE,level.start,n);
        drawn += n;
      }
      return drawn;
    },
  };
}
