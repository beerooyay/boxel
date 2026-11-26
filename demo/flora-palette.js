// Artist-facing sRGB swatches. Materials and baked colony light use linear RGB.
const swatches = {
  LEAF: '#4B9B50',
  NEW_GROWTH: '#A8BF53',
  PRAIRIE_ROSE: '#F184A6',
  PETAL_PINK: '#EA4696',
  ORCHID: '#A16ACD',
  SCARLET: '#D94456',
  GOLD: '#F3CB59',
  BLUE: '#568FDC',
  EVERGREEN: '#287149',
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
  ['SCARLET', 'PETAL_PINK', 0.47],
  ['LEAF', 'LEAF', 1],
  ['BLUE', 'BLUE', 1],
  ['ORCHID', 'BLUE', 0.78],
  ['GOLD', 'ORCHID', 0.58],
  ['SCARLET', 'GOLD', 0.64],
  ['LEAF', 'ORCHID', 0.72],
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
  if (seed < 0.78) return mix(LEAF,NEW_GROWTH,0.19*seed/0.78);
  if (seed < 0.85) return PETAL_PINK;
  if (seed < 0.91) return mix(EVERGREEN, LEAF, 0.22 * (seed - 0.85)/0.06);
  if (seed < 0.95) return mix(BLOSSOM, BLOSSOM_TIP, 0.72 * (seed - 0.91)/0.04);
  if (seed < 0.985) return mix(HONEY, APRICOT, (seed - 0.95)/0.035);
  return GOLD;
}
vec3 meadowTip(vec2 p, float elevation, float jitter){
  float habitat = 0.78*vnoise(p*0.030+3.) + 0.22*vnoise(p*0.09-5.) + jitter;
  float variation = vnoise(p*0.052+12.);
  float dry = smoothstep(0.4,8.,elevation);
  vec3 green = mix(LEAF, NEW_GROWTH, 0.14+0.37*variation+0.12*dry);
  float ground = habitat + 0.022*dry;
  float fringe = smoothstep(0.50,0.59,ground) * (1. - smoothstep(0.65,0.74,ground));
  vec3 spring = mix(green, NEW_GROWTH, fringe * (0.58 + 0.32 * variation));
  return mix(spring,PRAIRIE_ROSE,smoothstep(0.62,0.74,ground)) * mix(0.76,1.03,variation);
}`;
