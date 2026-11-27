// Shared by terrain generation, water rendering, placement and wading. All distances are metres.
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const VALLEY_HALF = 64, WORLD_HALF = 128;
export const spring = { x: -18, z: -99, level: 5.5 };

// The last coordinate is the tread elevation. Each route joins the next at
// the same height. Their inner ends pick up a walk in the original valley.
export const rangeWalks = {
  headwaters: [[-12, -52, 5], [-16, -63, 7], [-18, -73, 7.7], [-26, -83, 7.4], [-34, -94, 6.9], [-37, -103, 7.5],
    [-47, -109, 9.8], [-62, -110, 12], [-74, -99, 13.8], [-86, -86, 14], [-96, -71, 12]],
  west: [[-49, 30, 7.6], [-58, 35, 8.7], [-70, 38, 9], [-82, 31, 8], [-93, 17, 6.8], [-101, 4, 6],
    [-105, -10, 6.2], [-97, -24, 7.6], [-90, -40, 9.4], [-99, -55, 11], [-96, -71, 12]],
  south: [[36, 43, 7], [43, 53, 8.3], [49, 68, 9], [56, 81, 11.4], [45, 94, 13.6], [30, 104, 14.9],
    [11, 111, 15.8], [-10, 106, 14], [-31, 94, 11], [-52, 86, 10], [-69, 72, 10], [-82, 55, 9.1], [-82, 31, 8]],
  east: [[39, -29, 7.4], [50, -31, 8.3], [63, -29, 9.8], [75, -38, 12], [86, -45, 15],
    [100, -39, 18], [109, -23, 21], [112, -5, 22.4], [105, 15, 20], [92, 32, 16.5],
    [78, 44, 14.5], [71, 63, 12.8], [56, 81, 11.4]],
};

function springRadius(x, z) {
  const dx = (x - spring.x) / 17.5, dz = (z - spring.z) / 12;
  return Math.hypot(dx + 0.12 * Math.sin(dz * 3), dz) + 0.06 * Math.sin(dx * 4 + dz * 2);
}

export const summit = [-41, -35];
const hills = [
  // centre, footprint radii, prominence, spur direction
  [...summit, 33, 32, 16.9, 0.7],
  [-46, 16, 11, 19, 3.8, 1.3], [-38, 24, 11, 13, 2.3, 0.3],
  [34, 39, 19, 15, 4.4, 0.4], [44, 37, 13, 10, 2.1, 1.7],
  [11, -44, 11, 16, 6.8, 0.8],
  [-21, 47, 12, 10, 4.8, 2.1],
];
// Switch back across the sunward face, pausing on two shoulders before the crown.
export const trail = [[-15, -21, 1.65], [-20, -18, 2.6], [-27, -16, 4.1], [-35, -15, 5.8],
  [-42, -17, 7.5], [-45, -20, 8.0], [-38, -22, 9.3], [-31, -23, 10.6], [-26, -26, 11.7],
  [-25, -30, 12.0], [-29, -34, 13.4], [-35, -34, 14.9], [-39, -30, 16.0], [-44, -27, 16.8],
  [-48, -29, 17.9], [-49, -35, 19.0], [-46, -38, 19.7], [...summit, 19.9]];
export const valleyWalks = {
  fern: [[-32, 4, 1], [-36, 7, 1.8], [-40, 10, 2.8], [-41, 14, 3.9], [-40, 18, 4.6], [-42, 22, 5.5], [-46, 25, 6.3], rangeWalks.west[0]],
  terrace: [[20, 31, 1.3], [25, 33, 2.8], [28, 37, 4.4], [30, 42, 5.7], rangeWalks.south[0], [40, 43, 7.7], [43, 39, 8.3], [40, 36, 7.6], [35, 35, 6.1], [30, 36, 4.9], [28, 37, 4.4]],
  shelf: [[19, -11, 0.8], [23, -13, 1.9], [27, -16, 3.3], [29, -20, 4.8], [28, -24, 5.7], [30, -28, 6.3], [34, -30, 7.0], rangeWalks.east[0]],
  springSpur: [[34, -30, 7], [31, -37, 7.2], [24, -39, 6.1], [20, -44, 6.6], [17, -50, 7.6], [12, -51, 8], [11, -44, 8.5]],
  southKnoll: [[-32, 4, 1], [-35, 0, 1.2], [-39, 2, 2.4], [-45, 9, 3.8], [-49, 18, 5.5], [-49, 30, 7.6]],
  heath: [[-49, 30, 7.6], [-44, 36, 7], [-36, 41, 6.5], [-31, 48, 7.1], [-25, 51, 7.7], [-21, 47, 8.0]],
};
// Low, clear pockets beside the tread. The last two values describe a seat's
// long and short axes of its level centre and gently blended shoulders.
export const overlooks = [
  [-47, -21, 8.0, 3.3, 2.4], [-22, -29, 12.0, 3.4, 2.5], [-41, -35, 19.9, 4.0, 3.0],
  [-43, 15, 4.0, 2.6, 2.0], [45, 39, 8.3, 3.0, 2.3], [35, -32, 7.0, 2.6, 2.3],
  [11, -44, 8.5, 3.1, 2.2], [-21, 47, 8.0, 3.1, 2.3], [-100, -55, 11, 3.2, 2.4],
  [14, 113, 15.8, 3.3, 2.5], [115, -5, 22.4, 3.2, 2.5], [-87, -88, 14, 2.9, 2.1],
];
// Terrain, grazing cover and tree placement all query these treads. Index only
// segments that can affect each eight-metre square, including room for boulders.
const reach = 7, binWidth = 8, binStride = 2 * Math.ceil((WORLD_HALF + reach) / binWidth) + 1;
const restBins = new Map();
for (const seat of overlooks) {
  const [x, z,, rx, rz]=seat;
  for (let j=Math.floor((z-1.5*rz)/binWidth); j<=Math.floor((z+1.5*rz)/binWidth); j++) {
    for (let i=Math.floor((x-1.5*rx)/binWidth); i<=Math.floor((x+1.5*rx)/binWidth); i++) {
      const key=j*binStride+i;
      if (!restBins.has(key)) restBins.set(key, []);
      restBins.get(key).push(seat);
    }
  }
}
export function inRestArea(x, z, radius=0) {
  // Boulders and crowns need room for their entire footprint at camp.
  for (const [cx, cz,, rx, rz] of overlooks) {
    if (Math.abs(x-cx) < rx+radius && Math.abs(z-cz) < rz+radius &&
        Math.hypot((x-cx)/(0.75*rx+radius),(z-cz)/(0.75*rz+radius)) < 1) return true;
  }
  return false;
}
function restSurface(x, z, base, cover) {
  const seats=restBins.get(Math.floor(z/binWidth)*binStride+Math.floor(x/binWidth));
  if (seats) for (const [cx, cz, y, rx, rz] of seats) {
    const r=Math.hypot((x-cx)/rx,(z-cz)/rz);
    if (r<1.5) return cover ? 0.78*(1-smooth(0.62, 1.15, r)) : base+(y-base)*(1-smooth(0.56, 1.16, r));
  }
  return base;
}
const trailBins = new Map();
for (const points of [trail, ...Object.values(valleyWalks), ...Object.values(rangeWalks)]) {
  for (let i = 1; i < points.length; i++) {
    const [x, z, y] = points[i - 1], [bx, bz, by] = points[i], dx = bx - x, dz = bz - z;
    const segment = { x, z, dx, dz, y, dy: by - y, length2: dx * dx + dz * dz };
    for (let j = Math.floor((Math.min(z, bz) - reach) / binWidth); j <= Math.floor((Math.max(z, bz) + reach) / binWidth); j++) {
      for (let k = Math.floor((Math.min(x, bx) - reach) / binWidth); k <= Math.floor((Math.max(x, bx) + reach) / binWidth); k++) {
        const key = j * binStride + k;
        if (!trailBins.has(key)) trailBins.set(key, []);
        trailBins.get(key).push(segment);
      }
    }
  }
}

function nearby(x, z) {
  if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return;
  return trailBins.get(Math.floor(z / binWidth) * binStride + Math.floor(x / binWidth));
}
function alongSegment(s, x, z) {
  return Math.max(0, Math.min(1, ((x - s.x) * s.dx + (z - s.z) * s.dz) / s.length2));
}
export function trailDistance(x, z) {
  const segments = nearby(x, z);
  if (!segments) return reach;
  let nearest2 = reach * reach;
  for (const s of segments) {
    const u = alongSegment(s, x, z);
    const dx = x - s.x - u * s.dx, dz = z - s.z - u * s.dz;
    nearest2 = Math.min(nearest2, dx * dx + dz * dz);
  }
  return Math.sqrt(nearest2);
}

function uplandHeight(x, z, base, edge) {
  const blend = smooth(49, 65, edge) * (1 - smooth(128, 158, edge));
  if (!blend) return base;
  const west = 1 - smooth(0.30, 1, Math.hypot((x + 98) / 31, (z + 4) / 60));
  const east = 1 - smooth(0.20, 1, Math.hypot((x - 106) / 39, (z + 12) / 62));
  const south = 1 - smooth(0.10, 1, Math.hypot((x - 8) / 76, (z - 102) / 33));
  let y = base - west * (6.5 + 1.7 * Math.cos(z * 0.13)) + south * (3.4 + 1.65 * Math.sin(x * 0.13 + z * 0.08));
  const strata = x * 0.76 + z * 0.35;
  y += east * (4.3 + 2.4 * Math.sin(strata * 0.12) + 1.7 * smooth(-0.18, 0.18, Math.sin(strata * 0.30)));
  return base + (y - base) * blend;
}
function gradeWalks(x, z, base) {
  const segments = nearby(x,z);
  if (!segments) return base;
  let nearest = reach, total = 0, height = 0;
  for (const s of segments) {
    const u = alongSegment(s,x,z), dx = x-s.x-s.dx*u, dz = z-s.z-s.dz*u;
    const d2 = dx*dx+dz*dz;
    if (d2 >= reach*reach) continue;
    const d = Math.sqrt(d2), grade = s.y + u*s.dy;
    if (d < 0.00001) return grade;
    const w = (1-smooth(1.3,reach,d)) / (d2*d2);
    nearest = Math.min(nearest,d); total += w; height += w*grade;
  }
  return total ? base + (height/total-base)*(1-smooth(1.25,reach,nearest)) : base;
}
export function trailCover(x, z) {
  const distance = trailDistance(x,z);
  const seat = restSurface(x,z,0,true);
  if (distance >= 2) return seat;
  const verge = 0.18*Math.sin(x*1.3+z*0.87) + 0.14*Math.sin(z*2.17-x*0.61);
  return Math.max(seat,1-smooth(0.57,1.49+verge,distance));
}

export function riverX(z) {
  const lower = -5 + 3.4 * Math.sin(z * 0.13) + 1.4 * Math.sin(z * 0.29 + 0.8);
  return lower + (spring.x - lower) * smooth(66, 100, -z);
}
function riverDistance(x, z) {
  return Math.hypot(x - riverX(Math.max(spring.z, Math.min(-8, z))), Math.max(0, spring.z - z, z + 8));
}
// At the bedrock lip the upper channel spills forward of the cut face.
export const falls = { lip: -46.6, reach: 1.55, halfWidth: 1.76 };
function channelGrade(z) {
  return Math.min(spring.level, Math.max(0,-z-12)*0.055 + 1.15*(1-smooth(-49,-44,z)) + 0.65*smooth(65,82,-z));
}
const upperReach = (z, grade) => Math.max(grade,3.92+0.008*(falls.lip-z));
const lowerReach = (z, grade) => Math.min(grade,1.22+0.012*(falls.lip-z));
export function riverLevel(z) {
  const grade=channelGrade(z);
  if (z < -67 || z > -29) return grade;
  const upper=upperReach(z,grade), lower=lowerReach(z,grade);
  return upper+(lower-upper)*smooth(falls.lip,falls.lip+0.48,z);
}
// Both lakes are still. Water and drifting impacts pick up the current below the spring's outlet.
export function riverFlow(z, level) {
  return smooth(0.02, 0.65, level) * smooth(spring.z + 10, spring.z + 20, z);
}
export function waterLevel(x, z, shapedBanks=true) {
  if (z < -80 && z > -120 && x > -45 && x < 10 && springRadius(x, z) < 1.40) return spring.level;
  if (x < -26 || x > 8 || z < spring.z || z > -8) return 0;
  if (riverDistance(x,z) >= (shapedBanks ? 5.45 : 3.6)) return 0;
  return shapedBanks ? riverLevel(z) : channelGrade(z);
}
function joinBank(base, bed, bankTop, d, z) {
  const bank=bed+(Math.min(base,bed)-bed)*smooth(-18,-14,z);
  return base+(bank-base)*(1-smooth(bankTop,7.5,d))*smooth(spring.z,spring.z+10,z);
}
export function terrainHeight(x, z, base, shapedBanks=true) {
  for (const [cx, cz, rx, rz, height, phase] of hills) {
    if (Math.abs(x - cx) > rx || Math.abs(z - cz) > rz) continue;
    const dx = (x - cx) / rx, dz = (z - cz) / rz, r = Math.hypot(dx, dz);
    const spur = Math.sin(3 * Math.atan2(dz, dx) + phase + r) * 0.12 * Math.sin(Math.PI * Math.min(1, r));
    base += height * (1 - smooth(0.05, 1, r)) * (1 + spur);
  }
  const radius = Math.hypot(x - summit[0], z - summit[1]);
  if (radius < 34) {
    // Three radiating buttresses and an exposed bench break up the lookout's round profile.
    // The trail and overlook grades below flatten the tread and summit.
    const bearing = Math.atan2(z - summit[1], x - summit[0]);
    const ridge = Math.cos(bearing * 3 + radius * 0.075) * 0.72 + Math.cos(bearing * 7 - 0.5) * 0.28;
    const flank = smooth(2, 10, radius) * (1 - smooth(17, 33, radius));
    const strata = base + (x - summit[0]) * 0.16 - (z - summit[1]) * 0.08;
    base += flank * (2.15 * ridge + 1.0 * smooth(7, 9.8, strata) - 1.0 * smooth(13, 16.5, strata));
  }
  const edge = Math.max(Math.abs(x), Math.abs(z));
  if (edge > 49 && edge < 158) base = uplandHeight(x, z, base, edge);
  if (edge <= WORLD_HALF) {
    // The outer treads cross existing terraces. Within the old valley the
    // clearing is the destination and gets the final, level cut.
    if (edge > 56) base = restSurface(x,z,base,false);
    base = gradeWalks(x,z,base);
    if (edge <= 56) base = restSurface(x,z,base,false);
  }
  if (x < -49 || x > 13 || z < -122 || z > -4) return base;
  if (z < -77) {
    const r = springRadius(x, z);
    const basin = spring.level - 1.9 + 2.95 * smooth(0.28, 1.18, r);
    base += (basin - base) * (1 - smooth(1.06, 1.62, r));
  }
  const d=riverDistance(x,z), level=(shapedBanks?riverLevel:channelGrade)(Math.max(spring.z,z));
  // A shallow gravel ford just upstream of the lake connects both sides of
  // the watershed. Its longer banks can be climbed straight out of the water.
  const ford = 1 - smooth(1.3, 4.6, Math.abs(z + 25));
  if (!shapedBanks) {
    // Established grove seeds were planted on this terrain. Reusing its
    // acceptance mask prevents an edit at the river from reseeding distant trees.
    const top=3.4+0.7*ford;
    const bed=level-0.58+0.26*ford+(1.65-0.30*ford)*smooth(1.2-0.6*ford,top,d);
    return joinBank(base,bed,top,d,z);
  }
  const pool = smooth(falls.lip+0.55, falls.lip+1.6, z) * (1-smooth(falls.lip+3, falls.lip+7, z));
  // The deep cut ends below water. Gravel fans rise gently through the
  // waterline and widen on alternate bends, before joining the meadow.
  const side = Math.sign(x-riverX(z));
  const bar = side*(0.33*Math.sin(z*0.19+0.7)+0.15*Math.sin(z*0.46));
  const bankTop = 5.45+bar, depth = 0.58-0.26*ford+0.53*pool;
  const sill = smooth(0.20+0.10*pool,1.66+0.14*pool+0.90*bar,d);
  let bed = level-depth+(depth-0.24)*sill+1.31*smooth(1.56+bar,bankTop,d);
  const run=z-falls.lip;
  if (run > -4 && run < 8) {
    // An eroded sill runs across the channel. Its downstream edge recedes
    // behind the curtain, then curves out into two much broader bank shelves.
    const grade=channelGrade(z);
    const head=upperReach(z,grade), tail=lowerReach(z,grade);
    const lane=x-riverX(z);
    const bank=smooth(1.18,4.15,d), right=smooth(-1.4,1.4,lane);
    const plan=0.16*Math.sin(1.37*lane+0.42)+0.11*Math.sin(2.10*lane);
    const shoulder=bank*(0.70+0.86*right);
    const start=-0.20+0.59*plan-0.56*bank+shoulder;
    const end=1.10+0.64*plan+(3.20+0.88*right)*bank+shoulder;
    const shelf=head+(tail-head)*smooth(start,end,run);
    const ledge=smooth(-4,-1.7,run)*(1-smooth(6.1,8,run));
    // Stone shoulders hold the upper water inside the two spillways. The
    // gravel submerged at their feet opens out into the normal lower banks.
    const flank=smooth(1.23,1.99,d)*(1-smooth(3.25,4.95,d));
    const bedrock=(0.79+0.14*Math.sin(lane*1.7))*flank
      *smooth(-2.8,-0.6,run)*(1-smooth(0.4,3.45+0.35*right,run));
    const lip=0.36*(1-smooth(1.22,2.03,d))*smooth(-1.85,-0.5,run)*(1-smooth(0,0.95,run));
    const gravelShelf=smooth(1.10,2.78,run)*(1-smooth(3.72,4.73,d));
    bed+=((shelf-level)*ledge+bedrock+lip)*(1-gravelShelf);
  }
  // At the mouth, the channel opens into the existing lake basin.
  return joinBank(base,bed,bankTop,d,z);
}
