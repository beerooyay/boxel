import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaterSurface, waterTexture } from '../demo/water-surface.js';
import { createSwimWake, sampleWaterline, waterlineEdges, waterPart } from '../demo/swim-wake.js';
import { falls, riverLevel, riverX, waterLevel, terrainHeight } from '../demo/landmarks.js';
import { lipZ, landingAt } from '../demo/waterfall.js';

const grid = { x0: 0, z0: 0, width: 48, height: 48, step: 0.24 };
function tank(current = 0, wall = false) {
  return createWaterSurface(grid, (x, z, bed) => {
    bed.depth = wall && x >= 5.52 && x < 5.76 ? 0 : 0.6;
    bed.level = 0;
    bed.vx = 0;
    bed.vz = current;
  });
}
function dyeCentroid(water) {
  let mass = 0,
    moment = 0;
  for (let j = 0; j < grid.height; j++)
    for (let i = 0; i < grid.width; i++) {
      const z = (j + 0.5) * grid.step,
        f = water.sample((i + 0.5) * grid.step, z).light;
      mass += f;
      moment += z * f;
    }
  return moment / mass;
}
test('two contacts propagate through each other with signed superposition across tile boundaries', () => {
  const a = tank(),
    b = tank(),
    both = tank();
  for (const f of [a, both]) f.touch(3.0, 4.4, 0.8);
  for (const f of [b, both]) f.touch(5.0, 4.4, 0.6);
  let signal = 0;
  for (let tick = 0; tick < 72; tick++) {
    for (const f of [a, b, both]) f.advance(1 / 30);
    const x = a.sample(4.02, 4.44).height,
      y = b.sample(4.02, 4.44).height;
    signal = Math.max(signal, Math.min(Math.abs(x), Math.abs(y)));
    assert.ok(Math.abs(both.sample(4.02, 4.44).height - x - y) < 0.0002);
  }
  assert.ok(signal > 0.001, 'both wave trains reach the same point');
  assert.equal(both.sample(4.02, 4.44).light, 0);
});
test('waves reflect off dry rock, dye drifts downstream and wind shifts the wake', () => {
  const solid = tank(0, true),
    free = tank(),
    river = tank(0.8),
    windy = tank();
  assert.equal(solid.touch(5.64, 3.0, 1, 1), false);
  for (const f of [solid, free, river, windy]) f.touch(4.68, 3.0, 1, 1);
  let passed = 0,
    reflected = 0;
  for (let t = 0; t < 90; t++) {
    for (const f of [solid, free, river]) f.advance(1 / 30);
    windy.advance(1 / 30, 0, 0.12);
    passed = Math.max(passed, Math.abs(free.sample(6.84, 3.0).height));
    reflected = Math.max(reflected, Math.abs(free.sample(5.4, 3.0).height - solid.sample(5.4, 3.0).height));
    assert.equal(solid.sample(6.84, 3.0).height, 0);
  }
  assert.ok(passed > 0.0005 && reflected > 0.001);
  assert.ok(dyeCentroid(river) > dyeCentroid(free) + 2);
  assert.ok(dyeCentroid(windy) > dyeCentroid(free) + 0.22);
});
test('fixed steps give the same wake at 24 and 120 Hz, and reset clears it', () => {
  const slow = tank(0.74),
    fast = tank(0.74);
  for (const [f, rate] of [
    [slow, 24],
    [fast, 120]
  ]) {
    f.touch(3.84, 3.84, 1, 0.8);
    for (let i = 0; i < rate; i++) f.advance(1 / rate);
  }
  assert.deepEqual(slow.sample(3.84, 4.68), fast.sample(3.84, 4.68));
  assert.ok(Math.abs(slow.fraction - fast.fraction) < 1e-6);
  slow.reset();
  const q = slow.sample(3.84, 4.68);
  assert.equal(q.light, 0);
  assert.equal(q.height, 0);
});

test('a glow pulse blooms after contact, travels with the outgoing wave and fades downstream of the footprint', () => {
  const waved = tank(), quiet = tank(), blocked = tank(0,true);
  const x=4.44, z=4.44, outer=x+4*grid.step;
  waved.touch(x,z,0.9,0.8);
  quiet.touch(x,z,0,0.8);
  blocked.touch(x,z,0.9,0.8);
  let firstLight=0, centrePeak=0, outerPeak=0, quietPeak=0;
  let centreTick=0, outerTick=0;
  for (let i=1; i<=270; i++) {
    for (const basin of [waved,quiet,blocked]) basin.advance(1/30);
    const centre=waved.sample(x,z).light, edge=waved.sample(outer,z).light;
    if (i===1) firstLight=centre;
    if (centre>centrePeak) { centrePeak=centre; centreTick=i; }
    if (edge>outerPeak) { outerPeak=edge; outerTick=i; }
    quietPeak=Math.max(quietPeak,quiet.sample(outer,z).light);
    assert.equal(blocked.sample(5.88,z).light,0);
  }
  assert.ok(firstLight>0 && centrePeak>firstLight*2 && centreTick>=4);
  assert.ok(outerPeak>3/255 && outerPeak>quietPeak*3 && outerTick>centreTick);
  assert.ok(waved.sample(x,z).light<0.5/255 && waved.sample(outer,z).light<0.5/255);
});

test('skin contact charges adjacent wet cells continuously as a paw crosses a texel boundary', () => {
  const z=4.44;
  const left=tank(), right=tank();
  left.stir(4.8-0.0001,z,0.9);
  right.stir(4.8+0.0001,z,0.9);
  left.advance(1/30); right.advance(1/30);
  for (const x of [4.68,4.92]) {
    assert.ok(left.sample(x,z).light>0.04);
    assert.ok(Math.abs(left.sample(x,z).light-right.sample(x,z).light)<0.0001);
  }
});

test('texture updates preserve both fixed ticks across batched uploads and clear a reset', () => {
  const grid = { x0: 0, z0: 0, width: 37, height: 35, step: 0.24 };
  const water = createWaterSurface(grid, (_x,_z,bed) => Object.assign(bed,{depth:1,level:0,vx:0,vz:0}));
  const layerBytes = grid.width * grid.height * 4;
  const gpu = new Uint8Array(2 * layerBytes);
  let stride = 0, writes = 0;
  const gl = {
    TEXTURE0: 0, UNPACK_ROW_LENGTH: 1,
    createTexture() {}, activeTexture() {}, bindTexture() {}, texStorage3D() {}, texParameteri() {},
    pixelStorei(name, value) { if (name === this.UNPACK_ROW_LENGTH) stride = value; },
    texSubImage3D(_target, _level, x, y, layer, width, height, depth, _format, _type, bytes, offset = 0) {
      for (let z = 0; z < depth; z++) for (let row = 0; row < height; row++) {
        const src = offset + (z * height + row) * (stride || width) * 4;
        gpu.set(bytes.subarray(src, src + width*4), (layer+z)*layerBytes + ((y+row)*grid.width+x)*4);
      }
      writes++;
    }
  };
  const upload = waterTexture(gl,water,0);
  function snapshot() {
    const bytes = new Uint8Array(layerBytes), contact = {};
    const signed = value => 128 + Math.round(Math.max(-127,Math.min(127,value)));
    for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) {
      const x = (i+0.5)*grid.step, z = (j+0.5)*grid.step, p = 4*(j*grid.width+i);
      water.contactAt(x,z,contact);
      bytes[p] = signed(contact.height*720);
      bytes[p+1] = signed(contact.slopeX*340);
      bytes[p+2] = signed(contact.slopeZ*340);
      bytes[p+3] = Math.round(water.sample(x,z).light*255);
    }
    return bytes;
  }
  let current = snapshot(), previous = current;
  water.advance(1/120);
  for (let tick = 0; tick < 70; tick++) {
    if (tick < 15) water.touch(7.68+0.02*tick,7.68,0.5,0.05);
    water.advance(1/30);
    previous = current;
    current = snapshot();
    if (tick % 7 > 2) continue; // four skipped uploads followed by consecutive renders
    upload();
    for (let p = 0; p < layerBytes; p++) {
      const visible = gpu[p] + (gpu[layerBytes+p]-gpu[p])*water.textureMix;
      const expected = previous[p] + (current[p]-previous[p])*water.fraction;
      assert.ok(Math.abs(visible-expected) < 1e-8);
    }
  }
  water.reset();
  upload();
  assert.deepEqual(gpu.subarray(0,layerBytes),snapshot());
  assert.deepEqual(gpu.subarray(layerBytes),snapshot());
  const empty = writes;
  water.advance(1/30);
  upload();
  assert.equal(writes,empty);
});

const fox = { halfWidth: 0.21, halfLength: 0.48, draft: 0.416 };
test('a swimming body displaces water across tile boundaries without adding volume or lighting the lake', () => {
  const lake = tank(), drifting = tank(0.8), bank = tank(0, true);
  lake.swim(3.84, 7.68, 2.3, 0, 1/30, fox);
  drifting.swim(3.84, 7.68, 0, 0.8, 1/30, fox);
  bank.swim(5.64, 3, 2.3, 0, 1/30, fox);
  for (const basin of [lake, drifting, bank]) basin.advance(1/30);
  let volume = 0, high = 0, low = 0;
  for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) {
    const x = (i+0.5)*grid.step, z = (j+0.5)*grid.step;
    const { height, light } = lake.sample(x,z);
    volume += height*grid.step**2;
    high = Math.max(high, height); low = Math.min(low, height);
    assert.equal(light, 0);
    assert.equal(drifting.sample(x,z).height, 0);
    assert.equal(bank.sample(x,z).height, 0);
  }
  assert.ok(high > 0.002 && low < -0.003);
  assert.ok(Math.abs(volume) < 1e-7);
});
test('ordinary paddling sends a signed wake past the tail and faster strokes leave a larger wake at either frame rate', () => {
  function swim(rate, speed) {
    const water = tank();
    for (let frame=0; frame<2*rate; frame++) {
      const t=(frame+0.5)/rate;
      water.swim(3+t*speed,5.76,speed,0,1/rate,fox);
      water.advance(1/rate);
    }
    const samples=[];
    for (let behind=0.75; behind<2.85; behind+=grid.step)
      for (let side=-1.56; side<1.57; side+=grid.step)
        samples.push(water.sample(3+2*speed-behind,5.76+side).height);
    return samples;
  }
  const gentle=swim(60,1.3), fast=swim(30,2.4), highRate=swim(120,2.4);
  // The grid carries longer waves from steady displacement. Short wakes
  // from the bow and the legs are resolved separately at rendering scale.
  assert.ok(Math.max(...gentle)>0.004 && Math.min(...gentle)<-0.003);
  assert.ok(Math.max(...fast)>2*Math.max(...gentle));
  const energy=fast.reduce((sum,h)=>sum+h*h,0);
  const difference=fast.reduce((sum,h,i)=>sum+(h-highRate[i])**2,0);
  assert.ok(difference/energy<0.03**2);
});

const upright = [1,0,0,0,1,0,0,0,1];
test('waterline cuts the posed left and right legs independently and leaves a raised tail dry', () => {
  const positions = new Float32Array([
    0.1,-0.1,0.3, 0.3,0.1,0.3, 0.3,-0.1,0.3,
    -0.3,-0.1,0.3, -0.1,0.1,0.3, -0.1,-0.1,0.3,
    0,0.1,-0.4, 0.1,0.18,-0.5, -0.1,0.22,-0.5
  ]);
  const joints = new Uint8Array(36), weights = new Float32Array(36);
  for (let i=0; i<9; i++) { joints[4*i]=Math.floor(i/3); weights[4*i]=1; }
  const groups=['IKFrontLeg.L','FrontLowerLeg.R','Tail4'].map(waterPart);
  const mesh=waterlineEdges([{positions,joints,weights,indices:[0,1,2,3,4,5,6,7,8]}],groups);
  const bounds=new Float32Array(24);
  sampleWaterline(mesh,1,[0,0,0],upright,0,0,0,bounds);
  assert.ok(bounds[4]<0 && bounds[9]<0);
  assert.equal(bounds[20],-Infinity);
  positions[19]=-0.1;
  sampleWaterline(mesh,1,[0,0,0],upright,0,0,0,bounds);
  assert.ok(bounds[22]>0.4 && bounds[22]<0.5);
});

test('foreleg contact sustains a bow and a turn leaves the narrow wake on its previous path', () => {
  const water=tank(), wake=createSwimWake(water,()=>0,()=>{});
  const animal={waterline:fox, waterContacts(_o,_b,_h,_sx,_sz,bounds) {
    bounds.fill(-Infinity);
    bounds.set([-0.10,0.20,-0.20,0.25,0.20,-0.10,-0.20,0.25],4);
  }};
  const uniforms={};
  const gl={
    uniform4f:(key,...values)=>uniforms[key]=values,
    uniform2f:(key,...values)=>uniforms[key]=values,
    uniform1f:(key,value)=>uniforms[key]=value,
    uniform1fv:(key,values)=>uniforms[key]=values.slice(),
    uniform4fv:(key,values)=>uniforms[key]=values.slice()
  };
  for (let i=1; i<=22; i++) wake.update(animal,[4,-0.4,4+i/30],upright,0,1,1/30,i/30,true,0);
  assert.ok(wake.prepare(22/30));
  wake.bind(gl,{u:key=>key});
  assert.ok(uniforms.uBow[1]>4+22/30 && uniforms.uBow[3]>0.7);
  const firstLeg=32;
  const trail=uniforms['uWakePath[0]'];
  assert.ok(trail[firstLeg+2]>0 && trail[firstLeg+1]>trail[firstLeg+4*5+1]);
  const east=[0,0,-1,0,1,0,1,0,0];
  wake.update(animal,[4.033,-0.4,4+22/30],east,1,0,1/30,23/30,true,0);
  assert.ok(wake.prepare(23/30));
  wake.bind(gl,{u:key=>key});
  assert.deepEqual(uniforms.uBowDirection,[1,0]);
  assert.ok(Math.abs(uniforms['uWakePath[0]'][firstLeg+4*5]-4.15)<1e-5);
  wake.reset();
  assert.equal(wake.prepare(1),null);
});

test('a moving paw charges its previous footprint once more on lift and a resting paw stays dark', () => {
  const water=tank(), events=[];
  const wake=createSwimWake(water,()=>0,(x,z,amount)=>events.push({x,z,amount}));
  let planted=true;
  const animal={waterline:fox,waterContacts(_o,_b,_h,_sx,_sz,bounds) {
    bounds.fill(-Infinity);
    if (planted) bounds.set([0.06,0.06,0.08,0.08],4);
  }};
  const dt=1/30;
  for (let i=0; i<15; i++) wake.update(animal,[4,-0.2,4],upright,0,0,dt,i*dt,false,1);
  assert.equal(events.length,0);
  wake.update(animal,[4,-0.2,4.04],upright,0,1.2,dt,15*dt,false,1);
  assert.equal(events.length,1);
  assert.ok(Math.abs(events[0].z-4)<1e-6);
  planted=false;
  wake.update(animal,[4,-0.2,4.08],upright,0,1.2,dt,16*dt,false,1);
  assert.equal(events.length,2);
  assert.ok(Math.abs(events[1].z-4.04)<1e-6 && events[1].amount>0);
  wake.update(animal,[4,-0.2,4.12],upright,0,1.2,dt,17*dt,false,1);
  assert.equal(events.length,2);
});

test('both chutes have bedrock immediately below the lip and room for the falling sheet to reach the pool', () => {
  const head=riverLevel(falls.lip), tail=riverLevel(falls.lip+falls.reach);
  for (const s of [-0.78,-0.60,-0.19,0,0.18,0.40]) {
    const lip=lipZ(s), [,landing]=landingAt(s);
    for (let i=0; i<=20; i++) {
      const t=i/20, z=lip+(landing-lip)*t;
      const x=riverX(z)+s*falls.halfWidth*(0.99+0.08*t*t);
      const bed=terrainHeight(x,z,6);
      const water=head+0.010-(head-tail+0.22)*t*t;
      if (i===0) assert.ok(water-bed < 0.60, 'the feeding water rests on the ledge');
      assert.ok(water-bed>0, 'exposed terrain does not cut through the chute');
    }
  }
});
test('the upper race feeds the falls and a scoured pool drains continuously to the ford', () => {
  const top = riverLevel(falls.lip),
    toe = falls.lip + falls.reach;
  assert.ok(top - riverLevel(toe) > 2.6);
  assert.ok(riverLevel(toe) - terrainHeight(riverX(toe), toe, 8) > 0.9);
  let prior = Infinity;
  for (let z = -99; z <= -12; z += 0.025) {
    const level = waterLevel(riverX(z), z);
    assert.ok(level <= prior + 1e-6);
    prior = level;
  }
});
test('both pool banks and the lower river have a walkable gravel shelf through the waterline', () => {
  for (const z of [-56, -43.8, -43, -42, -40, -33, -25]) {
    const level = riverLevel(z);
    for (const side of [-1, 1]) {
      const height = (d) => terrainHeight(riverX(z) + side * d, z, 6) - level;
      let wetEdge, dryEdge;
      for (let d = 0.1; d < 5.2; d += 0.025) {
        const h = height(d);
        if (wetEdge === undefined && h >= -0.22) wetEdge = d;
        if (dryEdge === undefined && h >= 0.22) dryEdge = d;
        if (Math.abs(h) < 0.23) {
          assert.ok(Math.abs(h - height(d - 0.025)) / 0.025 < 0.58, `bank grade at ${z}, ${side * d}`);
        }
      }
      assert.ok(dryEdge - wetEdge > 1.1);
    }
  }
});
