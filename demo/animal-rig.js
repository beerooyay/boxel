// The Quaternius pack uses one skin per animal and flat-colour materials.
const component = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const MAX_JOINTS = 52;
const UNIT = [1, 1, 1];
const ORIGIN = [0, 0, 0], IDENTITY = [0, 0, 0, 1];

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

export function interpolate(out, a, ai, b, bi, count, t, offset) {
  let sign = 1;
  if (count === 4 && a[ai]*b[bi] + a[ai+1]*b[bi+1] + a[ai+2]*b[bi+2] + a[ai+3]*b[bi+3] < 0) sign = -1;
  for (let k = 0; k < count; k++) out[offset+k] = a[ai+k] * (1-t) + b[bi+k] * t * sign;
  if (count === 4) {
    const norm = Math.hypot(out[offset], out[offset+1], out[offset+2], out[offset+3]);
    for (let k = 0; k < count; k++) out[offset+k] /= norm;
  }
}

function readRig(bytes, keep) {
  const header = new DataView(bytes);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2) throw Error('Invalid animal GLB');
  const length = header.getUint32(12, true);
  const model = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
  const binary = 28 + length;
  function read(id) {
    const a = model.accessors[id], view = model.bufferViews[a.bufferView], Type = component[a.componentType];
    return new Type(bytes, binary + (view.byteOffset || 0) + (a.byteOffset || 0), a.count * width[a.type]);
  }
  const skinned = model.nodes.find(node => node.skin !== undefined);
  const skin = model.skins[skinned.skin];
  const rest = model.nodes.map(n => Float32Array.of(...(n.translation ?? ORIGIN), ...(n.rotation ?? IDENTITY)));
  const order = [];
  function addBranch(index, parent) {
    order.push({ index, parent, scale: model.nodes[index].scale ?? UNIT });
    for (const child of model.nodes[index].children ?? []) addBranch(child, index);
  }
  for (const root of model.scenes[model.scene].nodes) addBranch(root, -1);
  const inverse = read(skin.inverseBindMatrices);
  const bones = skin.joints.map((index, i) => ({ index, inverse: inverse.subarray(16*i, 16*i+16) }));
  // The stag carries a rigid antler mesh under its head joint.
  const parts = [];
  model.nodes.forEach((node, index) => {
    if (node.mesh === undefined) return;
    const rigid = node.skin === undefined ? bones.push({ index }) - 1 : -1;
    for (const primitive of model.meshes[node.mesh].primitives) parts.push({ primitive, rigid });
  });
  if (bones.length > MAX_JOINTS) throw Error('Animal exceeds the skin palette');
  const clips = {};
  for (const animation of model.animations) {
    const name = animation.name.split('|').pop();
    if (!keep.includes(name)) continue;
    const tracks = animation.channels.map(({ sampler, target }) => {
      const sample = animation.samplers[sampler];
      return { index: target.node, offset: target.path === 'rotation' ? 3 : 0,
        times: read(sample.input), values: read(sample.output) };
    });
    clips[name] = { tracks, duration: Math.max(...tracks.map(t => t.times[t.times.length - 1])) };
  }
  for (const name of keep) if (!clips[name]) throw Error('Missing animal animation: ' + name);
  return { model, read, rest, order, bones, clips, parts };
}

export function animalProgram(program, vertexHeader) {
  return program(vertexHeader + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=4) in vec3 aColour;
layout(location=2) in vec4 aWeights;
layout(location=3) in uvec4 aJoints;
uniform mat4 uBones[${MAX_JOINTS}];
uniform mat3 uAnimalBasis;
uniform vec3 uAnimalOrigin;
uniform float uAnimalScale;
out vec3 vWP, vN, vFur;
void main() {
  mat4 skin = uBones[aJoints.x] * aWeights.x + uBones[aJoints.y] * aWeights.y
            + uBones[aJoints.z] * aWeights.z + uBones[aJoints.w] * aWeights.w;
  vWP = uAnimalOrigin + uAnimalBasis * (skin * vec4(aPos, 1.)).xyz * uAnimalScale;
  vFur = aColour;
  vN = uAnimalBasis * mat3(skin) * aNor;
  gl_Position = project(vWP);
}`, `
in vec3 vWP, vN, vFur;
uniform float uClip, uAnimalWet;
out vec4 o;
void main() {
  if (vWP.y < uClip) discard;
  vec3 N = normalize(vN), V = normalize(uCam-vWP);
  vec3 color = pbr(vFur * mix(1., .7, uAnimalWet), mix(.88, .56, uAnimalWet), 0., N, V, vWP);
  o = vec4(tonemap(fogged(color, vWP)), 0.);
}`);
}

// Merge the material groups once. Their colours travel with the vertices, so a
// visible animal needs one indexed submission, including its eyes and antlers.
function uploadAnimal(gl, model, parts, read, contact) {
  const total = parts.reduce((n, {primitive}) => n + model.accessors[primitive.attributes.POSITION].count, 0);
  if (total > 65535) throw Error('Animal exceeds the vertex index range');
  const attributes = [3, 3, 4, 4, 3];
  const arrays = attributes.map((n, slot) => slot === 3 ? new Uint8Array(n * total) : new Float32Array(n * total));
  const [positions, normals, weights, joints, colours] = arrays;
  const indices = [], surfaces = [];
  let base = 0;
  for (const {primitive, rigid} of parts) {
    const a = primitive.attributes, pos = read(a.POSITION), n = pos.length / 3;
    const triangles = read(primitive.indices);
    positions.set(pos, 3 * base);
    normals.set(read(a.NORMAL), 3 * base);
    const rgb = model.materials[primitive.material].pbrMetallicRoughness.baseColorFactor.slice(0, 3);
    for (let i = base; i < base + n; i++) colours.set(rgb, 3 * i);
    if (rigid >= 0) {
      for (let i = base; i < base + n; i++) { weights[4*i] = 1; joints[4*i] = rigid; }
    } else {
      const j = read(a.JOINTS_0), w = read(a.WEIGHTS_0);
      joints.set(j, 4 * base); weights.set(w, 4 * base);
      if (contact) surfaces.push({ bind: pos, joints: j, weights: w, indices: triangles,
        positions: new Float32Array(pos.length) });
    }
    for (const i of triangles) indices.push(i + base);
    base += n;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = [];
  function bindBuffer(target) {
    const buffer = gl.createBuffer();
    buffers.push(buffer);
    gl.bindBuffer(target, buffer);
  }
  arrays.forEach((data, slot) => {
    bindBuffer(gl.ARRAY_BUFFER);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(slot);
    if (slot === 3) gl.vertexAttribIPointer(slot, 4, gl.UNSIGNED_BYTE, 0, 0);
    else gl.vertexAttribPointer(slot, attributes[slot], gl.FLOAT, false, 0, 0);
  });
  bindBuffer(gl.ELEMENT_ARRAY_BUFFER);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(indices), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  function dispose() {
    gl.deleteVertexArray(vao);
    buffers.forEach(buffer => gl.deleteBuffer(buffer));
  }
  return { vao, count: indices.length, surfaces, dispose };
}

export async function loadAnimal(gl, shader, url, keep, contact = false) {
  const response = await fetch(url);
  if (!response.ok) throw Error('Could not load ' + url);
  const { model, read, rest, order, bones, clips, parts } = readRig(await response.arrayBuffer(), keep);
  const { vao, count, surfaces, dispose } = uploadAnimal(gl, model, parts, read, contact);
  const world = rest.map(() => new Float32Array(16)), local = new Float32Array(16);
  const matrices = new Float32Array(bones.length * 16);
  const skinMatrices = bones.map((_, i) => matrices.subarray(i*16, (i+1)*16));

  function sample(pose, clip, time) {
    for (let i = 0; i < rest.length; i++) pose[i].set(rest[i]);
    for (const { index, offset, times, values } of clip.tracks) {
      let low = 0, high = times.length - 1;
      while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (times[mid] <= time) low = mid; else high = mid;
      }
      const t = high === low ? 0 : Math.max(0, Math.min(1, (time - times[low]) / (times[high] - times[low])));
      const count = offset ? 4 : 3;
      interpolate(pose[index], values, low*count, values, high*count, count, t, offset);
    }
  }
  function apply(pose, adjustBone, lift = 0) {
    for (const { index, parent, scale } of order) {
      localMatrix(local, pose[index], scale);
      if (parent < 0) world[index].set(local);
      else multiply(world[index], world[parent], local);
      if (adjustBone) adjustBone(index, world);
    }
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i], m = skinMatrices[i];
      if (bone.inverse) multiply(m, world[bone.index], bone.inverse);
      else m.set(world[bone.index]);
      m[13] -= lift;
    }
  }
  function draw(origin, basis, scale, wet = 0) {
    gl.uniformMatrix4fv(shader.u('uBones[0]'), false, matrices);
    gl.uniformMatrix3fv(shader.u('uAnimalBasis'), false, basis);
    gl.uniform3fv(shader.u('uAnimalOrigin'), origin);
    gl.uniform1f(shader.u('uAnimalScale'), scale);
    gl.uniform1f(shader.u('uAnimalWet'), wet);
    gl.bindVertexArray(vao);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  }
  return { rest, clips, sample, apply, draw, dispose, skinMatrices, surfaces, world,
    boneNames: bones.map(bone => model.nodes[bone.index].name),
    nodeIndex: name => model.nodes.findIndex(n => n.name === name) };
}
