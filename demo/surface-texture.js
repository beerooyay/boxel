// Boulder relief photographed by Dimitrios Savva, processed by Rico Cilliers.
// https://polyhaven.com/a/rock_boulder_dry (CC0). The 1.8 m scan is packed as
// tangent normals in RG and a mix of diffuse luminance and cavity shade in B.
// Bark Brown 02 by Rob Tuytel (CC0) supplies the separate sRGB and normal tiles.
// https://polyhaven.com/a/bark_brown_02
export async function loadSurface(file) {
  try {
    const response = await fetch(new URL(file, import.meta.url));
    if (!response.ok) return null;
    const blob = await response.blob();
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(blob, { colorSpaceConversion: 'none' }); }
      catch { /* Some browsers only decode these JPEGs through an image element. */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    } finally { URL.revokeObjectURL(url); }
  } catch {
    return null;
  }
}

// The emergency tile has the same vertical furrows in its colour and normals.
// Integer frequencies close the seam in both directions at every mip level.
export function barkTile(normals) {
  const size = 128, bytes = new Uint8Array(size*size*4), heights = new Float32Array(size*size);
  const tau = Math.PI*2, wrap = v => (v+size)%size;
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const u=x*tau/size, v=y*tau/size;
    const grain=u+0.10*Math.sin(3*u+v)+0.045*Math.sin(5*u-2*v);
    const cleft=(0.5+0.5*Math.cos(9*grain+0.8*Math.sin(2*v-u)))**5;
    heights[y*size+x]=0.65-0.52*cleft+0.10*Math.sin(23*grain-v)+0.07*Math.sin(41*grain+3*v);
  }
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const i=y*size+x, h=heights[i];
    if(normals) {
      const dx=1.25*(heights[y*size+wrap(x-1)]-heights[y*size+wrap(x+1)]);
      const dy=1.25*(heights[wrap(y-1)*size+x]-heights[wrap(y+1)*size+x]);
      const n=Math.hypot(dx,dy,1);
      bytes.set([127.5+127.5*dx/n,127.5+127.5*dy/n,127.5+127.5/n,255],i*4);
    } else bytes.set([66+77*h,49+66*h,37+50*h,255],i*4);
  }
  return {width:size,height:size,bytes};
}

export function uploadSurface(gl, image, unit, format, fallback) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (image) {
    gl.texImage2D(gl.TEXTURE_2D, 0, format, gl.RGBA, gl.UNSIGNED_BYTE, image);
    image.close?.();
  } else if (typeof fallback === 'function') {
    const {width,height,bytes}=fallback();
    gl.texImage2D(gl.TEXTURE_2D,0,format,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
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
