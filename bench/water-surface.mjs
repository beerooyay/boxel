// Pass a file from another revision to replay identical inputs. Timings cover
// JS simulation and texture packing. The GL stub counts submitted rectangles
// and bytes, excluding browser, driver, GPU and display latency.
import { pathToFileURL } from 'node:url';

const source = process.argv[2] ? pathToFileURL(process.argv[2]) : new URL('../demo/water-surface.js', import.meta.url);
const { basinGrid, createWaterSurface, waterTexture } = await import(source);
const water = createWaterSurface(basinGrid, (x, z, bed) => {
  bed.depth = 1.6 - Math.hypot(x / 23, z / 30);
  bed.vx = 0.1;
  bed.vz = 0.05;
  bed.level = 0;
});
let payloadBytes = 0, uploads = 0;
const gl = {
  TEXTURE0: 0,
  createTexture() {}, activeTexture() {}, bindTexture() {}, texStorage3D() {}, texParameteri() {}, pixelStorei() {},
  texSubImage3D(_target, _level, _x, _y, _layer, width, height, layers) {
    payloadBytes += width * height * layers * 4;
    uploads++;
  }
};
const uploadWaves = waterTexture(gl, water, 28);
const hull = { halfLength: 0.48, halfWidth: 0.21, draft: 0.42 };
const dt = 1 / 30, warmup = 301, ticks = 1500;
const simulation = [], packing = [], total = [];
let checksum = 0;
for (let tick = 0; tick < ticks; tick++) {
  if (tick === warmup) payloadBytes = uploads = 0;
  const time = tick * dt;
  const x = 12 + 6 * Math.sin(0.37*time), z = 3 + 4 * Math.sin(0.6*time);
  const vx = 2.22 * Math.cos(0.37*time), vz = 2.4 * Math.cos(0.6*time);
  const start = performance.now();
  water.swim(x, z, vx, vz, dt, hull);
  for (let limb = 0; limb < 5; limb++) {
    water.pressure(x + (limb%2-0.5)*0.22, z + (limb-2)*0.33, vx, vz, dt, 0.07, 0.07, 0.018);
  }
  if (tick % 120 === 0) water.touch(0, 2, 0.85, 0.2);
  const contactsDone = performance.now();
  water.advance(dt, 0.05, 0.01);
  const simulated = performance.now();
  uploadWaves();
  const end = performance.now();
  checksum += water.sample(14, 5).height;
  if (tick < warmup) continue;
  simulation.push(simulated - contactsDone);
  packing.push(end - simulated);
  total.push(end - start);
}

function quantiles(samples) {
  samples.sort((a, b) => a - b);
  const at = fraction => Number(samples[Math.floor(fraction*samples.length)].toFixed(3));
  return { median: at(0.5), p95: at(0.95) };
}
console.log(JSON.stringify({
  source: source.href, ticks: total.length,
  simulationMs: quantiles(simulation), packingMs: quantiles(packing), totalMs: quantiles(total),
  bytesPerTick: Math.round(payloadBytes / total.length),
  uploadsPerTick: Number((uploads / total.length).toFixed(2)), checksum
}, null, 2));
