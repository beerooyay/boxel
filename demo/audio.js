// Tarn's sound is made as it plays, with no recordings. Wind is shaped noise that swells with the gusts; the river and
// the lake are band-passed noise that rise as you near them and sit left or right of where you face; rain hisses in a
// storm and thunder rolls in after its flash, late by the time sound takes to cross the valley; crickets keep time at
// night; and thrown stones sound where they land.

const SPEED_OF_SOUND = 343;

export function createAudio() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  const ctx = new Context();
  const master = ctx.createGain();
  master.gain.value = 0.85;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10; limiter.ratio.value = 6;
  master.connect(limiter).connect(ctx.destination);

  // Two seconds of pink noise, shared by every voice; each voice starts at its own offset so none line up.
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  {
    const d = noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    }
  }
  const source = (loop) => {
    const s = ctx.createBufferSource();
    s.buffer = noise; s.loop = loop;
    return s;
  };
  const filter = (type, frequency, q) => {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = frequency; f.Q.value = q;
    return f;
  };

  // the continuous beds: each a looping noise through its own filter, gain and pan
  const bed = (type, frequency, q) => {
    const s = source(true), f = filter(type, frequency, q), g = ctx.createGain(), pan = ctx.createStereoPanner();
    g.gain.value = 0;
    s.connect(f).connect(g).connect(pan).connect(master);
    s.start(0, Math.random() * 2);
    return { f, g, pan };
  };
  const wind = bed('lowpass', 480, 0.7), whistle = bed('bandpass', 1500, 4), river = bed('bandpass', 850, 0.6);
  const lake = bed('lowpass', 300, 0.9), rain = bed('highpass', 1700, 0.4);

  const smooth = (param, value, seconds = 0.25) => param.setTargetAtTime(value, ctx.currentTime, seconds);
  // a burst of noise through a filter, with a fast attack and the given decay
  const burst = ({ type, frequency, q, gain, decay, pan = 0, at = ctx.currentTime, attack = 0.004 }) => {
    const s = source(false), f = filter(type, frequency, q), g = ctx.createGain(), p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    s.connect(f).connect(g).connect(p).connect(master);
    s.start(at, Math.random() * 1.5, attack + decay + 0.05);
    return f;
  };
  // a falling tone: the plop under a splash, the knock of a stone
  const tone = ({ from, to, gain, decay, pan = 0, at = ctx.currentTime, type = 'sine' }) => {
    const o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
    o.type = type; o.frequency.setValueAtTime(from, at); o.frequency.exponentialRampToValueAtTime(to, at + decay);
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    o.connect(g).connect(p).connect(master);
    o.start(at); o.stop(at + decay + 0.05);
  };

  let nextChirp = 0, muted = false;
  return {
    resume() { if (ctx.state !== 'running') ctx.resume().catch(() => {}); },
    suspend() { if (ctx.state === 'running') ctx.suspend().catch(() => {}); },
    capture() {
      const output = ctx.createMediaStreamDestination();
      limiter.connect(output);
      return { track: output.stream.getAudioTracks()[0], disconnect: () => limiter.disconnect(output) };
    },
    toggle() { muted = !muted; smooth(master.gain, muted ? 0 : 0.85, 0.08); return !muted; },
    /** Once a frame: the weather, the night, and how far the water is, with its bearing (radians, 0 ahead, + right). */
    update({ wind: strength, gust, height, night, storm, river: [riverDistance, riverBearing], lake: [lakeDistance, lakeBearing] }) {
      const g = Math.max(0, gust);
      smooth(wind.g.gain, 0.035 + 0.075 * strength * (0.55 + 0.45 * g) + 0.11 * storm);
      smooth(wind.f.frequency, 380 + 380 * g + 300 * storm, 0.6);
      smooth(whistle.g.gain, 0.006 * g * strength * (1 + Math.max(0, height - 8) / 6));
      smooth(river.g.gain, 0.15 / (1 + riverDistance / 3.5));
      smooth(river.pan.pan, Math.sin(riverBearing) * Math.min(1, riverDistance / 6), 0.15);
      smooth(lake.g.gain, 0.09 / (1 + lakeDistance / 2.5));
      smooth(lake.pan.pan, Math.sin(lakeBearing) * Math.min(1, lakeDistance / 5), 0.15);
      smooth(rain.g.gain, 0.16 * storm, 0.8);
      // crickets: a few quick pulses near 4.4 kHz, now and then, on warm quiet nights
      const now = ctx.currentTime, quiet = night * (1 - storm);
      if (quiet > 0.3 && now > nextChirp) {
        nextChirp = now + 0.35 + Math.random() * (1.4 - quiet);
        const pitch = 4100 + Math.random() * 700, pan = Math.random() * 1.6 - 0.8, level = 0.012 * quiet * (0.4 + Math.random() * 0.6);
        for (let k = 0; k < 3; k++) tone({ from: pitch, to: pitch * 0.98, gain: level, decay: 0.035, pan, at: now + k * 0.055 });
      }
    },
    /** A stone landing in water or on the ground, `distance` metres off at `bearing`. */
    splash(water, distance, bearing) {
      const near = 1 / (1 + distance / 7), pan = Math.sin(bearing);
      if (water) {
        burst({ type: 'lowpass', frequency: 1800, q: 0.6, gain: 0.5 * near, decay: 0.45, pan });
        tone({ from: 320, to: 95, gain: 0.3 * near, decay: 0.18, pan });
      } else {
        burst({ type: 'bandpass', frequency: 2600, q: 1.2, gain: 0.35 * near, decay: 0.08, pan });
      }
    },
    /** Thunder from a strike `distance` metres off at `bearing`: a crack when it is close, then the roll. */
    thunder(distance, bearing) {
      const at = ctx.currentTime + distance / SPEED_OF_SOUND, pan = Math.sin(bearing) * 0.7, far = 1 / (1 + distance / 140);
      if (distance < 70) burst({ type: 'highpass', frequency: 900, q: 0.5, gain: 0.55 * far, decay: 0.22, pan, at });
      // the roll is a few overlapping low rumbles, each a little later and darker
      for (let k = 0; k < 4; k++) {
        const f = burst({ type: 'lowpass', frequency: 220 - k * 35, q: 0.9, gain: (0.85 - k * 0.15) * far, decay: 2.2 + k * 0.7, pan, at: at + 0.05 + k * (0.25 + Math.random() * 0.35), attack: 0.08 + k * 0.05 });
        f.frequency.exponentialRampToValueAtTime(60, at + 3 + k);
      }
    },
  };
}
