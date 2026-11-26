// Available through __game.verify() on the deterministic ?test page.
export function verify({ gl, layers, scripted, darkControl, denseMode, boxelMode, size, tolerance }, view = 'river') {
  const pixels = () => {
    const rgba = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return rgba;
  };

  const dense = scripted(denseMode, 900, view);
  const reference = pixels();
  // Grid rows point into WASM memory. Copy them before changing engines.
  const grids = layers().map(layer => {
    const values = new Float32Array(size * size);
    const sheet = layer.sheet;
    for (let y = 0; y < size; y++) {
      const row = layer.g.row(y - size / 2);
      for (let x = 0; x < size; x++) values[y * size + x] = row[x] + sheet;
    }
    return values;
  });
  const boxel = scripted(boxelMode, 900, view);
  const image = pixels();
  const fields = layers().map((layer, k) => {
    const bound = layer.f.stats().bound;
    let largestDeficit = 0, largestExcess = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = layer.f.sample(x - size / 2, y - size / 2);
        const deficit = grids[k][y * size + x] - value;
        largestDeficit = Math.max(largestDeficit, deficit);
        largestExcess = Math.max(largestExcess, -deficit);
      }
    }
    return { bound, largestDeficit, largestExcess };
  });
  const maxFieldErrors = fields.map(({ largestDeficit, largestExcess }) => Math.max(largestDeficit, largestExcess));

  darkControl();
  const picture = checkPicture(reference, image, pixels());
  const glError = gl.getError();
  return {
    dense, boxel, fields, maxFieldErrors, glError,
    withinBound: fields.every(({ bound, largestDeficit, largestExcess }) => largestExcess === 0 && largestDeficit <= bound),
    boundWithinTolerance: fields.every(({ bound }) => bound <= tolerance),
    withinTolerance: maxFieldErrors.every(error => error <= tolerance),
    width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
    ...picture, picturePass: glError === gl.NO_ERROR && picture.picturePass,
  };
}

function compareRGB(reference, image) {
  let squaredError = 0, peak = 0, overTwo = 0;
  for (let i = 0; i < image.length; i += 4) {
    let largest = 0;
    for (let channel = 0; channel < 3; channel++) {
      const error = Math.abs(reference[i + channel] - image[i + channel]);
      squaredError += error * error;
      largest = Math.max(largest, error);
    }
    peak = Math.max(peak, largest);
    if (largest > 2) overTwo++;
  }
  const pixelCount = image.length / 4;
  return { psnr: squaredError === 0 ? Infinity : 10 * Math.log10(255 ** 2 * pixelCount * 3 / squaredError),
    peak, percentOverTwo: 100 * overTwo / pixelCount };
}

function contrast(rgba) {
  let sum = 0, squares = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const y = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    sum += y; squares += y * y;
  }
  const n = rgba.length / 4;
  return Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2));
}

export function checkPicture(dense, boxel, dark) {
  const comparison = compareRGB(dense, boxel), control = compareRGB(boxel, dark);
  const sceneContrast = Math.min(contrast(dense), contrast(boxel));
  const fieldVisible = control.peak >= 8 && control.percentOverTwo >= 0.1;
  return { ...comparison, control, sceneContrast, fieldVisible,
    picturePass: sceneContrast >= 4 && fieldVisible && comparison.psnr >= 50 && comparison.percentOverTwo <= 1 };
}

// Read the actual RGBA8 cube, including the polar regions and face seams.
export function compareSkyFaces(gl, size, optimized, reference) {
  const fb = gl.createFramebuffer(), actual = new Uint8Array(size * size * 4), full = new Uint8Array(actual.length);
  let different = 0, maxDelta = 0, referencePeak = 0, referenceFloor = 255;
  const read = (texture, face, data) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Sky comparison framebuffer incomplete');
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, data);
  };
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  try {
    for (let face = 0; face < 6; face++) {
      read(optimized, face, actual); read(reference, face, full);
      for (let i = 0; i < full.length; i += 4) {
        const delta = Math.max(Math.abs(full[i] - actual[i]), Math.abs(full[i + 1] - actual[i + 1]),
          Math.abs(full[i + 2] - actual[i + 2]), Math.abs(full[i + 3] - actual[i + 3]));
        const brightness = Math.max(full[i], full[i + 1], full[i + 2]);
        referenceFloor = Math.min(referenceFloor, brightness);
        referencePeak = Math.max(referencePeak, brightness);
        if (delta) different++;
        maxDelta = Math.max(maxDelta, delta);
      }
    }
    return { texels: 6 * size * size, different, maxDelta, referencePeak, referenceFloor, glError: gl.getError() };
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
  }
}

// Compare integrated sunlight, skylight, distance haze and opacity over a
// full hemisphere. Bright crowns, shaded bases and clear sky act as controls.
export function compareClouds(gl, clouds, rain) {
  const state = { t: 12 + 30 * rain, eye: [8 - 87 * rain, 3 + 14 * rain, 30 + 12 * rain],
    light: [-0.86, 0.4, -0.32], base: 360 - 190 * rain, rain };
  const pixels = clouds.width * clouds.height, bounded = new Uint8Array(pixels * 4), full = new Uint8Array(bounded.length);
  clouds.readOptics(state, true, bounded);
  clouds.readOptics(state, false, full);
  let different = 0, clear = 0, opaque = 0, sunlit = 0, shaded = 0;
  for (let i = 0; i < bounded.length; i += 4) {
    if (bounded[i] !== full[i] || bounded[i + 1] !== full[i + 1] ||
        bounded[i + 2] !== full[i + 2] || bounded[i + 3] !== full[i + 3]) different++;
    const alpha = full[i + 3];
    if (alpha < 8) clear++;
    if (alpha > 210) {
      opaque++;
      if (full[i] > 120) sunlit++;
      if (full[i] < 60) shaded++;
    }
  }
  return { pixels, different, clear, opaque, sunlit, shaded, glError: gl.getError() };
}
