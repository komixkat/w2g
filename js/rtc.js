/* One peer connection, one data channel. The room connects first; media is
   attached later and renegotiated over the data channel. */

import { pack, unpack, gatherComplete } from './signaling.js';

const ICE_CONFIG = {
  // One STUN server is enough to discover a public candidate and keeps the
  // invite code small.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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
    this.remote = null;

    this._videoTx = null;
    this._audioTx = null;
    this._negotiating = false;

    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      this.h.onState?.(s);
    });

    this.pc.addEventListener('track', ev => {
      if (!this.remote) this.remote = new MediaStream();
      if (!this.remote.getTracks().some(t => t.id === ev.track.id)) {
        this.remote.addTrack(ev.track);
      }
      // Keep the jitter buffer short so the viewer stays close to the host.
      try { ev.receiver.playoutDelayHint = 0; } catch { /* unsupported */ }
      try { ev.receiver.jitterBufferTarget = 0; } catch { /* unsupported */ }
      this.h.onStream?.(this.remote);
    });

    this.pc.addEventListener('datachannel', ev => this._wire(ev.channel));
    this.pc.addEventListener('negotiationneeded', () => this._renegotiate());
  }

  /* ── host: create the room (data channel only) ─────────────── */

  /**
   * Build an offer with only a data channel. Waiting for ICE gathering means
   * the invite code already contains every candidate, so the guest can reply
   * in one step.
   */
  async hostOffer() {
    this._wire(this.pc.createDataChannel('w2g', { ordered: true }));

    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gatherComplete(this.pc, 8000);
    return pack(this.pc.localDescription);
  }

  /** Apply the guest's reply and finish negotiation. */
  async hostFinish(code) {
    const desc = await unpack(code);
    if (desc.type !== 'answer') throw new Error('need a reply code');
    await this.pc.setRemoteDescription(desc);
  }

  /* ── guest: join the room ──────────────────────────────────── */

  /** Apply the host's invite and return the reply code. */
  async guestAnswer(code) {
    const desc = await unpack(code);
    if (desc.type !== 'offer') throw new Error('need an invite code');

    await this.pc.setRemoteDescription(desc);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    // The answer must carry candidates too; otherwise the host has nothing
    // to connect to once it applies the reply.
    await gatherComplete(this.pc, 8000);
    return pack(this.pc.localDescription);
  }

  /* ── both: attach or swap media after the room is live ─────── */

  /**
   * Attach (or replace) the outgoing video/audio tracks. Transceivers are
   * created lazily, which is what triggers renegotiation over the data
   * channel. Returns once the tracks are attached; negotiation continues in
   * the background.
   */
  async setStream(stream) {
    if (!stream) return;

    const vTrack = stream.getVideoTracks()[0] || null;
    const aTrack = stream.getAudioTracks()[0] || null;

    if (vTrack) {
      if (!this._videoTx) {
        this._videoTx = this.pc.addTransceiver(vTrack, {
          direction: 'sendonly',
          streams: [stream],
        });
        this._preferCodecs(this._videoTx, 'video', ['video/VP8', 'video/rtx']);
      } else {
        await this._videoTx.sender.replaceTrack(vTrack);
        if (this._videoTx.direction !== 'sendonly') {
          this._videoTx.direction = 'sendonly';
        }
      }
      try { vTrack.contentHint = 'motion'; } catch { /* unsupported */ }
    }

    if (aTrack) {
      if (!this._audioTx) {
        this._audioTx = this.pc.addTransceiver(aTrack, {
          direction: 'sendonly',
          streams: [stream],
        });
        this._preferCodecs(this._audioTx, 'audio', ['audio/opus']);
      } else {
        await this._audioTx.sender.replaceTrack(aTrack);
        if (this._audioTx.direction !== 'sendonly') {
          this._audioTx.direction = 'sendonly';
        }
      }
    }

    await this._capBitrate();
  }

  /** Detach outgoing media without ending the room. */
  async removeStream() {
    for (const tx of [this._videoTx, this._audioTx]) {
      if (!tx) continue;
      try {
        await tx.sender.replaceTrack(null);
        tx.direction = 'inactive';
      } catch { /* already gone */ }
    }
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
    this.h = {};
    try { this.dc?.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
  }

  /* ── internals ────────────────────────────────────────────── */

  _wire(channel) {
    this.dc = channel;
    channel.addEventListener('open', () => this.h.onOpen?.());
    channel.addEventListener('close', () => this.h.onClose?.());
    channel.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg?.t === 'sdp' && msg.desc?.sdp) {
        this._handleRemoteSdp(msg.desc);
        return;
      }
      this.h.onData?.(msg);
    });
  }

  _sendSdp(type, sdp) {
    if (!this.dc || this.dc.readyState !== 'open') return;
    try {
      this.dc.send(JSON.stringify({ t: 'sdp', desc: { type, sdp } }));
    } catch { /* channel is closing */ }
  }

  async _renegotiate() {
    if (this.closed || this._negotiating) return;
    if (this.pc.signalingState !== 'stable') return;

    this._negotiating = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      // The ICE transport is already established. New bundled m-lines reuse
      // it, so the raw SDP is enough here.
      this._sendSdp('offer', this.pc.localDescription.sdp);
    } catch (err) {
      console.warn('renegotiation failed', err);
    } finally {
      this._negotiating = false;
    }
  }

  async _handleRemoteSdp(desc) {
    try {
      if (desc.type === 'offer') {
        await this.pc.setRemoteDescription(desc);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this._sendSdp('answer', this.pc.localDescription.sdp);
      } else if (desc.type === 'answer') {
        await this.pc.setRemoteDescription(desc);
      }
    } catch (err) {
      console.warn('remote sdp failed', err);
    }
  }

  _preferCodecs(tx, kind, mimes) {
    if (!tx?.setCodecPreferences || !RTCRtpSender.getCapabilities) return;
    try {
      const prefs = RTCRtpSender.getCapabilities(kind).codecs
        .filter(c => mimes.includes(c.mimeType));
      if (prefs.length) tx.setCodecPreferences(prefs);
    } catch { /* older browser; keep the default list */ }
  }

  async _capBitrate(max = 12_000_000) {
    const sender = this._videoTx?.sender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = max;
      await sender.setParameters(params);
    } catch { /* browser refused; default bitrate is fine */ }
  }
}
