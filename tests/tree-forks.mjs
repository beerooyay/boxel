import test from 'node:test';
import assert from 'node:assert/strict';
import { forestStands, highCanopyMesh, treeFieldMask, treeFieldTiles } from '../demo/high-canopy.js';
import { FieldTexture } from '../demo/field-texture.js';
import { barkTile } from '../demo/surface-texture.js';

test('every primary branch starts inside its trunk and carries the parent bark into both detail levels', () => {
  for (let variant=0;variant<6;variant++) {
    let seed=9942+variant;
    const mesh=highCanopyMesh(() => ((seed=(Math.imul(1664525,seed)+1013904223)>>>0)/2**32),variant);
    const {position,index,blade,tissue,graft}=mesh;
    // Count triangle crossings towards +X through the six trunk segments.
    function insideTrunk(x,y,z) {
      let count=0;
      for(let i=0;i<6*12*6;i+=3) {
        const a=index[i]*3,b=index[i+1]*3,c=index[i+2]*3;
        const by=position[b+1]-position[a+1],bz=position[b+2]-position[a+2];
        const cy=position[c+1]-position[a+1],cz=position[c+2]-position[a+2];
        const det=by*cz-bz*cy;
        if(Math.abs(det)<1e-12) continue;
        const py=y-position[a+1],pz=z-position[a+2];
        const v=(py*cz-pz*cy)/det, w=(by*pz-bz*py)/det;
        if(v<0 || w<0 || v+w>1) continue;
        if(position[a]+v*(position[b]-position[a])+w*(position[c]-position[a])>x) count++;
      }
      return count%2===1;
    }
    const far=new Set(index.subarray(mesh.nearCount));
    let starts=0;
    for(let i=0;i<tissue.length;i++) {
      if(tissue[i]>=-1.15 || blade[3*i+1]!==0 || blade[3*i+2]<0.1) continue;
      assert(insideTrunk(...position.subarray(3*i,3*i+3)));
      assert(graft[4*i+3]>.99);
      if(blade[3*i]===0) {
        starts++;
        assert(far.has(i+20),'the second collar ring survives the distant mesh');
      }
    }
    assert(starts===7 || starts===8);
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
