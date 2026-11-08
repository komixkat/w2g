# w2g

Watch a local video together, peer-to-peer. No accounts, no uploads, no server.

## use

1. Enter a name and start a session. Pick a video.
2. Send the invite link. Your friend opens it, enters a name, and sends back the reply code.
3. Paste the reply and connect.

Only the host controls playback. The viewer follows the host's position and pause state.

## notes

- Chrome or Firefox. Video is capped at 12 Mbps; your upload speed is the real limit.
- Strict NAT or CGNAT may need a TURN relay. Add one to `ICE_CONFIG` in `js/rtc.js`.
- Keep the host tab open and the machine awake.

## local

```sh
python3 -m http.server 8000
```

Pushing to `main` deploys the repository root to GitHub Pages.
