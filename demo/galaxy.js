// The full evaluation and the bounded path write the same RGBA8 sky.
export const galaxyFragment = `uniform bool uBounded; uniform int uFace; uniform float uSize; uniform mat3 uGal; out vec4 o;
float h13(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1, 0, 0)), f.x), mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), f.x), mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
float fbmv(vec3 p, int oct){ float a = 0.5, s = 0., n = 0.; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vn(p); n += a; p = p * 2.03 + 1.7; a *= 0.5; } return s / n; }
float sq(float x){ return x * x; }
void main(){
  vec2 uv = gl_FragCoord.xy / uSize * 2. - 1.;
  vec3 s = uFace == 0 ? vec3(1., -uv.y, -uv.x) : uFace == 1 ? vec3(-1., -uv.y, uv.x) : uFace == 2 ? vec3(uv.x, 1., uv.y)
         : uFace == 3 ? vec3(uv.x, -1., -uv.y) : uFace == 4 ? vec3(uv.x, -uv.y, 1.) : vec3(-uv.x, -uv.y, -1.);
  vec3 g = normalize(s) * uGal;
  float b = asin(clamp(g.y, -1., 1.)), l = atan(g.z, g.x), lr = abs(l);
  float width = mix(0.2, 0.11, smoothstep(0., 2.4, lr));
  float bb = b - (fbmv(g * 3. + 1.7, 3) - 0.5) * 0.11 - 0.03 * sin(l * 2. + 0.5);
  // the disc, a soft glow around it, and a faint halo over half the sky
  float disc = exp(-sq(bb / width)), broad = exp(-sq(bb / (width * 2.6))) * 0.36 + exp(-sq(bb / 0.7)) * 0.026;
  float bulgeR = sqrt(l * l + sq(b * 1.8)), bulge = exp(-sq(bulgeR / 0.32)) * 0.85;
  float falloff = mix(1., 0.4, smoothstep(1.3, 3., lr));
  float warm = clamp(exp(-sq(bulgeR / 1.4)) * 1.2, 0., 1.), core = clamp(exp(-sq(bulgeR / 0.6)) * 1.2, 0., 1.);
  // A few bright stars and a grain of faint ones, each in its own colour, blue-white to orange, in front of the dust.
  vec3 cell = floor(normalize(s) * uSize * 0.9);
  float faint = pow(h13(cell), 6.), bright = pow(h13(cell + 31.7), 90.), hue = h13(cell + 7.3);
  float stars = (faint * 0.1 + bright * 3.) * (disc * disc + broad * 0.6 + bulge * 0.8);
  vec3 starTint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.78, 0.58), hue * hue);
  // gold at the core, rose and peach around it, lavender along the arms, the blue of the glow around them
  vec3 base = mix(vec3(0.6, 0.64, 1.0), vec3(0.98, 0.72, 0.78), warm);
  base = mix(base, vec3(1.0, 0.7, 0.42), core);
  base = mix(base, vec3(0.4, 0.5, 1.0), (1. - disc) * 0.6);
  // Resolve the halo's two grain octaves first. Its full range alone
  // can straddle several colour levels even where the dust is vanishingly thin.
  float grain = 0.85 + 0.3 * fbmv(g * 150., 2);
  if (uBounded && abs(bb) > 2.7 * width) {
    // Every noise term lies in [0,1]. Bound the light the star clouds can add, the dust they can lose, and how far
    // each colour mix after the noise can move the pigment; finish here only when both ends round to the same code.
    float riftMax = exp(-sq(max(0., abs(bb - 0.01) - 0.105) / 0.048));
    float forkMax = exp(-sq(max(0., abs(bb + 0.05) - 0.198) / 0.02));
    float laneMax = max(riftMax, 0.8 * forkMax);
    float dustMax = min(0.95, 0.86 * laneMax + 0.56 * smoothstep(0., 0.5, disc + 0.4 * bulge) + 1.25 * disc);
    float lo = (0.08 * disc + broad + 0.3 * bulge) * falloff * (1. - dustMax) * grain;
    float hi = (3.13 * disc + broad + bulge) * falloff * grain;
    float tintMax = 0.5 * disc + 0.3 * smoothstep(0.8, 1.6, hi + stars) + 0.3 * dustMax;
    vec3 shine = starTint * starTint * 0.62 * stars;
    vec3 lowColour = max(vec3(0.), base - tintMax), highColour = min(vec3(1.), base + tintMax);
    // Padding by 0.02 code on either side keeps floating-point roundoff
    // away from the rounding boundary. Only identical triples can finish here.
    vec3 lowCode = floor(sqrt(lowColour * lowColour * 0.62 * lo + shine * (1. - 0.6 * dustMax)) * 255. + 0.48);
    vec3 highCode = floor(sqrt(highColour * highColour * 0.62 * hi + shine) * 255. + 0.52);
    if (all(equal(lowCode, highCode))) { o = vec4(lowCode / 255., 1.); return; }
  }
  // star clouds at three sizes: big heaps with dim gaps between them, knots within them, small dense clusters
  float clouds = smoothstep(0.38, 0.82, 0.45 * fbmv(g * 6. + 11., 4) + 0.35 * fbmv(g * 13. + 3., 4) + 0.2 * fbmv(g * 28. + 6., 3));
  float knots = smoothstep(0.6, 0.88, fbmv(g * 36. + 2., 4)), clusters = smoothstep(0.7, 0.92, fbmv(g * 80. + 8., 3));
  float fine = fbmv(g * 38., 4);
  float I = (disc * (0.08 + 2.2 * clouds * clouds * (0.75 + 0.25 * fine) + 0.5 * knots * clouds + 0.35 * clusters * (0.4 + 0.6 * clouds))
           + broad + bulge * (0.3 + 0.7 * clouds)) * falloff;
  // The great rift wanders across the band, thins, breaks and forks; dark clouds sit among the stars, and thin threads
  // of dust cross them.
  float wander = (fbmv(g * 2.2 + 3.3, 3) - 0.5) * 0.16 + (fbmv(g * 9. + 3.3, 3) - 0.5) * 0.05;
  float rift = exp(-sq((bb - 0.01 + wander) / (0.026 + 0.022 * fbmv(g * 5. + 1., 2)))) * smoothstep(0.3, 0.6, fbmv(g * 4. + 7., 3));
  float fork = exp(-sq((bb + 0.05 + wander * 1.6 + (fbmv(g * 6. + 2., 3) - 0.5) * 0.06) / 0.02)) * smoothstep(0.5, 0.75, fbmv(g * 3. + 5., 3));
  float lane = max(rift, fork * 0.8) * smoothstep(-1.5, -0.2, l) * (1. - smoothstep(1., 1.9, l));
  float dpatch = smoothstep(0.56, 0.82, fbmv(g * 13. + 9., 4)) * smoothstep(0., 0.5, disc + bulge * 0.4);
  float coal = smoothstep(0.62, 0.9, fbmv(g * 30. + 4., 3)) * disc;
  float streak = bb + 0.065 + (fbmv(g * 11. + 7., 4) - 0.5) * 0.16;
  float threads = exp(-sq(streak / 0.013)) + 0.58 * exp(-sq((streak + 0.022) / 0.007));
  float dust = clamp(lane * 0.86 + dpatch * 0.56 + coal * 0.46 + threads * disc * 0.5, 0., 0.95);
  I *= (1. - dust) * grain;
  // bright star clouds go pink-white, the brightest whiter still, and dust reddens what it passes
  vec3 col = mix(base, vec3(1.0, 0.86, 0.92), 0.5 * clouds * disc);
  col = mix(col, vec3(1.0, 0.96, 0.92), 0.3 * smoothstep(0.8, 1.6, I + stars));
  col = mix(col, vec3(0.5, 0.26, 0.2), dust * 0.3);
  o = vec4(sqrt(col * col * 0.62 * max(I, 0.) + starTint * starTint * 0.62 * stars * (1. - 0.6 * dust)), 1.);
}`;
