/* One peer connection, one data channel. The host is the only one with media. */

import { pack, unpack, gatherComplete } from './signaling.js';

const ICE_CONFIG = {
  iceCandidatePoolSize: 2,
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

export class Link {
  /**
   * handlers: onState(state), onStream(stream), onData(msg),
   *           onOpen(), onClose()
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.pc = new RTCPeerConnection(ICE_CONFIG);
    this.dc = null;
    this.closed = false;

    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      this.h.onState?.(s);
      if (s === 'connected') this._capBitrate();
    });

    this.pc.addEventListener('track', ev => {
      // The offer may not carry msid, so build the stream ourselves.
      if (!this.remote) this.remote = new MediaStream();
      if (!this.remote.getTracks().some(t => t.id === ev.track.id)) {
        this.remote.addTrack(ev.track);
      }
      // Keep the jitter buffer short so the viewer stays close to the host.
      try { ev.receiver.playoutDelayHint = 0; } catch { /* not supported */ }
      try { ev.receiver.jitterBufferTarget = 0; } catch { /* not supported */ }
      this.h.onStream?.(this.remote);
    });

    this.pc.addEventListener('datachannel', ev => this._wire(ev.channel));
  }

  /* ── host ─────────────────────────────────────────────── */

  /** Build an offer for `stream` and return the invite code. */
  async hostOffer(stream) {
    this._wire(this.pc.createDataChannel('w2g', { ordered: true }));

    for (const track of stream.getTracks()) {
      if (track.kind === 'video') {
        try { track.contentHint = 'motion'; } catch { /* not supported */ }
      }
      this.pc.addTrack(track, stream);
    }

    // One audio codec and one video codec keeps the SDP small. VP8 + Opus
    // work in every browser this app supports, and dropping the H.264
    // profile variants cuts the invite code roughly in half.
    this._limitCodecs('audio', ['audio/opus']);
    this._limitCodecs('video', ['video/VP8', 'video/rtx']);

    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gatherComplete(this.pc);
    return pack(this.pc.localDescription);
  }

  _limitCodecs(kind, mimes) {
    if (!RTCRtpSender.getCapabilities) return;
    const tx = this.pc.getTransceivers().find(t => t.sender?.track?.kind === kind);
    if (!tx || !tx.setCodecPreferences) return;
    try {
      const caps = RTCRtpSender.getCapabilities(kind);
      const prefs = caps.codecs.filter(c => mimes.includes(c.mimeType));
      if (prefs.length) tx.setCodecPreferences(prefs);
    } catch { /* older browser; send the full codec list */ }
  }

  /** Apply the guest's reply code and finish negotiation. */
  async hostFinish(code) {
    const desc = await unpack(code);
    if (desc.type !== 'answer') throw new Error('need a reply code');
    await this.pc.setRemoteDescription(desc);
  }

  /* ── guest ────────────────────────────────────────────── */

  /** Apply the host's invite and return the reply code. */
  async guestAnswer(code) {
    const desc = await unpack(code);
    if (desc.type !== 'offer') throw new Error('need an invite code');
    await this.pc.setRemoteDescription(desc);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gatherComplete(this.pc);
    return pack(this.pc.localDescription);
  }

  /* ── both ─────────────────────────────────────────────── */

  /** Swap outgoing media without renegotiating. Pass null to detach. */
  async setStream(stream) {
    const jobs = [];
    for (const tx of this.pc.getTransceivers()) {
      const kind = tx.receiver?.track?.kind || tx.sender?.track?.kind;
      if (!kind) continue;
      const track = stream ? stream.getTracks().find(t => t.kind === kind) || null : null;
      if (!track && !tx.sender.track) continue;
      jobs.push(tx.sender.replaceTrack(track).catch(() => {}));
    }
    await Promise.all(jobs);
  }

  send(msg) {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    try {
      this.dc.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.closed = true;
    // Silence every late event from our own teardown before it can fire and
    // clobber the UI state that replaces this link.
    this.h = {};
    try { this.dc?.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
  }

  /* ── internals ────────────────────────────────────────── */

  _wire(channel) {
    this.dc = channel;
    channel.addEventListener('open', () => this.h.onOpen?.());
    channel.addEventListener('close', () => this.h.onClose?.());
    channel.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.h.onData?.(msg);
    });
  }

  async _capBitrate(max = 12_000_000) {
    const sender = this.pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = max;
      await sender.setParameters(params);
    } catch { /* browser refused; default bitrate is fine */ }
  }
}
