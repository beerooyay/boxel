// Each KTX2 level already contains the filtered cutouts and their coverage.
export const SPRAY_COLUMNS = 4, SPRAY_ROWS = 2, SPRAY_MAX_LEVEL = 6;
export const STRAP_ASPECT = 0.20;

export async function loadLeafSprays(coarsePointer) {
  const deflate = typeof DecompressionStream === 'function';
  const small = coarsePointer || !deflate;
  const fileName = !deflate ? 'leaf-sprays-raw.ktx2' : small ? 'leaf-sprays-small.ktx2' : 'leaf-sprays.ktx2';
  const response = await fetch(new URL(fileName, import.meta.url));
  if (!response.ok) throw Error('Leaf atlas failed to load (' + response.status + ')');
  const file = await response.arrayBuffer();
  const header = new DataView(file);
  const word = offset => header.getUint32(offset, true);
  // RGBA8_UNORM, one 2D face. Older WebGL2 browsers read the small raw levels directly.
  const levels = small ? SPRAY_MAX_LEVEL : SPRAY_MAX_LEVEL + 1;
  if (word(12) !== 37 || word(40) !== levels || word(44) !== (deflate ? 3 : 0))
    throw Error('Unexpected leaf atlas format');
  return Promise.all(Array.from({ length: levels }, async (_, mip) => {
    const entry = 80 + 24 * mip;
    const width = word(20) >> mip, height = word(24) >> mip;
    const start = Number(header.getBigUint64(entry, true));
    const size = Number(header.getBigUint64(entry + 8, true));
    let bytes = new Uint8Array(file, start, size);
    if (deflate) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (bytes.length !== width * height * 4) throw Error('Incomplete leaf atlas level');
    return { width, height, bytes };
  }));
}

export function uploadLeafSprays(gl, levels, unit) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texStorage2D(gl.TEXTURE_2D, levels.length, gl.RGBA8, levels[0].width, levels[0].height);
  for (const [mip, level] of levels.entries())
    gl.texSubImage2D(gl.TEXTURE_2D, mip, 0, 0, level.width, level.height, gl.RGBA, gl.UNSIGNED_BYTE, level.bytes);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels.length - 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// Where a card's texel lies in the atlas: the family by kind, the variant by seed, inset so mips do not bleed.
export const sprayGLSL = `
uniform sampler2D uLeafSprays;
vec2 sprayUV(float u, float side, float row, float seed){
  float col = floor(fract(seed * 7.131) * ${SPRAY_COLUMNS}.);
  vec2 t = vec2(side * 0.5 + 0.5, u) * 0.96 + 0.02;
  return (vec2(col, row) + t) / vec2(${SPRAY_COLUMNS}., ${SPRAY_ROWS}.);
}`;
