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

  vec2 pixel = 1. / vec2(sz);
  vec3 a = texture(tMap, vUv + vec2(pixel.x, 0.)).rgb, b = texture(tMap, vUv - vec2(pixel.x, 0.)).rgb;
  vec3 c = texture(tMap, vUv + vec2(0., pixel.y)).rgb, d = texture(tMap, vUv - vec2(0., pixel.y)).rgb;
  vec3 lo = min(current, packLight(min(min(a,b), min(c,d)))), hi = max(current, packLight(max(max(a,b), max(c,d))));
  vec3 pad = (hi - lo) * 0.08 + 0.004;
  vec3 history = clamp(texture(tHistory, uv).rgb, lo - pad, hi + pad);
  float delta = max(abs(history.r-current.r), max(abs(history.g-current.g), abs(history.b-current.b)));
  float weight = mix(0.90, 0.40, smoothstep(0.10, 1.6, motion)) * (1. - 0.50 * smoothstep(0.14, 0.34, delta));
  o.rgb = mix(current, history, weight);
}`;
