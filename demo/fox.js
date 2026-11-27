// Controllable quadrupeds from Quaternius's Ultimate Animated Animal Pack (CC0).
// https://quaternius.com/packs/ultimateanimatedanimals.html
// GLB conversion: https://github.com/trebeljahr/quaternius-showcase/blob/5b491b755c6d2aaa263aaaf8671b30b559a380a4/public/glb/animals_pack/Fox.glb
import { interpolate, loadAnimal } from './animal-rig.js';

export async function loadPlayerAnimal(gl, shader, species) {
  const { scale } = species;
  const rig = await loadAnimal(gl, shader, species.url, ['Idle', 'Walk', 'Gallop', 'Gallop_Jump'], true);
  const { rest, clips, nodeIndex, surfaces, skinMatrices } = rig;
  const pose = rest.map(n => n.slice()), blended = rest.map(n => n.slice()), from = rest.map(n => n.slice());
  const chest = nodeIndex('Torso'), neck = nodeIndex('Neck1'), tail = nodeIndex('Tail2');
  const frontFeet = [nodeIndex('IKFrontLeg.L'), nodeIndex('IKFrontLeg.R')];
  const limbs = new Map();
  for (const [side, phase] of [['L', 0], ['R', Math.PI]]) {
    for (const front of [true, false]) {
      const end = front ? 'Front' : 'Back', shoulder = nodeIndex(end + 'Shoulder.' + side);
      const limb = { shoulder, front, phase: phase + (front ? 0 : 0.80 * Math.PI) };
      limbs.set(shoulder, limb);
      limbs.set(nodeIndex('IK' + end + 'Leg.' + side), limb);
    }
  }
  const body = nodeIndex('Body');
  const jumpBase = clips.Gallop_Jump.tracks.find(t => t.index === body && !t.offset).values[2];
  rig.sample(pose, clips.Idle, 0);
  rig.apply(pose);
  const heightOf = name => rig.world[nodeIndex(name)][13] * scale;
  const shoulderHeight = heightOf('FrontShoulder.L');
  const head = heightOf('Head');
  const eyeHeight = nodeIndex('Head_end') < 0 ? head + 0.12*shoulderHeight : 0.78*head+0.22*heightOf('Head_end');
  const draft = Math.min(eyeHeight * 0.72, shoulderHeight * 0.9);
  const contactScale = species.id === 'Fox' ? 1 : Math.max(0.72, eyeHeight / 0.85, shoulderHeight / 0.51);
  let gait = 'Idle', time = 0, fade = 1, dirty = true;
  let steering = 0, tailLag = 0, bakedLift = 0, fromLift = 0;
  let swim = 0, climb = 0;
  function clipFor(g) { return clips[g === 'Swim' || g === 'Scramble' ? 'Walk' : g]; }
  function advance(dt, distance, running, turning, jumpPhase, swimming, scrambling, stroke) {
    const next = swimming ? 'Swim' : jumpPhase >= 0 ? 'Gallop_Jump' : scrambling ? 'Scramble'
      : Math.abs(distance) / dt < 0.10 ? 'Idle' : running ? 'Gallop' : 'Walk';
    if (next !== gait) {
      if (dirty) palette();
      for (let i = 0; i < from.length; i++) from[i].set(blended[i]);
      fromLift = bakedLift;
      time = 0; fade = 0; gait = next;
    }
    const clip = clipFor(gait);
    const stride = (gait === 'Gallop' ? 1.95 : gait === 'Scramble' ? 0.63 : 0.94) * Math.sqrt(contactScale);
    if (swimming) time = stroke * clip.duration;
    else if (jumpPhase >= 0) time = jumpPhase * clip.duration;
    else time = (time + (gait === 'Idle' ? dt : distance * clip.duration / stride) + clip.duration) % clip.duration;
    steering += (turning-steering) * -Math.expm1(-18*dt);
    tailLag += (steering-tailLag) * -Math.expm1(-6*dt);
    swim += (Number(swimming)-swim) * -Math.expm1(-9*dt);
    climb += (Number(scrambling)-climb) * -Math.expm1(-12*dt);
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
  // The leg chains and separately weighted paw targets rotate about the same
  // shoulder in the model's upright frame, including on the long-legged rigs.
  function pitchBone(m, angle, pivot = m) {
    const c = Math.cos(angle), s = Math.sin(angle), oy = pivot[13], oz = pivot[14];
    for (let k = 0; k < 16; k += 4) {
      const y = m[k+1], z = m[k+2];
      m[k+1] = c*y-s*z; m[k+2] = s*y+c*z;
    }
    m[13] += oy*(1-c)+oz*s;
    m[14] += oz*(1-c)-oy*s;
  }
  function steer(index, world) {
    if (index === chest || frontFeet.includes(index)) steerBone(world[index], -steering, world[chest]);
    else if (index === neck) steerBone(world[index], -steering*0.48);
    else if (index === tail) steerBone(world[index], tailLag*0.82);
    if (swim + climb < 0.001) return;
    if (index === neck) pitchBone(world[index], -0.23*swim + 0.16*climb);
    const limb = limbs.get(index);
    if (limb) {
      const phase = time / clipFor(gait).duration * 2*Math.PI + limb.phase;
      const pull = Math.sin(phase), recovery = Math.max(0, Math.cos(phase));
      const paddle = limb.front ? 0.13+0.66*pull-0.17*recovery : 0.30+0.45*pull;
      const scramble = (limb.front ? -0.31 : 0.20) + 0.29*pull;
      pitchBone(world[index], swim*paddle+climb*scramble, world[limb.shoulder]);
    }
  }
  function palette() {
    rig.sample(pose, clipFor(gait), time);
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
    rig.draw(ground, basis, scale, wet);
  }
  function contactSurfaces() {
    if (dirty) palette();
    const toGrid = scale / contactScale;
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
        positions[p] = px*toGrid; positions[p+1] = py*toGrid; positions[p+2] = pz*toGrid;
      }
    }
    return surfaces;
  }
  return { shader, species, eyeHeight, shoulderHeight, draft, contactScale,
    advance, draw, contactSurfaces, dispose: rig.dispose, get gait() { return gait; } };
}
