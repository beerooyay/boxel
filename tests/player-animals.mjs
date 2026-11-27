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
