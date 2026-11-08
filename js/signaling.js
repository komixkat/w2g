/* Signaling without a server: serialise the SDP offer/answer, deflate it,
   base64url it, and let the humans carry it across. */

const TAG = 'w2g1';
const COMPRESS = typeof CompressionStream !== 'undefined';

/* Lines the far side can regenerate or live without. Dropping them keeps a
   code inside the message limit of typical chat apps. */
const STRIP = /^(a=ssrc|a=msid|a=msid-semantic|a=extmap-allow-mixed|a=rtcp:|a=ice-options)/;

/* Header extensions matter: transport-cc drives the bandwidth estimate and
   mid keeps bundled RTP demuxable. The rest (orientation, playout-delay,
   color-space, …) can be left out. */
const KEEP_EXTMAP = /^a=extmap:\d+ (urn:ietf:params:rtp-hdrext:sdes:mid|http:\/\/www\.ietf\.org\/id\/draft-holmer-rmcat-transport-wide-cc-extensions-01)$/;

function minify(sdp) {
  const out = [];
  let section = -1;
  for (const line of String(sdp).split('\r\n')) {
    if (line.startsWith('m=')) section++;
    if (STRIP.test(line)) continue;
    if (line.startsWith('a=extmap') && !KEEP_EXTMAP.test(line)) continue;
    // BUNDLE means every section shares one transport; candidates from the
    // first section are enough. Repeating them in each section triples that
    // part of the code.
    if (line.startsWith('a=candidate:') && section > 0) continue;
    out.push(line);
  }
  return out.join('\r\n');
}

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(text) {
  let s = text.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compress + encode an RTCSessionDescription into a pasteable code. */
export async function pack(desc) {
  const json = JSON.stringify({ t: TAG, type: desc.type, sdp: minify(desc.sdp) });
  const raw = new TextEncoder().encode(json);
  if (!COMPRESS) return 'p.' + toB64(raw);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return 'z.' + toB64(out);
}

/** Pull the code out of a pasted link, or accept a bare code. */
function extractCode(input) {
  const text = String(input || '').trim();
  const linked = text.match(/#(?:i|r)\.([A-Za-z0-9_.-]+)/);
  return linked ? linked[1] : text.replace(/\s+/g, '');
}

/** Decode a code back into { type, sdp }. Throws on anything malformed. */
export async function unpack(code) {
  const clean = extractCode(code);
  if (clean.length < 8) throw new Error('code is too short');

  const mode = clean.slice(0, 2);
  if (mode !== 'z.' && mode !== 'p.') throw new Error('not a w2g code');

  let bytes = fromB64(clean.slice(2));
  if (mode === 'z.') {
    if (!COMPRESS) throw new Error('browser cannot read compressed codes');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }

  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('code is incomplete or corrupted');
  }
  if (!msg || msg.t !== TAG || !msg.sdp || !msg.type) throw new Error('not a w2g code');
  return { type: msg.type, sdp: msg.sdp };
}

/**
 * Wait until ICE gathering finishes so the code contains every candidate.
 * Resolves early after `timeout` ms — the connection usually still works
 * with the candidates gathered so far.
 */
export function gatherComplete(pc, timeout = 10000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(finish, timeout);
    pc.addEventListener('icegatheringstatechange', check);
  });
}
