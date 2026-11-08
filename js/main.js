import { Link } from './rtc.js';
import { Chat } from './chat.js';
import { LocalPlayer } from './player.js';

const $ = id => document.getElementById(id);

const UI = {
  statusPill: $('statusPill'), statusText: $('statusText'), btnHome: $('btnHome'),

  landing: $('viewLanding'), room: $('viewRoom'),
  lede: $('lede'), nameInput: $('nameInput'),
  btnHost: $('btnHost'), btnJoin: $('btnJoin'),

  video: $('video'), fileInput: $('fileInput'), changeFile: $('changeFile'),
  stageEmpty: $('stageEmpty'), stageRemote: $('stageRemote'),
  stageRemoteText: $('stageRemoteText'), stageHint: $('stageHint'),
  btnWatch: $('btnWatch'),
  stagePaused: $('stagePaused'),
  fileName: $('fileName'), statTime: $('statTime'), statDur: $('statDur'),
  progressFill: $('progressFill'),

  connectError: $('connectError'),
  stepHost: $('stepHost'), stepGuest: $('stepGuest'),
  inviteOut: $('inviteOut'), replyIn: $('replyIn'), btnFinish: $('btnFinish'),
  btnResetHost: $('btnResetHost'), btnShare: $('btnShare'),
  inviteIn: $('inviteIn'), btnAnswer: $('btnAnswer'), btnResetGuest: $('btnResetGuest'),
  replyWrap: $('replyWrap'), replyOut: $('replyOut'),
  connectedNote: $('connectedNote'), btnResetConnected: $('btnResetConnected'),

  chatList: $('chatList'), chatText: $('chatText'), btnSend: $('btnSend'),

  toasts: $('toasts'),
};

let sessionSeq = 0;

const state = {
  role: null,
  link: null,
  connected: false,
  saidHello: false,
  remoteStream: null,
  peerName: '',
  lastStateAt: 0,
  watchLock: null,
  pendingInvite: '',
  swapping: false,
  name: savedName(),
};

const player = new LocalPlayer(UI.video, onLocalState);
const chat = new Chat({ list: UI.chatList, input: UI.chatText, send: UI.btnSend });

UI.nameInput.value = state.name;

/* ── landing ──────────────────────────────────────────────── */

UI.btnHost.addEventListener('click', beginHost);
UI.btnJoin.addEventListener('click', () => beginGuest(state.pendingInvite));

UI.nameInput.addEventListener('input', () => {
  UI.nameInput.classList.remove('invalid');
  UI.nameInput.placeholder = 'name';
  state.name = UI.nameInput.value.trim().slice(0, 24);
});

UI.nameInput.addEventListener('change', () => {
  state.name = UI.nameInput.value.trim().replace(/\s+/g, ' ').slice(0, 24);
  persistName(state.name);
});

UI.nameInput.addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  (state.pendingInvite ? UI.btnJoin : UI.btnHost).click();
});

function beginHost(restore = false) {
  if (!requireName()) return;
  state.role = 'host';
  state.pendingInvite = '';
  state.peerName = '';
  openRoom();
  chat.clear();
  saveRoom({ invite: '' });

  // Drop anything left over from a guest session.
  UI.video.srcObject = null;
  delete UI.video.dataset.live;

  UI.stepHost.classList.remove('hidden');
  UI.stepGuest.classList.add('hidden');
  UI.changeFile.classList.remove('hidden');
  UI.video.controls = true;
  setStatus('idle');

  if (player.url && player.meta) {
    UI.stageEmpty.classList.add('hidden');
    UI.stageRemote.classList.add('hidden');
    UI.fileName.textContent = player.meta.name;
    UI.statDur.textContent = fmtTime(player.meta.duration);
    startHostSession();
    return;
  }

  UI.stageEmpty.classList.remove('hidden');
  UI.stageRemote.classList.add('hidden');
  UI.fileName.textContent = '—';
  if (restore) showHint('session restored — choose your video again');
  else UI.stageHint.classList.add('hidden');
  if (!restore) UI.fileInput.click();
}

function beginGuest(invite = '', restore = false) {
  if (!requireName()) return;
  state.role = 'guest';
  state.pendingInvite = '';
  state.peerName = '';
  const previousInvite = restore ? (savedRoom()?.invite || '') : '';
  const keptInvite = invite || previousInvite;
  openRoom();
  chat.clear();
  saveRoom({ invite: keptInvite });

  // A guest never plays local media.
  UI.video.srcObject = null;
  delete UI.video.dataset.live;
  if (player.url) player.release();

  UI.stepGuest.classList.remove('hidden');
  UI.stepHost.classList.add('hidden');
  UI.changeFile.classList.add('hidden');
  UI.stageEmpty.classList.add('hidden');
  UI.stageHint.classList.add('hidden');
  UI.stageRemote.classList.remove('hidden');
  UI.stageRemoteText.textContent = 'no stream';
  UI.btnWatch.classList.add('hidden');
  UI.video.controls = false;
  UI.fileName.textContent = '—';
  setStatus('idle');

  if (keptInvite) UI.inviteIn.value = keptInvite;
  if (invite && !restore) answerInvite();
}

function requireName() {
  const name = UI.nameInput.value.trim().replace(/\s+/g, ' ').slice(0, 24);
  if (!name) {
    UI.nameInput.classList.add('invalid');
    UI.nameInput.placeholder = 'enter a name';
    UI.nameInput.focus();
    return false;
  }
  UI.nameInput.classList.remove('invalid');
  state.name = name;
  persistName(name);
  return true;
}

function persistName(name) {
  try { localStorage.setItem('w2g:name', name); } catch { /* storage blocked */ }
}

function openRoom() {
  UI.landing.classList.add('hidden');
  UI.room.classList.remove('hidden');
  window.scrollTo(0, 0);
}

UI.btnHome.addEventListener('click', () => {
  if (state.connected && !confirm('leave the session?')) return;
  leaveRoom();
  UI.room.classList.add('hidden');
  UI.landing.classList.remove('hidden');
  setStatus('idle');
});

/* ── host: pick a file, build an invite ───────────────────── */

UI.fileInput.addEventListener('change', async ev => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file || state.role !== 'host') return;
  clearError();

  if (state.connected) {
    await swapHostFile(file);
    return;
  }

  try {
    const meta = await player.load(file);
    showHostFile(meta.name, meta.duration);
    await startHostSession();
  } catch (err) {
    fail(err.message);
    if (!player.url) {
      UI.stageEmpty.classList.remove('hidden');
      UI.stageRemote.classList.add('hidden');
      UI.fileName.textContent = '—';
    }
  }
});

UI.changeFile.addEventListener('click', () => UI.fileInput.click());

function showHostFile(name, duration) {
  UI.stageHint.classList.add('hidden');
  UI.stageEmpty.classList.add('hidden');
  UI.stageRemote.classList.add('hidden');
  UI.fileName.textContent = name;
  UI.statDur.textContent = fmtTime(duration);
  UI.statTime.textContent = '00:00';
  setProgress(0);
}

/** Load a new file and put its tracks on the existing peer connection. */
async function swapHostFile(file) {
  if (state.swapping) return;
  state.swapping = true;
  const link = state.link;
  const wasPlaying = !UI.video.paused;

  try {
    // A captured media element will not accept a new source until its old
    // capture tracks are stopped. The peer connection itself stays up.
    player.stopCapture();
    const meta = await player.load(file);
    showHostFile(meta.name, meta.duration);

    if (!state.connected || state.link !== link) {
      await startHostSession();
      return;
    }

    const stream = player.capture();
    await link.setStream(stream);

    if (!state.connected || state.link !== link) {
      await startHostSession();
      return;
    }

    link.send({ t: 'meta', name: meta.name, duration: meta.duration });

    if (wasPlaying) {
      try { await UI.video.play(); } catch { /* they can press play */ }
    }
    link.send({
      t: 'state',
      paused: UI.video.paused,
      time: UI.video.currentTime || 0,
      duration: meta.duration,
    });
    setStatus('connected');
  } catch (err) {
    // The peer is still connected; let the host try another file.
    if (state.connected) {
      toast(err.message, 'err');
      if (!player.meta) UI.stageEmpty.classList.remove('hidden');
    } else {
      fail(err.message);
    }
  } finally {
    state.swapping = false;
  }
}

async function startHostSession() {
  teardownLink();
  const seq = sessionSeq;
  clearError();
  resetCodes();
  setStatus('connecting');
  UI.inviteOut.placeholder = 'building…';

  try {
    const stream = player.capture();
    const link = new Link(handlers());
    state.link = link;
    const code = await link.hostOffer(stream);
    if (seq !== sessionSeq) return;
    UI.inviteOut.value = inviteLink(code);
    UI.inviteOut.placeholder = 'choose a video first';
    UI.replyIn.value = '';
    setStatus('waiting');
  } catch (err) {
    if (seq !== sessionSeq) return;
    state.link?.close();
    state.link = null;
    UI.inviteOut.placeholder = 'choose a video first';
    fail(err.message);
  }
}

function inviteLink(code) {
  return `${location.origin}${location.pathname}#i.${code}`;
}

UI.btnFinish.addEventListener('click', async () => {
  if (UI.btnFinish.disabled) return;
  clearError();
  const code = UI.replyIn.value.trim();
  if (!code) return showError('paste the reply first');
  if (!state.link) return showError('choose a video first');
  setStatus('connecting');
  UI.btnFinish.disabled = true;
  UI.btnFinish.textContent = 'connecting…';
  try {
    await state.link.hostFinish(code);
  } catch (err) {
    fail(err.message);
  } finally {
    UI.btnFinish.disabled = false;
    UI.btnFinish.textContent = 'connect';
  }
});

/* ── guest: answer an invite ──────────────────────────────── */

UI.btnAnswer.addEventListener('click', answerInvite);

UI.replyIn.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    UI.btnFinish.click();
  }
});

UI.inviteIn.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    UI.btnAnswer.click();
  }
});

// A read-only code is meant to be selected as a whole, not edited.
for (const field of [UI.inviteOut, UI.replyOut]) {
  field.addEventListener('focus', () => field.select());
  field.addEventListener('click', () => field.select());
}

async function answerInvite() {
  if (UI.btnAnswer.disabled) return;
  clearError();
  const code = UI.inviteIn.value.trim();
  if (!code) return showError('paste the invite first');
  saveRoom({ invite: code });

  teardownLink();
  const seq = sessionSeq;
  setStatus('connecting');
  UI.btnAnswer.disabled = true;
  UI.btnAnswer.textContent = 'building…';

  try {
    const link = new Link(handlers());
    state.link = link;
    const reply = await link.guestAnswer(code);
    if (seq !== sessionSeq) return;
    UI.replyOut.value = reply;
    UI.replyWrap.classList.remove('hidden');
    UI.stageRemoteText.textContent = 'waiting for host';
    setStatus('waiting');
  } catch (err) {
    if (seq !== sessionSeq) return;
    teardownLink();
    fail(err.message);
  } finally {
    if (seq === sessionSeq) {
      UI.btnAnswer.disabled = false;
      UI.btnAnswer.textContent = 'generate reply';
    }
  }
}

/* ── one link, many events ────────────────────────────────── */

function handlers() {
  return {
    onState: onPeerState,
    onOpen: onChannelOpen,
    onClose: onChannelClose,
    onData: onChannelData,
    onStream: onRemoteStream,
  };
}

function onPeerState(s) {
  if (s === 'connected') {
    setStatus('connected');
  } else if (s === 'connecting' || s === 'new') {
    setStatus('connecting');
  } else if (s === 'disconnected') {
    setStatus('connecting');
  } else if (s === 'failed') {
    setStatus('error');
    showError('connection failed');
  } else if (s === 'closed') {
    setStatus('idle');
  }
}

function onChannelOpen() {
  state.connected = true;
  state.saidHello = false;

  chat.setEnabled(true);
  UI.stepHost.classList.add('hidden');
  UI.stepGuest.classList.add('hidden');
  UI.connectedNote.classList.remove('hidden');
  setStatus('connected');
  clearError();

  sendHello();

  if (state.role === 'host') {
    if (player.meta) {
      state.link?.send({ t: 'meta', name: player.meta.name, duration: player.meta.duration });
    }
    const snap = player.snapshot();
    state.link?.send({
      t: 'state',
      paused: snap.paused,
      time: snap.time,
      duration: snap.duration,
    });
    grabWakeLock();
  }
}

function onChannelClose() {
  teardownLink();
  state.connected = false;
  state.saidHello = false;
  state.peerName = '';
  chat.setEnabled(false);
  chat.clear();
  UI.connectedNote.classList.add('hidden');
  hidePaused();

  // The old codes are dead. Build a fresh invite on the host, and let the
  // guest start over with a new one.
  if (state.role === 'host' && player.url && !state.swapping) {
    UI.stepHost.classList.remove('hidden');
    UI.stepGuest.classList.add('hidden');
    startHostSession();
    return;
  }

  resetCodes();
  if (state.role === 'guest') {
    state.remoteStream = null;
    UI.video.srcObject = null;
    delete UI.video.dataset.live;
    UI.stepGuest.classList.remove('hidden');
    UI.stepHost.classList.add('hidden');
    UI.stageRemote.classList.remove('hidden');
    UI.stageRemoteText.textContent = 'no stream';
    UI.btnWatch.classList.add('hidden');
  } else if (state.role === 'host') {
    UI.stepHost.classList.remove('hidden');
    UI.stepGuest.classList.add('hidden');
  }
  setStatus('idle');
}

function onChannelData(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.t) {
    case 'hello':
      state.peerName = clean(msg.name, 24);
      if (!state.saidHello) sendHello();
      break;
    case 'chat': {
      const text = clean(msg.text, 2000);
      if (!text) return;
      chat.add({
        name: clean(msg.name, 24) || state.peerName || 'peer',
        text,
        ts: msg.ts,
      });
      break;
    }
    case 'state':
      renderRemoteState(msg);
      break;
    case 'meta':
      UI.fileName.textContent = clean(msg.name, 200) || '—';
      UI.statDur.textContent = fmtTime(Number(msg.duration));
      break;
  }
}

function submitCode(field) {
  if (field.value.trim().length < 20) return;
  setTimeout(() => {
    if (field === UI.inviteIn) answerInvite();
    else if (field === UI.replyIn) UI.btnFinish.click();
  }, 0);
}

for (const field of [UI.inviteIn, UI.replyIn]) {
  field.addEventListener('paste', () => setTimeout(() => submitCode(field), 0));
}

function sendHello() {
  state.saidHello = true;
  state.link?.send({ t: 'hello', name: state.name });
}

function onRemoteStream(stream) {
  if (state.role !== 'guest') return;
  state.remoteStream = stream;
  UI.stageRemote.classList.remove('hidden');
  UI.stageRemoteText.textContent = 'stream ready';
  UI.btnWatch.classList.remove('hidden');
}

UI.btnWatch.addEventListener('click', async () => {
  if (!state.remoteStream) return;
  UI.video.removeAttribute('src');
  UI.video.srcObject = state.remoteStream;
  UI.video.dataset.live = '1';
  UI.video.controls = false;
  try {
    await UI.video.play();
    UI.stageRemote.classList.add('hidden');
  } catch {
    // Autoplay was refused: leave the controls on so they can start it.
    UI.video.controls = true;
    toast('press play to start', 'warn');
  }
});

UI.video.addEventListener('play', () => {
  if (state.role === 'guest' && state.remoteStream) {
    UI.stageRemote.classList.add('hidden');
  }
});

/* ── playback state ───────────────────────────────────────── */

function onLocalState(s, ev) {
  if (state.role !== 'host' || !s.hasMedia) return;

  renderPosition(s.time, s.duration);

  if (!state.connected) return;

  // timeupdate fires constantly; everything else is a real user action.
  const now = performance.now();
  if (ev === 'timeupdate' && now - state.lastStateAt < 250) return;
  state.lastStateAt = now;

  state.link?.send({
    t: 'state',
    paused: s.paused,
    time: s.time,
    duration: s.duration,
  });
}

function renderRemoteState(msg) {
  const time = Number(msg.time) || 0;
  const duration = Number(msg.duration) || 0;
  renderPosition(time, duration);
  UI.stagePaused.classList.toggle('hidden', !msg.paused || !state.connected);
}

function renderPosition(time, duration) {
  UI.statTime.textContent = fmtTime(time);
  UI.statDur.textContent = fmtTime(duration);
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  setProgress(pct);
}

function setProgress(percent) {
  const scale = Math.max(0, Math.min(1, percent / 100));
  UI.progressFill.style.transform = `scaleX(${scale.toFixed(4)})`;
}

function hidePaused() {
  UI.stagePaused.classList.add('hidden');
}

function showHint(text) {
  UI.stageHint.textContent = text;
  UI.stageHint.classList.remove('hidden');
}

/* ── chat ─────────────────────────────────────────────────── */

function sendChat() {
  const text = UI.chatText.value.trim();
  if (!text || !state.connected) return;
  const sent = state.link?.send({ t: 'chat', name: state.name, text, ts: Date.now() });
  if (!sent) return;
  chat.add({ name: state.name, text, ts: Date.now(), self: true });
  UI.chatText.value = '';
  UI.chatText.focus();
}

UI.btnSend.addEventListener('click', sendChat);
UI.chatText.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendChat();
  }
});

UI.chatText.addEventListener('focus', () => {
  if (window.innerWidth > 860) return;
  setTimeout(() => UI.chatText.scrollIntoView({ block: 'nearest' }), 120);
});

/* ── reset / teardown ─────────────────────────────────────── */

UI.btnResetHost.addEventListener('click', resetSession);
UI.btnResetGuest.addEventListener('click', resetSession);
UI.btnResetConnected.addEventListener('click', resetSession);

function leaveRoom() {
  teardownLink();
  clearError();
  resetCodes();
  hidePaused();
  clearRoom();
  state.remoteStream = null;
  state.role = null;
  state.peerName = '';

  player.release();
  UI.video.srcObject = null;
  delete UI.video.dataset.live;

  chat.setEnabled(false);
  chat.clear();
  UI.connectedNote.classList.add('hidden');
  UI.fileName.textContent = '—';
  UI.statDur.textContent = '00:00';
  UI.statTime.textContent = '00:00';
  setProgress(0);

  UI.lede.textContent = 'watch the same video file together, peer-to-peer.';
  UI.btnHost.classList.remove('hidden');
  UI.btnJoin.textContent = 'join a session';
  state.pendingInvite = '';
}

function resetSession() {
  const hadFile = !!player.url;
  teardownLink();
  clearError();
  resetCodes();
  hidePaused();
  state.remoteStream = null;

  UI.video.srcObject = null;
  delete UI.video.dataset.live;

  chat.setEnabled(false);
  chat.clear();
  UI.connectedNote.classList.add('hidden');
  UI.statTime.textContent = '00:00';
  setProgress(0);

  if (state.role === 'guest') {
    UI.stageRemote.classList.remove('hidden');
    UI.stageRemoteText.textContent = 'no stream';
    UI.btnWatch.classList.add('hidden');
  }

  if (state.role === 'host' && hadFile) {
    UI.stepHost.classList.remove('hidden');
    UI.stepGuest.classList.add('hidden');
    startHostSession();
    return;
  }

  if (state.role === 'host') {
    UI.stepHost.classList.remove('hidden');
    UI.stepGuest.classList.add('hidden');
  } else if (state.role === 'guest') {
    UI.stepGuest.classList.remove('hidden');
    UI.stepHost.classList.add('hidden');
  }

  setStatus('idle');
}

function teardownLink() {
  sessionSeq += 1;
  resetBusy();
  if (state.link) {
    try { state.link.close(); } catch { /* already gone */ }
  }
  state.link = null;
  state.connected = false;
  state.saidHello = false;
  if (state.watchLock) {
    try { state.watchLock.release(); } catch { /* already released */ }
    state.watchLock = null;
  }
}

function resetBusy() {
  UI.btnAnswer.disabled = false;
  UI.btnAnswer.textContent = 'generate reply';
  UI.btnFinish.disabled = false;
  UI.btnFinish.textContent = 'connect';
}

function resetCodes() {
  UI.inviteOut.value = '';
  UI.inviteOut.placeholder = 'choose a video first';
  UI.replyIn.value = '';
  UI.inviteIn.value = '';
  UI.replyOut.value = '';
  UI.replyWrap.classList.add('hidden');
}

/* ── small helpers ────────────────────────────────────────── */

function showError(text) {
  UI.connectError.textContent = text;
  UI.connectError.classList.remove('hidden');
}

function clearError() {
  UI.connectError.classList.add('hidden');
  UI.connectError.textContent = '';
}

function fail(message) {
  const text = String(message || 'something went wrong');
  showError(text);
  setStatus('error');
  toast(text, 'err');
}

function setStatus(text) {
  UI.statusText.textContent = text === 'idle' ? 'ready' : text;
  UI.statusPill.dataset.state = text;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  UI.toasts.append(el);
  setTimeout(() => el.remove(), 5000);
}

function fmtTime(seconds) {
  let s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function clean(value, max = 40) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function savedName() {
  try { return (localStorage.getItem('w2g:name') || '').trim().slice(0, 24); }
  catch { return ''; }
}

/* ── room persists until the user explicitly leaves ───────── */

const ROOM_KEY = 'w2g:room';

function savedRoom() {
  try {
    const room = JSON.parse(sessionStorage.getItem(ROOM_KEY) || 'null');
    return room && (room.role === 'host' || room.role === 'guest') ? room : null;
  } catch {
    return null;
  }
}

function saveRoom(patch = {}) {
  try {
    const room = { ...(savedRoom() || {}), ...patch, role: state.role, name: state.name };
    sessionStorage.setItem(ROOM_KEY, JSON.stringify(room));
  } catch { /* storage blocked */ }
}

function clearRoom() {
  try { sessionStorage.removeItem(ROOM_KEY); } catch { /* storage blocked */ }
}

/* ── clipboard ────────────────────────────────────────────── */

document.addEventListener('click', async ev => {
  const chip = ev.target.closest('[data-paste]');
  if (!chip) return;
  const target = document.getElementById(chip.dataset.paste);
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return;
    target.value = text;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
    submitCode(target);
    const label = chip.textContent;
    chip.textContent = 'pasted';
    setTimeout(() => { chip.textContent = label; }, 1000);
  } catch {
    toast('paste failed', 'err');
  }
});

document.addEventListener('click', async ev => {
  const chip = ev.target.closest('[data-copy]');
  if (!chip) return;
  const target = document.getElementById(chip.dataset.copy);
  const text = (target?.value ?? target?.textContent ?? '').trim();
  if (!text) return;
  const ok = await copyText(text);
  if (!ok) {
    toast('copy failed', 'err');
    return;
  }
  const label = chip.textContent;
  chip.classList.add('ok');
  chip.textContent = 'copied';
  setTimeout(() => {
    chip.classList.remove('ok');
    chip.textContent = label;
  }, 1400);
});

if (navigator.share) UI.btnShare.classList.remove('hidden');

UI.btnShare.addEventListener('click', async () => {
  const url = UI.inviteOut.value.trim();
  if (!url) return toast('choose a video first', 'warn');
  try {
    await navigator.share({ title: 'w2g — watch together', text: 'watch together', url });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    // Some desktops expose share but cannot hand off a custom URL.
    if (await copyText(url)) toast('invite copied');
    else toast('could not share', 'err');
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
      document.body.append(el);
      el.focus();
      el.select();
      const ok = document.execCommand('copy');
      el.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ── keep the host awake ──────────────────────────────────── */

async function grabWakeLock() {
  if (!('wakeLock' in navigator) || state.watchLock) return;
  try {
    state.watchLock = await navigator.wakeLock.request('screen');
    state.watchLock.addEventListener('release', () => { state.watchLock = null; });
  } catch { /* not allowed; user can keep the tab focused */ }
}

document.addEventListener('visibilitychange', () => {
  if (state.role === 'host' && state.connected && document.visibilityState === 'visible') {
    grabWakeLock();
  }
});

/* ── startup: invite links and room restore ───────────────── */

function inviteFromHash() {
  const match = location.hash.match(/^#i\.([A-Za-z0-9_.-]+)$/);
  if (!match) return '';
  history.replaceState(null, '', location.pathname + location.search);
  return match[1];
}

function useInvite(code) {
  clearRoom();
  state.pendingInvite = code;
  UI.lede.textContent = 'you have been invited to watch together.';
  UI.btnHost.classList.add('hidden');
  UI.btnJoin.textContent = 'join session';
  if (state.name) beginGuest(code);
}

const invited = inviteFromHash();
if (invited) {
  useInvite(invited);
} else {
  const room = savedRoom();
  const name = room?.name || state.name;
  if (room && name) {
    UI.nameInput.value = name;
    state.name = name;
    if (room.role === 'host') {
      beginHost(true);
      toast('room restored — choose your video again', 'warn');
    } else {
      beginGuest('', true);
      toast('room restored — reconnect to watch', 'warn');
    }
  } else if (room) {
    clearRoom();
  }
}

window.addEventListener('hashchange', () => {
  const code = inviteFromHash();
  if (code && UI.room.classList.contains('hidden')) useInvite(code);
});

/* debug handle, handy from the console */
window.__w2g = { state, player, chat };
