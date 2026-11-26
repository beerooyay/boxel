// Azimuth is measured from north toward east. The sky shaders and inspection cameras share these positions.
function skyDirection(azimuth, elevation) {
  const az = azimuth * Math.PI / 180, el = elevation * Math.PI / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}
export const skyBodies = {
  amber: skyDirection(13, 26),
  rose: skyDirection(-141, 40),
  ocean: skyDirection(94, 39),
  ice: skyDirection(-59, 49),
};
const glslDirection = v => `vec3(${v.map(x => x.toFixed(9)).join(', ')})`;

// Project each distant body into its own tangent plane. A visible ring fragment must be
// closer to the viewer than the spherical surface at that pixel.
export const companionWorlds = `
// Every body's visible hemisphere uses the same world-space stellar illumination.
// Low, cool fill keeps the material visible on the night side without moving the terminator.
// Tarn's own air lies in front of every body, the same for all of them: by day their night sides take the sky's blue,
// as a moon does in daylight; by night there is almost none of it.
vec3 gBehind;
// Fraction of the background star field transmitted through this sky pixel.
float starTransmission;
float nearestMoonDepth;
const vec3 nightFill = vec3(0.014, 0.019, 0.031);
vec3 bodyLight(vec3 albedo, vec3 normal, float viewCos, float atmosphere) {
  float incidence = dot(normal, uStarDir);
  float direct = max(incidence, 0.);
  float rim = pow(1. - clamp(viewCos, 0., 1.), 4.) * smoothstep(-0.02, 0.32, incidence);
  return albedo * (nightFill + 1.20 * direct)
       + atmosphere * (albedo + 0.12) * rim + gBehind * 0.42;
}

// Return depression, radial slope and ejecta for an eroded impact basin.
vec3 impactBasin(vec2 p, vec2 centre, float radius, float seed, float footprint) {
  float r = length(p - centre) / radius;
  float aa = max(0.024, footprint / radius);
  float inside = 1. - smoothstep(0.38, 0.92, r);
  float rim = 1. - smoothstep(0.045, 0.18 + aa, abs(r - 0.91));
  float ejecta = (1. - smoothstep(0.92, 1.38, r)) * smoothstep(0.47, 0.66, vnoise(p * 29. + seed));
  float resolve = 1. - smoothstep(0.17, 0.55, aa);
  return (vec3(-inside * 0.19 + rim * 0.14, rim * (0.91 - r) * 5.5, ejecta) * resolve);
}

// A moon of the body at P (T, B its axes on the sky, R its radius there): its orbit is a circle of orbit radii, seen
// squashed to squash and turned by tilt; at phase ph it is on the far side when sin(ph) > 0, and the body hides it.
vec3 moon(vec3 d, vec3 c, vec3 P, vec3 T, vec3 B, float R, float tilt, float orbit, float squash, float ph, float size, vec3 tint, float seed) {
  vec2 mo = vec2(cos(ph), sin(ph) * squash) * R * orbit;
  vec2 mq = vec2(mo.x * cos(tilt) - mo.y * sin(tilt), mo.x * sin(tilt) + mo.y * cos(tilt));
  vec3 M = normalize(P + mq.x * T + mq.y * B), MT = normalize(cross(M, vec3(0., 1., 0.))), MB = cross(MT, M);
  float dm0 = dot(d, M); if (dm0 < 0.99) return c;
  vec2 dm = vec2(dot(d, MT), dot(d, MB)) / dm0;
  float Rm = R * size, rm = length(dm), cov = 1. - smoothstep(Rm * 0.94, Rm, rm);
  if (cov <= 0.) return c;

  vec2 disc = dm / Rm; float viewCos = sqrt(max(0., 1. - dot(disc, disc)));
  float orbitDepth = -orbit * sin(ph) * sqrt(1. - squash * squash);
  float surfaceDepth = orbitDepth + size * viewCos;
  if (surfaceDepth < nearestMoonDepth) return c;
  nearestMoonDepth = surfaceDepth;
  vec3 nm = disc.x * MT + disc.y * MB - viewCos * M;
  vec2 first = vec2(-0.34 + 0.18 * sin(seed), 0.30 * cos(seed * 1.6));
  vec2 second = vec2(0.30 + 0.09 * cos(seed), -0.39 + 0.14 * sin(seed * 1.3));
  float footprint = max(length(dFdx(disc)), length(dFdy(disc)));
  vec3 a = impactBasin(disc, first, 0.29, seed, footprint);
  vec3 b = impactBasin(disc, second, 0.18, seed + 2., footprint);
  vec2 slope = (disc - first) * a.y + (disc - second) * b.y;
  nm = normalize(nm + slope.x * MT + slope.y * MB);
  float maria = smoothstep(0.34, 0.72, fbm3(disc * 3.2 + seed) + 0.12 * vnoise(disc * 9.5 - seed));
  float regolith = mix(0.5, vnoise(disc * 39. + seed * 5.), 1. - smoothstep(0.012, 0.060, footprint));
  vec3 mc = tint * (0.70 + 0.30 * maria + 0.15 * regolith + a.x + b.x)
    + tint * 0.18 * min(1., a.z + b.z);
  // Cast the planet's shadow on moons passing through its anti-stellar direction.
  vec3 local = (mq.x * T + mq.y * B) / R - orbitDepth * P + size * nm;
  float separation = length(local - min(0., dot(local, uStarDir)) * uStarDir);
  vec3 fill = mc * nightFill + gBehind * 0.42;
  starTransmission *= 1. - cov;
  return mix(c, mix(fill, bodyLight(mc, nm, viewCos, 0.), smoothstep(0.95, 1.05, separation)), cov);
}

// Composite the far orbital halves before the globe and its rings, the near halves after.
vec3 amberMoons(vec3 d, vec3 c, vec3 P, vec3 T, vec3 B, bool farSide) {
  float t = uTime;
  if ((sin(t * 0.045) > 0.) == farSide) c = moon(d, c, P, T, B, 0.17, 0.38, 2.75, 0.2, t * 0.045, 0.15, vec3(0.66, 0.64, 0.72), 1.3);
  if ((sin(t * 0.08 + 4.24) > 0.) == farSide) c = moon(d, c, P, T, B, 0.17, 0.38, 2.6, 0.2, t * 0.08 + 4.24, 0.1, vec3(0.8, 0.64, 0.46), 5.1);
  if ((sin(t * 0.03 + 6.22) > 0.) == farSide) c = moon(d, c, P, T, B, 0.17, 0.68, 3.3, 0.5, t * 0.03 + 6.22, 0.11, vec3(0.62, 0.72, 0.84), 8.9);
  return c;
}
float amberRingDensity(float r) {
  float gap = smoothstep(1.70, 1.75, r) * (1. - smoothstep(1.80, 1.85, r));
  return smoothstep(1.32, 1.38, r) * (1. - smoothstep(2.20, 2.28, r)) * (1. - 0.84 * gap);
}
// Ring coordinates are in planet radii. Trace toward the star from the particle
// to tell whether the globe lies between it and the light.
float ringSun(vec3 position) {
  float along = dot(position, uStarDir);
  float miss = length(position - min(0., along) * uStarDir);
  return mix(0.09, 1., smoothstep(0.96, 1.04, miss));
}
vec3 roseClouds(vec3 n) {
  vec2 p = n.xy;
  float t = uTime;
  // the whole deck is stirred by two passes of drifting turbulence, so no band runs clean
  vec2 w = p + 0.09 * (vec2(fbm3(p * 3.3 + vec2(t * 0.011, 1.7)), fbm3(p * 3.3 + vec2(-4.3, -t * 0.008))) - 0.5);
  w += 0.045 * (vec2(fbm3(w * 8.1 + vec2(-t * 0.02, 0.)), fbm3(w * 8.1 + vec2(2.9, t * 0.017))) - 0.5);
  // a great storm, and smaller ones that ride their bands and turn either way
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = i == 0 ? vec2(-0.22, -0.2) : vec2(fract(0.37 * fi + t * (0.0015 + 0.0011 * fi)) * 2.4 - 1.2, -0.62 + 0.3 * fi);
    vec2 sv = (w - c) * vec2(0.76, 1.35);
    float k = (i == 0 ? 4.6 : 2.4 + 0.6 * fi) * exp(-dot(sv, sv) * (i == 0 ? 12. : 30. + 14. * fi)) * (i == 2 || i == 4 ? -1. : 1.);
    w = c + vec2(sv.x * cos(k) - sv.y * sin(k), sv.x * sin(k) + sv.y * cos(k)) / vec2(0.76, 1.35);
  }
  float latitude = w.y;
  float flow = fbm3(vec2(w.x * 4. - t * 0.009, latitude * 8.) + n.z);
  // bands of uneven width whose edges break into waves and curls
  float wave = sin(latitude * 15. + 1.25 * sin(w.x * 5. + latitude * 4.) + flow * 3. + 0.6 * sin(w.x * 17. - t * 0.05 + latitude * 9.) * smoothstep(0.2, 0.8, flow));
  float belts = smoothstep(-0.78, 0.78, wave);
  vec3 body = mix(vec3(0.36, 0.15, 0.21), vec3(0.70, 0.37, 0.24), belts);
  body *= 0.81 + 0.29 * vnoise(w * 23. + flow);
  float clouds = fbm3(vec2(w.x * 11. - t * 0.014, latitude * 30. + flow * 3.)) * (0.75 + 0.5 * vnoise(w * 6. - t * 0.01));
  vec3 decks = mix(vec3(0.65, 0.35, 0.38), vec3(0.89, 0.71, 0.55), smoothstep(0.3, 0.74, flow + 0.16 * wave));
  return mix(body, decks, smoothstep(0.32, 0.75, clouds) * (0.42 + 0.49 * belts));
}

// The ocean world, in its own frame (x right, y up, z toward Tarn). It spins about the pole of its first ring.
const vec3 OCEAN_POLE = vec3(-0.194, 0.951, 0.24);
vec3 spin(vec3 v, vec3 k, float a) { return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1. - cos(a)); }
uniform sampler2D uOceanAtlas;
// Wrap the longitude derivative too. The seam has the same mip level as its neighbours.
vec4 oceanAtlas(vec3 p) {
  vec2 uv=vec2(atan(p.x,p.z)/(2.*PI)+0.5,asin(clamp(p.y,-1.,1.))/PI+0.5);
  vec2 dx=dFdx(uv), dy=dFdy(uv);
  dx.x-=round(dx.x); dy.x-=round(dy.x);
  return textureGrad(uOceanAtlas,uv,dx,dy);
}
const float ringTilt = 0.24;
const vec2 ringMinorH = vec2(-0.19866933, 0.98006658);
const vec2 ringMinorV = vec2(-0.98006658, -0.19866933);
float ringDensity(float radius) {
  float coverage = smoothstep(1.27, 1.32, radius) * (1. - smoothstep(1.94, 2., radius));
  float gap = smoothstep(1.61, 1.65, radius) * (1. - smoothstep(1.69, 1.72, radius));
  return coverage * (1. - 0.85 * gap);
}
// Work in the local tangent frame (+z toward the observer), in planet radii.
float ringTransmission(vec3 point, vec3 sun, vec2 minor) {
  vec3 pole = vec3(minor * sqrt(1. - ringTilt * ringTilt), ringTilt);
  float cosRay = dot(sun, pole);
  if (abs(cosRay) < 0.0001) return 1.;
  float travel = -dot(point, pole) / cosRay;
  if (travel <= 0.) return 1.;
  return 1. - 0.70 * ringDensity(length(point + travel * sun));
}

vec3 oceanWorld(vec3 n, vec3 normal, vec3 right, vec3 up, vec3 axis) {
  vec3 L = vec3(dot(uStarDir, right), dot(uStarDir, up), -dot(uStarDir, axis));
  vec3 pole = normalize(OCEAN_POLE);
  vec3 p = spin(n, pole, uTime * 0.01), pc = spin(n, pole, uTime * 0.016);
  vec4 geography=oceanAtlas(p);
  float relief=geography.r, wet=geography.g, ridge=geography.b;
  float coast=0.498, aa=max(fwidth(relief)*0.65,0.003);
  float sea=1.-smoothstep(coast-aa,coast+aa,relief);
  vec3 ocean=mix(vec3(0.009,0.060,0.17),vec3(0.016,0.205,0.35),smoothstep(0.27,0.48,relief));
  ocean=mix(ocean,vec3(0.043,0.41,0.43),smoothstep(0.466,coast,relief)*(0.36+0.52*wet));
  vec3 dry=mix(vec3(0.30,0.094,0.043),vec3(0.62,0.31,0.11),0.29+0.61*ridge);
  vec3 forest=mix(vec3(0.022,0.118,0.058),vec3(0.13,0.275,0.077),ridge);
  vec3 land=mix(dry,forest,smoothstep(0.35,0.57,wet));
  land=mix(land,vec3(0.38,0.32,0.22),smoothstep(0.62,0.77,relief)*ridge);
  vec3 inland=spin(normalize(n+0.013*(L-n*dot(n,L))),pole,uTime*0.01);
  land*=clamp(1.+4.6*(relief-oceanAtlas(inland).r),0.67,1.23);
  vec3 ground=mix(land,ocean,sea);
  float ice=smoothstep(0.91,0.983,abs(dot(n,pole))+0.034*ridge);
  ground=mix(ground,vec3(0.62,0.76,0.79),ice);
  float cloud=oceanAtlas(pc).a;
  float shadow=oceanAtlas(spin(normalize(n+0.019*(L-n*dot(n,L))),pole,uTime*0.016)).a;
  ground*=1.-0.49*shadow;
  float reliefLight = clamp(0.29 + 0.61 * cloud + 1.68 * (cloud - shadow), 0., 1.);
  vec3 vapour = mix(vec3(0.44,0.53,0.65),vec3(1.02,0.99,0.91),reliefLight);
  vec3 surf=mix(ground,vapour,cloud*0.94);
  float rings = ringTransmission(n, L, ringMinorH) * ringTransmission(n, L, ringMinorV);
  float viewCos = n.z, incidence = dot(normal, uStarDir);
  vec3 fill = surf * nightFill + gBehind * 0.42;
  vec3 c = mix(fill, bodyLight(surf, normal, viewCos, 0.), rings);
  // the star's glint on open water, and the blue of the air thickening toward the edge
  vec3 h = normalize(uStarDir - axis);
  c += vec3(1., 0.94, 0.84) * pow(max(dot(normal, h), 0.), 90.) * sea * (1. - cloud) * rings * 0.9;
  c += vec3(0.3, 0.55, 1.) * pow(1. - viewCos, 2.4) * smoothstep(-0.15, 0.35, incidence) * 0.5;
  return c;
}
vec3 ringLayer(vec3 sky, vec2 q, float surfaceZ, vec3 tint, vec3 planeXY, vec3 axis) {
  float radius = length(vec2(q.x, q.y / ringTilt));
  float depth = -q.y * sqrt(1. - ringTilt * ringTilt) / ringTilt;
  float grain = 0.74 + 0.15 * sin(radius * 62.) + 0.09 * sin(radius * 117.);
  float alpha = ringDensity(radius) * step(surfaceZ, depth) * 0.76;
  starTransmission *= 1. - alpha;
  return mix(sky, tint * grain * ringSun(planeXY - depth * axis) + gBehind * 0.42, alpha);
}

vec3 companion(vec3 d, vec3 sky, vec3 axis, float radius, bool ocean) {
  float facing = dot(d, axis);
  if (facing < 0.95) return sky;
  vec3 right = normalize(cross(axis, vec3(0., 1., 0.))), up = cross(right, axis);
  vec2 q = vec2(dot(d, right), dot(d, up)) / (facing * radius);
  float r2 = dot(q, q), surfaceZ = -3.;
  if (r2 < 1.) {
    starTransmission = 0.;
    surfaceZ = sqrt(1. - r2);
    vec3 n = vec3(q, surfaceZ);
    vec3 normal = right * n.x + up * n.y - axis * n.z;
    if (ocean) sky = oceanWorld(n, normal, right, up, axis);
    else {
      vec2 sheet = n.xy * vec2(7.8, 31.);
      float macro = fbm3(sheet + vec2(0.13 * uTime, n.z * 4.8));
      float whorls = vnoise(sheet * 2.1 + macro * 3.6);
      float grain = mix(whorls, 0.5, smoothstep(0.18,0.62,max(fwidth(sheet.x),fwidth(sheet.y))));
      vec3 auburn = roseClouds(n) * (0.73 + 0.46 * macro + 0.25 * grain);
      sky = bodyLight(auburn, normal, n.z, 0.13);
    }
  } else if (ocean) {
    // a thin edge of air just past the limb, on the side the star lights
    float lit = smoothstep(-0.2, 0.5, dot(normalize(right * q.x + up * q.y), uStarDir));
    sky += vec3(0.3, 0.55, 1.) * exp(-(sqrt(r2) - 1.) * 45.) * lit * 0.22;
  }
  if (ocean && r2 < 4.1) {
    vec2 r = vec2(-dot(q, ringMinorV), dot(q, ringMinorH));
    vec2 v = vec2(r.y, -r.x);
    // Paint the farther of the two ring planes first at their crossings.
    bool horizontalFirst = r.y > v.y;
    vec3 silver = vec3(0.54, 0.63, 0.72), copper = vec3(0.62, 0.45, 0.38);
    vec3 planeXY = right * q.x + up * q.y;
    sky = ringLayer(sky, horizontalFirst ? r : v, surfaceZ, horizontalFirst ? silver : copper, planeXY, axis);
    sky = ringLayer(sky, horizontalFirst ? v : r, surfaceZ, horizontalFirst ? copper : silver, planeXY, axis);
  }
  return sky;
}
const vec3 ICE_DIR = ${glslDirection(skyBodies.ice)}, ROSE_DIR = ${glslDirection(skyBodies.rose)}, OCEAN_DIR = ${glslDirection(skyBodies.ocean)};
vec3 companions(vec3 d, vec3 sky) {
  vec3 rt = normalize(cross(ROSE_DIR, vec3(0., 1., 0.))), rb = cross(rt, ROSE_DIR);
  float phase = uTime * 0.05 + 1.2;
  bool behind = sin(phase) > 0.;
  if (behind) sky = moon(d, sky, ROSE_DIR, rt, rb, 0.198, -0.4, 2.2, 0.32, phase, 0.13, vec3(0.72, 0.62, 0.66), 3.7);
  sky = companion(d, sky, ROSE_DIR, 0.198, false);
  if (!behind) sky = moon(d, sky, ROSE_DIR, rt, rb, 0.198, -0.4, 2.2, 0.32, phase, 0.13, vec3(0.72, 0.62, 0.66), 3.7);
  return companion(d, sky, OCEAN_DIR, 0.143, true);
}
`;

// Bake continuous spherical terrain and weather once. The two layers then
// turn independently; the sun and both rings still light them each frame.
export const oceanAtlasFragment = `
in vec2 vUv; out vec4 atlas;
float lattice(vec3 p) {
  p=fract(p*vec3(0.1031,0.11369,0.13787));
  p+=dot(p,p.yzx+19.19);
  return fract((p.x+p.y)*p.z);
}
float volume(vec3 q) {
  vec3 i=floor(q), f=fract(q); f=f*f*(3.-2.*f);
  vec2 z=vec2(0.,1.);
  return mix(mix(mix(lattice(i),lattice(i+z.yxx),f.x),mix(lattice(i+z.xyx),lattice(i+z.yyx),f.x),f.y),
    mix(mix(lattice(i+z.xxy),lattice(i+z.yxy),f.x),mix(lattice(i+z.xyy),lattice(i+1.),f.x),f.y),f.z);
}
float terrainNoise(vec3 p) {
  float sum=0., weight=0.52;
  for (int i=0;i<6;i++) {sum+=weight*volume(p); p=p.yzx*2.08+vec3(17.,8.1,23.); weight*=0.49;}
  return sum;
}
void main() {
  vec2 a=(vUv-0.5)*vec2(2.*PI,PI);
  vec3 p=vec3(sin(a.x)*cos(a.y),sin(a.y),cos(a.x)*cos(a.y));
  vec3 warp=vec3(volume(3.3*p),volume(3.1*p+8.),volume(3.6*p-4.))-0.5;
  vec3 q=p+0.46*warp;
  float relief=terrainNoise(q*2.9+vec3(2.7,4.1,8.3));
  float ridge=1.-abs(2.*terrainNoise(q*20.+14.)-1.);
  float detail=terrainNoise(q*53.+2.);
  relief+=0.096*(ridge-0.7)+0.16*(detail-0.5);
  float wet=terrainNoise(p*4.4+8.)+0.15*cos(dot(p,OCEAN_POLE)*7.)+0.16*(detail-0.5);
  // Local shear turns a broken bank. Only air near the low curls around it.
  vec3 centre=normalize(vec3(-0.35,0.28,0.90));
  vec3 air=spin(p,centre,0.78*exp(-15.*dot(p-centre,p-centre)));
  air=spin(air,OCEAN_POLE,0.095*sin(dot(air,OCEAN_POLE)*6.+warp.x*2.));
  vec3 flow=air+0.14*warp;
  float bank=terrainNoise(flow*5.7+18.);
  float cells=terrainNoise(flow*30.+9.);
  float wisps=terrainNoise(flow*vec3(19.,49.,16.)+27.);
  float cloud=smoothstep(0.51,0.69,0.70*bank+0.30*cells);
  cloud*=0.62+0.38*smoothstep(0.3,0.67,cells);
  cloud+=0.19*smoothstep(0.53,0.69,wisps)*smoothstep(0.38,0.54,bank);
  atlas=vec4(relief,wet,(ridge-0.54)*1.1+0.38*detail,clamp(cloud,0.,1.));
}`;
