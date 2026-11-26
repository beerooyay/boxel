// Capture each light's depth from the actual terrain, boulders and forest, then reuse it in the scene and its
// reflection. The planet holds still and is baked once. The star does too, until the day is let run: then `rebake`
// draws one spare layer at a time for where the star is about to be.
export function bakeShadows(gl, size, half, directions, casters, spare = 0) {
  size = Math.min(size, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE9);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT16, size, size, directions.length + spare);
  for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, parameter, gl.LINEAR);
  for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, parameter, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

  const targets = Array.from({ length: directions.length + spare }, (_, layer) => {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, texture, 0, layer);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Shadow depth target incomplete');
    return fb;
  });
  const begin = layer => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets[layer]);
    gl.viewport(0, 0, size, size);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 4);
  };
  const end = () => {
    gl.bindVertexArray(null);
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  };

  // Reuse the same vertex deformation and instance layout as the colour pass.
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragment, '#version 300 es\nprecision highp float; void main() {}');
  gl.compileShader(fragment);
  const draws = [];
  // A caster may bring its own fragment stage, to cut its shadow to what it draws (a leaf card to its leaves).
  const own = [];
  for (const { source, draw, slices = 1, fragmentSource, setup } of casters) {
    const p = gl.createProgram();
    const vs = gl.getAttachedShaders(source).find(s => gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.VERTEX_SHADER);
    gl.attachShader(p, vs);
    let fs = fragment;
    if (fragmentSource) {
      fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fragmentSource); gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(fs));
      own.push(fs);
    }
    gl.attachShader(p, fs);
    for (let i = 0; i < gl.getProgramParameter(source, gl.ACTIVE_ATTRIBUTES); i++) {
      const { name } = gl.getActiveAttrib(source, i);
      const location = gl.getAttribLocation(source, name);
      if (location >= 0 && !name.startsWith('gl_')) gl.bindAttribLocation(p, location, name);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
    const vp = gl.getUniformLocation(p, 'uVP');
    gl.useProgram(p);
    gl.uniform1f(gl.getUniformLocation(p, 'uMirror'), 1);
    gl.uniform1f(gl.getUniformLocation(p, 'uLodW'), 1);
    gl.uniform1i(gl.getUniformLocation(p, 'uSimpleLeaf'), 1);
    setup?.(p);
    for (let i = 0; i < slices; i++) {
      draws.push(matrix => {
        gl.useProgram(p);
        gl.uniformMatrix4fv(vp, false, matrix);
        draw(i, slices);
      });
    }
  }

  gl.deleteShader(fragment);
  for (const fs of own) gl.deleteShader(fs);

  const matrices = new Float32Array(16 * (directions.length + spare));
  const prepare = (layer, [x, y, z]) => {
    const horizontal = Math.hypot(x, z), rx = z / horizontal, rz = -x / horizontal;
    // Fit the projection to the whole square, including its diagonal and the upland canopy.
    const centreY = 22, vertical = 46, along = half * (Math.abs(rx) + Math.abs(rz));
    const width = along + 8, height = Math.abs(y) * along + horizontal * vertical + 4;
    const depth = horizontal * along + Math.abs(y) * vertical + 8;
    const matrix = new Float32Array([
      rx / width, -y * x / horizontal / height, -x / depth, 0,
      0, horizontal / height, -y / depth, 0,
      rz / width, -y * z / horizontal / height, -z / depth, 0,
      0, -centreY * horizontal / height, centreY * y / depth, 1,
    ]);
    return { layer, matrix, cursor: 0 };
  };
  // Only publish the new matrix after its entire spare layer is ready. The
  // main view and the water reflection see the same completed depth map.
  const shadows = {
    texture, matrices, version: 0, prepare, passes: draws.length,
    advance(job, count) {
      begin(job.layer);
      if (job.cursor === 0) gl.clear(gl.DEPTH_BUFFER_BIT);
      const stop = Math.min(draws.length, job.cursor + count);
      while (job.cursor < stop) draws[job.cursor++](job.matrix);
      end();
      if (job.cursor < draws.length) return false;
      matrices.set(job.matrix, 16 * job.layer);
      shadows.version++;
      return true;
    },
    rebake(layer, direction) { shadows.advance(prepare(layer, direction), draws.length); },
  };
  directions.forEach((direction, layer) => shadows.rebake(layer, direction));
  return shadows;
}
