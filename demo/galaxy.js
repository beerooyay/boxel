// The full evaluation and the bounded path write the same RGBA8 sky.
export const galaxyFragment = `uniform bool uBounded; uniform int uFace; uniform float uSize; uniform mat3 uGal; out vec4 o;
float h13(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1, 0, 0)), f.x), mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), f.x), mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
float fbmv(vec3 p, int oct){ float a = 0.5, s = 0., n = 0.; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vn(p); n += a; p = p * 2.03 + 1.7; a *= 0.5; } return s / n; }
float sq(float x){ return x * x; }
// thin creases where the noise crosses its middle: the branching dark filaments of dust
float ridge(vec3 p, int oct){ return 1. - abs(2. * fbmv(p, oct) - 1.); }
void main(){
  vec2 uv = gl_FragCoord.xy / uSize * 2. - 1.;
  vec3 s = uFace == 0 ? vec3(1., -uv.y, -uv.x) : uFace == 1 ? vec3(-1., -uv.y, uv.x) : uFace == 2 ? vec3(uv.x, 1., uv.y)
         : uFace == 3 ? vec3(uv.x, -1., -uv.y) : uFace == 4 ? vec3(uv.x, -uv.y, 1.) : vec3(-uv.x, -uv.y, -1.);
  vec3 g = normalize(s) * uGal;
  float b = asin(clamp(g.y, -1., 1.)), l = atan(g.z, g.x), lr = abs(l);
  float width = mix(0.2, 0.11, smoothstep(0., 2.4, lr));
  float bb = b - (fbmv(g * 3. + 1.7, 3) - 0.5) * 0.11 - 0.03 * sin(l * 2. + 0.5);
  // the disc, a soft glow around it, and a faint halo over half the sky
  float disc = exp(-sq(bb / width)), broad = exp(-sq(bb / (width * 2.6))) * 0.3 + exp(-sq(bb / 0.7)) * 0.022;
  float bulgeR = sqrt(l * l + sq(b * 1.8)), bulge = exp(-sq(bulgeR / 0.32)) * 0.85;
  float falloff = mix(1., 0.4, smoothstep(1.3, 3., lr));
  float warm = clamp(exp(-sq(bulgeR / 1.4)) * 1.2, 0., 1.), core = clamp(exp(-sq(bulgeR / 0.6)) * 1.2, 0., 1.);
  // a few bright stars and a light grain of faint ones, all in front of the dust
  vec3 cell = floor(normalize(s) * uSize * 0.9);
  float faint = pow(h13(cell), 9.), bright = pow(h13(cell + 31.7), 40.);
  float stars = (faint * 0.12 + bright * 4.) * (disc * disc + broad * 0.5 + bulge * 0.8);
  // gold at the core, rose and peach around it, lavender along the arms, a cool blue halo
  vec3 base = mix(vec3(0.64, 0.66, 1.0), vec3(0.98, 0.72, 0.78), warm);
  base = mix(base, vec3(1.0, 0.7, 0.42), core);
  base = mix(base, vec3(0.42, 0.48, 0.95), (1. - disc) * 0.55);
  float reach = smoothstep(0., 0.6, disc + 0.8 * broad + 0.5 * bulge);
  if (uBounded && abs(bb) > 2.7 * width) {
    // Every noise term lies in [0,1]. Bound the light the star clouds can add, the dust they can lose, and how far
    // each colour mix after the noise can move the pigment; finish here only when both ends round to the same code.
    float laneMax = exp(-sq(max(0., abs(bb - 0.01) - 0.036) / 0.034));
    float dustMax = min(0.95, 0.85 * laneMax + 0.55 * reach + 0.45 * disc);
    float lo = (0.08 * disc + broad + 0.3 * bulge) * falloff * (1. - dustMax) * 0.9 + stars * (1. - 0.6 * dustMax);
    float hi = (2.08 * disc + broad + bulge) * falloff * 1.1 + stars;
    float tintMax = 0.28 * (1. - warm) * disc + 0.3 * smoothstep(0.8, 1.6, hi) + 0.3 * dustMax;
    // Padding by 0.02 code on either side keeps floating-point roundoff
    // away from the rounding boundary. Only identical triples can finish here.
    vec3 lowCode = floor(max(vec3(0.), base - tintMax) * sqrt(0.62 * lo) * 255. + 0.48);
    vec3 highCode = floor(min(vec3(1.), base + tintMax) * sqrt(0.62 * hi) * 255. + 0.52);
    if (all(equal(lowCode, highCode))) { o = vec4(lowCode / 255., 1.); return; }
  }
  // Structure in a disc seen edge-on is drawn out along it: the noise runs about twice as fine across the band as along.
  vec3 a = vec3(g.x, g.y * 2.2, g.z);
  // billowing star clouds: big bright heaps and dim gaps between them, brightest toward the core
  float clouds = smoothstep(0.32, 0.8, 0.5 * fbmv(a * 3. + 11., 4) + 0.3 * fbmv(a * 7. + 3., 4) + 0.2 * fbmv(a * 16. + 6., 3));
  float fine = fbmv(g * 38., 4);
  float I = (disc * (0.08 + 2. * clouds * clouds * (0.75 + 0.25 * fine)) + broad + bulge * (0.3 + 0.7 * clouds)) * falloff;
  // dust: the great rift down the middle, dark filaments that branch across the band, darker clouds among the stars
  vec3 w = a + 0.1 * vec3(fbmv(a * 4. + 1., 3), fbmv(a * 4. + 7., 3), fbmv(a * 4. + 13., 3));
  float lane = exp(-sq((bb - 0.01 + (fbmv(g * 9. + 3.3, 3) - 0.5) * 0.072) / 0.034)) * smoothstep(-1.4, -0.2, l) * (1. - smoothstep(1., 1.8, l));
  float filaments = min(1., smoothstep(0.86, 0.97, ridge(w * 7. + 2., 4)) * 0.7 + smoothstep(0.9, 0.98, ridge(w * 17. + 5., 3)) * 0.4);
  float darks = smoothstep(0.58, 0.82, fbmv(a * 9. + 9., 4)) * disc;
  float dust = clamp(lane * 0.85 + filaments * 0.55 * reach + darks * 0.45, 0., 0.95);
  I *= (1. - dust) * (0.9 + 0.2 * fbmv(g * 150., 2));
  I += stars * (1. - 0.6 * dust);
  // a violet cast in the arms' star clouds, white where they are brightest, brown where dust reddens what it passes
  vec3 col = mix(base, vec3(0.86, 0.66, 1.0), 0.28 * (1. - warm) * clouds * disc);
  col = mix(col, vec3(1.0, 0.95, 0.88), 0.3 * smoothstep(0.8, 1.6, I));
  col = mix(col, vec3(0.5, 0.26, 0.2), dust * 0.3);
  o = vec4(col * sqrt(max(I * 0.62, 0.)), 1.);
}`;
