// Artist-facing sRGB swatches. Materials and baked colony light use linear RGB.
const swatches = {
  MAPLE_WINE: '#6D3549',
  MAPLE_COPPER: '#CB6234',
  MAPLE_CORAL: '#CD6A5B',
  MAPLE_ROSE: '#CB738E',
  LEAF: '#698951',
  NEW_GROWTH: '#A8BF53',
  PRAIRIE_ROSE: '#F5B5C8',
  SEDGE: '#83AF89',
  STRAW: '#D6B878',
  PETAL_PINK: '#F0B5C7',
  DUSK_ROSE: '#AD6683',
  FERN: '#758D5A',
  GOLD: '#F3CB59',
  BLUE: '#568FDC',
  EVERGREEN: '#446844',
  BLOSSOM: '#FF9EC6',
  BLOSSOM_TIP: '#FFD4E1',
  HONEY: '#FFC358',
  APRICOT: '#FF9B55',
};
function linear(channel) {
  const s = parseInt(channel,16)/255;
  return s <= 0.04045 ? s/12.92 : ((s+0.055)/1.055)**2.4;
}
const pigment = Object.fromEntries(Object.entries(swatches).map(([name, hex]) =>
  [name, hex.slice(1).match(/../g).map(linear)]));

// Species inherit a pair of pigments with a stable colony-wide split.
const undergrowth = [
  ['PRAIRIE_ROSE', 'PETAL_PINK', 0.47],
  ['LEAF', 'LEAF', 1],
  ['BLUE', 'BLUE', 1],
  ['FERN', 'BLUE', 0.78],
  ['GOLD', 'FERN', 0.58],
  ['PRAIRIE_ROSE', 'GOLD', 0.64],
  ['LEAF', 'FERN', 0.72],
];

export function understoryPigment(type, hue) {
  const [a, b, split] = undergrowth[type];
  return pigment[hue < split ? a : b];
}

export const floraPalette = Object.entries(pigment)
  .map(([name, rgb]) => 'const vec3 ' + name + ' = vec3(' + rgb.map(v => v.toFixed(3)).join(',') + ');')
  .join('\n') + `
vec3 understoryPigment(float type, float hue) {
  ${undergrowth.map(([a,b,split], i) =>
    (i < undergrowth.length - 1 ? 'if (type < ' + (i + 0.5) + ') ' : '') +
    'return ' + (a === b ? a : 'hue < ' + split.toFixed(2) + ' ? ' + a + ' : ' + b) + ';').join('\n  ')}
}
// A stand has a stable inherited hue. Exposure and moisture can modulate its value.
vec3 crownPigment(float seed){
  if (seed > 1.) return MAPLE_CORAL;
  if (seed < 0.78) return mix(LEAF,NEW_GROWTH,0.26+0.19*seed/0.78);
  if (seed < 0.85) return mix(PETAL_PINK,DUSK_ROSE,(seed-0.78)/0.07);
  if (seed < 0.91) return mix(EVERGREEN, LEAF, 0.22 * (seed - 0.85)/0.06);
  if (seed < 0.95) return mix(BLOSSOM, BLOSSOM_TIP, 0.72 * (seed - 0.91)/0.04);
  if (seed < 0.985) return mix(HONEY, APRICOT, (seed - 0.95)/0.035);
  return GOLD;
}
uniform sampler2D uMeadowColour;
vec4 meadowStand(vec2 p){
  return textureLod(uMeadowColour, p / (uExtent+1.) + 0.5, 0.);
}`;

// Linear reflectance and local tone at one-metre posts. The blades, litter and
// nocturnal glow sample the same stand from either side of a tile boundary.
export function writeMeadowColour(bytes, offset, variation, shade, water, dry, rose) {
  for (let c=0; c<3; c++) {
    const leaf = pigment.LEAF[c], newGrowth = pigment.NEW_GROWTH[c];
    let value = leaf + (newGrowth-leaf)*(0.33 + 0.42*variation);
    value += (pigment.EVERGREEN[c]-value)*shade*0.51;
    value += (pigment.SEDGE[c]-value)*water*0.79;
    value += (pigment.STRAW[c]-value)*dry*0.77;
    value += (pigment.PRAIRIE_ROSE[c]-value)*rose;
    bytes[offset+c] = Math.round(255*value*(0.89+0.11*variation));
  }
  bytes[offset+3] = Math.round(255*variation);
}
