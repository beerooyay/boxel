// Movement uses metres and seconds. The rendered skeleton consumes the same
// heading and flight phase as the collision body, independently of the camera.
export const JUMP_HEIGHT = 1.10, GRAVITY = 12.4;
const launchSpeed = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
export const jumpDuration = 2 * launchSpeed / GRAVITY;

export function requestJump(player) {
  if (!player.grounded) return false;
  player.grounded = false;
  player.vy = launchSpeed;
  player.flight = 0;
  return true;
}

export function advanceFlight(player, ground, dt) {
  const next = player.y + (player.vy - 0.5 * GRAVITY * dt) * dt;
  player.vy -= GRAVITY * dt;
  player.flight += dt;
  if (next <= ground && player.vy <= 0) {
    player.y = ground;
    player.vy = 0;
    player.grounded = true;
    return true;
  }
  player.y = Math.max(ground, next);
  return false;
}

export function steerFox(pose, mx, forward, cameraYaw, sprint, dt, airborne) {
  const strength = Math.min(1, Math.hypot(mx, forward));
  const reverse = forward < -0.24 && -forward > Math.abs(mx)*0.9;
  pose.backing = reverse && !sprint;
  // When backing, the fox keeps its own heading even if the camera orbits.
  // Lateral input steers the haunches. Commit a running about-face once per press.
  if (reverse && sprint) pose.reverseYaw ??= pose.yaw + Math.PI;
  else pose.reverseYaw = null;
  let desired = cameraYaw + Math.atan2(mx, forward);
  if (pose.backing) desired = pose.yaw - 0.42*mx;
  else if (pose.reverseYaw !== null) desired = pose.reverseYaw + Math.atan2(-mx,-forward);
  const error = strength > 0.04 ? Math.atan2(Math.sin(desired-pose.yaw), Math.cos(desired-pose.yaw)) : 0;
  // Bleed speed in a tight switchback. The paws can step through the turn
  // while the hindquarters catch up and the chest starts the new heading.
  const rate = airborne ? 1.7 : pose.backing ? 2.4 : sprint ? 4.6 : 5.6;
  const turn = Math.max(-rate*dt, Math.min(rate*dt, error * -Math.expm1(-10*dt)));
  pose.yaw += turn;
  pose.turn = turn;
  pose.bend = Math.max(-0.36, Math.min(0.36, 0.32*error + 0.038*turn/dt));
  const alignment = Math.max(0, Math.cos(error-turn));
  return strength * (pose.backing ? -1.24 : sprint ? 4.2 : 1.9) * alignment;
}
