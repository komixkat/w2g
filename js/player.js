/* Local file playback + the MediaStream we hand to WebRTC. */

export class LocalPlayer {
  constructor(video, onChange) {
    this.video = video;
    this.onChange = onChange;
    this.url = null;
    this.stream = null;
    this.meta = null;

    for (const ev of ['play', 'pause', 'seeked', 'timeupdate', 'ended', 'loadedmetadata']) {
      video.addEventListener(ev, () => this.onChange?.(this.snapshot(), ev));
    }
  }

  /** Point the element at a File and wait until it is decodable. */
  async load(file) {
    this.release();

    if (!URL.createObjectURL) throw new Error('this browser cannot open local files');

    this.url = URL.createObjectURL(file);
    this.video.src = this.url;
    this.video.controls = true;

    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error('this file cannot be played by your browser')); };
      const cleanup = () => {
        this.video.removeEventListener('loadedmetadata', ok);
        this.video.removeEventListener('error', bad);
      };
      this.video.addEventListener('loadedmetadata', ok);
      this.video.addEventListener('error', bad);
      this.video.load();
    });

    this.meta = { name: file.name, duration: Number.isFinite(this.video.duration) ? this.video.duration : 0 };
    return this.meta;
  }

  /** Lazily capture the element's output as a MediaStream (video + audio). */
  capture() {
    if (this.stream) return this.stream;
    const capture =
      this.video.captureStream?.bind(this.video) ||
      this.video.mozCaptureStream?.bind(this.video);
    if (!capture) {
      throw new Error('this browser cannot capture video. try chrome or firefox.');
    }
    this.stream = capture();
    return this.stream;
  }

  snapshot() {
    const v = this.video;
    return {
      paused: v.paused,
      time: Number.isFinite(v.currentTime) ? v.currentTime : 0,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      ended: v.ended,
      hasMedia: !!this.url,
    };
  }

  release() {
    // A media element that is being captured stays bound to its old source;
    // stop the tracks or the next file will never reach loadedmetadata.
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch { /* already ended */ }
      }
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.stream = null;
    this.meta = null;
    this.video.removeAttribute('src');
    this.video.removeAttribute('data-live');
    this.video.controls = false;
    try { this.video.load(); } catch { /* nothing to reset */ }
  }
}
