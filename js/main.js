import { Link } from './rtc.js';
import { Chat } from './chat.js';
import { LocalPlayer } from './player.js';

const $ = id => document.getElementById(id);

const UI = {
  statusPill: $('statusPill'), statusText: $('statusText'),

  landing: $('viewLanding'), room: $('viewRoom'),
  btnHost: $('btnHost'), btnJoin: $('btnJoin'),

  video: $('video'), fileInput: $('fileInput'), changeFile: $('changeFile'),
  stageEmpty: $('stageEmpty'), stageRemote: $('stageRemote'),
  stageRemoteText: $('stageRemoteText'), btnWatch: $('btnWatch'),
  stagePaused: $('stagePaused'),
  fileName: $('fileName'), statTime: $('statTime'), statDur: $('statDur'),
  statNet: $('statNet'), progressFill: $('progressFill'), roomBadge: $('roomBadge'),

  connectBadge: $('connectBadge'), connectError: $('connectError'),
  stepHost: $('stepHost'), stepGuest: $('stepGuest'),
  inviteOut: $('inviteOut'), inviteMeta: $('inviteMeta'),
  replyIn: $('replyIn'), btnFinish: $('btnFinish'),
  btnResetHost: $('btnResetHost'),
  inviteIn: $('inviteIn'), btnAnswer: $('btnAnswer'), btnResetGuest: $('btnResetGuest'),
  replyWrap: $('replyWrap'), replyOut: $('replyOut'),
  connectedNote: $('connectedNote'), connectedDetail: $('connectedDetail'),
  btnResetConnected: $('btnResetConnected'),

  chatList: $('chatList'), chatEmpty: $('chatEmpty'),
  chatText: $('chatText'), btnSend: $('btnSend'), peerBadge: $('peerBadge'),

  toasts: $('toasts'),
};

const state = {
  role: null,
  link: null,
  connected: false,
  saidHello: false,
  remoteStream: null,
  peerName: null,
  lastStateAt: 0,
  watchLock: null,
  name: nickname(),
};

const player = new LocalPlayer(UI.video, onLocalState);
const chat = new Chat({
  list: UI.chatList,
  empty: UI.chatEmpty,
  input: UI.chatText,
  send: UI.btnSend,
});

/* ── entry ────────────────────────────────────────────────── */

UI.btnHost.addEventListener('click', () => {
  state.role = 'host';
  openRoom();
  chat.clear();

  // Drop anything left over from a guest session.
  UI.video.srcObject = null;
  delete UI.video.dataset.live;

  UI.stepHost.classList.remove('hidden');
  UI.stepGuest.classList.add('hidden');
  UI.changeFile.classList.remove('hidden');
  UI.video.controls = true;
  setRoomBadge('waiting');
  setStatus('idle');
  setConnectBadge('choose a video');
  chat.system(`you are ${state.name}`);

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
  chat.system('choose a video to build an invite code');
});

UI.btnJoin.addEventListener('click', () => {
  state.role = 'guest';
  openRoom();
  chat.clear();

  // A guest never plays local media.
  UI.video.srcObject = null;
  delete UI.video.dataset.live;
  if (player.url) player.release();

  UI.stepGuest.classList.remove('hidden');
  UI.stepHost.classList.add('hidden');
  UI.changeFile.classList.add('hidden');
  UI.stageEmpty.classList.add('hidden');
  UI.stageRemote.classList.remove('hidden');
  UI.stageRemoteText.textContent = 'paste an invite code to begin';
  UI.btnWatch.classList.add('hidden');
  UI.video.controls = false;
  setConnectBadge('paste a code');
  setRoomBadge('waiting');
  setStatus('idle');
  chat.system(`you are ${state.name}`);
  chat.system('ask your friend for an invite code');
});

document.querySelector('.logo').addEventListener('click', () => {
  if (state.connected && !confirm('leave the session?')) return;
  resetSession();
  UI.room.classList.add('hidden');
  UI.landing.classList.remove('hidden');
  setStatus('idle');
});

function openRoom() {
  UI.landing.classList.add('hidden');
  UI.room.classList.remove('hidden');
  window.scrollTo(0, 0);
}

/* ── host: pick a file, build a code ──────────────────────── */

UI.fileInput.addEventListener('change', async ev => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file || state.role !== 'host') return;

  if (state.connected) {
    toast('changing the file ends the current session', 'warn');
    chat.system('loading a new file — the current session ends');
  }

  try {
    const meta = await player.load(file);
    UI.stageEmpty.classList.add('hidden');
    UI.stageRemote.classList.add('hidden');
    UI.fileName.textContent = meta.name;
    UI.statDur.textContent = fmtTime(meta.duration);
    UI.statTime.textContent = '00:00';
    UI.progressFill.style.width = '0%';
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

UI.changeFile.addEventListener('click', () => {
  // Once a file has been captured, a media element stays bound to that source:
  // pointing it at another file can stall before metadata loads. A fresh page
  // is the reliable reset, and swapping files ends the session anyway.
  if (!player.url) {
    UI.fileInput.click();
    return;
  }
  if (state.connected && !confirm('changing the file ends the current session. continue?')) return;
  location.hash = '#host';
  location.reload();
});

async function startHostSession() {
  teardownLink();
  clearError();
  resetCodes();
  setStatus('connecting');
  setConnectBadge('building code');
  setRoomBadge('waiting', 'warn');

  try {
    const stream = player.capture();
    const link = new Link(handlers());
    state.link = link;
    const code = await link.hostOffer(stream);
    UI.inviteOut.value = code;
    UI.inviteMeta.textContent = code.length > 1900
      ? `${code.length} characters · over some chat limits — send it in two parts`
      : `${code.length} characters`;
    UI.replyIn.value = '';
    setConnectBadge('awaiting reply');
    chat.system('invite code ready — copy it to your friend');
  } catch (err) {
    state.link?.close();
    state.link = null;
    fail(err.message);
  }
}

UI.btnFinish.addEventListener('click', async () => {
  if (UI.btnFinish.disabled) return;
  clearError();
  const code = UI.replyIn.value.trim();
  if (!code) return showError('paste the reply code first');
  if (!state.link) return showError('choose a video first — that builds the invite');
  setConnectBadge('connecting');
  setStatus('connecting');
  UI.btnFinish.disabled = true;
  try {
    await state.link.hostFinish(code);
    chat.system('reply accepted — connecting…');
  } catch (err) {
    fail(err.message);
  } finally {
    UI.btnFinish.disabled = false;
  }
});

/* ── guest: answer a code ─────────────────────────────────── */

UI.btnAnswer.addEventListener('click', async () => {
  if (UI.btnAnswer.disabled) return;
  clearError();
  const code = UI.inviteIn.value.trim();
  if (!code) return showError('paste the invite code first');

  teardownLink();
  setStatus('connecting');
  setConnectBadge('building reply');
  UI.btnAnswer.disabled = true;

  try {
    const link = new Link(handlers());
    state.link = link;
    const reply = await link.guestAnswer(code);
    UI.replyOut.value = reply;
    UI.replyWrap.classList.remove('hidden');
    UI.stageRemoteText.textContent = 'waiting for the host to connect';
    setConnectBadge('awaiting host');
    chat.system('reply code ready — send it back');
  } catch (err) {
    teardownLink();
    fail(err.message);
  } finally {
    UI.btnAnswer.disabled = false;
  }
});

/* ── one link, many events ────────────────────────────────── */

function handlers() {
  return {
    onState: onPeerState,
    onOpen: onChannelOpen,
    onClose: onChannelClose,
    onData: onChannelData,
    onStream: onRemoteStream,
    onStats: onStats,
  };
}

function onPeerState(s) {
  if (s === 'connected') {
    setStatus('connected', 'connected');
  } else if (s === 'connecting' || s === 'new') {
    setStatus('connecting');
  } else if (s === 'disconnected') {
    setStatus('connecting');
    toast('connection dropped — trying to recover', 'warn');
  } else if (s === 'failed') {
    setStatus('error');
    setConnectBadge('failed');
    toast('connection failed. reset and exchange codes again.', 'err');
  } else if (s === 'closed') {
    setStatus('idle');
  }
}

function onChannelOpen() {
  state.connected = true;
  state.saidHello = false;

  chat.setEnabled(true);
  UI.peerBadge.textContent = '2 here';
  UI.stepHost.classList.add('hidden');
  UI.stepGuest.classList.add('hidden');
  UI.connectedNote.classList.remove('hidden');
  UI.connectedDetail.textContent = state.role === 'host'
    ? 'your friend is connected'
    : 'connected to your friend';
  setConnectBadge('connected', 'live');
  setRoomBadge(state.role === 'host' ? 'live' : 'streaming', 'live');
  setStatus('connected', 'connected');
  clearError();

  chat.system('connected');
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
  state.connected = false;
  state.saidHello = false;
  chat.setEnabled(false);
  UI.peerBadge.textContent = 'solo';
  UI.connectedNote.classList.add('hidden');
  if (state.role === 'host') UI.stepHost.classList.remove('hidden');
  if (state.role === 'guest') UI.stepGuest.classList.remove('hidden');
  setConnectBadge('exchange new codes');
  setRoomBadge('waiting');
  setStatus('idle');
  chat.system('disconnected');
  hidePaused();
}

function onChannelData(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.t) {
    case 'hello': {
      const name = clean(msg.name);
      if (!name) return;
      state.peerName = name;
      chat.system(`${name} joined`);
      if (!state.saidHello) sendHello();
      break;
    }
    case 'chat': {
      const text = clean(msg.text, 2000);
      if (!text) return;
      chat.add({ name: clean(msg.name) || state.peerName || 'peer', text, ts: msg.ts });
      break;
    }
    case 'state':
      renderRemoteState(msg);
      break;
    case 'meta': {
      const name = clean(msg.name, 200);
      if (name) UI.fileName.textContent = name;
      UI.statDur.textContent = fmtTime(Number(msg.duration));
      break;
    }
  }
}

function sendHello() {
  state.saidHello = true;
  state.link?.send({ t: 'hello', name: state.name });
}

function onRemoteStream(stream) {
  if (state.role !== 'guest') return;
  state.remoteStream = stream;
  UI.stageRemote.classList.remove('hidden');
  UI.stageRemoteText.textContent = 'stream is live';
  UI.btnWatch.classList.remove('hidden');
  chat.system('stream ready — press watch');
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
    toast('press play on the video to start', 'warn');
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
  if (msg.paused && state.connected) {
    UI.stagePaused.classList.remove('hidden');
  } else {
    UI.stagePaused.classList.add('hidden');
  }
}

function renderPosition(time, duration) {
  UI.statTime.textContent = fmtTime(time);
  UI.statDur.textContent = fmtTime(duration);
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  UI.progressFill.style.width = pct.toFixed(2) + '%';
}

function hidePaused() {
  UI.stagePaused.classList.add('hidden');
}

/* ── stats ────────────────────────────────────────────────── */

function onStats({ kbps, rtt, dir }) {
  if (!state.connected) {
    UI.statNet.textContent = '—';
    return;
  }
  const arrow = dir === 'out' ? '\u2191' : '\u2193';
  const rate = kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' mbps' : kbps + ' kbps';
  UI.statNet.textContent = `${arrow} ${rate}${rtt != null ? ` \u00b7 ${rtt} ms` : ''}`;
}

/* ── chat ─────────────────────────────────────────────────── */

function sendChat() {
  const text = UI.chatText.value.trim();
  if (!text || !state.connected) return;
  const sent = state.link?.send({ t: 'chat', name: state.name, text, ts: Date.now() });
  if (!sent) {
    toast('not connected — message not sent', 'err');
    return;
  }
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

/* ── reset / teardown ─────────────────────────────────────── */

UI.btnResetHost.addEventListener('click', () => resetSession());
UI.btnResetGuest.addEventListener('click', () => resetSession());
UI.btnResetConnected.addEventListener('click', () => resetSession());

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
  UI.peerBadge.textContent = 'solo';
  UI.connectedNote.classList.add('hidden');
  UI.statNet.textContent = '—';
  UI.statTime.textContent = '00:00';
  UI.progressFill.style.width = '0%';

  if (state.role === 'guest') {
    UI.stageRemote.classList.remove('hidden');
    UI.stageRemoteText.textContent = 'paste an invite code to begin';
    UI.btnWatch.classList.add('hidden');
  }

  if (state.role === 'host' && hadFile) {
    UI.stepHost.classList.remove('hidden');
    UI.stepGuest.classList.add('hidden');
    chat.system('session reset — building a new invite');
    startHostSession();
    return;
  }

  if (state.role === 'host') {
    UI.stepHost.classList.remove('hidden');
    UI.stepGuest.classList.add('hidden');
    chat.system('session reset');
    setConnectBadge('choose a video');
  } else if (state.role === 'guest') {
    UI.stepGuest.classList.remove('hidden');
    UI.stepHost.classList.add('hidden');
    chat.system('session reset');
    setConnectBadge('paste a code');
  }

  setRoomBadge('waiting');
  setStatus('idle');
}

function teardownLink() {
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

function resetCodes() {
  UI.inviteOut.value = '';
  UI.inviteMeta.textContent = '';
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
  setConnectBadge('failed');
  toast(text, 'err');
}

function setStatus(text, kind = 'idle') {
  UI.statusText.textContent = text;
  UI.statusPill.dataset.state = kind;
}

function setConnectBadge(text, kind) {
  UI.connectBadge.textContent = text;
  if (kind) UI.connectBadge.dataset.state = kind;
  else UI.connectBadge.removeAttribute('data-state');
}

function setRoomBadge(text, kind) {
  UI.roomBadge.textContent = text;
  if (kind) UI.roomBadge.dataset.state = kind;
  else UI.roomBadge.removeAttribute('data-state');
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  UI.toasts.append(el);
  setTimeout(() => el.remove(), 6000);
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

function nickname() {
  const words = {
    a: ['silent', 'hollow', 'cold', 'pale', 'lost', 'quiet', 'empty', 'sharp', 'bitter', 'slow'],
    n: ['crow', 'moth', 'wolf', 'tide', 'ash', 'iron', 'raven', 'ghost', 'flame', 'dust'],
  };
  try {
    const saved = localStorage.getItem('w2g:name');
    if (saved) return saved;
  } catch { /* storage blocked */ }
  const name = pick(words.a) + ' ' + pick(words.n);
  try { localStorage.setItem('w2g:name', name); } catch { /* storage blocked */ }
  return name;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/* ── clipboard ────────────────────────────────────────────── */

document.addEventListener('click', async ev => {
  const chip = ev.target.closest('[data-copy]');
  if (!chip) return;
  const target = document.getElementById(chip.dataset.copy);
  const text = (target?.value ?? target?.textContent ?? '').trim();
  if (!text) {
    toast('nothing to copy yet', 'warn');
    return;
  }
  const ok = await copyText(text);
  if (!ok) {
    toast('copy failed — select the code and copy it manually', 'err');
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
  if (state.role !== 'host' || !state.connected) return;
  if (document.visibilityState === 'visible') {
    grabWakeLock();
  } else {
    toast('tab hidden — your stream may stall', 'warn');
  }
});

window.addEventListener('beforeunload', ev => {
  if (state.connected && state.role === 'host') {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

/* deep links: /#host and /#join */
if (location.hash === '#host') UI.btnHost.click();
else if (location.hash === '#join') UI.btnJoin.click();

/* debug handle, handy from the console */
window.__w2g = { state, player, chat };
