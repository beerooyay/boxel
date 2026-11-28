// Controllable quadrupeds from Quaternius's Ultimate Animated Animal Pack (CC0).
// https://quaternius.com/packs/ultimateanimatedanimals.html
// GLB conversion: https://github.com/trebeljahr/quaternius-showcase/blob/5b491b755c6d2aaa263aaaf8671b30b559a380a4/public/glb/animals_pack/Fox.glb
import { interpolate, loadAnimal } from './animal-rig.js';
import { sampleWaterline, waterlineEdges, waterPart } from './swim-wake.js';

export async function loadPlayerAnimal(gl, shader, species) {
  const { scale } = species;
  const rig = await loadAnimal(gl, shader, species.url, ['Idle', 'Walk', 'Gallop', 'Gallop_Jump'], true);
  const { rest, clips, nodeIndex, surfaces, skinMatrices } = rig;
  const waterMesh=waterlineEdges(surfaces,rig.boneNames.map(waterPart));
  const pose = rest.map(n => n.slice()), blended = rest.map(n => n.slice()), from = rest.map(n => n.slice());
  const chest = nodeIndex('Torso'), neck = nodeIndex('Neck1'), tail = nodeIndex('Tail2');
  const frontFeet = [nodeIndex('IKFrontLeg.L'), nodeIndex('IKFrontLeg.R')];
  const limbs = new Map();
  for (const [side, phase] of [['L', 0], ['R', Math.PI]]) {
    for (const front of [true, false]) {
      const end = front ? 'Front' : 'Back', shoulder = nodeIndex(end + 'Shoulder.' + side);
      const limb = { shoulder, front, diagonal: front === (side === 'L') ? 1 : -1, phase: phase + (front ? 0 : 0.80 * Math.PI) };
      limbs.set(shoulder, limb);
      limbs.set(nodeIndex('IK' + end + 'Leg.' + side), limb);
    }
  }
  const hipJoints = new Map();
  if (species.id === 'Fox') for (const [side,sign] of [['L',1],['R',-1]]) {
    hipJoints.set(nodeIndex('BackLeg.'+side),{sign, gain:1});
    hipJoints.set(nodeIndex('BackUpperLeg.'+side),{sign, gain:-1.55});
    hipJoints.set(nodeIndex('BackLowerLeg.'+side),{sign, gain:0.55});
  }
  // The paw targets are independently skinned. Fold the thigh and stifle
  // in opposition so the haunch can change shape over a supporting paw.
  let hipSwing=0, hipFold=0;
  const body = nodeIndex('Body');
  const jumpBase = clips.Gallop_Jump.tracks.find(t => t.index === body && !t.offset).values[2];
  rig.sample(pose, clips.Idle, 0);
  rig.apply(pose);
  const heightOf = name => rig.world[nodeIndex(name)][13] * scale;
  const shoulderHeight = heightOf('FrontShoulder.L');
  const head = heightOf('Head');
  const eyeHeight = nodeIndex('Head_end') < 0 ? head + 0.12*shoulderHeight : 0.78*head+0.22*heightOf('Head_end');
  const draft = Math.min(eyeHeight * 0.72, shoulderHeight * 0.9);
  const fore = rig.world[frontFeet[0]], hind = rig.world[nodeIndex('IKBackLeg.L')];
  const waterline = {
    centre: (fore[14] + hind[14]) * scale * 0.5,
    halfLength: (fore[14] - hind[14]) * scale * 0.5 + 0.35 * draft,
    halfWidth: Math.max(Math.abs(fore[12]), Math.abs(hind[12])) * scale + 0.25 * draft,
    draft
  };
  const contactScale = species.id === 'Fox' ? 1 : Math.max(0.72, eyeHeight / 0.85, shoulderHeight / 0.51);
  let gait = 'Idle', time = 0, fade = 1, dirty = true, contactDirty = true;
  let steering = 0, tailLag = 0, bakedLift = 0, fromLift = 0;
  let swim = 0, climb = 0, swimPhase = 0;
  let pawOffset = 0, compression = 0;
  let waistPitch = 0, neckPitch = 0, waistYaw = 0, hindDrive = 0, preload = 0, rearExtension = 0;
  function isStride(g) { return g !== 'Idle' && g !== 'Gallop_Jump'; }
  function clipFor(g) { return clips[g === 'Swim' || g === 'Scramble' ? 'Walk' : g]; }
  function advance(dt, distance, running, turning, jumpPhase, swimming, scrambling, stroke, grade = Number(scrambling), diagonal = 0, settle = 0, push = -1) {
    pawOffset += (diagonal/scale-pawOffset) * -Math.expm1(-24*dt);
    compression = settle * 0.10;
    const next = swimming ? 'Swim' : jumpPhase >= 0 ? 'Gallop_Jump' : scrambling ? 'Scramble'
      : Math.abs(distance) / dt < 0.10 ? 'Idle' : running ? 'Gallop' : 'Walk';
    if (next !== gait) {
      if (dirty) palette();
      for (let i = 0; i < from.length; i++) from[i].set(fade < 1 ? blended[i] : pose[i]);
      fromLift = bakedLift;
      // Walk and scramble share the same footfalls. Carry the stride across
      // changes of grade and speed so a planted foot can finish its step.
      const carryStride = isStride(gait) && isStride(next);
      time = carryStride ? time / clipFor(gait).duration * clipFor(next).duration : 0;
      if (next === 'Swim') swimPhase = carryStride ? time / clipFor(next).duration - stroke : 0;
      fade = 0; gait = next;
    }
    const clip = clipFor(gait);
    const stride = (gait === 'Gallop' ? 1.95 : gait === 'Scramble' ? 0.63 : 0.94) * Math.sqrt(contactScale);
    if (swimming) time = ((stroke + swimPhase + 1) % 1) * clip.duration;
    else if (jumpPhase >= 0) time = jumpPhase * clip.duration;
    else time = (time + (gait === 'Idle' ? dt : distance * clip.duration / stride) + clip.duration) % clip.duration;
    steering += (turning-steering) * -Math.expm1(-18*dt);
    tailLag += (steering-tailLag) * -Math.expm1(-6*dt);
    swim += (Number(swimming)-swim) * -Math.expm1(-9*dt);
    climb += (grade-climb) * -Math.expm1(-12*dt);
    fade = Math.min(1, fade + dt / (jumpPhase >= 0 ? 0.09 : 0.14));
    const cycle = time / clip.duration * Math.PI*2;
    const moving = isStride(gait) ? Math.min(1,Math.abs(distance)/(dt*1.7)) : 0;
    const earlyFlight = jumpPhase >= 0 ? Math.max(0,1-(jumpPhase-0.24)/0.23) : 0;
    preload = push >= 0 ? Math.sin(Math.PI*push) : 0;
    rearExtension = push >= 0 ? 0.16*push*push : 0.16*earlyFlight**3;
    hindDrive = push >= 0 ? push*push : earlyFlight*earlyFlight;
    const shift = gait === 'Idle' ? 0.032*Math.sin(cycle) : 0;
    const hipTarget = shift + (swimming ? 0.08 : 0.16)*moving*Math.sin(cycle);
    hipSwing += (hipTarget-hipSwing)*-Math.expm1(-20*dt);
    hipFold = -0.42*preload+0.14*hindDrive-0.22*settle;
    const flex = moving*Math.sin(cycle)*(running ? 0.10 : 0.045);
    waistPitch += (flex-0.29*hindDrive+0.07*preload-waistPitch)*-Math.expm1(-32*dt);
    neckPitch += (-0.48*waistPitch-neckPitch)*-Math.expm1(-14*dt);
    waistYaw += (0.055*moving*Math.sin(cycle+0.8)-waistYaw)*-Math.expm1(-18*dt);
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
    if (index === chest || frontFeet.includes(index)) {
      steerBone(world[index], -steering+waistYaw, world[chest]);
      pitchBone(world[index], waistPitch, world[chest]);
    }
    else if (index === neck) steerBone(world[index], -steering*0.48);
    else if (index === tail) steerBone(world[index], tailLag*0.82);
    if (index === neck) pitchBone(world[index],neckPitch);
    const hip = hipJoints.get(index);
    if (hip) pitchBone(world[index],hip.gain*(hipFold+hip.sign*hipSwing));
    const limb = limbs.get(index);
    if (limb && !limb.front && hindDrive > 0) pitchBone(world[index],0.48*hindDrive,world[limb.shoulder]);
    if (limb && (preload > 0 || rearExtension > 0 || compression > 0 || Math.abs(pawOffset) > 0.0001)) {
      // Compress both the leg chain and its separately weighted paw target.
      const m = world[index], pivotY = world[limb.shoulder][13];
      const flex = compression + preload*(limb.front ? 0.25 : 0.18) - (limb.front ? 0 : rearExtension);
      for (let k = 1; k < 12; k += 4) m[k] *= 1-flex;
      m[13] += (pivotY-m[13])*flex + limb.diagonal*pawOffset;
    }
    if (swim + Math.abs(climb) < 0.001) return;
    if (index === neck) pitchBone(world[index], -0.23*swim + 0.16*climb);
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
    const weight = fade*fade*(3-2*fade);
    if (fade < 1) for (let i = 0; i < pose.length; i++) {
      interpolate(blended[i], from[i], 0, pose[i], 0, 3, weight, 0);
      interpolate(blended[i], from[i], 3, pose[i], 3, 4, weight, 3);
    }
    // World physics supplies the jump arc; keep the authored leg motion.
    bakedLift = fromLift*(1-weight) + (gait === 'Gallop_Jump' ? (pose[body][2]-jumpBase)*100 : 0)*weight;
    rig.apply(fade < 1 ? blended : pose, steer, bakedLift + (compression+0.19*preload)*shoulderHeight/scale);
    dirty = false;
    contactDirty = true;
  }
  function draw(ground, basis, wet) {
    if (dirty) palette();
    rig.draw(ground, basis, scale, wet);
  }
  function contactSurfaces() {
    if (dirty) palette();
    if (!contactDirty) return surfaces;
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
    contactDirty = false;
    return surfaces;
  }
  function waterContacts(origin,basis,height,slopeX,slopeZ,bounds) {
    contactSurfaces();
    sampleWaterline(waterMesh,contactScale,origin,basis,height,slopeX,slopeZ,bounds);
  }
  return { shader, species, eyeHeight, shoulderHeight, draft, waterline, contactScale,
    advance, draw, contactSurfaces, waterContacts, dispose: rig.dispose, get gait() { return gait; } };
}
