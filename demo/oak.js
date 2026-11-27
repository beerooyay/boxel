// One summer specimen from LOLIPOP's oak pack. The trunk and crown share a
// world-space root; only the lowest trunk ring follows the triangulated slope.
import {loadSurface, uploadSurface} from './surface-texture.js';

export function oakProgram(program, world, air) {
  return program(world + air + `
layout(location=0) in vec3 pos; layout(location=1) in vec3 normal;
layout(location=2) in vec2 uv; layout(location=3) in vec4 tangent;
out vec3 wp,n; out vec2 tex; out vec4 tanFrame,haze;
void main(){wp=pos; n=normal; tex=uv; tanFrame=tangent;
haze=airAt(wp); gl_Position=project(wp);}`, `
in vec3 wp,n; in vec2 tex; in vec4 tanFrame,haze;
uniform float uClip; uniform bool uOakLeaves,uCoverage; uniform sampler2D uOakColor,uOakNormal; out vec4 o;
void main(){vec4 base=texture(uOakColor,tex);
float cover=clamp((base.a-0.45)/max(fwidth(base.a),0.001)+0.5,0.,1.);
if(wp.y<uClip || (uCoverage ? cover<0.02 : base.a<0.45)) discard;
vec3 N=normalize(n), T=normalize(tanFrame.xyz-N*dot(N,tanFrame.xyz));
vec3 grain=texture(uOakNormal,tex).xyz*2.-1.;
N=normalize(mat3(T,cross(N,T)*tanFrame.w,N)*grain);
vec3 sun=uSunCol*directLight(wp);
float facing=dot(N,uSunDir);
vec3 light=2.2*ambient(N)+sun*(0.18+0.82*max(facing,0.));
if(uOakLeaves){
  float lower=1.-smoothstep(-0.22,0.22,dot(N,normalize(uCam-wp)));
  vec2 sides=vec2(max(facing,0.),max(-facing,0.));
  light=2.2*mix(ambient(N),ambient(-N),0.55*lower)+sun*(0.15+
    0.78*mix(sides.x,sides.y,lower)+vec3(0.65,0.52,0.34)*mix(sides.y,sides.x,lower));
}
o=vec4(tonemap(base.rgb*light*haze.a+haze.rgb),uCoverage ? cover : 0.);}`);
}

export async function loadOak(gl, x, z, ground) {
  const base = ground(x,z);
  return Promise.all(['bark','leaves'].map(async (part) => {
    const [response,color,normal] = await Promise.all([
      fetch(new URL('./oak/'+part+'.bin',import.meta.url)),
      loadSurface('./oak/'+part+'-color.webp'),loadSurface('./oak/'+part+'-normal.webp')]);
    if (!response.ok || !color || !normal) throw Error('Oak asset unavailable: '+part);
    const bytes=await response.arrayBuffer(), count=new DataView(bytes).getUint32(0,true);
    const vertices=new Float32Array(bytes,4,count*12), indices=new Uint16Array(bytes,4+vertices.byteLength);
    const bounds={x0:Infinity,y0:Infinity,z0:Infinity,y1:-Infinity,pad:0};
    let x1=-Infinity,z1=-Infinity;
    for(let i=0;i<vertices.length;i+=12){
      const wx=x+vertices[i]*.78, h=vertices[i+1]*.78, wz=z+vertices[i+2]*.78;
      const f=Math.min(1,Math.max(0,h/.95)), fit=1-f*f*(3-2*f);
      vertices[i]=wx; vertices[i+1]=base+h+fit*(ground(wx,wz)-base-.11); vertices[i+2]=wz;
      bounds.x0=Math.min(bounds.x0,wx); bounds.z0=Math.min(bounds.z0,wz);
      x1=Math.max(x1,wx); z1=Math.max(z1,wz);
      bounds.y0=Math.min(bounds.y0,vertices[i+1]); bounds.y1=Math.max(bounds.y1,vertices[i+1]);
    }
    const vao=gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);
    let offset=0;
    [3,3,2,4].forEach((size,loc)=>{gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc,size,gl.FLOAT,false,48,offset); offset+=size*4;});
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {vao,count:indices.length,leaves:part==='leaves',bounds,width:x1-bounds.x0,depth:z1-bounds.z0,color:uploadSurface(gl,color,28,gl.SRGB8_ALPHA8),
      normal:uploadSurface(gl,normal,29,gl.RGBA8)};
  }));
}
export function drawOak(gl, parts, program, planes, outsideView) {
  for(const part of parts){
    if(planes && outsideView(planes,part.bounds,part.width,part.depth)) continue;
    if(program) gl.uniform1i(program.u('uOakLeaves'),part.leaves);
    gl.activeTexture(gl.TEXTURE0+28); gl.bindTexture(gl.TEXTURE_2D,part.color);
    gl.activeTexture(gl.TEXTURE0+29); gl.bindTexture(gl.TEXTURE_2D,part.normal);
    gl.bindVertexArray(part.vao); gl.drawElements(gl.TRIANGLES,part.count,gl.UNSIGNED_SHORT,0);
  }
}
