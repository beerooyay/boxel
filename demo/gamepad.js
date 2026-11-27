// Standard Gamepad mapping. Apply a radial dead zone so diagonal input retains its direction.
function axisPair(x = 0, y = 0) {
  const length = Math.hypot(x, y);
  if (length <= 0.16) return [0, 0];
  const gain = (Math.min(1, length) - 0.16) / (0.84 * length);
  return [x * gain, y * gain];
}

export function foxController() {
  const input = { x: 0, forward: 0, run: false };
  let previous = [], active = -1, unavailable = false;
  function poll(dt, { started, menu, gallery, toggleMenu, look, jump, throwStone, toggleCamera }) {
    input.x = input.forward = 0;
    input.run = false;
    if (unavailable || document.hidden || !document.hasFocus()) return;
    let devices;
    try { devices = navigator.getGamepads?.(); }
    catch { unavailable = true; return; } // Embedded players may restrict gamepad access.
    if (!devices?.length) { previous = []; active = -1; return; }
    const pads = Array.from(devices).filter(p => p?.mapping === 'standard');
    const pad = pads.find(p => p.buttons.some(b => b.pressed) || p.axes.some(a => Math.abs(a) > 0.2))
      || pads.find(p => p.index === active);
    if (!pad) { previous = []; active = -1; return; }
    if (pad.index !== active) previous = [];
    if (pad.index !== active) document.body.classList.add('using-controller');
    active = pad.index;
    const buttons = pad.buttons.map(b => b.pressed);
    const hit = i => buttons[i] && !previous[i];
    try {
      if (!started) {
        if (hit(0) || hit(9)) document.getElementById('go').click();
      } else if (gallery.open || menu.open) {
        const dialog = gallery.open ? gallery : menu;
        if (hit(1) || hit(9)) { dialog.close(); return; }
        const items = Array.from(dialog.querySelectorAll('button:not(:disabled), a[href], video[controls]')).filter(el => el.getClientRects().length);
        const i = items.indexOf(document.activeElement);
        const dir = hit(13) || hit(15) ? 1 : hit(12) || hit(14) ? -1 : 0;
        if (dir && items.length) items[(Math.max(0,i) + dir + items.length) % items.length].focus();
        else if (hit(0) && i >= 0) items[i].click();
      } else if (hit(9)) toggleMenu();
      else {
        const [x, y] = axisPair(...pad.axes.slice(0, 2));
        const [rx, ry] = axisPair(...pad.axes.slice(2, 4));
        input.x = x; input.forward = -y; input.run = buttons[7];
        look(rx * Math.abs(rx) * 2.8, ry * Math.abs(ry) * 1.9, dt);
        if (hit(0)) jump();
        if (hit(2)) throwStone();
        if (hit(3)) toggleCamera();
      }
    } finally { previous = buttons; }
  }
  return { input, poll };
}
