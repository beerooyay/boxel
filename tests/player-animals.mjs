import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { animalById, animals } from '../demo/animal-catalog.js';
import { loadPlayerAnimal } from '../demo/fox.js';

// Run the real GLB decoder, skinning and pose evaluation. Only buffer uploads
// and draw submission need a graphics stub for this check.
test('every selectable animal has a usable eye, flotation depth and moving limbs in both traversal gaits', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(await readFile(url)));
  const noop = () => {};
  const gl = new Proxy({}, {get: () => noop});
  assert.equal(new Set(animals.map(a=>a.id)).size, 12);
  for (const species of animals) {
    assert.equal(animalById(species.id), species);
    const animal = await loadPlayerAnimal(gl, {}, species);
    assert.ok(animal.eyeHeight > animal.draft + 0.10, species.id);
    assert.ok(animal.draft > 0.20, species.id);
    function pose(phase,swim,climb) {
      for(let i=0;i<12;i++) animal.advance(1/60,0.018,false,0,-1,swim,climb,phase);
      const coordinates = animal.contactSurfaces()[0].positions.slice();
      assert(coordinates.every(Number.isFinite),species.id);
      return coordinates;
    }
    const left=pose(0.17,true,false), right=pose(0.68,true,false);
    assert.equal(animal.gait,'Swim');
    assert(left.some((v,i)=>Math.abs(v-right[i])>0.035),species.id+' paddle');
    const uphill=pose(0,false,true);
    assert.equal(animal.gait,'Scramble');
    assert(uphill.some((v,i)=>Math.abs(v-right[i])>0.035),species.id+' scramble');
    animal.advance(1/60,0.07,true,0,-1,false,false,0);
    assert.equal(animal.gait,'Gallop');
    animal.advance(1/60,0,false,0,0.53,false,false,0);
    assert.equal(animal.gait,'Gallop_Jump');
    assert(animal.contactSurfaces()[0].positions.every(Number.isFinite));
    animal.dispose();
  }
});

test('the fox releases its forepaws while the hind paws still support the launch', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(await readFile(url)));
  const fox = await loadPlayerAnimal(new Proxy({}, {get: () => () => {}}), {}, animalById('Fox'));
  function soles() {
    let fore = Infinity, hind = Infinity;
    for (const {positions} of fox.contactSurfaces()) {
      for (let i = 0; i < positions.length; i += 3) {
        const y = positions[i+1], z = positions[i+2];
        if (z > 0.17) fore = Math.min(fore,y);
        if (z < -0.12 && z > -0.50) hind = Math.min(hind,y);
      }
    }
    return {fore,hind};
  }
  const rest = soles();
  for (let i = 0; i < 6; i++) {
    fox.advance(1/60,0,false,0,-1,false,false,0,0,0,0,i/6);
    const {fore,hind} = soles();
    assert(Math.abs(hind-rest.hind) < 0.025,'hind paw stays within reach of the ground');
    if (i === 5) assert(fore-hind > 0.045,'forepaws release before the hind push');
  }
  fox.dispose();
});

test('the walking fox bends its waist to both sides over a straight stride', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(await readFile(url)));
  const fox = await loadPlayerAnimal(new Proxy({}, {get: () => () => {}}), {}, animalById('Fox'));
  const positions = fox.contactSurfaces()[0].positions;
  // Track the same flank vertices through the stride. A rigid sideways shift
  // of the whole animal cancels when comparing the waist with the two ends.
  const bands = [-0.32, 0, 0.25].map(z => {
    const indices = [];
    for (let i = 0; i < positions.length; i += 3) {
      if (Math.abs(positions[i+2]-z)<0.09 && positions[i+1]>0.39 && positions[i+1]<0.67) indices.push(i);
    }
    assert(indices.length > 0);
    return indices;
  });
  const bends = [];
  for (let i = 0; i < 96; i++) {
    fox.advance(1/60, 0.94/48, false, 0, -1, false, false, 0);
    if (i < 48) continue;
    fox.contactSurfaces();
    const [hip, waist, chest] = bands.map(band => band.reduce((sum, j) => sum+positions[j], 0)/band.length);
    bends.push(waist-(hip+chest)/2);
  }
  assert(Math.min(...bends)<-0.01 && Math.max(...bends)>0.01);
  fox.dispose();
});
