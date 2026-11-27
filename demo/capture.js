const FPS = 30;
const LIMIT_MS = 10 * 60 * 1000;

const elapsedLabel = seconds => {
  const whole = Math.floor(seconds);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
};

function openLibrary() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tarn-captures', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('clips', { keyPath: 'id' });
      request.result.createObjectStore('video', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function bindCapture(canvas, { audio, pause, resume }) {
  const record = document.getElementById('capture-record');
  const gallery = document.getElementById('capture-gallery');
  const status = document.getElementById('capture-status');
  const dialog = document.getElementById('capture-library');
  const list = dialog.querySelector('.capture-list');
  const hint = dialog.querySelector('.capture-hint');
  const video = dialog.querySelector('video');
  const detail = dialog.querySelector('.capture-detail');
  const download = detail.querySelector('a');
  const back = detail.querySelector('button');
  const supported = typeof MediaRecorder === 'function' && typeof canvas.captureStream === 'function';
  const memory = new Map();
  let library, active, outputSize, queued = false, saving = false, mediaURL, thumbURLs = [];
  let paneVersion = 0, originalFocus, noticeTimer;

  async function store(tables, mode, operation) {
    library ??= openLibrary();
    const db = await library;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(tables, mode);
      let request;
      try {
        request = operation(tx);
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function saveClip(clip) {
    const { blob, thumb, ...metadata } = clip;
    const write = (thumbnail, media) => store(['clips', 'video'], 'readwrite', tx => {
      tx.objectStore('clips').put({ ...metadata, ...thumbnail });
      tx.objectStore('video').put({ id: clip.id, mime: blob.type, ...media });
    });
    try {
      await write({ thumb }, { blob });
    } catch (error) {
      // Some WebKit contexts accept binary buffers in IndexedDB but reject blobs.
      if (error?.name !== 'UnknownError' && error?.name !== 'DataCloneError') throw error;
      const bytes = await blob.arrayBuffer();
      const preview = thumb && await thumb.arrayBuffer();
      await write({ preview }, { bytes });
    }
  }

  function notice(message) {
    clearTimeout(noticeTimer);
    status.textContent = message;
    noticeTimer = setTimeout(() => { status.textContent = ''; }, 4500);
  }

  function updateButton() {
    const recording = queued || (active && !saving);
    record.textContent = saving ? 'Saving…' : recording ? 'Stop 0:00' : 'Record';
    record.disabled = saving;
    record.setAttribute('aria-pressed', String(Boolean(recording)));
  }

  function release(session) {
    clearTimeout(session.timer);
    session.sound?.disconnect();
    session.stream.getTracks().forEach(track => track.stop());
  }

  async function finish(session) {
    if (active !== session) return;
    saving = true;
    updateButton();
    release(session);
    outputSize = null;
    try {
      const blob = new Blob(session.chunks, { type: (session.recorder.mimeType || session.chunks[0]?.type || 'video/webm').split(';')[0] });
      if (!blob.size) {
        notice('The recording was empty. Try a longer clip.');
        return;
      }
      const thumb = await new Promise(resolve => session.preview.toBlob(resolve, 'image/jpeg', 0.82));
      const created = Date.now();
      const clip = { id: crypto.randomUUID(), created, duration: (session.ended - session.started) / 1000, blob, thumb };
      try {
        await saveClip(clip);
        notice('Clip saved to Gallery');
      } catch {
        memory.set(clip.id, clip);
        notice('Browser storage unavailable. Download this clip before leaving.');
      }
    } catch {
      notice('Could not save the clip.');
    } finally {
      active = null;
      saving = false;
      updateButton();
      if (dialog.open && detail.hidden) showList();
    }
  }

  function stop() {
    queued = false;
    if (!active) outputSize = null;
    if (active && !saving) {
      saving = true;
      active.ended = performance.now();
      clearTimeout(active.timer);
      if (active.recorder.state !== 'inactive') active.recorder.stop();
    }
    updateButton();
  }

  function toggle() {
    if (dialog.open || saving) return;
    if (!supported) return notice('Gameplay recording is unavailable in this browser.');
    if (queued || active) return stop();
    const scale = Math.min(1, 1920 / canvas.width, 1080 / canvas.height);
    outputSize = {
      width: Math.max(2, 2*Math.round(canvas.width*scale/2)),
      height: Math.max(2, 2*Math.round(canvas.height*scale/2)),
    };
    queued = true;
    updateButton();
  }

  function start(now) {
    queued = false;
    let stream, sound;
    try {
      // The renderer presents directly into the fixed-size recording surface.
      // Only the small Gallery thumbnail needs a 2D copy, once per clip.
      const preview = document.createElement('canvas');
      const scale = 280 / Math.max(canvas.width,canvas.height);
      preview.width = Math.max(1, Math.round(canvas.width*scale));
      preview.height = Math.max(1, Math.round(canvas.height*scale));
      preview.getContext('2d', {alpha:false}).drawImage(canvas,0,0,preview.width,preview.height);
      stream = canvas.captureStream(FPS);
      try { sound = audio()?.capture(); } catch { /* Video recording can still proceed. */ }
      if (sound) stream.addTrack(sound.track);
      const codecs = sound ? ['video/mp4;codecs=avc1.42001f,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/mp4']
        : ['video/mp4;codecs=avc1.42001f', 'video/webm;codecs=vp8', 'video/mp4'];
      const mimeType = codecs.find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      const session = { recorder, stream, sound, preview, chunks: [], started: now, next: now + 1000 };
      recorder.ondataavailable = ({ data }) => { if (data.size) session.chunks.push(data); };
      recorder.onstop = () => { session.ended ??= performance.now(); void finish(session); };
      recorder.onerror = () => { notice('Recording interrupted. Saving captured footage.'); };
      recorder.start(1000);
      active = session;
      session.timer = setTimeout(stop, LIMIT_MS);
    } catch {
      outputSize = null;
      sound?.disconnect();
      stream?.getTracks().forEach(track => track.stop());
      notice('Could not start gameplay recording in this browser.');
    }
    updateButton();
  }

  function frame(now) {
    if (queued) start(now);
    else if (active && !saving && now >= active.next) {
      active.next = now + 1000;
      record.textContent = 'Stop ' + elapsedLabel((now - active.started) / 1000);
    }
  }

  function releasePreview() {
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (mediaURL) URL.revokeObjectURL(mediaURL);
    mediaURL = null;
    download.removeAttribute('href');
    detail.hidden = true;
  }

  async function showList() {
    const version = ++paneVersion;
    releasePreview();
    for (const url of thumbURLs) URL.revokeObjectURL(url);
    thumbURLs = [];
    list.replaceChildren();
    list.hidden = false;
    hint.textContent = 'Loading clips…';
    let saved = [];
    try { saved = await store('clips', 'readonly', tx => tx.objectStore('clips').getAll()); } catch { /* session library */ }
    if (version !== paneVersion || !dialog.open) return;
    const clips = [...saved, ...memory.values()].sort((a, b) => b.created - a.created);
    if (saving) hint.textContent = 'Saving your clip…';
    else if (memory.size) hint.textContent = 'Some clips are only available for this session. Download them before leaving.';
    else hint.textContent = clips.length ? 'Clips are stored in this browser.' : 'No clips yet. Use Record while exploring Tarn.';
    for (const clip of clips) {
      const card = document.getElementById('capture-card').content.cloneNode(true);
      const open = card.querySelector('.capture-open');
      const del = card.querySelector('.capture-delete');
      const date = new Date(clip.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      open.setAttribute('aria-label', 'Watch clip from ' + date);
      const thumbnail = clip.thumb ?? (clip.preview && new Blob([clip.preview], { type: 'image/jpeg' }));
      if (thumbnail) {
        const url = URL.createObjectURL(thumbnail);
        thumbURLs.push(url);
        card.querySelector('img').src = url;
      } else card.querySelector('img').remove();
      card.querySelector('time').textContent = elapsedLabel(clip.duration);
      card.querySelector('.capture-date').textContent = date;
      open.onclick = async () => {
        const version = ++paneVersion;
        list.hidden = true;
        detail.hidden = false;
        hint.textContent = 'Loading clip…';
        back.focus();
        try {
          const media = memory.get(clip.id) ?? await store('video', 'readonly', tx => tx.objectStore('video').get(clip.id));
          if (version !== paneVersion || !dialog.open) return;
          if (!media) throw new Error('Missing video');
          const blob = media.blob ?? new Blob([media.bytes], { type: media.mime });
          mediaURL = URL.createObjectURL(blob);
          video.src = mediaURL;
          hint.textContent = date;
          download.href = mediaURL;
          download.download = 'tarn-' + new Date(clip.created).toISOString().replace(/[:.]/g, '-') +
            (blob.type === 'video/mp4' ? '.mp4' : '.webm');
        } catch {
          if (version === paneVersion && dialog.open) hint.textContent = 'Could not open this clip.';
        }
      };
      del.onclick = async () => {
        if (del.textContent === 'Delete') {
          del.textContent = 'Confirm delete';
          return;
        }
        del.disabled = true;
        try {
          if (!memory.delete(clip.id)) {
            await store(['clips', 'video'], 'readwrite', tx => {
              tx.objectStore('clips').delete(clip.id);
              tx.objectStore('video').delete(clip.id);
            });
          }
          if (dialog.open) {
            await showList();
            dialog.querySelector('.capture-close').focus();
          }
        } catch {
          if (dialog.open) hint.textContent = 'Could not delete this clip. Try again.';
          del.disabled = false;
        }
      };
      list.append(card);
    }
  }

  function open() {
    if (dialog.open) return;
    originalFocus = document.pointerLockElement ? gallery : document.activeElement;
    if (document.pointerLockElement) document.exitPointerLock();
    stop();
    dialog.showModal();
    pause();
    void showList();
  }

  dialog.addEventListener('close', () => {
    ++paneVersion;
    releasePreview();
    for (const url of thumbURLs) URL.revokeObjectURL(url);
    thumbURLs = [];
    list.replaceChildren();
    resume();
    originalFocus?.focus();
  });
  back.onclick = async () => {
    await showList();
    if (dialog.open && detail.hidden) (list.querySelector('.capture-open') || dialog.querySelector('.capture-close')).focus();
  };
  record.onclick = toggle;
  gallery.onclick = open;
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  return { frame, toggle, open, get outputSize() { return outputSize; }, get viewing() { return dialog.open; } };
}
