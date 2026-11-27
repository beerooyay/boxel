import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readTuft, CLUMP, meadowFraction } from '../demo/meadow.js';
import { forestStands, highCanopyMesh } from '../demo/high-canopy.js';
import { bakeCanopy } from '../demo/atmosphere.js';

test('a slow frame keeps every foreground root and only thins the distant meadow', () => {
  for (const far of [72,84]) for (const density of [0.3,0.65,1]) {
    let previous = 1;
    for (let distance = 0; distance <= far; distance += 0.25) {
      const fraction = meadowFraction(distance,density,far);
      if (distance <= 10) assert.equal(fraction,1);
      assert.ok(fraction >= 0 && fraction <= previous);
      previous = fraction;
    }
    assert.equal(previous,0);
    assert.ok(meadowFraction(40,0.3,far) < meadowFraction(40,1,far));
  }
});

test('a root encodes its nearest tuft across cell boundaries, including in negative coordinates', () => {
  const result = {};
  const hash = (x,z) => Math.imul(x + 123, 1831565813) ^ Math.imul(z + 317, 73244475);
  for (let x = -1.07; x < 1.6; x += 0.071) for (let z = -1.28; z < 0.75; z += 0.09) {
    readTuft(x,z,result,hash);
    const cx = Math.floor(x/CLUMP), cz = Math.floor(z/CLUMP);
    const distance = (i,j) => {
      const h = hash(i,j);
      return Math.hypot(i+0.15+0.7*(h & 65535)/65536-x/CLUMP, j+0.15+0.7*(h >>> 16)/65536-z/CLUMP);
    };
    const chosen = distance(cx + result.neighbour%3 - 1, cz + Math.floor(result.neighbour/3) - 1);
    let closest = Infinity;
    for (let j = cz-2; j <= cz+2; j++) for (let i = cx-2; i <= cx+2; i++) closest = Math.min(closest,distance(i,j));
    assert.ok(Math.abs(closest-chosen) < 1e-9 && Math.abs(result.distance-closest) < 1e-9);
  }
});

import { loadLeafSprays, SPRAY_COLUMNS, SPRAY_ROWS, SPRAY_MAX_LEVEL } from '../demo/leaf-spray.js';
import { makeLeafSprays } from '../tools/bake-leaf-sprays.mjs';
const seeded = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
test('leaf sprays are the same for the same seed, and distant mips keep the crowns as full as near ones', () => {
  const a = makeLeafSprays(seeded(2024), 64), b = makeLeafSprays(seeded(2024), 64);
  assert.equal(a.levels.length, SPRAY_MAX_LEVEL + 1);
  assert.equal(a.width, 64 * SPRAY_COLUMNS); assert.equal(a.height, 64 * SPRAY_ROWS);
  assert.deepEqual(a.levels[0].bytes, b.levels[0].bytes);
  const share = ({ bytes }) => { let n = 0; for (let i = 3; i < bytes.length; i += 4) if (bytes[i] >= 128) n++; return n / (bytes.length / 4); };
  const full = share(a.levels[0]);
  assert.ok(full > 0.15 && full < 0.7, `cover ${full}`);
  for (const level of a.levels.slice(1, 4)) assert.ok(Math.abs(share(level) - full) < 0.06, `level cover ${share(level)} vs ${full}`);
  // At two texels across, each tree shoot still needs its own piece of canopy.
  const tiny = a.levels.find(level => level.width === 2*SPRAY_COLUMNS);
  for (let col = 0; col < SPRAY_COLUMNS; col++) {
    const visible = [0,1,tiny.width,tiny.width+1].filter(offset => tiny.bytes[4*(2*col + offset)+3] >= 128);
    assert.equal(visible.length, 1);
  }
});

test('the desktop and mobile atlases decode to the baked leaf cutouts at every distance', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(await readFile(url)));
  const expected = makeLeafSprays(seeded(2024)).levels;
  for (const mobile of [false, true]) {
    const levels = await loadLeafSprays(mobile);
    assert.deepEqual(levels, expected.slice(mobile ? 1 : 0));
  }
  const stream = Object.getOwnPropertyDescriptor(globalThis, 'DecompressionStream');
  try {
    Object.defineProperty(globalThis, 'DecompressionStream', { value: undefined, configurable: true });
    assert.deepEqual(await loadLeafSprays(false), expected.slice(1));
  } finally {
    Object.defineProperty(globalThis, 'DecompressionStream', stream);
  }
});

test('both canopy meshes cover the opaque leaflets across all four atlas variants', () => {
  const tile = 64, atlas = makeLeafSprays(seeded(2024), tile).levels[0];
  const mesh = highCanopyMesh(seeded(9942));
  const tissue = mesh.tissue.find(value => value >= 0);
  for (const indices of [mesh.index.subarray(0,mesh.nearCount), mesh.index.subarray(mesh.nearCount)]) {
    const triangles = [];
    for (let i = 0; i < indices.length; i += 3) {
      if (mesh.tissue[indices[i]] !== tissue) continue;
      triangles.push(Array.from(indices.subarray(i,i+3), vertex => mesh.blade.subarray(3*vertex,3*vertex+2)));
    }
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      const u = ((y+0.5)/tile-0.02)/0.96, side = 2*((x+0.5)/tile-0.02)/0.96-1;
      if (u < 0 || u > 1 || Math.abs(side) > 1) continue;
      const opaque = [0,1,2,3].some(col => atlas.bytes[4*(y*atlas.width+col*tile+x)+3] >= 128);
      if (!opaque) continue;
      const covered = triangles.some(tri => tri.every(([a,b], k) => {
        const [c,d] = tri[(k+1)%3];
        return (c-a)*(side-b) - (d-b)*(u-a) <= 1e-6;
      }));
      assert.ok(covered, `leaflet clipped at length ${u}, width ${side}`);
    }
  }
});

test('valley, upland and island trees share an anchored crown at both viewing distances', () => {
  const valley = [3,0,4,0.43,4, -18,2,36,0.63,7], upland = [78,11,31,14], island = [-6,1.3,8,4.35,0.7317];
  const forest = forestStands(valley, upland, island, () => 0.5, seeded);
  const sites = new Set();
  for (const tile of forest.tiles) {
    const mesh = forest.meshes[tile.variant];
    for (let i = 4*tile.start; i < 4*(tile.start+tile.count); i += 4) {
      const [x,y,z,h] = forest.sites.subarray(i,i+4);
      sites.add([x,z].join(','));
      assert.ok(tile.y0 <= y+h*mesh.bottom && tile.y1 >= y+h*mesh.top);
      assert.ok(tile.pad >= h*forest.styles[i+2]*mesh.radius);
    }
  }
  assert.deepEqual([...sites].sort(), ['3,4','-18,36','78,31','-6,8'].sort());
  for (const mesh of forest.meshes) {
    const near = new Set(mesh.index.subarray(0,mesh.nearCount)), far = new Set(mesh.index.subarray(mesh.nearCount));
    assert.equal(mesh.index.length,mesh.nearCount+mesh.farCount);
    const stems = new Set();
    for (const vertex of near) {
      if (mesh.tissue[vertex]<0 || mesh.blade[3*vertex]!==0) continue;
      // Every leaf keeps the same anchoring stalk when its centre span retires.
      assert.ok(far.has(vertex));
      stems.add(mesh.stalk.subarray(3*vertex,3*vertex+3).join(','));
    }
    assert.equal(stems.size,mesh.foliage.length/4);
    for (const vertex of far) assert.ok(near.has(vertex));
  }
});

test('meadow shelter follows the rotated, scaled leaf area even away from the trunk', () => {
  const gl = { activeTexture() {}, bindTexture() {}, createTexture() {}, texImage2D() {}, texParameteri() {} };
  const forest = {
    meshes: [{foliage:[1,0.8,0,0.5]}], tiles: [{variant:0,start:0,count:1}],
    sites: [1,0,2,4], styles: [0,1,2,0.4],
  };
  const shelter = bakeCanopy(gl, {R:[],D:[],M:[]}, forest, 32);
  assert.ok(shelter(1.5,10.5)>0.75);
  assert.ok(shelter(1,10)>0 && shelter(1,10)<shelter(1.5,10.5));
  assert.equal(shelter(9,2),0);
  assert.equal(shelter(1,2),0);
  assert.equal(shelter(51,51),0);
});

test('the downhill rim of each trunk enters the triangulated slope', () => {
  const height=(x,z)=>0.61*x-0.34*z+0.04*Math.abs(z);
  const forest=forestStands([3,0,4,0.43,5],[],[-6,0,8,4.35,0.7317],()=>0.5,seeded,height);
  for(const tile of forest.tiles) {
    const mesh=forest.meshes[tile.variant];
    for(let i=tile.start; i<tile.start+tile.count; i++) {
      const [x,y,z,h]=forest.sites.subarray(4*i,4*i+4);
      const [c,s,width]=forest.styles.subarray(4*i,4*i+3);
      const [gx,gz]=forest.slopes.subarray(2*i,2*i+2);
      for(let j=0;j<12;j++) {
        const [px,py,pz]=mesh.position.subarray(3*j,3*j+3);
        const dx=h*width*(c*px-s*pz), dz=h*width*(s*px+c*pz);
        const t=Math.max(0,Math.min(1,py/0.18));
        const rim=y+h*py+(1-t*t*(3-2*t))*(gx*dx+gz*dz);
        const buried=height(x+dx,z+dz)-rim;
        assert.ok(buried>=0.025 && buried<0.22, `root rim buried ${buried} m`);
      }
    }
  }
});
