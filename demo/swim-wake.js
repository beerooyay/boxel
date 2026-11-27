// Classify the same skinned mesh used by grass contact. Where its edges cross
// the waterline, measure a separate footprint for the hull, each leg and tail.
const PARTS = 6;
const SAMPLES = 8;
const INTERVAL = 1/15;

export function waterPart(name) {
  if (name.startsWith('Tail')) return 5;
  const side = name.endsWith('.L') ? 0 : 1;
  if (/^(?:IK)?Front|^FF\./.test(name)) return 1 + side;
  if (/^(?:IK)?Back(?:Leg|Shoulder|Upper|Lower)|^FFB\./.test(name)) return 3 + side;
  return 0;
}

export function waterlineEdges(surfaces, parts) {
  return surfaces.map(({ indices, joints, weights, positions }) => {
    const group = new Uint8Array(positions.length/3);
    for (let i=0; i<group.length; i++) {
      let top=4*i;
      for (let j=top+1; j<4*i+4; j++) if (weights[j]>weights[top]) top=j;
      group[i]=parts[joints[top]];
    }
    const edges=[], seen=new Set();
    for (let i=0; i<indices.length; i+=3) for (let j=0; j<3; j++) {
      const a=indices[i+j], b=indices[i+(j+1)%3];
      const lo=Math.min(a,b), hi=Math.max(a,b), key=lo*group.length+hi;
      if (a===b || seen.has(key)) continue;
      seen.add(key);
      edges.push(lo,hi);
    }
    return { positions, group, edges: Uint32Array.from(edges), depth: new Float32Array(group.length) };
  });
}

export function sampleWaterline(mesh, scale, origin, basis, waterHeight, slopeX, slopeZ, bounds) {
  // Per part: extents along left, right, aft and forward axes, all in metres.
  bounds.fill(-Infinity);
  // Signed depth against the local water plane, expressed in the rig frame.
  const nx=(-basis[1]+slopeX*basis[0]+slopeZ*basis[2])*scale;
  const ny=(-basis[4]+slopeX*basis[3]+slopeZ*basis[5])*scale;
  const nz=(-basis[7]+slopeX*basis[6]+slopeZ*basis[8])*scale;
  const forwardLength=Math.hypot(basis[6],basis[8]);
  const fx=basis[6]/forwardLength, fz=basis[8]/forwardLength;
  for (const { positions, group, edges, depth } of mesh) {
    for (let i=0; i<depth.length; i++) {
      depth[i]=waterHeight-origin[1]+nx*positions[i*3]+ny*positions[i*3+1]+nz*positions[i*3+2];
    }
    for (let i=0; i<edges.length; i+=2) {
      const a=edges[i], b=edges[i+1], da=depth[a], db=depth[b];
      if ((da>0)===(db>0)) continue;
      const u=da/(da-db), j=4*(u<0.5 ? group[a] : group[b]);
      const x=positions[3*a]+u*(positions[3*b]-positions[3*a]);
      const y=positions[3*a+1]+u*(positions[3*b+1]-positions[3*a+1]);
      const z=positions[3*a+2]+u*(positions[3*b+2]-positions[3*a+2]);
      const wx=(basis[0]*x+basis[3]*y+basis[6]*z)*scale;
      const wz=(basis[2]*x+basis[5]*y+basis[8]*z)*scale;
      const across=fz*wx-fx*wz, along=fx*wx+fz*wz;
      bounds[j]=Math.max(bounds[j],-across);
      bounds[j+1]=Math.max(bounds[j+1],across);
      bounds[j+2]=Math.max(bounds[j+2],-along);
      bounds[j+3]=Math.max(bounds[j+3],along);
    }
  }
}

export function createSwimWake(surface, levelAt, emitLight) {
  const bounds=new Float32Array(PARTS*4);
  const parts=Array.from({length:PARTS}, () => ({wet:false,x:0,z:0,vx:0,vz:0,width:0,force:0}));
  const history=new Float32Array(PARTS*SAMPLES*4);
  const output=history.slice();
  const ages=new Float32Array(SAMPLES);
  const region=new Float32Array(4);
  const timestamps=new Float64Array(SAMPLES-1);
  const water={};
  let head=0, count=0, next=0, bowX=0, bowZ=0;
  let forwardX=0, forwardZ=1, bowWidth=0, bowForce=0, wakeLevel=0;
  const contact={};
  let lastForced=-Infinity;

  function update(fox, origin, basis, xSpeed, zSpeed, dt, t, swimming, night) {
    const [x,y,z]=origin, level=levelAt(x,z);
    const nearby=y<level+0.22;
    const centreWet=nearby && surface.contactAt(x,z,water);
    const slopeX=centreWet ? water.slopeX : 0, slopeZ=centreWet ? water.slopeZ : 0;
    const forwardLength=Math.hypot(basis[6],basis[8]);
    const fx=basis[6]/forwardLength, fz=basis[8]/forwardLength;
    const velocityBlend=-Math.expm1(-18*dt), forceBlend=-Math.expm1(-14*dt);
    forwardX=fx; forwardZ=fz;
    const flowX=centreWet ? water.vx : 0, flowZ=centreWet ? water.vz : 0;
    const speed=Math.hypot(xSpeed-flowX,zSpeed-flowZ);
    const heading=(xSpeed-flowX)*fx+(zSpeed-flowZ)*fz;
    if (nearby) {
      if (centreWet) wakeLevel=level;
      const wave=centreWet ? Math.min(0.045,Math.max(-0.045,water.height)) : 0;
      fox.waterContacts(origin,basis,level+wave,slopeX,slopeZ,bounds);
      // At a high float pose the chest clears the water and the two immersed
      // legs facing the flow split it ahead of the body.
      if (swimming) {
        const leadLeg=heading<-.07 ? 12 : 4;
        for (let k=0; k<4; k++) bounds[k]=Math.max(bounds[k],bounds[k+leadLeg],bounds[k+leadLeg+4]);
      }
    }
    bowForce=0;
    for (let i=0; i<PARTS; i++) {
      const part=parts[i], k=4*i;
      const found=nearby && Number.isFinite(bounds[k]);
      const a=found ? (bounds[k+1]-bounds[k])/2 : 0;
      const length=found ? (bounds[k+2]+bounds[k+3])/2 : 0;
      const side=found ? (bounds[k]+bounds[k+1])/2 : 0;
      const long=found ? (bounds[k+3]-bounds[k+2])/2 : 0;
      const lead=i===0 ? (heading<-.07 ? -0.78 : 0.78)*length : 0;
      const px=x+fz*a+fx*(long+lead), pz=z-fx*a+fz*(long+lead);
      const wet=found && Math.abs(levelAt(px,pz)-level)<0.24 && surface.contactAt(px,pz,contact);
      const width=i===0 ? Math.max(0.065,side) : Math.max(0.028,Math.min(0.18,Math.max(side,length*0.6)));
      let vx=xSpeed, vz=zSpeed;
      if (wet && part.wet) {
        vx=part.vx+(Math.max(-5,Math.min(5,(px-part.x)/dt))-part.vx)*velocityBlend;
        vz=part.vz+(Math.max(-5,Math.min(5,(pz-part.z)/dt))-part.vz)*velocityBlend;
      }
      const movement=wet ? Math.hypot(vx-contact.vx,vz-contact.vz) : 0;
      const force=i===0 ? Math.min(1.35,Math.max(0,(speed-0.07)*0.84))
        : Math.min(0.67,Math.max(0,movement-0.11)*(i===5 ? 0.24 : 0.27)*Math.sqrt(width/0.075));
      part.force += ((wet ? force : 0)-part.force)*forceBlend;
      if (night>0.01 && (wet || part.wet)) {
        // Charge the water the skin actually crosses during this frame. A
        // lifted paw leaves its remaining impulse at the last wet location.
        const pulse=wet ? force*dt : Math.min(part.force,0.7)*0.055;
        if (pulse>0.0001) {
          let sx=wet ? px : part.x, sz=wet ? pz : part.z;
          if (wet && part.wet) { sx=0.5*(px+part.x); sz=0.5*(pz+part.z); }
          const energy=pulse*(i===0 ? 0.28 : 1.05);
          surface.stir(sx,sz,0.70*energy);
          emitLight(sx,sz,energy);
        }
      }
      if (wet) {
        if (part.force>=0.004) lastForced=t;
        wakeLevel=level;
        if (i===0) {
          bowX=px; bowZ=pz; bowWidth=width;
          bowForce=part.force*Math.min(1,Math.abs(heading)*3+speed*0.36);
          if (heading<-.07) { forwardX=-fx; forwardZ=-fz; }
        } else if (part.wet && force>0.04) {
          // The fine creases ride on a small, balanced displacement in the
          // wet grid. Keep the independent light signal at actual contact.
          surface.pressure((px+part.x)*0.5,(pz+part.z)*0.5,vx,vz,dt,
            width,width,force*0.024);
        }
        part.x=px; part.z=pz; part.width=width; part.vx=vx; part.vz=vz;
      }
      part.wet=Boolean(wet);
      if (!wet && part.force<0.004) part.force=0;
    }

    if (swimming && centreWet) {
      const hull=fox.waterline;
      surface.swim(x+fx*hull.centre,z+fz*hull.centre,xSpeed,zSpeed,dt,hull);
    }
    if (t>=next) {
      next=t+INTERVAL-(t-next)%INTERVAL;
      timestamps[head]=t;
      for (let i=0; i<PARTS; i++) {
        const k=(head*PARTS+i)*4, part=parts[i];
        write(history,k,part,part.wet ? part.force : 0);
        if (!part.wet) history[k+3]=0;
      }
      head=(head+1)%timestamps.length;
      count=Math.min(count+1,timestamps.length);
    }
  }

  function write(buffer, k, part, force) {
    buffer[k]=part.x;
    buffer[k+1]=part.z;
    buffer[k+2]=force;
    buffer[k+3]=part.width;
  }

  function prepare(t) {
    if (t-lastForced>0.58) return null;
    for (let j=1; j<SAMPLES; j++) ages[j]=t-timestamps[(head-j+timestamps.length)%timestamps.length];
    let minX=Infinity, minZ=Infinity, maxX=-Infinity, maxZ=-Infinity;
    function include(x,z,r) {
      minX=Math.min(minX,x-r); minZ=Math.min(minZ,z-r);
      maxX=Math.max(maxX,x+r); maxZ=Math.max(maxZ,z+r);
    }
    if (bowForce>0.004) {
      // Include the full curved crest, including the wider cattle rigs.
      const radius=0.15+bowWidth, across=2.8*radius;
      const aft=1.27*(Math.hypot(across,radius)-radius);
      const margin=0.32+0.25*bowWidth;
      const dx=Math.abs(forwardX)*margin+Math.abs(forwardZ)*across;
      const dz=Math.abs(forwardZ)*margin+Math.abs(forwardX)*across;
      minX=Math.min(bowX,bowX-aft*forwardX)-dx; maxX=Math.max(bowX,bowX-aft*forwardX)+dx;
      minZ=Math.min(bowZ,bowZ-aft*forwardZ)-dz; maxZ=Math.max(bowZ,bowZ-aft*forwardZ)+dz;
    }
    for (let i=0; i<PARTS; i++) {
      const part=parts[i], start=i*SAMPLES*4;
      write(output,start,part,part.wet ? part.force : 0);
      if (!part.wet) output[start+3]=0;
      if (output[start+2]>0.004) include(part.x,part.z,0.6+part.width);
      for (let j=1; j<SAMPLES; j++) {
        const slot=(head-j+timestamps.length)%timestamps.length;
        const age=t-timestamps[slot], k=start+4*j;
        output[k+2]=output[k+3]=0;
        if (j>count || age<0 || age>0.58) continue;
        const at=(slot*PARTS+i)*4;
        output[k]=history[at]; output[k+1]=history[at+1];
        output[k+2]=history[at+2]; output[k+3]=history[at+3];
        if (output[k+2]>0.004) include(output[k],output[k+1],0.60+1.35*age+output[k+3]);
      }
    }
    if (minX===Infinity) return null;
    region[0]=minX; region[1]=minZ; region[2]=maxX; region[3]=maxZ;
    return region;
  }

  function bind(gl,shader) {
    gl.uniform4fv(shader.u('uWakeBounds'),region);
    gl.uniform1fv(shader.u('uWakeAges[0]'),ages);
    gl.uniform4fv(shader.u('uWakePath[0]'),output);
    gl.uniform1f(shader.u('uWakeLevel'),wakeLevel);
    gl.uniform4f(shader.u('uBow'),bowX,bowZ,bowWidth,bowForce);
    gl.uniform2f(shader.u('uBowDirection'),forwardX,forwardZ);
  }

  function reset() {
    head=count=next=bowForce=0;
    lastForced=-Infinity;
    for (const part of parts) { part.wet=false; part.force=0; }
  }
  return { update, prepare, bind, reset };
}

export const swimmerWakeGLSL = `
uniform vec4 uWakeBounds, uBow;
uniform vec2 uBowDirection;
uniform float uWakeLevel;
uniform vec4 uWakePath[${PARTS*SAMPLES}];
uniform float uWakeAges[${SAMPLES}];

float wakeCrest(float distance, float width, float pixelMetres) {
  float filtered=sqrt(width*width+0.27*pixelMetres*pixelMetres);
  float k=distance/filtered;
  return (k*exp(-0.56*k*k)+0.30*(k+2.9)*exp(-0.74*(k+2.9)*(k+2.9))) * width*width/(filtered*filtered);
}

// The water just swept by a moving part has a soft centre and a short tail.
// Each contribution approaches zero at its spatial and temporal bounds.
float skinLight(float d2,float size,float force,float age) {
  if (d2>=0.36 || age>=0.32 || force<=0.05) return 0.;
  float span=0.11+1.4*size, radial=d2/(span*span);
  float soft=(1.-smoothstep(0.20,0.36,d2))/(1.+radial*(2.+radial));
  float youth=(1.-smoothstep(0.21,0.32,age))/(1.+6.*age);
  float drive=force*smoothstep(0.05,0.36,force);
  return soft*drive*youth*youth;
}

// xy bends the reflection; z is the shear that excites plankton at the live
// waterline. Both use the same animated contacts and the same wet-patch bounds.
vec3 swimmerDisturbance(vec2 p,vec2 drift,float level,float pixelMetres,bool luminous) {
  if (any(lessThan(p,uWakeBounds.xy)) || any(greaterThan(p,uWakeBounds.zw))) return vec3(0.);
  float sameWater=1.-smoothstep(0.10,0.29,abs(level-uWakeLevel));
  if (sameWater<=0.) return vec3(0.);
  vec2 slope=vec2(0.);
  float contact=0.;
  if (uBow.w>0.004) {
    vec2 q=p-uBow.xy, f=uBowDirection, side=vec2(-f.y,f.x);
    float across=dot(q,side), along=dot(q,f);
    float radius=0.15+uBow.z;
    // Continuous nose and shoulders. The crest bends around the wetted chest
    // and opens into two arms. The historical paths carry the arms after a turn.
    float curve=sqrt(across*across+radius*radius);
    float lip=0.09 + uBow.z*0.25 - 1.27*(curve-radius);
    float fade=1.-smoothstep(radius*1.1,radius*2.8,abs(across));
    if (fade>0. && abs(along-lip)<0.31) {
      vec2 normal=normalize(f+side*1.27*across/curve);
      float crestDistance=dot(normal,f)*(along-lip);
      float wave=wakeCrest(crestDistance,0.043+0.24*uBow.z,pixelMetres);
      slope+=normal*wave*uBow.w*0.67*fade;
    }
  }
  for(int i=0;i<${PARTS};i++){
    int start=i*${SAMPLES};
    vec2 bestOffset=vec2(0.), bestSide=vec2(0.);
    float best=1.e6, width=0., load=0., feather=0., extent=0.;
    vec4 skin=uWakePath[start];
    float partLight=0.;
    if (luminous && skin.w>0.) {
      vec2 delta=p-skin.xy;
      partLight=skinLight(dot(delta,delta),skin.w,skin.z,0.);
    }
    for(int j=1;j<${SAMPLES};j++){
      vec4 a=uWakePath[start+j-1], b=uWakePath[start+j];
      if (min(a.w,b.w)<=0. || max(a.z,b.z)<0.004 || uWakeAges[j]>0.58) continue;
      float ageA=uWakeAges[j-1], ageB=uWakeAges[j];
      vec2 from=a.xy+drift*ageA, to=b.xy+drift*ageB, line=to-from;
      float lengthSquared=dot(line,line);
      if (lengthSquared<0.000025 || lengthSquared>0.60) continue;
      float raw=dot(p-from,line)/lengthSquared;
      float u=clamp(raw,0.,1.);
      vec2 offset=p-mix(from,to,u);
      float d=dot(offset,offset);
      float age=mix(ageA,ageB,u), size=mix(a.w,b.w,u), force=mix(a.z,b.z,u);
      if (luminous && ageA<0.32 && d<0.36)
        partLight=max(partLight,skinLight(d,size,force,age));
      if (d>=best) continue;
      best=d; bestOffset=offset; bestSide=vec2(-line.y,line.x)*inversesqrt(lengthSquared);
      extent=max(0.001,abs(raw-u)*sqrt(lengthSquared));
      width=(i==0 ? 0.057 : 0.028)+0.14*size;
      feather=max(0.,age)*(i==0 ? 0.82 : 0.44)+size*(i==0 ? 1.27 : 0.69);
      load=force*(1.-smoothstep(0.24,0.51,age));
    }
    contact=max(contact,partLight*(i==0 ? 1. : 1.3));
    if (best>0.58 || load<0.004) continue;
    float transverse=dot(bestOffset,bestSide);
    float wing=abs(transverse)-feather;
    float taper=(1.-smoothstep(0.012,0.16,extent))*smoothstep(0.,0.043,abs(transverse));
    float wave=wakeCrest(wing,width,pixelMetres);
    slope+=sign(transverse)*bestSide*(load*wave*taper*(i==0 ? 0.35 : 0.28));
  }
  return sameWater*vec3(slope,contact);
}
`;
