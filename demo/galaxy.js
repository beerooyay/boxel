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
  float width = mix(0.21, 0.12, smoothstep(0., 2.4, lr));
  float bb = b - (fbmv(g * 3. + 1.7, 3) - 0.5) * 0.11 - 0.03 * sin(l * 2. + 0.5);
  // the disc, a broad glow around it, and a faint halo over half the sky
  float disc = exp(-sq(bb / width)), broad = exp(-sq(bb / (width * 3.2))) * 0.28 + exp(-sq(bb / 0.75)) * 0.025;
  float bulgeR = sqrt(l * l + sq(b * 1.8)), bulge = exp(-sq(bulgeR / 0.3)) * 1.25;
  float falloff = mix(1., 0.45, smoothstep(1.4, 3., lr));
  float grain = 0.8 + 0.4 * fbmv(g * 170., 2);
  vec3 cell = floor(normalize(s) * uSize * 0.9);
  float faint = pow(h13(cell), 7.), bright = pow(h13(cell + 31.7), 40.);
  float stars = (faint * 0.3 + bright * 4.) * (disc * disc + broad * 0.5 + bulge * 0.8);
  vec3 base = mix(vec3(0.6, 0.55, 1.0), vec3(1.0, 0.72, 0.42), clamp(exp(-sq(bulgeR / 0.75)) * 1.3, 0., 1.));
  base = mix(base, vec3(0.6, 0.5, 1.0), (1. - disc) * 0.4);
  if (uBounded && abs(bb) > 2.7 * width) {
    // All noise octaves lie in [0,1]. Bound the dust removed from the halo
    // and the foreground stars, and the pigment each remaining colour mix adds.
    float laneMax = exp(-sq(max(0., abs(bb - 0.012) - 0.0351) / 0.038));
    float dustMax = min(0.96, 0.86 * laneMax + 0.56 * smoothstep(0., 0.5, disc + 0.4 * bulge) + 1.38 * disc);
    float tintMax = 0.60 * dustMax + 1.55 * disc;
    float lo = (0.42 * disc + broad + 0.55 * bulge) * falloff * (1. - dustMax) * grain + stars * (1. - 0.6 * dustMax);
    float hi = (2.07 * disc + broad + bulge) * falloff * grain + stars;
    // Padding by 0.02 code on either side keeps floating-point roundoff
    // away from the rounding boundary. Only identical triples can finish here.
    vec3 lowCode = floor(max(vec3(0.), base - tintMax) * sqrt(0.62 * lo) * 255. + 0.48);
    vec3 highCode = floor(min(vec3(1.), base + tintMax) * sqrt(0.62 * hi) * 255. + 0.52);
    if (all(equal(lowCode, highCode))) { o = vec4(lowCode / 255., 1.); return; }
  }
  float clouds = smoothstep(0.28, 0.78, fbmv(g * 7. + 11., 4)), fine = fbmv(g * 42., 4);
  float knots = smoothstep(0.55, 0.85, fbmv(g * 16. + 2., 4)) * disc;
  float I = disc * (0.42 + clouds * (0.6 + 0.45 * fine)) + broad + knots * 0.6 * (0.6 + 0.4 * fine) + bulge * (0.55 + 0.45 * fine);
  I *= falloff;
  float lane = exp(-sq((bb - 0.012 + (fbmv(g * 9. + 3.3, 3) - 0.5) * 0.07) / 0.038)) * smoothstep(-1.25, -0.15, l) * (1. - smoothstep(0.9, 1.6, l));
  float dpatch = smoothstep(0.56, 0.82, fbmv(g * 13. + 9., 4)) * smoothstep(0., 0.5, disc + bulge * 0.4);
  float coal = smoothstep(0.62, 0.9, fbmv(g * 30. + 4., 3)) * disc;
  float streak = bb + 0.065 + (fbmv(g * 11. + 7., 4) - 0.5) * 0.16;
  float threads = exp(-sq(streak / 0.013)) + 0.58 * exp(-sq((streak + 0.022) / 0.007));
  float dust = clamp(lane * 0.86 + dpatch * 0.56 + coal * 0.46 + threads * disc * 0.58, 0., 0.96);
  I *= (1. - dust) * grain;
  I += stars * (1. - 0.6 * dust);
  vec3 col = mix(base, vec3(1.0, 0.92, 0.95), knots * 0.35);
  col = mix(col, vec3(1.0, 0.5, 0.32), dust * 0.6);
  float neb = smoothstep(0.6, 0.84, fbmv(g * 22. + 5.5, 3)) * disc;
  col = mix(col, vec3(1.0, 0.38, 0.62), neb * smoothstep(-0.9, 0.2, l) * (1. - smoothstep(1.1, 1.8, l)) * 0.75);
  col = mix(col, vec3(0.35, 0.92, 0.88), neb * smoothstep(1.5, 2.1, lr) * 0.45);
  o = vec4(col * sqrt(max(I * 0.62, 0.)), 1.);
}`;
