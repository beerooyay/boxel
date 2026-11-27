// A resident patch around the fox. Four RGBA8 layers hold offsets at quarter
// lengths of real blades. No per-blade dynamic storage follows the rest of Tarn.
import { CONTACT_SIZE } from './fox-contact.js';

const SITES = 96, FIELD = 80, CELL = 0.06, LAYERS = 16, BAND = 0.12;
export const CONTACT_REACH = FIELD * CELL / 2;
const STEP = 1/30;

export const bladeStateGLSL = `
uniform highp sampler2DArray uBladeNow, uBladeLast;
uniform vec4 uRootGrid; // tile corner, strata per metre, maximum strata per metre
uniform ivec2 uSiteBase, uLastBase;
uniform bool uContactEnabled, uStillGrass, uMarkContact;
uniform float uBladeMix;
const int SITES = ${SITES};
ivec2 bladeSite(vec2 root) {
  vec2 cell = floor((root-uRootGrid.xy)*uRootGrid.z);
  return ivec2(floor((uRootGrid.xy+(cell+0.5)/uRootGrid.z)*uRootGrid.w));
}
bool onPage(ivec2 p) { return all(greaterThanEqual(p,ivec2(0))) && all(lessThan(p,ivec2(SITES))); }
ivec2 address(ivec2 p, int sibling) { return p + ivec2(0,sibling*SITES); }
vec3 unpackOffset(vec4 s) { return s.a > 0. ? (s.rgb*255.-128.)/176. : vec3(0.); }
vec4 knot(highp sampler2DArray tex, ivec2 p, int k) {
  if (k < 0) return vec4(0.);
  vec4 s = texelFetch(tex, ivec3(p,k),0);
  return vec4(unpackOffset(s), s.a);
}
`;

export const solveGLSL = `
uniform highp sampler2D uNeighbours, uDonorSite;
uniform vec3 uLastField;
uniform float uRecovery;
uniform bool uCoupled;
flat out vec4 vKnot[4];
const int FIELD = ${FIELD}, BANDS = ${LAYERS};
const float FIELD_CELL = ${CELL}, BAND = ${BAND};
int ownerID(ivec2 site,int sibling) {
  return 1 + ((site.x & 127) + 128*(site.y & 127))*3 + sibling;
}
vec2 donorAt(vec3 p, ivec2 xy, int band, int self, float width) {
  if (band<0 || band>=BANDS) return vec2(0.);
  ivec2 ij=xy+ivec2(0,band*FIELD);
  vec4 sampleV=texelFetch(uNeighbours,ij,0);
  ivec2 id=ivec2(round(sampleV.ba*255.));
  int donor=id.x+256*id.y;
  if (donor==0 || donor==self) return vec2(0.);
  vec4 site=texelFetch(uDonorSite,ij,0);
  vec2 donorXZ=(vec2(xy)+0.5+2.*(site.rg-0.5))*FIELD_CELL;
  vec2 fromDonor=p.xz-donorXZ;
  // Grid cells nominate pairs. Actual sample positions and stem widths decide
  // the contact. The vertical allowance spans half a link on either blade.
  float reach=width+site.a*0.10+0.009;
  float dy=abs(p.y-(float(band)+site.b)*BAND);
  if (dy>0.065 || dot(fromDonor,fromDonor)>reach*reach) return vec2(0.);
  vec2 impulse=(sampleV.rg*255.-128.)/240.;
  if(dot(impulse,fromDonor)<-0.013*length(impulse)) return vec2(0.);
  return impulse;
}
vec2 neighbourPush(vec3 position, int self, float width) {
  vec3 p=position-uLastField;
  ivec2 xy=ivec2(floor(p.xz/FIELD_CELL)); int band=int(floor(p.y/BAND));
  if (!uCoupled || any(lessThan(xy,ivec2(0))) || any(greaterThanEqual(xy,ivec2(FIELD)))) return vec2(0.);
  vec2 push=donorAt(p,xy,band,self,width);
  if(dot(push,push)>0.) return push;
  return donorAt(p,xy,band+(fract(p.y/BAND)<0.5 ? -1 : 1),self,width);
}
void solveBlade(vec3 root, vec3 edge, vec2 lean, float arc, float curvature, ivec2 site, int sibling) {
  ivec2 slot = site-uSiteBase;
  if (!onPage(slot)) { gl_Position=vec4(3,3,0,1); return; }
  ivec2 dest = address(slot,sibling);
  gl_Position = vec4((vec2(dest)+0.5)/vec2(SITES,3*SITES)*2.-1.,0.,1.);
  gl_PointSize=1.;
  vec3 base=transpose(uContactBasis)*(root-uContactOrigin);
  vec2 extent=vec2(arc+length(edge));
  vec3 lo=CONTACT_MIN*uContactScale, hi=(CONTACT_MIN+CONTACT_EXTENT)*uContactScale;
  bool bodyPossible=all(greaterThan(base.xz,lo.xz-extent)) && all(lessThan(base.xz,hi.xz+extent)) &&
                    base.y+arc+0.06>lo.y && base.y-0.20*arc<hi.y;
  vec3 joint=root, lastRest=root;
  float direct=0., received=0.;
  ivec2 old=site-uLastBase;
  int self=ownerID(site,sibling);
  // Eight short links catch paws between the four stored render knots. Both
  // margins touch the same posed surface as the centreline. Roots stay planted.
  for(int j=1;j<=8;j++) {
    float t=float(j)/8.;
    vec3 rest=root+bladeArc(arc,curvature,lean,t);
    vec3 delta=rest-lastRest, candidate=joint+delta;
    vec3 width=edge*((0.43+0.57*smoothstep(0.,0.27,t))*pow(1.-t,0.75));
    vec2 push=neighbourPush(candidate,self,length(width));
    if (dot(push,push)>0.000016) {
      // A bent neighbour transfers only part of its motion. Subtract the
      // displacement already carried up from lower links so a tip cannot amplify it.
      vec2 carried=candidate.xz-rest.xz;
      vec2 share=push*0.62;
      share *= clamp(1.-dot(carried,share)/max(dot(share,share),0.00001),0.,1.);
      candidate.xz+=share;
      received=max(received,length(share));
    }
    for(int pass=0;bodyPossible && pass<2;pass++) {
      vec3 escape=longestEscape(surfaceEscape(candidate), surfaceEscape((joint+candidate)*0.5)*1.35);
      escape=longestEscape(escape,longestEscape(surfaceEscape(candidate+width),surfaceEscape(candidate-width)));
      if(dot(escape,escape)<0.0000002) break;
      direct=max(direct,length(escape));
      candidate+=escape;
      candidate=joint+normalize(candidate-joint+vec3(0.,0.000001,0.))*length(delta);
    }
    joint+=normalize(candidate-joint+vec3(0.,0.000001,0.))*length(delta);
    lastRest=rest;
    if ((j & 1)==0) {
      int k=j/2-1;
      vec3 offset=joint-rest;
      // A released blade unwinds in place. Only fresh contact may load another blade.
      float tag=direct>0.001 ? 1. : received>0.001 ? 0.60 : 0.;
      if (tag==0. && onPage(old)) {
        offset=unpackOffset(texelFetch(uBladeLast,ivec3(address(old,sibling),k),0))*uRecovery;
        if(length(offset)>0.006) tag=0.16;
      }
      vKnot[k]=vec4((128.+clamp(offset*176.,-127.,127.))/255.,tag);
    }
  }
}
`;

export const stampGLSL = `
uniform vec3 uField;
flat out vec4 vPressure;
flat out vec4 vDonor;
flat out float vStampY;
void stamp(vec3 root, vec2 lean, float arc, float curve, float halfWidth, ivec2 site, int sibling, int sampleIndex) {
  gl_Position=vec4(3,3,0,1); gl_PointSize=1.;
  ivec2 slot=site-uSiteBase;
  if(!onPage(slot)) return;
  // Lay contact along the displaced stem, not at its root. Height bins keep
  // leaves crossing above one another from transferring pressure.
  float t=float(sampleIndex+1)/8.;
  float f=4.*t;
  int k=int(ceil(f))-1;
  ivec2 p=address(slot,sibling);
  vec4 sampleV=knot(uBladeNow,p,k);
  if(sampleV.w<0.5) return;
  vec3 d=mix(knot(uBladeNow,p,k-1).xyz,sampleV.xyz,f-float(k));
  float force=length(d.xz);
  if(force<0.009) return;
  vec3 w=root+bladeArc(arc,curve,lean,t)+d-uField;
  vec2 pixel=w.xz/${CELL};
  int band=int(floor(w.y/${BAND}));
  if(band<0 || band>=${LAYERS} || any(lessThan(pixel,vec2(1.))) || any(greaterThanEqual(pixel,vec2(${FIELD-1}.)))) return;
  pixel.y+=float(band*${FIELD});
  gl_Position=vec4(pixel/vec2(${FIELD}.,${FIELD*LAYERS}.)*2.-1.,1.-min(1.,force*2.),1.);
  gl_PointSize=2.;
  vDonor=vec4(pixel,fract(w.y/${BAND}),clamp(halfWidth*pow(1.-t,0.75)/0.10,0.,1.));
  vStampY=float(band*${FIELD});
  int id=1+((site.x & 127)+128*(site.y & 127))*3+sibling;
  vPressure=vec4((128.+clamp(d.xz*240.,-127.,127.))/255.,float(id & 255)/255.,float(id>>8)/255.);
}
`;
export const knotsFragment = `
flat in vec4 vKnot[4];
layout(location=0) out vec4 a; layout(location=1) out vec4 b;
layout(location=2) out vec4 c; layout(location=3) out vec4 d;
void main(){ a=vKnot[0]; b=vKnot[1]; c=vKnot[2]; d=vKnot[3]; }`;
export const stampFragment = `
flat in vec4 vPressure;
flat in float vStampY;
flat in vec4 vDonor;
layout(location=0) out vec4 o; layout(location=1) out vec4 donor;
void main() {
  if (gl_FragCoord.y<vStampY || gl_FragCoord.y>=vStampY+${FIELD}. || distance(gl_PointCoord,vec2(0.5))>0.55) discard;
  o=vPressure; donor=vec4(0.5+0.5*(vDonor.xy-gl_FragCoord.xy),vDonor.zw);
}`;

export function createBladeContact(gl, solve, stamp, grid) {
  const zero=new Float32Array(4), one=Float32Array.of(1);
  function texture(unit,target) {
    gl.activeTexture(gl.TEXTURE0+unit);
    const tex=gl.createTexture();
    gl.bindTexture(target,tex);
    gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    return tex;
  }
  function page() {
    const tex=texture(22,gl.TEXTURE_2D_ARRAY);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY,1,gl.RGBA8,SITES,3*SITES,4);
    const fbo=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
    const targets=[];
    for(let i=0;i<4;i++) {
      targets.push(gl.COLOR_ATTACHMENT0+i);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER,targets[i],tex,0,i);
    }
    gl.drawBuffers(targets);
    return {tex,fbo,base:[-100000,-100000]};
  }
  let current=page(), previous=page();
  const volume=texture(21,gl.TEXTURE_3D);
  gl.texStorage3D(gl.TEXTURE_3D,1,gl.RGBA8,...CONTACT_SIZE);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  for(const axis of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T,gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D,axis,gl.CLAMP_TO_EDGE);
  const pressure=texture(24,gl.TEXTURE_2D);
  gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,FIELD,FIELD*LAYERS);
  const positions=texture(25,gl.TEXTURE_2D);
  gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,FIELD,FIELD*LAYERS);
  const fieldFbo=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,fieldFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,pressure,0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,positions,0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1]);
  const depth=gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER,depth);
  gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,FIELD,FIELD*LAYERS);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  let fieldOrigin=[-100000,0,-100000], lastBounds=null, carry=STEP;
  const stats={roots:0,uploadBytes:0,cpuMs:0};
  function uploadFox(fox) {
    const bytes=grid.update(fox.contactSurfaces()), bounds=grid.bounds;
    // Include the previous occupied box so moving paws clear their old texels.
    const old=lastBounds ?? bounds;
    const x=Math.min(old[0],bounds[0]), y=Math.min(old[1],bounds[1]), z=Math.min(old[2],bounds[2]);
    const w=Math.max(old[3],bounds[3])-x, h=Math.max(old[4],bounds[4])-y, d=Math.max(old[5],bounds[5])-z;
    stats.uploadBytes=0;
    if(w>0 && h>0 && d>0) {
      gl.activeTexture(gl.TEXTURE21); gl.bindTexture(gl.TEXTURE_3D,volume);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH,CONTACT_SIZE[0]); gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT,CONTACT_SIZE[1]);
      gl.texSubImage3D(gl.TEXTURE_3D,0,x,y,z,w,h,d,gl.RGBA,gl.UNSIGNED_BYTE,bytes,4*(x+CONTACT_SIZE[0]*(y+CONTACT_SIZE[1]*z)));
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH,0); gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT,0);
      stats.uploadBytes=4*w*h*d;
    }
    lastBounds=Array.from(bounds);
  }
  function clearPatch() {
    current.base=previous.base=[-100000,-100000];
    fieldOrigin=[-100000,0,-100000]; stats.roots=stats.uploadBytes=0;
  }
  function bind(p) {
    gl.uniform2iv(p.u('uSiteBase'),current.base);
    gl.uniform2iv(p.u('uLastBase'),previous.base);
    gl.uniform1i(p.u('uBladeLast'),23); gl.activeTexture(gl.TEXTURE23); gl.bindTexture(gl.TEXTURE_2D_ARRAY,previous.tex);
    gl.uniform1i(p.u('uBladeNow'),22); gl.activeTexture(gl.TEXTURE22); gl.bindTexture(gl.TEXTURE_2D_ARRAY,current.tex);
    gl.uniform1f(p.u('uBladeMix'),Math.min(1,carry/STEP));
  }
  function advance(dt,x,y,z,ground,fox,basis,grass,setup,coupled) {
    carry+=dt;
    if(carry+1e-8<STEP) return;
    const elapsed=Math.min(0.10,carry);
    carry=Math.max(0,carry-Math.floor((carry+1e-8)/STEP)*STEP);
    const groups=grass.nearRoots(x,z,CONTACT_REACH);
    if(!groups.length) {
      if(stats.roots) clearPatch();
      return;
    }
    const start=performance.now();
    uploadFox(fox);
    [current,previous]=[previous,current];
    const rate=grass.siteRate;
    current.base=[Math.floor(x*rate)-SITES/2, Math.floor(z*rate)-SITES/2];
    gl.disable(gl.BLEND); gl.disable(gl.DITHER); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true); gl.colorMask(true,true,true,true);
    gl.bindFramebuffer(gl.FRAMEBUFFER,current.fbo); gl.viewport(0,0,SITES,3*SITES);
    for(let i=0;i<4;i++) gl.clearBufferfv(gl.COLOR,i,zero);
    setup(solve); bind(solve);
    gl.uniform3fv(solve.u('uLastField'),fieldOrigin);
    gl.uniform1i(solve.u('uCoupled'),coupled);
    gl.uniform1f(solve.u('uRecovery'),Math.exp(-elapsed*8));
    gl.uniform3f(solve.u('uContactOrigin'),x,y,z);
    gl.uniformMatrix3fv(solve.u('uContactBasis'),false,basis);
    gl.uniform1f(solve.u('uContactScale'),fox.contactScale);
    gl.uniform1i(solve.u('uFoxVolume'),21); gl.uniform1i(solve.u('uNeighbours'),24); gl.uniform1i(solve.u('uDonorSite'),25);
    stats.roots=grass.drawRoots(solve,groups,3);
    fieldOrigin=[Math.floor(x/CELL)*CELL-CONTACT_REACH,Math.floor(ground/BAND)*BAND-2*BAND,Math.floor(z/CELL)*CELL-CONTACT_REACH];
    gl.bindFramebuffer(gl.FRAMEBUFFER,fieldFbo); gl.viewport(0,0,FIELD,FIELD*LAYERS);
    gl.clearBufferfv(gl.COLOR,0,zero);
    if(coupled) {
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.clearBufferfv(gl.DEPTH,0,one);
      setup(stamp); bind(stamp); gl.uniform3fv(stamp.u('uField'),fieldOrigin);
      grass.drawRoots(stamp,groups,3*8);
      gl.invalidateFramebuffer(gl.FRAMEBUFFER,[gl.DEPTH_ATTACHMENT]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.bindVertexArray(null); gl.enable(gl.DITHER);
    stats.cpuMs+=0.15*(performance.now()-start-stats.cpuMs);
  }
  return {advance,bind,reset() { clearPatch(); carry=STEP; },stats};
}
