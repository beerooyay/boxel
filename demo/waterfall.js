import { falls, riverLevel, riverX } from './landmarks.js';

const top = riverLevel(falls.lip),
  bottom = riverLevel(falls.lip + falls.reach);
const fallTime = Math.sqrt((2 * (top - bottom)) / 9.81);
const lipX = riverX(falls.lip),
  footX = riverX(falls.lip + falls.reach);
export const fallsBounds = {
  x0: Math.min(lipX, footX) - 3.5,
  z0: falls.lip - 1.0,
  y0: bottom - 0.35,
  y1: top + 0.6,
  pad: 0.18
};

// Distance from the bedrock lip to each landing lane in the pool.
function pourReach(s) {
  const cleft = (s + 0.38) / 0.16;
  const seam = 0.5 + 0.5 * Math.sin(8.7 * s + 0.4 * Math.sin(4.2 * s));
  return falls.reach * (0.79 + 0.18 * seam + 0.17 * Math.cos(4.7 * s) - 0.24 * Math.exp(-cleft * cleft));
}
export function lipZ(s) {
  return falls.lip + 0.09 * Math.sin(4.7 * s) + 0.045 * Math.sin(10.3 * s);
}
export function landingAt(s) {
  const z = lipZ(s) + pourReach(s);
  return [riverX(z) + s * falls.halfWidth * 1.07, z];
}
const outfallGLSL = `
float landingZ(float s){
  float cleft=(s+0.38)/0.16;
  float seam=0.5+0.5*sin(8.7*s+0.4*sin(4.2*s));
  return ${falls.lip}+0.09*sin(4.7*s)+0.045*sin(10.3*s)+${falls.reach}*(0.79+0.18*seam+0.17*cos(4.7*s)-0.24*exp(-cleft*cleft));
}`;

// x is displacement in metres, yz is its world-space slope, w is the
// breaking lip. The mesh, surface lighting and wet stones use the same phase.
export const crestGLSL = `
vec4 rollingFront(float phase, vec2 phaseGradient, float amplitude, float breaking){
  float skew=phase+0.32*sin(phase+0.68);
  float cap=0.5+0.5*cos(skew), peak=cap*cap*cap;
  float slope=-1.5*cap*cap*sin(skew)*(1.+0.32*cos(phase+0.68));
  float lip=smoothstep(0.59,0.96,peak)*smoothstep(-0.76,0.12,sin(skew)+0.14);
  return vec4(amplitude*(peak-0.29), amplitude*slope*phaseGradient, breaking*lip);
}
vec4 waterCrests(vec2 p, float depth, vec2 bedSlope, float t, float gust){
  vec4 wave=vec4(0.);
  if(depth < -0.23) return wave;
  float runup=smoothstep(-0.22,0.15,depth);
  if(depth<1.1){
    // Depth contours turn each front toward the local beach. Broad wind
    // groups leave stretches of flat water between breaking wavelets.
    float turn=dot(p,vec2(0.31,-0.20));
    vec2 drift=vec2(0.19,0.14);
    float phase=dot(p,drift)-6.8*depth-2.17*t+0.54*sin(turn);
    vec2 gradient=drift-6.8*bedSlope+0.54*cos(turn)*vec2(0.31,-0.20);
    float group=smoothstep(-0.75,0.82,sin(dot(p,vec2(0.31,0.17))-0.54*t+0.91*sin(turn)));
    float strength=runup*(1.-smoothstep(0.42,1.10,depth))*(0.36+0.64*group);
    wave=rollingFront(phase,gradient,strength*(0.075+0.11*gust),
                      strength*(0.37+0.63*gust));
  }
  vec2 fromToe=p-vec2(${footX.toFixed(4)},${(falls.lip + falls.reach).toFixed(4)});
  if(fromToe.y > -0.7 && fromToe.y < 9. && abs(fromToe.x)<6.){
    // Short curved rollers spread away from the two chutes. The plunge is
    // the energy source, so these can break even on a windless day.
    vec2 arc=vec2(0.69*fromToe.x,fromToe.y);
    float r=max(0.01,length(arc)), ribs=fromToe.x*1.38+0.5;
    float groups=0.75+0.25*cos(0.87*r-1.23*t+0.45*sin(ribs));
    float surge=runup*groups*smoothstep(-0.65,0.40,fromToe.y)*
      (1.-smoothstep(1.4,8.8,r))*(1.-smoothstep(4.4,5.9,abs(fromToe.x)));
    float phase=3.65*r-4.05*t+0.34*sin(ribs);
    vec2 gradient=3.65*arc*vec2(0.69,1.)/r+vec2(0.47*cos(ribs),0.);
    wave+=rollingFront(phase,gradient,0.235*surge,0.96*surge);
  }
  return wave;
}`;

export const plungeGLSL =
  outfallGLSL +
  `
float plungeFoam(vec2 p, float t) {
  float reach = p.y-(${(falls.lip + falls.reach).toFixed(3)});
  if (reach < -1.45 || reach > 8. || abs(p.x-(${footX.toFixed(3)})) > 6.) return 0.;
  float lane = p.x+5.-3.4*sin(p.y*0.13)-1.4*sin(p.y*0.29+0.8);
  reach=p.y-landingZ(clamp(lane/${(falls.halfWidth * 1.07).toFixed(4)},-1.,1.));
  float trail = smoothstep(-1.15,0.25,reach)*(1.-smoothstep(1.1,7.6,reach));
  float travel=reach/(0.82+0.14*cos(lane*1.9));
  vec2 q=vec2(lane+0.13*sin(2.5*reach-1.2*t),travel-t);
  float curl = vnoise(q*1.3);
  float cells = vnoise(q*vec2(5.6,3.6)+vec2(curl,-curl)*2.1);
  float beads = vnoise(q*vec2(24.,19.)+2.6*curl);
  float lace = (1.-smoothstep(0.035,0.12,abs(cells-0.53)))*smoothstep(0.16,0.76,beads);
  lace+=0.28*smoothstep(0.49,0.79,beads)*smoothstep(.38,.72,curl);
  float boil = exp(-1.9*abs(reach-0.22-0.18*sin(lane*4.3+t*2.4)));
  float edges = 1.-smoothstep(1.22,2.35,abs(lane+0.31*sin(reach*1.2)-0.23*(curl-0.5)));
  return edges*(boil*(0.50+0.50*beads)+trail*(0.06+0.80*lace));
}`;

// t measures time since the water left the lip. This gives the curtain a
// horizontal tongue over the ledge and gravity-stretched threads in its lower half.
export function createWaterfall(gl, program, worldVertex, vao) {
  const curtain = program(
    worldVertex +
      `
layout(location=0) in vec4 aSheet;
out vec3 vWP; out vec2 vSheet;
void main() {
  float s=aSheet.x, t=aSheet.y, fall=max(0.,t);
  float z=aSheet.z+aSheet.w*t;
  float x = -5.+3.4*sin(z*.13)+1.4*sin(z*.29+.8);
  float width=${falls.halfWidth}*(0.99+0.08*fall*fall);
  float folds=sin(12.5*s+2.7*t-1.8*uTime)+0.45*sin(22.*s-6.2*t+2.4*uTime);
  vec2 inlet=vec2(x+s*width,aSheet.z-0.37);
  float inletWave=waterWave(inlet,uTime).x+surfaceAt(inlet).x;
  float y=${top.toFixed(5)}+0.010+inletWave*(1.-smoothstep(0.,0.34,fall))+0.014*sin(12.*s-3.*t-2.8*uTime)
    -${(top - bottom + 0.22).toFixed(5)}*fall*fall;
  z+=folds*(0.013+0.032*fall);
  vWP=vec3(x+s*width+0.045*fall*folds,y,z);
  vSheet=aSheet.xy; gl_Position=project(vWP);
}`,
    `
uniform float uClip; in vec3 vWP; in vec2 vSheet; out vec4 o;
void main(){
  if(vWP.y<uClip) discard;
  float s=vSheet.x, t=max(0.,vSheet.y), clock=uTime/${fallTime.toFixed(6)};
  float moving=t-clock;
  float coarse=vnoise(vec2(7.2*s+0.27*sin(3.1*moving+4.*s),2.1*moving));
  float bend=0.65*coarse+0.19*sin(2.7*moving+11.*s);
  float threads=vnoise(vec2(42.*s+bend*3.4,6.*moving));
  float fines=vnoise(vec2(104.*s+7.2*bend,13.*moving));
  float gap=(s+0.38-0.026*sin(4.*t))/(0.084+0.075*t);
  float cleft=exp(-gap*gap);
  float thickness=(0.24+0.56*coarse+0.34*threads-0.15*t)*(1.-0.98*cleft);
  float rim=1.-smoothstep(0.91,1.,abs(s));
  if (rim*thickness<0.094+0.16*t*fines) discard;
  float air=smoothstep(0.10,0.80,t);
  float ropes=vnoise(vec2(16.*s+1.35*bend,3.6*moving));
  float pearl=smoothstep(0.29,0.77,0.36*ropes+0.32*threads+0.20*fines+0.12*coarse+0.10*air);
  pearl*=0.65+0.35*smoothstep(0.18,0.82,fines);
  vec3 N=normalize(cross(dFdx(vWP),dFdy(vWP)));
  if(dot(N,uCam-vWP)<0.) N=-N;
  N=normalize(N+vec3((threads-0.5)*0.65,(fines-0.5)*0.18,0.));
  vec3 V=normalize(uCam-vWP), reflection=reflect(-V,N);
  vec3 sky=skyBase(reflection);
  float sun=directLight(vWP);
  float glint=pow(max(0.,dot(N,normalize(V+uSunDir))),48.);
  vec3 water=vec3(0.018,0.062,0.051)*(0.5+0.5*coarse)+sky*(0.10+0.18*pow(1.-abs(dot(N,V)),3.));
  vec3 white=vec3(0.78,0.84,0.80)*(0.06+2.75*ambient(N)+0.42*uSunCol*sun);
  vec3 lit=mix(water*(1.-0.88*uNight),white,pearl*(0.55+0.44*air))+uSunCol*sun*glint*0.40;
  o=vec4(tonemap(fogged(lit,vWP)),0.);
}`
  );
  const columns = 48,
    rows = 22,
    points = [],
    indices = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const s = (2 * i) / columns - 1;
      points.push(s, -0.19 + (1.22 * j) / rows, lipZ(s), pourReach(s));
      if (j && i) {
        const d = j * (columns + 1) + i,
          a = d - columns - 2;
        indices.push(a, d - 1, a + 1, a + 1, d - 1, d);
      }
    }
  const mesh = vao([{ loc: 0, size: 4, data: new Float32Array(points) }], new Uint16Array(indices));
  const spray = program(
    worldVertex +
      outfallGLSL +
      `
uniform float uScale; out float vFade, vSeed, vBubbles;
void main(){
  float seed=float(gl_VertexID)+0.5;
  vec3 r=fract(sin(seed*vec3(17.31,45.112,93.17))*vec3(1324.57,1792.43,632.17));
  float lane=2.*r.x-1., z=landingZ(lane);
  float x=-5.+3.4*sin(z*.13)+1.4*sin(z*.29+.8)+lane*${(falls.halfWidth * 1.07).toFixed(4)};
  vBubbles=step(seed,156.); vSeed=seed;
  float life=mix(0.32+0.48*r.y,0.34+0.23*r.y,vBubbles), u=fract(r.z+uTime/life);
  float kick=4.905*life*life*u*(1.-u)*mix(1.,0.35,vBubbles);
  vec3 p=vec3(x+(r.x-0.48)*0.71*u,${bottom.toFixed(3)}+0.045+kick,z+0.08+(0.27+r.z)*u);
  vec4 clip=project(p); gl_Position=clip;
  float size=mix(0.011+0.039*r.y*r.y,(0.050+0.094*r.y)*(0.63+u*0.62),vBubbles);
  gl_PointSize=clamp(uScale*size/clip.w,1.,42.);
  vFade=smoothstep(0.,0.15,u)*(1.-smoothstep(.54,1.,u))*(0.17+0.57*r.z)*(1.-0.31*vBubbles);
}`,
    `in float vFade,vSeed,vBubbles; out vec4 o;
void main(){
  vec2 p=gl_PointCoord-.5;
  float grit=vnoise(p*8.2+vSeed);
  float d=length(p)*2.+(grit-0.5)*0.45*vBubbles;
  float a=(1.-smoothstep(0.06,1.,d))*vFade;
  o=vec4(tonemap(vec3(0.76,0.84,0.83)*(0.83-0.79*uNight)*(0.72+0.38*grit)),a);
}`
  );
  return {
    curtain,
    spray,
    sheet() {
      gl.bindVertexArray(mesh);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
    },
    drops(scale) {
      gl.uniform1f(spray.u('uScale'), scale);
      gl.bindVertexArray(null);
      gl.drawArrays(gl.POINTS, 0, 360);
    }
  };
}
