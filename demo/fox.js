// Fox from Quaternius's Ultimate Animated Animal Pack (CC0).
// https://quaternius.com/packs/ultimateanimatedanimals.html
// GLB conversion: https://github.com/trebeljahr/quaternius-showcase/blob/5b491b755c6d2aaa263aaaf8671b30b559a380a4/public/glb/animals_pack/Fox.glb
import { interpolate, loadAnimal } from './animal-rig.js';

const SCALE = 0.32;

export async function loadFox(gl, shader, contact = false) {
  const rig = await loadAnimal(gl, shader, new URL('./fox.glb', import.meta.url),
    ['Idle', 'Walk', 'Gallop', 'Gallop_Jump'], contact);
  const { rest, clips, nodeIndex, surfaces, skinMatrices } = rig;
  const pose = rest.map(n => n.slice()), blended = rest.map(n => n.slice()), from = rest.map(n => n.slice());
  const chest = nodeIndex('Torso'), neck = nodeIndex('Neck1'), tail = nodeIndex('Tail2');
  const frontFeet = [nodeIndex('IKFrontLeg.L'), nodeIndex('IKFrontLeg.R')];
  const body = nodeIndex('Body');
  const jumpBase = clips.Gallop_Jump.tracks.find(t => t.index === body && !t.offset).values[2];
  let gait = 'Idle', time = 0, fade = 1, dirty = true;
  let steering = 0, tailLag = 0, bakedLift = 0, fromLift = 0;
  function advance(dt, distance, running, turning, jumpPhase) {
    const next = jumpPhase >= 0 ? 'Gallop_Jump' : Math.abs(distance) / dt < 0.10 ? 'Idle' : running ? 'Gallop' : 'Walk';
    if (next !== gait) {
      if (dirty) palette();
      for (let i = 0; i < from.length; i++) from[i].set(blended[i]);
      fromLift = bakedLift;
      time = 0; fade = 0; gait = next;
    }
    const clip = clips[gait];
    const stride = gait === 'Gallop' ? 1.95 : 0.94;
    if (jumpPhase >= 0) time = jumpPhase * clip.duration;
    else time = (time + (gait === 'Idle' ? dt : distance * clip.duration / stride) + clip.duration) % clip.duration;
    steering += (turning-steering) * -Math.expm1(-18*dt);
    tailLag += (steering-tailLag) * -Math.expm1(-6*dt);
    fade = Math.min(1, fade + dt / (jumpPhase >= 0 ? 0.09 : 0.14));
    dirty = true;
  }
  // Rotate in the asset's upright frame. Its joints have different bind axes,
  // and the independently skinned front paw targets must follow the chest pivot.
  function steerBone(m, angle, pivot = m) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const ox = pivot[12], oz = pivot[14];
    for (let k = 0; k < 16; k += 4) {
      const x = m[k], z = m[k+2];
      m[k] = c*x + s*z;
      m[k+2] = -s*x + c*z;
    }
    m[12] += ox*(1-c) - oz*s;
    m[14] += oz*(1-c) + ox*s;
  }
  function steer(index, world) {
    if (index === chest || frontFeet.includes(index)) steerBone(world[index], -steering, world[chest]);
    else if (index === neck) steerBone(world[index], -steering*0.48);
    else if (index === tail) steerBone(world[index], tailLag*0.82);
  }
  function palette() {
    rig.sample(pose, clips[gait], time);
    for (let i = 0; i < pose.length; i++) {
      interpolate(blended[i], from[i], 0, pose[i], 0, 3, fade, 0);
      interpolate(blended[i], from[i], 3, pose[i], 3, 4, fade, 3);
    }
    // World physics supplies the jump arc; keep the authored leg motion.
    bakedLift = fromLift*(1-fade) + (gait === 'Gallop_Jump' ? (pose[body][2]-jumpBase)*100 : 0)*fade;
    rig.apply(blended, steer, bakedLift);
    dirty = false;
  }
  function draw(ground, basis, wet) {
    if (dirty) palette();
    rig.draw(ground, basis, SCALE, wet);
  }
  function contactSurfaces() {
    if (dirty) palette();
    for (const { bind, joints, weights, positions } of surfaces) {
      for (let v = 0; v < bind.length/3; v++) {
        const p = v*3, x = bind[p], y = bind[p+1], z = bind[p+2];
        let px = 0, py = 0, pz = 0;
        for (let k = 4*v; k < 4*v+4; k++) {
          const w = weights[k];
          if (w === 0) continue;
          const b = skinMatrices[joints[k]];
          px += w*(b[0]*x + b[4]*y + b[8]*z + b[12]);
          py += w*(b[1]*x + b[5]*y + b[9]*z + b[13]);
          pz += w*(b[2]*x + b[6]*y + b[10]*z + b[14]);
        }
        positions[p] = px*SCALE; positions[p+1] = py*SCALE; positions[p+2] = pz*SCALE;
      }
    }
    return surfaces;
  }
  return { shader, advance, draw, contactSurfaces, get gait() { return gait; } };
}
