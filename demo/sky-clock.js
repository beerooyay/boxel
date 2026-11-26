// The ordinary solar clock takes just over five minutes for a full orbit.
export const DAY_RATE = 0.02;
export const TIMELAPSE_SECONDS = 28;
const RAMP = 2;
const ORBIT = 2 * Math.PI / DAY_RATE;
const EXTRA_RATE = (ORBIT - TIMELAPSE_SECONDS) / (TIMELAPSE_SECONDS - RAMP);

// Integral of smoothstep over the acceleration ramp. Integrating the
// speed keeps the same solar angle and cloud travel at any display rate.
function rampTravel(seconds) {
  const t = seconds / RAMP;
  return RAMP * t ** 3 * (1 - 0.5 * t);
}

export function timelapseTravel(seconds) {
  const t = Math.max(0, Math.min(TIMELAPSE_SECONDS, seconds));
  const endRamp = TIMELAPSE_SECONDS - RAMP;
  const boosted = t < RAMP ? rampTravel(t)
    : t <= endRamp ? t - RAMP / 2
    : TIMELAPSE_SECONDS - RAMP - rampTravel(TIMELAPSE_SECONDS - t);
  return t + EXTRA_RATE * boosted;
}
