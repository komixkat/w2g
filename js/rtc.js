/* One peer connection, one data channel. The host is the only one with media. */

import { pack, unpack, gatherComplete } from './signaling.js';

const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

export class Link {
  /**
   * handlers: onState(state), onStream(stream), onData(msg),
   *           onOpen(), onClose(), onStats({ kbps, rtt, dir })
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.pc = new RTCPeerConnection(ICE_CONFIG);
    this.dc = null;
    this.closed = false;
    this.timer = 0;
    this.prev = { out: { bytes: 0, ts: 0 }, in: { bytes: 0, ts: 0 } };

    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      this.h.onState?.(s);
      if (s === 'connected') {
        this._capBitrate();
        this._startStats();
      }
      if (s === 'failed' || s === 'closed' || s === 'disconnected') this._stopStats();
    });

    this.pc.addEventListener('track', ev => {
      // The offer may not carry msid, so build the stream ourselves.
      if (!this.remote) this.remote = new MediaStream();
      if (!this.remote.getTracks().some(t => t.id === ev.track.id)) {
        this.remote.addTrack(ev.track);
      }
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

    // Offer only the codecs that every supported browser shares. Chromium
    // otherwise lists a dozen H.264 profile variants, which triples the SDP
    // and pushes the invite code past chat-app message limits.
    this._limitVideoCodecs(['video/VP8', 'video/H264', 'video/rtx']);

    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gatherComplete(this.pc);
    return pack(this.pc.localDescription);
  }

  _limitVideoCodecs(mimes) {
    if (!RTCRtpSender.getCapabilities) return;
    const tx = this.pc.getTransceivers().find(t => t.sender?.track?.kind === 'video');
    if (!tx || !tx.setCodecPreferences) return;
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      const prefs = caps.codecs.filter(c => mimes.includes(c.mimeType));
      if (prefs.length) tx.setCodecPreferences(prefs);
    } catch { /* older browser; send the full codec list */ }
  }

  /** Apply the guest's reply code and finish negotiation. */
  async hostFinish(code) {
    const desc = await unpack(code);
    if (desc.type !== 'answer') throw new Error('that is an invite code, not a reply code');
    await this.pc.setRemoteDescription(desc);
  }

  /* ── guest ────────────────────────────────────────────── */

  /** Apply the host's invite and return the reply code. */
  async guestAnswer(code) {
    const desc = await unpack(code);
    if (desc.type !== 'offer') throw new Error('that is a reply code, not an invite code');
    await this.pc.setRemoteDescription(desc);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gatherComplete(this.pc);
    return pack(this.pc.localDescription);
  }

  /* ── both ─────────────────────────────────────────────── */

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
    this._stopStats();
    try { this.dc?.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
    // Silence late events from our own teardown so they cannot clobber
    // the UI state that replaces this link.
    this.h = {};
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

  _startStats() {
    this._stopStats();
    this.timer = setInterval(() => this._sampleStats(), 2000);
  }

  _stopStats() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }

  async _sampleStats() {
    if (this.closed) return;
    let report;
    try { report = await this.pc.getStats(); } catch { return; }

    const now = performance.now();
    let kbps = 0;
    let dir = 'out';
    let rtt = null;

    report.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        dir = 'out';
        kbps = this._rate('out', r.bytesSent, now);
      } else if (r.type === 'inbound-rtp' && r.kind === 'video' && !kbps) {
        dir = 'in';
        kbps = this._rate('in', r.bytesReceived, now);
      } else if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
        rtt = Math.round(r.currentRoundTripTime * 1000);
      }
    });

    this.h.onStats?.({ kbps, rtt, dir });
  }

  _rate(key, bytes, now) {
    const prev = this.prev[key];
    let kbps = 0;
    if (prev.ts && bytes >= prev.bytes) {
      const seconds = (now - prev.ts) / 1000;
      if (seconds > 0.2) kbps = Math.round(((bytes - prev.bytes) * 8) / seconds / 1000);
    }
    prev.bytes = bytes;
    prev.ts = now;
    return kbps;
  }
}
