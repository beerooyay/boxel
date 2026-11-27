import test from 'node:test';
import assert from 'node:assert/strict';
import { highCanopyMesh } from '../demo/high-canopy.js';
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
