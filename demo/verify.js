// Available through __game.verify() on the deterministic ?test page.
export function verify({ gl, layers, scripted, denseMode, boxelMode, size, tolerance }, view = 'river') {
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
  const maxFieldErrors = layers().map((layer, k) => {
    let max = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = layer.f.sample(x - size / 2, y - size / 2);
        max = Math.max(max, Math.abs(value - grids[k][y * size + x]));
      }
    }
    return max;
  });

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
  const glError = gl.getError();
  return {
    dense, boxel, maxFieldErrors, glError,
    withinTolerance: maxFieldErrors.every(error => error <= tolerance),
    width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
    psnr: squaredError === 0 ? Infinity : 10 * Math.log10(255 ** 2 * pixelCount * 3 / squaredError),
    peak, percentOverTwo: 100 * overTwo / pixelCount,
  };
}
