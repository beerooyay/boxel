// Summer oaks from LOLIPOP. Each root flare follows the triangulated terrain.
import {loadSurface, uploadSurface} from './surface-texture.js';

export function oakProgram(program, world, air) {
  return program(world + air + `
layout(location=0) in vec3 pos; layout(location=1) in vec3 normal;
layout(location=2) in vec2 uv; layout(location=3) in vec4 tangent;
uniform vec4 uTree;
out vec3 wp,n; out vec2 tex; out vec4 tanFrame,haze;
void main(){wp=pos;
if(uWind>0.) {
  float flex=clamp((pos.y-uTree.y)/uTree.w,0.,1.);
  wp+=boughOffset(crownLoad(uTree.xz)*uWind,flex,uTree.w);
} n=normal; tex=uv; tanFrame=tangent;
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

function uploadOakMesh(gl, bytes, site, ground) {
  const count = new DataView(bytes).getUint32(0, true);
  const vertices = new Float32Array(bytes, 4, count * 12).slice();
  const indices = new Uint16Array(bytes, 4 + vertices.byteLength);
  const {x, y: base, z, scale, yaw, height} = site;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const bounds = {x0: Infinity, y0: Infinity, z0: Infinity, y1: -Infinity, pad: 0.5};
  let x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < vertices.length; i += 12) {
    const wx = x + scale * (cos * vertices[i] - sin * vertices[i+2]);
    const wz = z + scale * (sin * vertices[i] + cos * vertices[i+2]);
    const h = vertices[i+1] * scale;
    // Turn both the normal and the tangent with the tree's bark grain.
    for (let offset = 3; offset <= 8; offset += 5) {
      const a = vertices[i+offset], b = vertices[i+offset+2];
      vertices[i+offset] = cos*a - sin*b;
      vertices[i+offset+2] = sin*a + cos*b;
    }
    let wy = base + h;
    if (h < 0.95) {
      const t = Math.max(0, h / 0.95);
      wy += (1 - t*t*(3-2*t)) * (ground(wx,wz) - base - 0.11);
    }
    vertices[i] = wx; vertices[i+1] = wy; vertices[i+2] = wz;
    bounds.x0 = Math.min(bounds.x0, wx); x1 = Math.max(x1, wx);
    bounds.z0 = Math.min(bounds.z0, wz); z1 = Math.max(z1, wz);
    bounds.y0 = Math.min(bounds.y0, wy); bounds.y1 = Math.max(bounds.y1, wy);
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  let offset = 0;
  [3,3,2,4].forEach((size, loc) => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 48, offset);
    offset += size * 4;
  });
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {vao, count: indices.length, bounds, width: x1 - bounds.x0, depth: z1 - bounds.z0,
    site, tree: new Float32Array([x, base, z, height])};
}

export async function loadOak(gl, sites, ground) {
  const files = new Map();
  function geometry(name) {
    if (!files.has(name)) {
      const url = new URL('./oak/' + name + '.bin', import.meta.url);
      files.set(name, fetch(url).then(response => {
        if (!response.ok) throw Error('Oak mesh unavailable: ' + name);
        return response.arrayBuffer();
      }));
    }
    return files.get(name);
  }
  const batches = await Promise.all(['bark','leaves'].map(async part => {
    const [albedo, relief] = await Promise.all(['color','normal'].map(role => loadSurface('./oak/'+part+'-'+role+'.webp')));
    if (!albedo || !relief) throw Error('Oak material unavailable: ' + part);
    const color = uploadSurface(gl, albedo, 28, gl.SRGB8_ALPHA8);
    const normal = uploadSurface(gl, relief, 29, gl.RGBA8);
    return Promise.all(sites.flatMap(site => [false,true].map(async far => {
      const file = site.form === 'medium' && !far ? part : site.form + '-' + (far ? 2 : 1) + '-' + part;
      const mesh = uploadOakMesh(gl, await geometry(file), site, ground);
      return {...mesh, color, normal, leaves: part === 'leaves', far};
    })));
  }));
  return batches.flat();
}
export function drawOak(gl, parts, program, planes, outsideView, eye) {
  for(const part of parts){
    const {x,z}=part.site;
    const far=!eye || (eye[0]-x)**2+(eye[2]-z)**2>42**2;
    if(far!==part.far || (planes && outsideView(planes,part.bounds,part.width,part.depth))) continue;
    if(program) {
      gl.uniform1i(program.u('uOakLeaves'),part.leaves);
      gl.uniform4fv(program.u('uTree'),part.tree);
    }
    gl.activeTexture(gl.TEXTURE0+28); gl.bindTexture(gl.TEXTURE_2D,part.color);
    gl.activeTexture(gl.TEXTURE0+29); gl.bindTexture(gl.TEXTURE_2D,part.normal);
    gl.bindVertexArray(part.vao); gl.drawElements(gl.TRIANGLES,part.count,gl.UNSIGNED_SHORT,0);
  }
}
