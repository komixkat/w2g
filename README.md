# w2g_

Watch the same local video file with one other person, at the same time.

The site is static. There is no server, no account, and no upload: you pick a
video from your disk, and it is streamed straight to your friend's browser over
WebRTC. The two of you exchange connection codes by hand (Discord, Signal,
wherever), which is what replaces the signalling server.

## how it works

1. **Start a session**, pick a video file. Your browser builds an *invite code*
   (a deflated SDP offer with ICE candidates).
2. Send that code to your friend. They open the site, **Join a session**, paste
   it, and get a *reply code* back.
3. Paste the reply code into your side and press **connect**.
4. The video streams peer-to-peer. Chat travels over a WebRTC data channel.

Because both codes are generated locally, nothing about the session ever
touches a third party except STUN, which is used only to discover a network
path between the two browsers.

## notes

- **Your upload speed is the ceiling.** Video is re-encoded for the peer, capped
  at 12 Mbps. 1080p usually looks fine; 4K is still a stretch.
- **Only the host controls playback.** Your friend watches the live stream, so
  pausing, seeking and volume are yours. They see your position and when you pause.
- **Keep the tab open and your machine awake.** Screen Wake Lock is requested
  while connected, but a closed tab ends the session.
- **Strict NATs can block the connection.** If the status never reaches
  *connected*, the two networks need a TURN relay; add one to `ICE_CONFIG` in
  `js/rtc.js`.
- **Chrome / Firefox** are the supported browsers (`captureStream` is the weak
  spot on Safari).

## files

```
index.html            markup for the landing page and the room
styles.css            flat dark theme: 28px grid, hairline borders, one accent
js/main.js            UI state machine, wiring, chat, wake lock
js/signaling.js       SDP <-> pasteable code (deflate + base64url)
js/rtc.js             RTCPeerConnection, data channel, bitrate cap, stats
js/player.js          local file -> <video> -> MediaStream
js/chat.js            chat rendering
oneko.js              the cat (MIT, adryd325/oneko.js)
fonts/Monocraft-Bold.otf   display font (OFL, IdreesInc/Monocraft)
```

No build step. To preview locally:

```sh
python3 -m http.server 8000
# http://localhost:8000
```

WebRTC needs a secure context; `localhost` counts. For a real test with two
people, push and use the Pages URL.

## deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which publishes the
repository root to GitHub Pages.
