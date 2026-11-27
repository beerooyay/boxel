// Boulder relief photographed by Dimitrios Savva, processed by Rico Cilliers.
// https://polyhaven.com/a/rock_boulder_dry (CC0). The 1.8 m scan is packed as
// tangent normals in RG and a mix of diffuse luminance and cavity shade in B.
// Bark Brown 02 by Rob Tuytel (CC0) supplies the separate sRGB and normal tiles.
// https://polyhaven.com/a/bark_brown_02
export async function loadSurface(file) {
  try {
    const response = await fetch(new URL(file, import.meta.url));
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
  } catch {
    return null;
  }
}

export function uploadSurface(gl, image, unit, format, fallback) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (image) {
    gl.texImage2D(gl.TEXTURE_2D, 0, format, gl.RGBA, gl.UNSIGNED_BYTE, image);
    image.close();
  } else {
    // Preserve the base material when a photo tile is unavailable.
    gl.texImage2D(gl.TEXTURE_2D, 0, format, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...fallback,255]));
  }
  gl.generateMipmap(gl.TEXTURE_2D);
  const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
  if (anisotropy) gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
    Math.min(4, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  return texture;
}
