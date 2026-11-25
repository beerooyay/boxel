// Both light sources are fixed above the valley. Capture their depth from the actual
// terrain, boulders and forest once, then reuse it in the scene and its reflection.
export function bakeShadows(gl, size, half, directions, casters) {
  size = Math.min(size, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE9);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT16, size, size, directions.length);
  for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, parameter, gl.LINEAR);
  for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, parameter, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  gl.viewport(0, 0, size, size);
  gl.enable(gl.DEPTH_TEST);
  gl.depthMask(true);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(1.5, 4);

  // Reuse the same vertex deformation and instance layout as the colour pass.
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragment, '#version 300 es\nprecision highp float; void main() {}');
  gl.compileShader(fragment);
  const programs = casters.map(({ source }) => {
    const p = gl.createProgram();
    const vs = gl.getAttachedShaders(source).find(s => gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.VERTEX_SHADER);
    gl.attachShader(p, vs);
    gl.attachShader(p, fragment);
    for (let i = 0; i < gl.getProgramParameter(source, gl.ACTIVE_ATTRIBUTES); i++) {
      const { name } = gl.getActiveAttrib(source, i);
      const location = gl.getAttribLocation(source, name);
      if (location >= 0 && !name.startsWith('gl_')) gl.bindAttribLocation(p, location, name);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
    return p;
  });

  const matrices = directions.map(([x, y, z], layer) => {
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
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, texture, 0, layer);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Shadow depth target incomplete');
    gl.clear(gl.DEPTH_BUFFER_BIT);
    casters.forEach(({ draw }, i) => {
      const p = programs[i];
      gl.useProgram(p);
      gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uVP'), false, matrix);
      gl.uniform1f(gl.getUniformLocation(p, 'uMirror'), 1);
      gl.uniform1f(gl.getUniformLocation(p, 'uLodW'), 1);
      draw();
    });
    return matrix;
  });
  gl.bindVertexArray(null);
  gl.useProgram(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.deleteFramebuffer(fb);
  programs.forEach(p => gl.deleteProgram(p));
  gl.deleteShader(fragment);
  return { texture, matrices: new Float32Array(matrices.flatMap(m => Array.from(m))) };
}
