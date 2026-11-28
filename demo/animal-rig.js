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
layout(location=4) in vec4 aColour;
layout(location=2) in vec4 aWeights;
layout(location=3) in uvec4 aJoints;
uniform mat4 uBones[${MAX_JOINTS}];
uniform mat3 uAnimalBasis;
uniform vec3 uAnimalOrigin;
uniform float uAnimalScale, uAnimalWet, uAnimalWaterLevel, uNight;
out vec3 vWP, vN, vFur;
out vec2 vWaterLight;
out vec3 vCoatPosition;
flat out float vCoat;
void main() {
  mat4 skin = uBones[aJoints.x] * aWeights.x + uBones[aJoints.y] * aWeights.y
            + uBones[aJoints.z] * aWeights.z + uBones[aJoints.w] * aWeights.w;
  vWP = uAnimalOrigin + uAnimalBasis * (skin * vec4(aPos, 1.)).xyz * uAnimalScale;
  vFur = aColour.rgb;
  vCoat = aColour.a;
  // Allow for the source rig's 100x armature transform. Bind-space
  // markings move with the skin through every gait.
  vCoatPosition = aPos * (100. * uAnimalScale);
  vN = uAnimalBasis * mat3(skin) * aNor;
  vWaterLight = vec2(0.);
  if (uNight > 0. && uMirror > 0. && uAnimalWet > 0.) {
    float depth = swimmerWaterline(vWP.xz,uAnimalWaterLevel) - vWP.y;
    vWaterLight.x = depth;
    if (depth > -0.30) {
      vec4 pulse = surfaceAt(vWP.xz);
      depth += waterWave(vWP.xz,uTime).x + pulse.x;
      vWaterLight = vec2(depth,planktonLight(pulse.a)/(1.+3.7*max(0.,depth)));
    }
  }
  gl_Position = project(vWP);
}`, `
in vec3 vWP, vN, vFur;
in vec2 vWaterLight;
in vec3 vCoatPosition;
flat in float vCoat;
uniform float uClip, uAnimalWet;
out vec4 o;
void main() {
  if (vWP.y < uClip) discard;
  vec3 N = normalize(vN), V = normalize(uCam-vWP);
  float facing = dot(N,uSunDir);
  float edge = 1.-clamp(dot(N,V),0.,1.);
  float sheen = edge*edge*edge*smoothstep(-0.25,0.60,-dot(V,uSunDir))*vCoat*(1.-uNight)*(1.-0.86*uAnimalWet);
  float sun = facing>0. || sheen>0.001 ? directLight(vWP) : 0.;
  vec3 pigment = vFur;
  if (vCoat>0. && uNight<1.) {
    // Longitudinal guard hairs follow the dorsal axis; break up their lay
    // in small locks. Fade the grain when a lock is smaller than a pixel.
    vec3 p = vCoatPosition;
    float across = p.x + 0.68*p.z;
    vec2 lay = vec2(105.*across, 16.*p.y);
    float resolved = 1.-smoothstep(0.35,1.1,max(fwidth(lay.x),fwidth(lay.y)));
    float lock = vnoise(vec2(18.*across,6.*p.y));
    float hair = vnoise(lay + vec2(3.6*lock,0.));
    pigment *= 1.+(1.-uNight)*(1.-0.75*uAnimalWet)*resolved*(0.14*(lock-0.5)+0.26*(hair-0.5));
  }
  vec3 color = pbr(pigment * mix(1., .7, uAnimalWet), mix(.88, .56, uAnimalWet), 0., N,V,vWP,sun,canopyCover(vWP));
  // Light caught at a grazing angle gives the coat a soft edge. Wet hair
  // lies flat, reducing the sheen as the animal wades or swims.
  color += (0.06+0.20*pigment)*uSunCol*sun*sheen;
  // Grazing green light from the excited water catches the wet flanks and
  // paws. Keep the fur pigment and let the refracted scene carry it to the eye.
  float immersed = smoothstep(0.,0.055,vWaterLight.x);
  color += vec3(0.14,0.66,0.48)*(0.26+0.74*vFur)*(0.64+0.36*N.y)*vWaterLight.y*immersed*uNight*uNight;
  o = vec4(tonemap(fogged(color, vWP)), 0.);
}`);
}

// Flat-shaded faces split vertices for their render normals. Grass and water
// only need the posed surface, so skin each identical position/influence once.
function contactMesh(positions, joints, weights, triangles) {
  const ids = new Map(), source = [];
  const remap = new Uint16Array(positions.length/3);
  for (let vertex = 0; vertex < remap.length; vertex++) {
    const p = 3*vertex, b = 4*vertex;
    let key = positions[p] + ',' + positions[p+1] + ',' + positions[p+2];
    for (let j = b; j < b+4; j++) key += ';' + joints[j] + ',' + weights[j];
    let id = ids.get(key);
    if (id === undefined) {
      id = source.length;
      ids.set(key, id);
      source.push(vertex);
    }
    remap[vertex] = id;
  }
  const indices = Uint16Array.from(triangles, vertex => remap[vertex]);
  const bind = new Float32Array(source.length*3);
  const skinJoints = new Uint8Array(source.length*4), skinWeights = new Float32Array(source.length*4);
  for (let i = 0; i < source.length; i++) {
    const p = source[i]*3, b = source[i]*4;
    bind.set(positions.subarray(p,p+3), 3*i);
    skinJoints.set(joints.subarray(b,b+4), 4*i);
    skinWeights.set(weights.subarray(b,b+4), 4*i);
  }
  return { bind, joints: skinJoints, weights: skinWeights, indices, positions: new Float32Array(bind.length) };
}

// Give neighbouring coat faces a shared lighting normal while keeping the
// breaks at sharply folded ears. Pigment boundaries can cross a smooth flank.
function softenCoatNormals(positions, normals, colours) {
  const groups = new Map();
  for (let i=0; i<positions.length/3; i++) {
    if (!colours[4*i+3]) continue;
    const p = 3*i, key = positions[p]+','+positions[p+1]+','+positions[p+2];
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key,[p]);
  }
  const authored = normals.slice();
  for (const group of groups.values()) {
    for (const p of group) {
      const x = authored[p], y = authored[p+1], z = authored[p+2];
      let sx=0, sy=0, sz=0;
      for (const q of group) {
        const alignment=x*authored[q]+y*authored[q+1]+z*authored[q+2];
        const w=Math.max(0,Math.min(1,(alignment-0.45)*3));
        sx+=w*authored[q]; sy+=w*authored[q+1]; sz+=w*authored[q+2];
      }
      const blend=0.85/(Math.hypot(sx,sy,sz)||1);
      normals[p]=0.15*x+blend*sx; normals[p+1]=0.15*y+blend*sy; normals[p+2]=0.15*z+blend*sz;
    }
  }
}

// Merge the material groups once. Their colours travel with the vertices, so a
// visible animal needs one indexed submission, including its eyes and antlers.
function uploadAnimal(gl, model, parts, read, contact) {
  const total = parts.reduce((n, {primitive}) => n + model.accessors[primitive.attributes.POSITION].count, 0);
  if (total > 65535) throw Error('Animal exceeds the vertex index range');
  const attributes = [3, 3, 4, 4, 4];
  const arrays = attributes.map((n, slot) => slot === 3 ? new Uint8Array(n * total)
    : slot === 4 ? new Uint16Array(n * total) : new Float32Array(n * total));
  const [positions, normals, weights, joints, colours] = arrays;
  const indices = [], surfaces = [];
  let base = 0;
  for (const {primitive, rigid} of parts) {
    const a = primitive.attributes, pos = read(a.POSITION), n = pos.length / 3;
    const triangles = read(primitive.indices);
    positions.set(pos, 3 * base);
    normals.set(read(a.NORMAL), 3 * base);
    const material = model.materials[primitive.material];
    const colour = material.pbrMetallicRoughness.baseColorFactor.slice(0,3).map(v=>Math.round(v*65535));
    // The husky and stag exports retained Blender's generic material names.
    const coat = /^(Main(?:_.*)?|Hair|Grey)$/.test(material.name) ||
      (rigid<0 && (material.name==='Material' || (primitive.material===1 && material.name.startsWith('Material.'))));
    colour.push(coat ? 65535 : 0);
    for (let i = base; i < base + n; i++) colours.set(colour, 4 * i);
    if (rigid >= 0) {
      for (let i = base; i < base + n; i++) { weights[4*i] = 1; joints[4*i] = rigid; }
    } else {
      const j = read(a.JOINTS_0), w = read(a.WEIGHTS_0);
      joints.set(j, 4 * base); weights.set(w, 4 * base);
      if (contact) surfaces.push(contactMesh(pos, j, w, triangles));
    }
    for (const i of triangles) indices.push(i + base);
    base += n;
  }
  softenCoatNormals(positions,normals,colours);
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
    else gl.vertexAttribPointer(slot, attributes[slot], slot===4 ? gl.UNSIGNED_SHORT : gl.FLOAT, slot===4, 0, 0);
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
