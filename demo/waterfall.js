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
vec2 crestSeed(vec2 id){
  vec3 h=fract(id.xyx*vec3(.1031,.1030,.0973));
  h+=dot(h,h.yzx+33.33);
  return fract((h.xx+h.yz)*h.zy);
}
// Each wind patch launches a short train at its own angle and cadence. Its
// footprint and lifetime go to zero before its cell or event identity changes.
vec4 shorePacket(vec2 p,float depth,vec2 bedSlope,float t,float gust,mat2 axes,vec2 offset){
  const float spacing=4.8;
  vec2 tile=axes*p/spacing+offset, cell=floor(tile);
  vec2 seed=crestSeed(cell+offset*83.);
  float interval=3.25+2.8*seed.x, clock=t/interval+seed.y;
  float age=fract(clock), life=smoothstep(0.,0.17,age)*(1.-smoothstep(0.68,1.,age));
  vec2 roll=crestSeed(cell+vec2(floor(clock)*17.7,41.2+offset.x));
  vec2 q=(fract(tile)-0.5)*spacing;
  vec2 centre=(seed-0.5)*0.52+(roll-0.5)*0.26;
  centre+=vec2(0.34,-0.20)*(age-0.5);
  vec2 radii=vec2(1.25+0.60*roll.y,1.37+0.48*seed.x);
  vec2 local=(q-centre)/radii;
  float envelope=max(0.,1.-dot(local,local));
  if(envelope<=0. || life<=0.) return vec4(0.);
  vec2 heading=vec2(0.28+0.86*roll.x,1.28*(roll.y-0.5));
  float curve=0.40*(0.3+seed.y), deepK=5.5+2.8*seed.x;
  float phase=dot(q,heading)+curve*local.y*local.y-deepK*depth
    -age*interval*(1.74+1.0*roll.y)+6.283*roll.x;
  vec2 gradient=transpose(axes)*(heading+vec2(0.,2.*curve*local.y/radii.y))-deepK*bedSlope;
  float energy=life*(0.66+0.34*roll.x), strength=energy*envelope*envelope;
  float amplitude=0.10+0.13*min(gust,1.5);
  vec4 wave=rollingFront(phase,gradient,amplitude*strength,strength*(0.46+0.52*gust));
  wave.yz+=wave.x*transpose(axes)*(-4.*local/(radii*envelope));
  return wave;
}
// Travel time connects each roller to a pulse from one of the two chutes.
// Different pulses spread into different parts of the pool.
vec4 chuteRoll(vec2 p,vec2 source,float inlet,float t){
  vec2 q=p-source; float r=max(0.02,length(q)), speed=1.02+0.11*inlet;
  float clock=(t-r/speed)/(2.57+0.53*inlet)+inlet*4.1;
  vec2 seed=crestSeed(vec2(floor(clock),inlet*39.7+4.));
  float age=fract(clock), life=smoothstep(0.,0.13,age)*(1.-smoothstep(0.72,1.,age));
  float bend=(seed.x-0.44)*0.78+inlet*0.19;
  float crossFlow=q.x-bend*q.y-0.22*sin(0.87*q.y+5.*seed.y);
  float width=0.63+q.y*(0.13+0.11*seed.y);
  float fan=1.-smoothstep(0.18,max(0.25,width),abs(crossFlow));
  float energy=life*fan*(0.64+0.36*seed.y)*smoothstep(-0.6,0.35,q.y)*(1.-smoothstep(1.6,7.3,r));
  float skew=0.33*crossFlow*crossFlow;
  float phase=-6.283*age*(1.38+0.69*seed.y)+skew;
  float radialK=6.283*(1.38+0.69*seed.y)/((2.57+0.53*inlet)*speed);
  vec2 gradient=radialK*q/r+0.66*crossFlow*vec2(1.,-bend-0.1914*cos(0.87*q.y+5.*seed.y));
  return rollingFront(phase,gradient,0.21*energy,0.92*energy);
}
vec4 waterCrests(vec2 p, float depth, vec2 bedSlope, float t, float gust){
  vec4 wave=vec4(0.);
  if(depth < -0.23) return wave;
  float runup=smoothstep(-0.22,0.15,depth);
  if(depth < 1.1){
    float shoal=runup*(1.-smoothstep(0.42,1.10,depth));
    wave=shoal*(shorePacket(p,depth,bedSlope,t,gust,mat2(0.8,0.6,-0.6,0.8),vec2(0.17,0.58))
      +0.82*shorePacket(p,depth,bedSlope,t,gust,mat2(0.96,-0.28,0.28,0.96),vec2(0.79,0.12)));
  }
  vec2 fromToe=p-vec2(${footX.toFixed(4)},${(falls.lip+falls.reach).toFixed(4)});
  if(fromToe.y > -1.6 && fromToe.y < 8. && abs(fromToe.x)<6.) {
    wave+=runup*(chuteRoll(p,vec2(${landingAt(-0.73).map(v=>v.toFixed(4)).join(',')}),-0.73,t)
      +chuteRoll(p,vec2(${landingAt(0.47).map(v=>v.toFixed(4)).join(',')}),0.47,t));
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
  float s=lane/${(falls.halfWidth * 1.07).toFixed(4)};
  float chutes=(1.-smoothstep(.88,1.04,abs(s)))*smoothstep(.05,.23,abs(s+.38));
  float impact=reach-.10-.12*sin(lane*4.3+t*2.4)-.09*(cells-.5);
  float collar=(1.-smoothstep(.02,.35+.17*curl,abs(impact)))*chutes;
  float edges = 1.-smoothstep(1.22,2.35,abs(lane+0.31*sin(reach*1.2)-0.23*(curl-0.5)));
  return min(1.,collar*(.72+.28*beads)+edges*trail*(.04+.68*lace));
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
  float gap=(s+0.38-0.026*sin(4.*t)-0.010*(coarse-.5))/(0.041+0.058*t);
  float cleft=exp(-gap*gap);
  float thickness=(0.24+0.56*coarse+0.34*threads-0.15*t)*(1.-smoothstep(0.03,0.46,t)*0.98*cleft);
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
uniform float uScale; out float vFade, vSeed; flat out int vKind;
void main(){
  float seed=float(gl_VertexID)+0.5;
  vec3 r=fract(sin(seed*vec3(17.31,45.112,93.17))*vec3(1324.57,1792.43,632.17));
  // Mist, surface bubbles and individual drops share the two impact lanes.
  vKind=gl_VertexID<110 ? 0 : gl_VertexID<228 ? 1 : 2;
  float life=vKind==0 ? 0.74+0.47*r.y : vKind==1 ? 0.36+0.44*r.y : 0.28+0.34*r.y;
  float cycle=r.z+uTime/life, u=fract(cycle);
  vec2 burst=fract(sin(vec2(seed,seed+3.7)*37.3+floor(cycle)*vec2(12.8,24.3))*2974.42);
  float along=fract(r.x+0.15*(burst.x-0.5));
  float lane=along<0.28 ? mix(-0.97,-0.45,along/0.28) : mix(-0.31,0.97,(along-0.28)/0.72);
  float z=landingZ(lane);
  float x=-5.+3.4*sin(z*.13)+1.4*sin(z*.29+.8)+lane*${(falls.halfWidth * 1.07).toFixed(4)};
  float lift=4.905*life*life*u*(1.-u);
  float spread=(burst.x-0.49)*0.64+0.26*lane, downstream=0.28+0.62*burst.y;
  vec3 p=vec3(x+spread*u,${bottom.toFixed(3)}+0.055,z+0.02+downstream*u);
  float size;
  if(vKind==0){
    p.y+=0.12*u+(0.055+0.08*r.y)*sin(3.14159*u);
    p.xz+=WIND_DIR*(0.10+0.32*max(0.,windWave(vec2(x,z))*uWind))*u*u;
    size=(0.23+0.23*r.y)*(0.68+1.30*u);
    vFade=0.085+0.105*burst.y;
  } else if(vKind==1){
    p.y+=0.025+lift*0.14;
    size=(0.034+0.061*r.y)*(1.+0.52*u);
    vFade=0.32+0.29*burst.y;
  } else {
    p.y+=lift; p.z+=0.19*u;
    size=0.012+0.023*r.y*r.y;
    vFade=0.49+0.41*burst.y;
  }
  vSeed=seed+13.*burst.x;
  vFade*=smoothstep(0.,0.15,u)*(1.-smoothstep(.50,1.,u));
  vec4 clip=project(p); gl_Position=clip;
  gl_PointSize=clamp(uScale*size/max(0.01,clip.w),1.,100.);
}`,
    `in float vFade,vSeed; flat in int vKind; out vec4 o;
void main(){
  vec2 p=gl_PointCoord*2.-1.;
  float grain=vnoise(p*(vKind==0 ? 3.2 : 5.3)+vSeed);
  float d=length(p*vec2(1.,vKind==0 ? 1.23 : 1.))+(grain-.5)*(vKind==0 ? .47 : .19);
  float a=(1.-smoothstep(vKind==0 ? 0. : .16,1.,d))*vFade;
  vec3 salt=vKind==0 ? vec3(.64,.80,.79) : vec3(.83,.90,.87);
  o=vec4(tonemap(salt*(0.84-0.80*uNight)*(.77+.32*grain)),a);
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
