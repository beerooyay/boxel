// Fox from Quaternius's Ultimate Animated Animal Pack (CC0).
// https://quaternius.com/packs/ultimateanimatedanimals.html
// GLB conversion: https://github.com/trebeljahr/quaternius-showcase/blob/5b491b755c6d2aaa263aaaf8671b30b559a380a4/public/glb/animals_pack/Fox.glb
const component = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const SCALE = 0.32;
const UNIT = [1, 1, 1];

function multiply(out, a, b) {
  for (let col = 0; col < 16; col += 4) {
    for (let row = 0; row < 4; row++) {
      out[col + row] = a[row] * b[col] + a[row + 4] * b[col + 1]
        + a[row + 8] * b[col + 2] + a[row + 12] * b[col + 3];
    }
  }
}

function localMatrix(out, [px, py, pz, x, y, z, w], [sx, sy, sz]) {
  const xx = 2*x*x, yy = 2*y*y, zz = 2*z*z, xy = 2*x*y, xz = 2*x*z, yz = 2*y*z;
  const wx = 2*w*x, wy = 2*w*y, wz = 2*w*z;
  out[0] = (1 - yy - zz)*sx; out[1] = (xy+wz)*sx; out[2] = (xz-wy)*sx; out[3] = 0;
  out[4] = (xy-wz)*sy; out[5] = (1 - xx - zz)*sy; out[6] = (yz+wx)*sy; out[7] = 0;
  out[8] = (xz+wy)*sz; out[9] = (yz-wx)*sz; out[10] = (1 - xx - yy)*sz; out[11] = 0;
  out[12] = px; out[13] = py; out[14] = pz; out[15] = 1;
}

function interpolate(out, a, ai, b, bi, count, t, offset) {
  let sign = 1;
  if (count === 4 && a[ai]*b[bi] + a[ai+1]*b[bi+1] + a[ai+2]*b[bi+2] + a[ai+3]*b[bi+3] < 0) sign = -1;
  for (let k = 0; k < count; k++) out[offset+k] = a[ai+k] * (1-t) + b[bi+k] * t * sign;
  if (count === 4) {
    const norm = Math.hypot(out[offset], out[offset+1], out[offset+2], out[offset+3]);
    for (let k = 0; k < count; k++) out[offset+k] /= norm;
  }
}

function readFox(bytes) {
  const header = new DataView(bytes);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2) throw Error('Invalid fox GLB');
  const length = header.getUint32(12, true);
  const model = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
  const binary = 28 + length;
  function read(id) {
    const a = model.accessors[id], view = model.bufferViews[a.bufferView], Type = component[a.componentType];
    return new Type(bytes, binary + (view.byteOffset || 0) + (a.byteOffset || 0), a.count * width[a.type]);
  }
  const fox = model.nodes.find(n => n.mesh !== undefined), skin = model.skins[fox.skin];
  const rest = model.nodes.map(n => Float32Array.of(...n.translation, ...n.rotation));
  const order = [];
  function addBranch(index, parent) {
    order.push({ index, parent, scale: model.nodes[index].scale ?? UNIT });
    for (const child of model.nodes[index].children ?? []) addBranch(child, index);
  }
  for (const root of model.scenes[model.scene].nodes) addBranch(root, -1);
  const inverse = read(skin.inverseBindMatrices);
  const bones = skin.joints.map((index, i) => ({ index, inverse: inverse.subarray(16*i, 16*i+16) }));
  const clips = {};
  for (const animation of model.animations) {
    const name = animation.name.split('|').pop();
    if (!['Idle', 'Walk', 'Gallop', 'Gallop_Jump'].includes(name)) continue;
    const tracks = animation.channels.map(({ sampler, target }) => {
      const sample = animation.samplers[sampler];
      return { index: target.node, offset: target.path === 'rotation' ? 3 : 0,
        times: read(sample.input), values: read(sample.output) };
    });
    clips[name] = { tracks, duration: Math.max(...tracks.map(t => t.times[t.times.length - 1])) };
  }
  return { model, fox, read, rest, order, bones, clips };
}

export async function loadFox(gl, program, vertexHeader, contact = false) {
  const response = await fetch(new URL('./fox.glb', import.meta.url));
  if (!response.ok) throw Error('Could not load the fox model');
  const { model, fox, read, rest, order, bones, clips } = readFox(await response.arrayBuffer());
  const shader = program(vertexHeader + `
in vec3 aPos, aNor;
in vec4 aWeights;
in uvec4 aJoints;
uniform mat4 uBones[${bones.length}];
uniform mat3 uFoxBasis;
uniform vec3 uFoxOrigin;
out vec3 vWP, vN;
void main() {
  mat4 skin = uBones[aJoints.x] * aWeights.x + uBones[aJoints.y] * aWeights.y
            + uBones[aJoints.z] * aWeights.z + uBones[aJoints.w] * aWeights.w;
  vWP = uFoxOrigin + uFoxBasis * (skin * vec4(aPos, 1.)).xyz * ${SCALE};
  vN = uFoxBasis * mat3(skin) * aNor;
  gl_Position = project(vWP);
}`, `
in vec3 vWP, vN;
uniform float uClip, uFoxWet;
uniform vec3 uFur;
out vec4 o;
void main() {
  if (vWP.y < uClip) discard;
  vec3 N = normalize(vN), V = normalize(uCam-vWP);
  vec3 color = pbr(uFur * mix(1., .7, uFoxWet), mix(.88, .56, uFoxWet), 0., N, V, vWP);
  o = vec4(tonemap(fogged(color, vWP)), 0.);
}`);
  const surfaces = [];
  const slots = [
    ['POSITION', 'aPos', 3], ['NORMAL', 'aNor', 3],
    ['WEIGHTS_0', 'aWeights', 4], ['JOINTS_0', 'aJoints', 4],
  ];
  const draws = model.meshes[fox.mesh].primitives.map(primitive => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    for (const [key, name, count] of slots) {
      const id = primitive.attributes[key], type = model.accessors[id].componentType;
      const slot = gl.getAttribLocation(shader, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, read(id), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(slot);
      if (key === 'JOINTS_0') gl.vertexAttribIPointer(slot, count, type, 0, 0);
      else gl.vertexAttribPointer(slot, count, type, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, read(primitive.indices), gl.STATIC_DRAW);
    const { count, componentType } = model.accessors[primitive.indices];
    if (contact) {
      const { POSITION, JOINTS_0, WEIGHTS_0 } = primitive.attributes;
      const bind = read(POSITION);
      surfaces.push({ bind, joints: read(JOINTS_0), weights: read(WEIGHTS_0),
        indices: read(primitive.indices), positions: new Float32Array(bind.length) });
    }
    const fur = model.materials[primitive.material].pbrMetallicRoughness.baseColorFactor.slice(0, 3);
    return { vao, count, componentType, fur };
  });
  gl.bindVertexArray(null);

  const pose = rest.map(n => n.slice()), blended = rest.map(n => n.slice()), from = rest.map(n => n.slice());
  const world = rest.map(() => new Float32Array(16)), local = new Float32Array(16);
  const matrices = new Float32Array(bones.length * 16);
  const skinMatrices = bones.map((_, i) => matrices.subarray(i*16, (i+1)*16));
  const nodeIndex = name => model.nodes.findIndex(n => n.name === name);
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
  function palette() {
    for (let i = 0; i < rest.length; i++) pose[i].set(rest[i]);
    for (const { index, offset, times, values } of clips[gait].tracks) {
      let low = 0, high = times.length - 1;
      while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (times[mid] <= time) low = mid; else high = mid;
      }
      const t = high === low ? 0 : Math.max(0, Math.min(1, (time - times[low]) / (times[high] - times[low])));
      const count = offset ? 4 : 3;
      interpolate(pose[index], values, low*count, values, high*count, count, t, offset);
    }
    for (const { index, parent, scale } of order) {
      const dest = blended[index];
      interpolate(dest, from[index], 0, pose[index], 0, 3, fade, 0);
      interpolate(dest, from[index], 3, pose[index], 3, 4, fade, 3);
      localMatrix(local, dest, scale);
      if (parent < 0) world[index].set(local);
      else multiply(world[index], world[parent], local);
      if (index === chest || frontFeet.includes(index)) steerBone(world[index], -steering, world[chest]);
      else if (index === neck) steerBone(world[index], -steering*0.48);
      else if (index === tail) steerBone(world[index], tailLag*0.82);
    }
    // The authored leap includes vertical root motion on top of the leg poses.
    // Remove that translation from the entire skin; world physics supplies the arc.
    bakedLift = fromLift*(1-fade) + (gait === 'Gallop_Jump' ? (pose[body][2]-jumpBase)*100 : 0)*fade;
    for (let i = 0; i < bones.length; i++) {
      multiply(skinMatrices[i], world[bones[i].index], bones[i].inverse);
      skinMatrices[i][13] -= bakedLift;
    }
    dirty = false;
  }
  function draw(ground, basis, wet) {
    if (dirty) palette();
    gl.uniformMatrix4fv(shader.u('uBones[0]'), false, matrices);
    gl.uniformMatrix3fv(shader.u('uFoxBasis'), false, basis);
    gl.uniform3fv(shader.u('uFoxOrigin'), ground);
    gl.uniform1f(shader.u('uFoxWet'), wet);
    for (const part of draws) {
      gl.uniform3fv(shader.u('uFur'), part.fur);
      gl.bindVertexArray(part.vao);
      gl.drawElements(gl.TRIANGLES, part.count, part.componentType, 0);
    }
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
