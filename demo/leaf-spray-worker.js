import { makeLeafSprays } from './leaf-spray.js';

self.onmessage = ({ data: { seed, tile } }) => {
  let s = seed >>> 0;
  const sprays = makeLeafSprays(() => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296, tile);
  self.postMessage(sprays, sprays.levels.map((level) => level.bytes.buffer));
};
