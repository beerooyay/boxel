// The valley and the outer forest grow from the same fluted trunk and alternating
// broadleaf shoots. Templates change the branching habit, instances set size and pigment.
const habits = [
  { fork: 0.26, spread: 0.49, lift: 0.3, lean: 0.32, taper: 0.44, shoulder: 0.02 }, // spreading
  { fork: 0.19, spread: 0.37, lift: 0.17, lean: 0.06, taper: 0.78, shoulder: 0.05 }, // upright
  { fork: 0.32, spread: 0.37, lift: 0.27, lean: 0.13, taper: 0.46, shoulder: 0.32 }, // rounded
];
// The broadleaf on an exposed bank reaches out of the wind. Use one of the
// six existing templates so the same crown goes into shadows and reflections.
const bankHabit = { fork: 0.34, spread: 0.58, lift: 0.40, lean: 0.64, taper: 0.73, shoulder: 0.21 };
const rootSides = 12;
const treeSeeds = [9942, 2113, 8605, 981, 7139, 3029];

export function highCanopyMesh(random, variant = 0) {
  const habit = variant === 3 ? bankHabit : habits[variant % habits.length],
    foliage = [];
  const position = [],
    normal = [],
    tissue = [],
    blade = [],
    stalk = [], graft = [],
    near = [],
    far = [];
  const tau = 2 * Math.PI;
  function vertex(p, n, shade, u = 0, side = 0, root = p, angle = 0) {
    position.push(...p);
    normal.push(...n);
    tissue.push(shade);
    blade.push(u, side, angle);
    stalk.push(...root);
    graft.push(0);
    return tissue.length - 1;
  }
  function normalise(x, y, z) {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  }
  function mix(a, b, t) {
    return a.map((v, i) => v + t * (b[i] - v));
  }
  function curvePoint(a,b,c,d,t) {
    // Cubic Hermite segment through successive woody growth nodes.
    return b.map((v,i)=>v+(0.5*t)*((c[i]-a[i])+t*(2*a[i]-5*v+4*c[i]-d[i]+t*(3*v-a[i]-3*c[i]+d[i]))));
  }
  function extend(p, angle, reach, rise) {
    return [p[0] + Math.cos(angle) * reach, p[1] + rise, p[2] + Math.sin(angle) * reach];
  }
  // Each limb has its own axis. Broad root flutes die out before the trunk forks.
  const sockets=[];
  const throatRing=4; // Keep the trunk collar inside the first bend of each bough.
  const cutTriangles=new Set(), seamCopies=new Map();
  const trunkLevels=[0,0.09,0.25,0.42,0.63,0.8,0.94];
  const at=(array,id)=>array.slice(id*3,id*3+3);
  // Stitch closed loops of different resolutions without a cap or interior face.
  function bridge(indices,lower,upper) {
    let i=0,j=0;
    while(i<lower.length || j<upper.length) {
      const a=lower[i%lower.length], b=upper[j%upper.length];
      if ((i+1)*upper.length <= (j+1)*lower.length) {
        indices.push(a,lower[++i%lower.length],b);
      } else indices.push(a,upper[++j%upper.length],b);
    }
  }
  function collarPatch(indices,rim,throat,axis) {
    // Match the two loops by least travel without reversing winding.
    let shift=0,best=Infinity;
    for(let offset=0;offset<throat.length;offset++) {
      let cost=0;
      rim.forEach((id,i)=>{
        const q=at(position,throat[(offset+Math.round(i*throat.length/rim.length))%throat.length]);
        cost+=at(position,id).reduce((sum,v,j)=>sum+(v-q[j])**2,0);
      });
      if(cost<best) {best=cost;shift=offset;}
    }
    const target=throat.slice(shift).concat(throat.slice(0,shift));
    const centre=rim.reduce((sum,id)=>sum.map((v,j)=>v+position[3*id+j]/rim.length),[0,0,0]);
    let previous=rim;
    for(const t of [0.28,0.62]) {
      const loop=rim.map((id,i)=>{
        const u=i*target.length/rim.length, j=Math.floor(u);
        const q=mix(at(position,target[j]),at(position,target[(j+1)%target.length]),u-j);
        const p=at(position,id), n=at(normal,id);
        const inward=centre.map((v,k)=>v-p[k]), radial=inward.reduce((s,v,k)=>s+v*n[k],0);
        const tangent=inward.map((v,k)=>(v-radial*n[k])*1.6);
        const run=Math.hypot(...q.map((v,k)=>v-p[k]));
        const point=mix(p,q,t*t*(3-2*t)).map((v,k)=>v+t*(1-t)*((1-t)*tangent[k]-t*run*axis[k]));
        const endNormal=mix(at(normal,target[j]),at(normal,target[(j+1)%target.length]),u-j);
        const index=vertex(point,normalise(...mix(n,endNormal,t)),-1-point[1],0,0,axis,0.2);
        graft[index]=1; return index;
      });
      bridge(indices,previous,loop); previous=loop;
    }
    bridge(indices,previous,target);
  }
  // Open a window in the parent bough around a shoot. Its four sides can
  // cross the cylindrical UV seam; use each side's actual edge indices.
  function shootSocket(parent,shootStart,shootSides,axis) {
    const {first,segments,nearBand,terminal,cap}=parent;
    const atRing=(r,j)=>first+r*(segments+1)+(j+segments)%segments;
    const target=Array.from({length:shootSides},(_,i)=>shootStart+i);
    let rim=[];
    if(terminal) {
      for(let i=0;i<segments;i++) cutTriangles.add(cap+i*3);
      rim=Array.from({length:segments},(_,j)=>atRing(0,j));
    } else {
      let closest=0,best=-Infinity;
      for(let j=0;j<segments;j++) {
        const p=at(position,atRing(0,j));
        const score=p.reduce((sum,v,k)=>sum+(v-parent.p[k])*axis[k],0);
        if(score>best) {best=score; closest=j;}
      }
      const start=closest-1;
      for(let r=-1;r<1;r++) for(let j=0;j<2;j++) {
        const face=nearBand+(r*segments+(start+j+segments)%segments)*6;
        cutTriangles.add(face); cutTriangles.add(face+3);
      }
      for(const [r,j] of [[-1,0],[-1,1],[-1,2],[0,2],[1,2],[1,1],[1,0],[0,0]])
        rim.push(atRing(r,start+j));
    }
    // A ring seam has duplicate UV vertices at identical positions.
    for(const id of rim) graft[id]=1;
    collarPatch(near,rim,target,axis);
  }
  function wood(points, radii, sides, farRings, buttress = false, join = false) {
    const start = tissue.length, ring = sides + 1, spin = random() * tau;
    const flares = Array.from({ length: sides }, () => 0.18 + 0.82 * random());
    const girth = tau * radii[1];
    const lobes = 3 + Math.floor(flares[0]*2.8), fluteTwist = (flares[1]-0.5)*1.6;
    const rings = [];
    const lastRadius = join === true ? new Float64Array(sides+1).fill(Infinity) : null;
    let across, arc = 0;
    for (let k = 0; k < points.length; k++) {
      const p = points[k], next = points[Math.min(k + 1, points.length - 1)], prev = points[Math.max(k - 1, 0)];
      const axis = normalise(...next.map((v, i) => v - prev[i]));
      if (k) arc += Math.hypot(...p.map((v, i) => v - prev[i]));
      // Transport the last ring's frame through the bend so fibres follow the
      // fork. Duplicate the seam to carry a full cylindrical UV interval.
      if (!across) across = Math.abs(axis[0]) < 0.8 ? [1,0,0] : [0,0,1];
      const axial = across.reduce((sum, v, j) => sum + v * axis[j], 0);
      across = normalise(...across.map((v,j) => v - axial * axis[j]));
      const [x,y,z] = axis, [a,b,c] = across;
      const binormal = [y*c-z*b, z*a-x*c, x*b-y*a];
      rings.push({ p, axis, across, binormal, radius:radii[k] });
      for (let i = 0; i <= sides; i++) {
        const theta = spin + (i % sides) * tau / sides;
        const radial = across.map((v,j) => v * Math.cos(theta) + binormal[j] * Math.sin(theta));
        const ridge = flares[i % sides];
        // Broad, asymmetric buttresses twist into shallower ridges up the bole.
        const flute = buttress ? (0.5+0.5*Math.cos(lobes*theta+fluteTwist*k+0.55*Math.sin(theta+spin)))**2 : 0;
        const flare = buttress ? (1.48*Math.exp(-p[1]*12)+0.16*Math.exp(-p[1]*2.6))*flute*(0.7+0.5*ridge) : 0;
        // One broad rib turns around the limb; the wood swells on the
        // outside of the crook while each longitudinal ridge tapers to its tip.
        const rib = join === true ? (0.5+0.5*Math.cos(theta*2+spin+arc*11))**3 : 0;
        let radius = radii[k] * (0.87 + 0.23 * ridge + flare + 0.23*rib);
        if (lastRadius) {
          radius=Math.min(radius,lastRadius[i]);
          lastRadius[i]=radius;
        }
        const surface = p.map((v,j) => v+radius*radial[j]);
        const slope = (radii[Math.max(0,k-1)]-radii[Math.min(k+1,radii.length-1)]) / Math.hypot(...next.map((v,j)=>v-prev[j]));
        let n=normalise(...radial.map((v,j)=>v+axis[j]*slope));
        if (buttress && k===0) surface[1]=0;
        let blend=0;
        if(join === true) blend=k<=throatRing ? 1 : k===throatRing+1 ? 0.32 : 0;
        if (join && join !== true && k < 3) {
          // Wrap the twig shoulder around the parent limb in its own bark frame.
          const parent=join, d=surface.map((v,j)=>v-parent.p[j]);
          const dot=v=>d.reduce((sum,n,j)=>sum+n*v[j],0);
          const along=dot(parent.axis), angle=Math.atan2(dot(parent.binormal),dot(parent.across));
          const radial=parent.across.map((v,j)=>v*Math.cos(angle)+parent.binormal[j]*Math.sin(angle));
          const distance=Math.hypot(dot(parent.across),dot(parent.binormal));
          const reach=k===0 ? Math.min(distance,0.58*parent.radius) : distance;
          for(let j=0;j<3;j++) surface[j]=parent.p[j]+along*parent.axis[j]+radial[j]*reach;
          blend=(1-Math.min(1,Math.max(0,(reach/parent.radius-0.72)/1.6)))**2;
          n=normalise(...mix(n,radial,blend));
        }
        const id=vertex(surface,n,-1-p[1],i/sides,arc,axis,girth);
        graft[id]=buttress || (join && k===1) ? 1 : blend;
        if(i===sides) seamCopies.set(id,id-sides);
      }
    }
    if (buttress || join === true) {
      // Light the flutes using the actual tapered silhouette, including the UV seam.
      const at=(k,i,j)=>position[3*(start+k*ring+(i+sides)%sides)+j];
      for(let k=0;k<points.length;k++) for(let i=0;i<=sides;i++) {
        const around=[0,1,2].map(j=>at(k,i+1,j)-at(k,i-1,j));
        const up=[0,1,2].map(j=>at(Math.min(points.length-1,k+1),i,j)-at(Math.max(0,k-1),i,j));
        const n=normalise(around[1]*up[2]-around[2]*up[1],around[2]*up[0]-around[0]*up[2],around[0]*up[1]-around[1]*up[0]);
        const offset=3*(start+k*ring+i);
        const parentWeight=buttress ? 0 : graft[offset/3];
        for(let j=0;j<3;j++) normal[offset+j]+= (n[j]-normal[offset+j])*(1-parentWeight);
      }
    }
    function connect(indices, lower, upper, facets) {
      for (let j = 0; j < facets; j++) {
        const left = Math.round(j*sides/facets), right = Math.round((j+1)*sides/facets);
        const lo = start + lower*ring, hi = start + upper*ring;
        // At the welded throat the bark uses solid projection, so the
        // wraparound edge shares its vertex even at the cylindrical UV seam.
        const end=join===true && lower===throatRing && right===sides ? lo : lo+right;
        indices.push(lo+left,end,hi+left, end,hi+right,hi+left);
      }
    }
    const bandStart=near.length;
    for (let k = join===true ? throatRing+1 : join ? 2 : 1; k < points.length; k++) connect(near,k-1,k,sides);
    for (let k = join===true ? 3 : 1; k < farRings.length; k++)
      connect(far,join===true && k===3 ? throatRing : farRings[k-1],farRings[k],join===true ? sides : buttress ? 7 : 4);
    if(join && join!==true) {
      shootSocket(join,start+ring,sides,rings[1].axis);
    }
    if (!farRings.length) return; // the terminal shoot already tapers to a point
    const last = points.length - 1, limb = normalise(...points[last].map((v,i) => v-points[last-1][i]));
    const tip = vertex(points[last].map((v,i) => v + limb[i]*radii[last]*1.8),
      limb, -1-points[last][1], 0.5, arc+radii[last], across, girth);
    const cap=near.length;
    if (join===true) rings.forEach((r,k)=>Object.assign(r,{first:start+k*ring,segments:sides,
      nearBand:bandStart+(k-throatRing)*sides*6, terminal:k===last, cap}));
    for (let i = 0; i < sides; i++) near.push(start+last*ring+i,start+last*ring+i+1,tip);
    if (join===true) for (let i=0;i<sides;i++) far.push(start+last*ring+i,start+last*ring+i+1,tip);
    if (join===true) sockets.push({ base:points[0], throat:points[throatRing], axis:rings[throatRing].axis,
      first:start+throatRing*ring, sides });
    return rings;
  }

  // Both levels fold along the woody midrib. A twig can carry leaves all
  // the way to its base, so preserve the full tapered atlas footprint.
  function frond(root, angle, length, slope, droop, tone) {
    const c=Math.cos(angle), s=Math.sin(angle);
    const roll=(random()-0.5)*1.80, curl=(random()-0.5)*0.27;
    const breadth=length*(0.47+0.12*random());
    const fold=0.43+0.26*tone, twist=curl*3.6;
    function point(t, side) {
      const lateral=length*curl*t*t+side*breadth;
      const crossSlope=roll+twist*(t-0.5)-fold*Math.sign(side);
      const tilt=slope-2*droop*t+side*breadth*twist/length;
      const y=length*(slope*t-droop*t*t)+breadth*(side*(roll+twist*(t-0.5))-Math.abs(side)*fold);
      return vertex([root[0]+c*length*t-s*lateral,root[1]+y,root[2]+s*length*t+c*lateral],
        normalise(-c*tilt+s*crossSlope,1,-s*tilt-c*crossSlope),tone,t,side,root,angle);
    }
    const foot = point(0,0), left = point(0,-0.96), right = point(0,0.96);
    const tip = point(1,0), endLeft = point(1,-0.74), endRight = point(1,0.74);
    const mid = point(0.49,0);
    near.push(foot,mid,left, left,mid,endLeft, endLeft,mid,tip,
      foot,right,mid, right,endRight,mid, mid,endRight,tip);
    far.push(foot,tip,left, left,tip,endLeft, foot,right,tip, right,endRight,tip);
    foliage.push(
      root[0] + 0.54 * c * length,
      root[1] + length * (0.54 * slope - 0.29 * droop),
      root[2] + 0.54 * s * length,
      0.59 * length * breadth,
    );
  }

  function shoot(root, angle, reach, lift, heel = 0.0064, parent = null) {
    const turn = (random() - 0.5) * 0.86;
    const mid = extend(root, angle, reach * 0.54, lift * 0.76 + 0.02);
    const tip = extend(mid, angle + turn, reach * 0.46, lift * 0.24 - 0.014);
    if (parent) {
      heel = Math.min(heel,parent.radius*0.62);
      const collar=mix(root,mid,Math.min(0.46,parent.radius*2.2/Math.hypot(...mid.map((v,j)=>v-root[j]))));
      collar[1]+=0.24*parent.radius;
      wood([root,collar,mid,tip],[heel*1.45,heel*1.1,Math.min(heel,0.0034),0.0002],5,[],false,parent);
    } else wood([root,mid,tip],[heel,Math.min(heel,0.0034),0.0002],4,[]);
    const pairs = 3 + Math.floor(2 * random()),
      tone = random();
    for (let j = 0; j < 2 * pairs; j++) {
      const t = 0.20 + 0.79 * (j + 0.3 + 0.55 * random()) / (2 * pairs);
      const p = t < 0.54 ? mix(root, mid, t / 0.54) : mix(mid, tip, (t - 0.54) / 0.46);
      const az = angle + turn * t + (j % 2 ? 1 : -1) * (0.8 + 0.49 * (1 - t) + 0.23 * random());
      const length = (0.18 + 0.085 * random()) * (1.06 - 0.29 * t);
      const slope = -0.08 + 0.94 * random() + 0.32 * t;
      const droop = 0.33 + 0.58 * random() + 0.19 * (1 - t);
      frond(p, az, length, slope, droop, 0.06 + 0.5 * tone + 0.38 * random());
    }
    frond(tip, angle + turn, 0.18 + 0.04 * random(), 0.25, 0.6, 0.65 + 0.28 * random());
  }

  const lean = habit.lean * (0.78 + 0.4 * random()),
    twist = (random() - 0.5) * 0.13;
  const spine = (t) => [lean * t * t + 0.029 * Math.sin(t * 5.3), t, twist * t * t];
  wood(
    trunkLevels.map(spine),
    [0.065, 0.047, 0.04, 0.033, 0.024, 0.015, 0.004],
    rootSides, [0,1,3,5,6], true,
  );
  // Keep the root profile as a sampling cage. Replace its unbroken tube with
  // cut panels after all attachment heights and directions are known.
  near.length=far.length=0;
  const forks = 7 + Math.floor(2 * random()),
    rotation = tau * random();
  for (let i = 0; i < forks; i++) {
    const t = i / (forks - 1),
      a = rotation + i * 2.39996 + (random() - 0.5) * 0.72;
    const base = spine(habit.fork + (0.81 - habit.fork) * t);
    const profile = 1 - habit.taper * t + habit.shoulder * Math.sin(Math.PI * t);
    const lee = habit === bankHabit ? 0.94 + 0.29*Math.cos(a) : 1;
    const reach = habit.spread * profile * (0.82 + 0.37 * random()) * lee;
    const lift = habit.lift * (1 - 0.53 * t) * (0.76 + 0.4 * random()),
      turn = (random() - 0.5) * 1.0;
    // A swollen collar grows out of the trunk into a load-bearing crook.
    // The branch rises close to the trunk, reaches sideways, then lifts its fork.
    const collar = extend(base, a-0.12*turn, reach*0.13, lift*0.26);
    const crook = 0.65+0.35*Math.sin(a*2.7+variant);
    const elbow = extend(collar, a+0.45*turn, reach*0.34, lift*(0.30+0.18*t));
    const wrist = extend(elbow, a+turn*1.6, reach*0.29, -lift*0.19*crook);
    const hand = extend(wrist, a+turn*0.7, reach*0.24, lift*0.38);
    const baseRadius = 0.030 - 0.014*t;
    const haunch = mix(base,collar,0.48);
    haunch[1] -= baseRadius*0.21;
    const shoulder = extend(collar,a-0.32*turn,reach*0.135,lift*(0.25+0.19*crook));
    const knots=[haunch,collar,shoulder,elbow,wrist,hand];
    const widths=[1.32,1.15,0.84,0.52,0.28,0.0024/baseRadius];
    const points=[base,haunch,collar], radii=[1.42,widths[0],widths[1]].map(w=>w*baseRadius);
    // Relax sharp changes of direction over the neighbouring growth spans.
    // The roots of the shoots follow the rounded centreline in both LODs.
    const relaxed=knots.map((p,k)=>k<2 || k===knots.length-1 ? p :
      mix(p,mix(knots[k-1],knots[k+1],0.5),0.26));
    const coarseRings=[0,2];
    for(let k=1;k<relaxed.length-1;k++) {
      const steps=k<4 ? 3 : 2;
      for(let step=1;step<=steps;step++) {
        const u=step/steps;
        points.push(curvePoint(relaxed[k-1],relaxed[k],relaxed[k+1],relaxed[Math.min(k+2,relaxed.length-1)],u));
        radii.push(baseRadius*(widths[k]*(1-u)+widths[k+1]*u));
      }
      coarseRings.push(points.length-1);
    }
    const branch=wood(points,radii,9,coarseRings,false,true);
    const outerFork=branch[coarseRings[3]], tipFork=branch[coarseRings[4]], tip=branch[coarseRings[5]];
    shoot(outerFork.p, a - 0.82, reach * 0.74, 0.055 + 0.075 * random(),0.0064,outerFork);
    shoot(tipFork.p, a + turn + 0.89, reach * 0.69, 0.034 + 0.08 * random(),0.0064,tipFork);
    shoot(tip.p, a + turn, 0.15 + 0.055 * random(), 0.015 - 0.066 * random(),0.0027,tip);
  }
  growTrunk();
  function growTrunk() {
    const trunkStart=tissue.length;
    const centres=sockets.map(s=>s.base[1]+(s.throat[1]-s.base[1])*0.46);
    const edges=[centres[0]-(centres[1]-centres[0])*0.66];
    for(let i=1;i<centres.length;i++) edges.push((centres[i]+centres[i-1])/2);
    edges.push((centres.at(-1)+0.94)/2);
    const levels=[0,0.09,...edges,0.94];
    const shared=[];
    function row(y) {
      let k=1;
      while(trunkLevels[k]<y && k<trunkLevels.length-1) k++;
      const t=(y-trunkLevels[k-1])/(trunkLevels[k]-trunkLevels[k-1]);
      return Array.from({length:rootSides},(_,j)=>{
        const lo=(k-1)*(rootSides+1)+j, hi=lo+rootSides+1;
        const p=mix(at(position,lo),at(position,hi),t);
        const id=vertex(p,normalise(...mix(at(normal,lo),at(normal,hi),t)),-1-y,j/rootSides,y,[0,1,0],0.3);
        graft[id]=1;
        return id;
      });
    }
    let lower=row(0);
    const mod=i=>(i+rootSides)%rootSides;
    for(let k=1;k<levels.length;k++) {
      const upper=row(levels[k]), socket=sockets[k-3];
      let start=-1;
      if(socket) {
        const mid=spine(centres[k-3]);
        const dx=socket.throat[0]-mid[0], dz=socket.throat[2]-mid[2];
        let best=-Infinity;
        for(let j=0;j<rootSides;j++) {
          const p=mix(at(position,lower[j]),at(position,upper[j]),0.5);
          const score=((p[0]-mid[0])*dx+(p[2]-mid[2])*dz)/Math.hypot(p[0]-mid[0],p[2]-mid[2]);
          if(score>best) { best=score; start=mod(j-2); }
        }
      }
      for(let j=0;j<rootSides;j++) {
        if(socket && mod(j-start)<4) continue;
        const h=mod(j+1);
        shared.push(lower[j],lower[h],upper[j],lower[h],upper[h],upper[j]);
      }
      if(socket) {
        const rim=[];
        for(let j=0;j<=4;j++) rim.push(lower[mod(start+j)]);
        for(let j=4;j>=0;j--) rim.push(upper[mod(start+j)]);
        const throat=Array.from({length:socket.sides},(_,j)=>socket.first+j);
        collarPatch(shared,rim,throat,socket.axis);
      }
      lower=upper;
    }
    const tip=trunkLevels.length*(rootSides+1);
    for(let j=0;j<rootSides;j++) shared.push(lower[j],lower[mod(j+1)],tip);
    // Area-weighted normals cross the actual socket boundary. Retain the
    // branch's downstream normal at the throat, including its duplicated UV seam.
    const sums=new Map();
    for(let i=0;i<shared.length;i+=3) {
      const ids=shared.slice(i,i+3),[a,b,c]=ids.map(id=>at(position,id));
      const u=b.map((v,k)=>v-a[k]),v=c.map((x,k)=>x-a[k]);
      const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      for(const id of ids) {
        if(id<trunkStart) continue;
        const sum=sums.get(id)??[0,0,0];
        for(let k=0;k<3;k++) sum[k]+=cross[k];
        sums.set(id,sum);
      }
    }
    for(const [id,sum] of sums) {
      const n=normalise(...sum);
      for(let k=0;k<3;k++) normal[id*3+k]=n[k];
    }
    near.push(...shared); far.push(...shared);
  }
  for (let i = 0; i < 4; i++)
    shoot(spine(0.86 + i * 0.022), rotation + i * 1.55, 0.16 + 0.095 * random(), 0.07 + 0.065 * random());
  // Solid-projected bark has no UV cut. Reuse the same index on both
  // sides of any socket that straddles the old cylindrical wrap.
  for(const indices of [near,far]) for(let i=0;i<indices.length;i++) {
    const source=seamCopies.get(indices[i]);
    if(source!==undefined && graft[source]===1) indices[i]=source;
  }
  let kept=0;
  for(let i=0;i<near.length;i+=3) if(!cutTriangles.has(i)) {
    near[kept++]=near[i]; near[kept++]=near[i+1]; near[kept++]=near[i+2];
  }
  near.length=kept;
  let radius = 0,
    bottom = Infinity,
    top = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    radius = Math.max(radius, Math.hypot(position[i], position[i + 2]));
    bottom = Math.min(bottom, position[i + 1]);
    top = Math.max(top, position[i + 1]);
  }
  return {
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    blade: new Float32Array(blade),
    stalk: new Float32Array(stalk),
    graft: new Float32Array(graft),
    tissue: new Float32Array(tissue),
    index: new Uint16Array([...near, ...far]),
    foliage: new Float32Array(foliage),
    radius,
    bottom,
    top,
    nearCount: near.length,
    farCount: far.length,
  };
}

export function highCanopySites(heightAt, noise, random, half, pathCover, waterLevel) {
  const instances = [];
  for (let i = 0; i < 2400; i++) {
    const x = (random() * 2 - 1) * 200,
      z = (random() * 2 - 1) * 200;
    const edge = Math.max(Math.abs(x), Math.abs(z)),
      stand = noise(x * 0.045 + 3, z * 0.045 - 11);
    if (edge < half - 12 || stand < 0.5 || (edge < half && stand < 0.73) || pathCover(x, z) > 0.01) continue;
    const y = heightAt(x, z);
    if (y < waterLevel(x, z) + 0.8 || y > 38 || Math.abs(y - heightAt(x + 2, z + 1)) > 2.6) continue;
    instances.push(x, y - 0.55, z, 4.8 + 9.8 * random() + stand * 3.3);
  }
  return { instances: new Float32Array(instances) };
}

// Group trunks by shape and position once. This instance list also places the
// real foliated shoots in the ground shelter bake and supplies the water reflection.
export function forestStands(localTrees, uplandTrees, isletTree, noise, random, groundAt) {
  const width = 16,
    clusters = new Map();
  const meshes = treeSeeds.map((seed, i) => highCanopyMesh(random(seed), i));
  const accents = [
    [-30, -3, 0.964],
    [10, -19, 0.929],
    [31, 3, 0.875],
    [1, 31, 0.843, 3.4], // the rose crown overhanging the south landing
  ];
  function plant(x, y, z, h, seed, islet = false) {
    const r = random(Math.floor(seed * 1e8) ^ 0x6a73);
    const colour = 0.74 * noise(x * 0.068 + 7, z * 0.068 - 12) + 0.26 * r();
    let hue = 0.12 + 0.6 * r();
    if (colour < 0.29) hue = 0.855 + 0.047 * r();
    else if (colour > 0.77) hue = 0.921 + 0.024 * r();
    else if (colour > 0.69) hue = 0.951 + 0.031 * r();
    for (const [cx, cz, pigment, radius = 9.49] of accents) {
      if ((x - cx) ** 2 + (z - cz) ** 2 < radius*radius) hue = pigment + 0.009 * (seed - 0.5);
    }
    if (islet) hue = 0.08;
    let form = Math.floor(r() * 3);
    if (hue >= 0.85 && hue < 0.91) {
      form = 1;
      h *= 1.2;
    }
    if (hue >= 0.91 && hue < 0.95) {
      form = 0;
      h *= 1.18;
    }
    const variant = islet ? 3 : form + (r() < 0.5 ? 3 : 0);
    const az = islet ? 2.73 : r() * 2 * Math.PI,
      spread = islet ? 1.23 : 0.86 + 0.38 * r();
    const ix = Math.floor(x / width),
      iz = Math.floor(z / width),
      key = [variant, ix, iz].join(',');
    let tile = clusters.get(key);
    if (!tile) {
      tile = {
        variant,
        x0: ix * width,
        z0: iz * width,
        y0: Infinity,
        y1: -Infinity,
        pad: 0,
        minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
        sites: [],
        styles: [],
        slopes: [],
      };
      clusters.set(key, tile);
    }
    const mesh = meshes[variant], c=Math.cos(az), s=Math.sin(az);
    let gx=0, gz=0;
    if (groundAt) {
      const r=Math.max(0.15,h*spread*0.10);
      gx=(groundAt(x+r,z)-groundAt(x-r,z))/(2*r);
      gz=(groundAt(x,z+r)-groundAt(x,z-r))/(2*r);
      // Fit the rim of this fluted trunk, including the downhill toe.
      y=groundAt(x,z);
      for(let k=0; k<3*rootSides; k+=3) {
        const dx=h*spread*(c*mesh.position[k]-s*mesh.position[k+2]);
        const dz=h*spread*(s*mesh.position[k]+c*mesh.position[k+2]);
        y=Math.min(y,groundAt(x+dx,z+dz)-gx*dx-gz*dz);
      }
      y-=0.045;
    }
    tile.sites.push(x,y,z,h);
    tile.styles.push(c,s,spread,hue);
    tile.slopes.push(gx,gz);
    tile.minX = Math.min(tile.minX, x); tile.maxX = Math.max(tile.maxX, x);
    tile.minZ = Math.min(tile.minZ, z); tile.maxZ = Math.max(tile.maxZ, z);
    tile.y0 = Math.min(tile.y0, y+h*mesh.bottom - h*0.23*spread*Math.hypot(gx,gz) - 0.12);
    tile.y1 = Math.max(tile.y1, y + h * (mesh.top + 0.18) + 0.12);
    tile.pad = Math.max(tile.pad, h * (mesh.radius * spread + 0.18) + 0.12);
  }
  for (let i = 0; i < localTrees.length; i += 5)
    plant(localTrees[i], localTrees[i + 1], localTrees[i + 2], localTrees[i + 4], localTrees[i + 3]);
  for (let i = 0; i < uplandTrees.length; i += 4) {
    const x = uplandTrees[i],
      z = uplandTrees[i + 2],
      f = x * 0.75488 + z * 0.56984;
    plant(x, uplandTrees[i + 1], z, uplandTrees[i + 3], f - Math.floor(f));
  }
  plant(...isletTree, true);
  const sites = [],
    styles = [],
    slopes = [],
    tiles = [];
  for (const tile of [...clusters.values()].sort((a, b) => a.variant - b.variant || a.z0 - b.z0 || a.x0 - b.x0)) {
    // The sorting grid batches instances, but its empty margins need neither
    // rendering nor the close mesh. Keep the full wind envelope around the roots.
    const { sites: local, styles: style, slopes: grade, minX, maxX, minZ, maxZ } = tile;
    tiles.push({ variant: tile.variant, start: sites.length / 4, count: local.length / 4,
      x0: minX, width: maxX-minX, z0: minZ, depth: maxZ-minZ, y0: tile.y0, y1: tile.y1, pad: tile.pad });
    sites.push(...local);
    styles.push(...style);
    slopes.push(...grade);
  }
  return { meshes, sites: new Float32Array(sites), styles: new Float32Array(styles), slopes: new Float32Array(slopes), tiles };
}

// Every vertex on a tree samples the ground fields at its trunk centre.
// Store that centre's tile once, in the same order as the instance buffer.
export function treeFieldTiles(sites, half, tileSize) {
  const across = Math.ceil(2 * half / tileSize);
  const cell = x => Math.max(0, Math.min(across - 1, Math.floor((x + half) / tileSize)));
  return Uint16Array.from({ length: sites.length / 4 }, (_, i) =>
    cell(sites[4*i]) + across * cell(sites[4*i+2]));
}

export function treeFieldMask(tiles, start, count, glow, ground) {
  const possible = (glow ? 1 : 0) | (ground ? 2 : 0);
  let mask = 0;
  for (let i=start; i<start+count && mask!==possible; i++) {
    const tile = tiles[i];
    if (glow && glow[tile]) mask |= 1;
    if (ground && ground[tile]) mask |= 2;
  }
  return mask;
}
