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
  const foxRig=species.id==='Fox';
  const ribcage=nodeIndex('Torso2');
  const pelvis=nodeIndex('Back'), upperNeck=nodeIndex('Neck2');
  const limbs = new Map(), pawEnds=new Map(), elbows=new Map();
  const legChains=[];
  for (const [side, phase] of [['L', 0], ['R', Math.PI]]) {
    for (const front of [true, false]) {
      const end = front ? 'Front' : 'Back', shoulder = nodeIndex(end + 'Shoulder.' + side);
      const limb = { shoulder, front, swing:0, fold:0, side:side==='L'?1:-1, diagonal: front === (side === 'L') ? 1 : -1, phase: phase + (front ? 0 : 0.80 * Math.PI) };
      legChains.push(limb);
      limbs.set(shoulder, limb);
      const paw=nodeIndex('IK' + end + 'Leg.' + side);
      limbs.set(paw, limb);
      if(foxRig) {
        pawEnds.set(paw,nodeIndex(end+'LowerLeg.'+side+'_end'));
        if(front) elbows.set(nodeIndex('FrontLowerLeg.'+side),limb);
      }
    }
  }
  const hipJoints = new Map();
  if (species.id === 'Fox') for (const [side,sign] of [['L',1],['R',-1]]) {
    const limb=limbs.get(nodeIndex('BackShoulder.'+side));
    hipJoints.set(nodeIndex('BackLeg.'+side),{sign, limb, gain:1});
    hipJoints.set(nodeIndex('BackUpperLeg.'+side),{sign, limb, gain:-1.55});
    hipJoints.set(nodeIndex('BackLowerLeg.'+side),{sign, limb, gain:0.55});
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
  const draft = Math.min(eyeHeight * (foxRig ? 0.80 : 0.72), shoulderHeight * (foxRig ? 1.03 : 0.9));
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
  let swim = 0, climb = 0, swimPhase = 0, cycle = 0;
  let pawOffset = 0, compression = 0;
  let waistPitch = 0, neckPitch = 0, waistYaw = 0, hindDrive = 0, preload = 0, rearExtension = 0;
  let pelvicSway=0, chestSway=0, chestFlex=0, strideWeight=0, airborne=false;
  // A smooth pulse with separate onset and release for each limb.
  function pulse(t,start,end) {
    if (t <= start || t >= end) return 0;
    const u=(t-start)/(end-start);
    return Math.sin(Math.PI*u)**2;
  }
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
    cycle = time / clip.duration * Math.PI*2;
    const moving = isStride(gait) ? Math.min(1,Math.abs(distance)/(dt*1.7)) : 0;
    const earlyFlight = jumpPhase >= 0 ? Math.max(0,1-(jumpPhase-0.24)/0.23) : 0;
    preload = push >= 0 ? Math.sin(Math.PI*push) : 0;
    rearExtension = push >= 0 ? 0.16*push*push : 0.16*earlyFlight**3;
    hindDrive = push >= 0 ? push*push : earlyFlight*earlyFlight;
    const shift = gait === 'Idle' ? 0.032*Math.sin(cycle) : 0;
    const hipTarget = shift + (swimming ? 0.28 : 0.16*moving)*Math.sin(cycle);
    hipSwing += (hipTarget-hipSwing)*-Math.expm1(-20*dt);
    hipFold = -0.58*preload+0.14*hindDrive-0.22*settle;
    const flex = moving*Math.sin(cycle)*(running ? 0.10 : 0.045);
    waistPitch += (flex-0.29*hindDrive+0.07*preload-waistPitch)*-Math.expm1(-32*dt);
    neckPitch += (-0.48*waistPitch-neckPitch)*-Math.expm1(-14*dt);
    waistYaw += (0.055*moving*Math.sin(cycle+0.8)-waistYaw)*-Math.expm1(-18*dt);
    if (foxRig) {
      const blend=-Math.expm1(-20*dt);
      strideWeight+=(moving-strideWeight)*blend;
      pelvicSway+=(-0.095*moving*Math.sin(cycle)-pelvicSway)*blend;
      chestSway+=(0.085*moving*Math.sin(cycle+0.55)-chestSway)*blend;
      airborne=jumpPhase>=0;
      const gather=pulse(jumpPhase,0.33,0.79);
      chestFlex=0.15*preload-0.16*hindDrive+0.24*gather+0.15*settle;
      for (const leg of legChains) {
        const lead=leg.side*0.023;
        const flight=jumpPhase+lead;
        if (leg.front) {
          leg.swing=-0.25*pulse(push+lead,0.24,1)-0.32*pulse(flight,0.52,0.95);
          leg.fold=0.54*pulse(flight,0.23,0.70)+0.26*settle;
        } else {
          leg.fold=-0.52*pulse(flight,0.39,0.91);
          leg.swing=0.24*pulse(flight,0.19,0.52)-0.24*pulse(flight,0.49,0.94);
        }
      }
    }
    dirty = true;
  }
  // Rotate in the asset's upright frame. Its joints have different bind axes,
  // and the independently skinned front paw targets must follow the chest pivot.
  function steerBone(m, angle, pivot = m) {
    if (angle === 0) return;
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
    // The pelvis follows the heading after the chest. Independent paw
    // controls sit outside that hierarchy and receive the same pelvis turn.
    const pelvisTurn=foxRig ? 0.48*tailLag+pelvicSway : 0;
    if (foxRig && (index===pelvis || pawEnds.has(index))) steerBone(world[index],pelvisTurn,world[pelvis]);
    if (index === chest || frontFeet.includes(index)) {
      steerBone(world[index], -steering+waistYaw-pelvisTurn, world[chest]);
      pitchBone(world[index], waistPitch, world[chest]);
    }
    if (foxRig && (index===ribcage || frontFeet.includes(index))) {
      steerBone(world[index],chestSway,world[ribcage]);
      pitchBone(world[index],chestFlex,world[ribcage]);
    }
    if (index === neck) steerBone(world[index], -steering*0.48);
    else if (index === tail) steerBone(world[index], tailLag*0.82);
    if (index === neck) pitchBone(world[index],neckPitch);
    const limb = limbs.get(index);
    if (foxRig && index===upperNeck) pitchBone(world[index],0.09*swim);
    if(foxRig && limb && limb.swing) pitchBone(world[index],limb.swing,world[limb.shoulder]);
    const elbow=elbows.get(index);
    if(foxRig && limb?.front && preload>0) pitchBone(world[index],-0.24*preload,world[limb.shoulder]);
    if(elbow) pitchBone(world[index],elbow.fold+0.46*preload+0.34*swim*Math.cos(cycle+elbow.phase));
    const hip = hipJoints.get(index);
    if (hip) pitchBone(world[index],hip.gain*(hipFold+hip.limb.fold+hip.sign*hipSwing));
    if (limb && !limb.front && hindDrive > 0) pitchBone(world[index],0.48*hindDrive,world[limb.shoulder]);
    if (limb && (preload > 0 || rearExtension > 0 || compression > 0 || Math.abs(pawOffset) > 0.0001)) {
      // Compress both the leg chain and its separately weighted paw target.
      const m = world[index], pivotY = world[limb.shoulder][13];
      const flex = compression + preload*(limb.front ? 0.25 : 0.18) - (limb.front ? 0 : rearExtension);
      for (let k = 1; k < 12; k += 4) m[k] *= 1-flex;
      m[13] += (pivotY-m[13])*flex + limb.diagonal*pawOffset;
    }
    if (swim + Math.abs(climb) < 0.001 && !(foxRig && (airborne || strideWeight>0.001 || Math.abs(steering)>0.001))) return;
    if (index === neck) pitchBone(world[index], (foxRig ? 0.12 : -0.23)*swim + 0.16*climb);
    if (limb && (swim !== 0 || climb !== 0)) {
      const phase = cycle + limb.phase;
      const pull = Math.sin(phase), recovery = Math.max(0, Math.cos(phase));
      const paddle = limb.front ? 0.13+0.66*pull-0.17*recovery : 0.30+(foxRig ? 0.76 : 0.45)*pull;
      const scramble = (limb.front ? -0.31 : 0.20) + 0.29*pull;
      pitchBone(world[index], swim*paddle+climb*scramble, world[limb.shoulder]);
    }
    // Fox paw controls are siblings of the body. The leg ends have already
    // inherited the spine turn and the folded elbow or hock at this point.
    const end=pawEnds.get(index);
    if(end!==undefined) {
      const weight=Math.min(1,swim+Math.abs(steering)*3+strideWeight+Number(airborne));
      for(let j=12;j<15;j++) world[index][j]+=(world[end][j]-world[index][j])*weight;
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
