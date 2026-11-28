import test from 'node:test';
import assert from 'node:assert/strict';
import { forestStands, highCanopyMesh, treeFieldMask, treeFieldTiles } from '../demo/high-canopy.js';
import { FieldTexture } from '../demo/field-texture.js';
import { barkTile } from '../demo/surface-texture.js';

test('both detail levels share the full cut edge between each primary limb and the trunk', () => {
  for(let variant=0;variant<6;variant++) {
    let seed=9942+variant;
    const mesh=highCanopyMesh(()=>((seed=(Math.imul(1664525,seed)+1013904223)>>>0)/2**32),variant);
    assert(mesh.normal.every(Number.isFinite));
    for(const indices of [mesh.index.subarray(0,mesh.nearCount),mesh.index.subarray(mesh.nearCount)]) {
      // Only unwrap the bark chart's U=1 twin onto its U=0 edge.
      const seam=new Map(), original=new Map();
      for(const id of indices) if(mesh.blade[3*id]===0)
        original.set(mesh.position.subarray(3*id,3*id+3).join(','),id);
      for(const id of indices) if(mesh.blade[3*id]===1) {
        const root=original.get(mesh.position.subarray(3*id,3*id+3).join(','));
        if(root!==undefined) seam.set(id,root);
      }
      const girth=id=>mesh.blade[3*id+2];
      const isSocket=id=>mesh.graft[id]===Math.fround(0.025);
      const edges=new Map();
      for(let i=0;i<indices.length;i+=3) {
        for(let k=0;k<3;k++) {
          const a=indices[i+k], b=indices[i+(k+1)%3], c=indices[i+(k+2)%3];
          if(mesh.graft[a]!==0 || mesh.graft[b]!==mesh.graft[a] || girth(a)!==girth(b)) continue;
          if(girth(a)===Math.fround(0.3) || girth(a)<0.10 || mesh.blade[3*a+1]!==mesh.blade[3*b+1]) continue;
          const left=seam.get(a)??a, right=seam.get(b)??b;
          const key=Math.min(left,right)*65536+Math.max(left,right);
          const edge=edges.get(key)??{ faces:0, socket:false, winding:0 };
          edge.faces++; edge.winding+=left<right ? 1 : -1;
          edge.socket ||= isSocket(c);
          edges.set(key,edge);
        }
      }
      const joins=[...edges.values()].filter(edge=>edge.socket);
      assert(joins.length>=7*9);
      assert(joins.every(edge=>edge.faces===2 && edge.winding===0));
    }
  }
});

test('a failed bark download still has ridged colour and non-flat lighting normals', () => {
  const colour=barkTile(false), normal=barkTile(true);
  assert.equal(colour.bytes.length,normal.bytes.length);
  const reds=new Set(),across=new Set();
  for(let i=0;i<colour.bytes.length;i+=4) {
    reds.add(colour.bytes[i]); across.add(normal.bytes[i]);
    assert(normal.bytes[i+2]>180);
  }
  assert(reds.size>35 && across.size>70);
});

test('batched tree bounds follow the planted roots and contain each wind-blown crown', () => {
  const random = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const local = [1,0,2,0.31,4, 4,0,6,0.31,5, -4,0,-4,0.31,3];
  const stands = forestStands(local, [], [53,0,-21,6,0.7], () => 0.5, random, (x,z) => 0.12*x-0.18*z);
  assert(stands.tiles.some(tile => tile.count === 2 && tile.width === 3 && tile.depth === 4));
  assert(stands.tiles.some(tile => tile.count === 1 && tile.width === 0 && tile.depth === 0));
  let offset = 0;
  for (const tile of stands.tiles) {
    assert.equal(tile.start, offset);
    for (let j=tile.start; j<tile.start+tile.count; j++) {
      const [x,y,z,height]=stands.sites.subarray(4*j,4*j+4);
      const mesh=stands.meshes[tile.variant], spread=stands.styles[4*j+2];
      const reach=height*(mesh.radius*spread+0.18)+0.12, epsilon=1e-5;
      assert(x-reach >= tile.x0-tile.pad-epsilon && x+reach <= tile.x0+tile.width+tile.pad+epsilon);
      assert(z-reach >= tile.z0-tile.pad-epsilon && z+reach <= tile.z0+tile.depth+tile.pad+epsilon);
      assert(y+height*(mesh.top+0.18)+0.12 <= tile.y1+epsilon);
      assert(y+height*mesh.bottom-height*0.23*spread*Math.hypot(0.12,0.18)-0.12 >= tile.y0-epsilon);
    }
    offset += tile.count;
  }
  assert.equal(offset, local.length/5+1);
});

test('a canopy draw can omit a field only when every root has zero bilinear contribution', () => {
  const size=64, half=32, cellSize=16;
  function layer(bx, by, offset) {
    const cache=new FieldTexture(size,cellSize);
    let live=true;
    const values=new Float32Array(256);
    values[offset]=1;
    const field={
      blocks(visit) { if (live) visit(bx,by,values); },
      freed(visit) { if (!live) visit(bx,by); },
      forgetFreed() {},
    };
    const gl={ pixelStorei() {}, texSubImage2D() {} };
    cache.uploadSparse(gl,field);
    function sample(x,z) {
      const dx=x-(bx*16+offset%16+0.5), dz=z-(by*16+(offset>>4)+0.5);
      return live ? Math.max(0,1-Math.abs(dx))*Math.max(0,1-Math.abs(dz)) : 0;
    }
    return { cache, sample, retire(){ live=false; cache.uploadSparse(gl,field); } };
  }
  // The single lit texel is in the preceding tile but still contributes
  // to a root just across both of its edges.
  const glow=layer(-1,-1,255), ground=layer(1,1,17);
  const points=[[0.125,0.125],[-0.75,-0.5],[17.5,17.5],[-31,31],[-32,32],[32,-32]];
  const tiles=treeFieldTiles(Float32Array.from(points.flatMap(([x,z])=>[x,0,z,1])),half,cellSize);
  assert(glow.sample(...points[0])>0);
  assert.equal(treeFieldMask(tiles,3,1,glow.cache.tileBlocks,ground.cache.tileBlocks),0);
  for (const state of ['both','glow retired','both retired']) {
    if (state==='glow retired') glow.retire();
    if (state==='both retired') ground.retire();
    for (let start=0; start<points.length; start++) for (let count=1; start+count<=points.length; count++) {
      const mask=treeFieldMask(tiles,start,count,glow.cache.pages.size ? glow.cache.tileBlocks : null,
        ground.cache.pages.size ? ground.cache.tileBlocks : null);
      for (const p of points.slice(start,start+count)) {
        const g=glow.sample(...p), w=ground.sample(...p);
        assert.equal(mask&1 ? g : 0,g);
        assert.equal(mask&2 ? w : 0,w);
      }
    }
  }
});
