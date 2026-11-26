import { viewRay } from './valley-light.js';

// A balanced eight-frame subpixel pattern. The first frame after a cut uses
// the centre sample, so a teleport or a resized canvas is immediately usable.
const samples = [[1, -3], [-1, 3], [-5, -1], [3, 5], [5, -5], [-3, -7], [7, 1], [-7, 7]];
export const depthRange = [0.05, 3000];
export function cameraJitter(previous, eye, forward, time, width, height) {
  const centre = { phase: -1, offset: [0, 0] };
  if (!previous || time < previous.time || time - previous.time > 0.25) return centre;
  const travel = Math.hypot(eye[0] - previous.eye[0], eye[1] - previous.eye[1], eye[2] - previous.eye[2]);
  const turn = Math.hypot(forward[0] - previous.forward[0], forward[1] - previous.forward[1], forward[2] - previous.forward[2]);
  if (travel > 1.5 || turn > 0.35) return centre;
  const phase = (previous.phase + 1) % samples.length;
  // MSAA already covers silhouettes within a frame. Narrow the extra sampling
  // footprint across a moving edge where fewer old samples can be trusted.
  const motion = (turn + travel * 0.15) * height;
  const spread = 0.26 + 0.74 / (1 + 4 * motion * motion);
  return { phase, offset: [spread * samples[phase][0] / (8 * width), spread * samples[phase][1] / (8 * height)] };
}

export const historyColor = `
vec3 packLight(vec3 c){ return uHDR > 0.5 ? sqrt(max(c, 0.) / (1. + max(c, 0.))) : c; }
vec3 unpackLight(vec3 c){ vec3 q = c * c; return uHDR > 0.5 ? q / max(1. - q, 0.001) : c; }
`;

export const temporalFragment = viewRay + historyColor + `
uniform sampler2D tMap, tHistory;
uniform mat4 uPreviousVP;
uniform bool uReuse;
in vec2 vUv; out vec4 o;
vec3 toYCoCg(vec3 c){ return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
vec3 fromYCoCg(vec3 c){ return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
float depthCode(float distance){ return log2(max(1., distance / uDepthRange.x)) / log2(uDepthRange.y / uDepthRange.x); }
void main(){
  vec3 current = packLight(texture(tMap, vUv).rgb);
  float raw = texture(tDepth, vUv).r, z = viewDepth(raw);
  bool sky = raw == 1.;
  o = vec4(current, sky ? 1. : depthCode(z));
  if (!uReuse) return;
  vec3 ray = cameraRay(vUv);
  // The sky follows rotation only. History is on the unjittered output grid.
  vec4 previous = sky ? uPreviousVP * vec4(ray, 0.) : uPreviousVP * vec4(uCam + ray * z, 1.);
  vec2 uv = (previous.xy / previous.w + uJitter) * 0.5 + 0.5;
  if (previous.w <= 0. || any(greaterThanEqual(abs(uv - 0.5), vec2(0.5)))) return;
  ivec2 sz = textureSize(tHistory, 0);
  float lastDepth = texelFetch(tHistory, ivec2(uv * vec2(sz)), 0).a;
  float expected = sky ? 1. : depthCode(previous.w);
  float motion = length((uv - vUv) * vec2(sz));
  // At rest the coverage of a blade can alternate between ground and sky at
  // the same output pixel. Only moving silhouettes need disocclusion rejection.
  if (motion > 0.65 && (abs(lastDepth - expected) > 0.009 || sky != (lastDepth == 1.))) return;

  // History is only kept where it could be this frame's colour. Reprojection follows the camera, not the wind, so a
  // leaf or blade that moved leaves its old colour behind: compare it with the 3 x 3 neighbourhood's spread (mean and
  // deviation, in luma and chroma) and pull anything outside it straight back toward the mean. A plain min/max box
  // would span leaf and sky alike and let the old leaf through.
  vec2 pixel = 1. / vec2(sz);
  vec3 m1 = vec3(0.), m2 = vec3(0.), lo = vec3(1e9), hi = vec3(-1e9);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 n = toYCoCg(i == 0 && j == 0 ? current : packLight(texture(tMap, vUv + vec2(float(i), float(j)) * pixel).rgb));
    m1 += n; m2 += n * n; lo = min(lo, n); hi = max(hi, n);
  }
  vec3 mean = m1 / 9., sigma = sqrt(max(m2 / 9. - mean * mean, 0.)) * 1.15 + 0.002;
  vec3 boxLo = max(lo, mean - sigma), boxHi = min(hi, mean + sigma);
  vec3 old = toYCoCg(texture(tHistory, uv).rgb), centre = 0.5 * (boxLo + boxHi), extent = max(0.5 * (boxHi - boxLo), vec3(1e-4));
  vec3 off = old - centre, unit = abs(off / extent);
  float reach = max(unit.x, max(unit.y, unit.z));
  vec3 history = fromYCoCg(reach > 1. ? centre + off / reach : old);
  float delta = max(abs(history.r-current.r), max(abs(history.g-current.g), abs(history.b-current.b)));
  float weight = mix(0.90, 0.40, smoothstep(0.10, 1.6, motion)) * (1. - 0.50 * smoothstep(0.14, 0.34, delta));
  // A capillary ring travels several of its own widths between frames. Its old
  // colour belongs to open water by then. Use the water depth already drawn
  // against the valley atlas, keeping full history on the bank and far shore.
  if (uStorm > 0.005 && !sky && z < 22.) {
    vec3 wp = uCam + ray*z;
    vec2 waterUV = fieldUV(wp.xz);
    vec2 bed = textureLod(uValleyGround, waterUV, 0.).gb;
    float level = groundHeight(bed.y);
    float stepHeight = uGroundRange.y / 255.;
    float surface = (1. - smoothstep(0.07, 0.15+0.5*stepHeight, abs(wp.y-level)))
                  * smoothstep(0.02, 0.12+stepHeight, level-groundHeight(bed.x)) * inField(waterUV);
    weight *= 1. - 0.87*surface*smoothstep(0.005,0.26,uStorm)*(1.-smoothstep(14.,22.,z));
  }
  o.rgb = mix(current, history, weight);
}`;
