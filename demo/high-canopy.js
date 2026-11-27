// The valley and the outer forest grow from the same fluted trunk and alternating
// broadleaf shoots. Templates change the branching habit, instances set size and pigment.
const habits = [
  { fork: 0.26, spread: 0.49, lift: 0.3, lean: 0.32, taper: 0.44, shoulder: 0.02 }, // spreading
  { fork: 0.19, spread: 0.37, lift: 0.17, lean: 0.06, taper: 0.78, shoulder: 0.05 }, // upright
  { fork: 0.32, spread: 0.37, lift: 0.27, lean: 0.13, taper: 0.46, shoulder: 0.32 }, // rounded
];
const rootSides = 12;
const treeSeeds = [9942, 2113, 8605, 981, 7139, 3029];

export function highCanopyMesh(random, variant = 0) {
  const habit = habits[variant % habits.length],
    foliage = [];
  const position = [],
    normal = [],
    tissue = [],
    blade = [],
    stalk = [],
    near = [],
    far = [];
  const tau = 2 * Math.PI;
  function vertex(p, n, shade, u = 0, side = 0, root = p, angle = 0) {
    position.push(...p);
    normal.push(...n);
    tissue.push(shade);
    blade.push(u, side, angle);
    stalk.push(...root);
    return tissue.length - 1;
  }
  function normalise(x, y, z) {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  }
  function mix(a, b, t) {
    return a.map((v, i) => v + t * (b[i] - v));
  }
  function extend(p, angle, reach, rise) {
    return [p[0] + Math.cos(angle) * reach, p[1] + rise, p[2] + Math.sin(angle) * reach];
  }
  // Each limb has its own axis. Broad root flutes die out before the trunk forks.
  function wood(points, radii, sides, farRings, buttress = false) {
    const start = tissue.length, ring = sides + 1, spin = random() * tau;
    const flares = Array.from({ length: sides }, () => 0.18 + 0.82 * random());
    const girth = tau * radii[1];
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
      for (let i = 0; i <= sides; i++) {
        const theta = spin + (i % sides) * tau / sides;
        const n = across.map((v,j) => v * Math.cos(theta) + binormal[j] * Math.sin(theta));
        const ridge = flares[i % sides];
        const flare = buttress && k < 2 ? (k === 0 ? 1.48 : 0.28) * ridge ** 2 : 0;
        const radius = radii[k] * (0.87 + 0.23 * ridge + flare);
        const surface = p.map((v,j) => v+radius*n[j]);
        if (buttress && k===0) surface[1]=0;
        vertex(surface,n,-1-p[1],i/sides,arc,axis,girth);
      }
    }
    function connect(indices, lower, upper, facets) {
      for (let j = 0; j < facets; j++) {
        const left = Math.round(j*sides/facets), right = Math.round((j+1)*sides/facets);
        const lo = start + lower*ring, hi = start + upper*ring;
        indices.push(lo+left,lo+right,hi+left, lo+right,hi+right,hi+left);
      }
    }
    for (let k = 1; k < points.length; k++) connect(near,k-1,k,sides);
    for (let k = 1; k < farRings.length; k++)
      connect(far,farRings[k-1],farRings[k],buttress ? 7 : 4);
    if (!farRings.length) return; // the terminal shoot already tapers to a point
    const last = points.length - 1, limb = normalise(...points[last].map((v,i) => v-points[last-1][i]));
    const tip = vertex(points[last].map((v,i) => v + limb[i]*radii[last]*1.8),
      limb, -1-points[last][1], 0.5, arc+radii[last], across, girth);
    for (let i = 0; i < sides; i++) near.push(start+last*ring+i,start+last*ring+i+1,tip);
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

  function shoot(root, angle, reach, lift) {
    const turn = (random() - 0.5) * 0.86;
    const mid = extend(root, angle, reach * 0.54, lift * 0.76 + 0.02);
    const tip = extend(mid, angle + turn, reach * 0.46, lift * 0.24 - 0.014);
    wood([root, mid, tip], [0.0064, 0.0034, 0.0002], 4, []);
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
    [0, 0.09, 0.25, 0.42, 0.63, 0.8, 0.94].map(spine),
    [0.065, 0.047, 0.04, 0.033, 0.024, 0.015, 0.004],
    rootSides, [0,1,3,5,6], true,
  );
  const forks = 7 + Math.floor(2 * random()),
    rotation = tau * random();
  for (let i = 0; i < forks; i++) {
    const t = i / (forks - 1),
      a = rotation + i * 2.39996 + (random() - 0.5) * 0.72;
    const base = spine(habit.fork + (0.81 - habit.fork) * t);
    const profile = 1 - habit.taper * t + habit.shoulder * Math.sin(Math.PI * t);
    const reach = habit.spread * profile * (0.82 + 0.37 * random());
    const lift = habit.lift * (1 - 0.53 * t) * (0.76 + 0.4 * random()),
      turn = (random() - 0.5) * 1.0;
    // A swollen collar grows out of the trunk into a load-bearing crook.
    // The branch rises close to the trunk, reaches sideways, then lifts its fork.
    const collar = extend(base, a-0.12*turn, reach*0.13, lift*0.26);
    const elbow = extend(collar, a, reach*0.34, lift*0.31);
    const wrist = extend(elbow, a+turn*0.62, reach*0.29, lift*0.12);
    const hand = extend(wrist, a+turn, reach*0.24, lift*0.31);
    const baseRadius = 0.030 - 0.014*t;
    wood([base, collar, elbow, wrist, hand],
      [baseRadius*1.27, baseRadius*0.94, baseRadius*0.62, baseRadius*0.33, 0.0032], 7, [0,2,4]);
    shoot(elbow, a - 0.82, reach * 0.74, 0.055 + 0.075 * random());
    shoot(wrist, a + turn + 0.89, reach * 0.69, 0.034 + 0.08 * random());
    shoot(hand, a + turn, 0.15 + 0.055 * random(), 0.015 - 0.066 * random());
  }
  for (let i = 0; i < 4; i++)
    shoot(spine(0.86 + i * 0.022), rotation + i * 1.55, 0.16 + 0.095 * random(), 0.07 + 0.065 * random());
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
  ];
  function plant(x, y, z, h, seed, islet = false) {
    const r = random(Math.floor(seed * 1e8) ^ 0x6a73);
    const colour = 0.74 * noise(x * 0.068 + 7, z * 0.068 - 12) + 0.26 * r();
    let hue = 0.12 + 0.6 * r();
    if (colour < 0.29) hue = 0.855 + 0.047 * r();
    else if (colour > 0.77) hue = 0.921 + 0.024 * r();
    else if (colour > 0.69) hue = 0.951 + 0.031 * r();
    for (const [cx, cz, pigment] of accents) {
      if ((x - cx) ** 2 + (z - cz) ** 2 < 90) hue = pigment + 0.009 * (seed - 0.5);
    }
    if (islet) hue = 0.41;
    let form = Math.floor(r() * 3);
    if (hue >= 0.85 && hue < 0.91) {
      form = 1;
      h *= 1.2;
    }
    if (hue >= 0.91 && hue < 0.95) {
      form = 0;
      h *= 1.18;
    }
    if (islet) form = 0;
    const variant = form + (r() < 0.5 ? 3 : 0);
    const az = islet ? 2.4 : r() * 2 * Math.PI,
      spread = islet ? 1.35 : 0.86 + 0.38 * r();
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
    const { sites: local, styles: style, slopes: grade, ...bounds } = tile;
    tiles.push({ ...bounds, start: sites.length / 4, count: local.length / 4 });
    sites.push(...local);
    styles.push(...style);
    slopes.push(...grade);
  }
  return { meshes, sites: new Float32Array(sites), styles: new Float32Array(styles), slopes: new Float32Array(slopes), tiles, width };
}
