# Huddle — free P2P video call rooms (WebRTC)

A self-hosted video/audio call + chat room, built on WebRTC. Calls are
peer-to-peer (mesh) — audio and video travel directly between browsers, so
there's nothing to pay for even with many simultaneous rooms. The Node
server only does "signaling": it introduces peers to each other and relays
tiny text messages (who joined, connection setup info, chat text).

## Features
- Multi-person video/audio calls (mesh — works great for 2–6 people; see note below for larger rooms)
- Text chat alongside the call
- Mute mic / turn camera off, with live status shown to others
- Screen sharing
- Shareable room links (`yoursite.com?room=tuesday-standup`)
- No accounts, no database, no paid APIs — uses Google's free public STUN servers

## Run it locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Open http://localhost:3000 in two different browser tabs (or two devices)
to test a call with yourself.

## Deploy it for free

Any host with a free tier that supports long-running Node processes + WebSockets works. Two easy options:

### Render.com (free web service)
1. Push this folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo.
3. Build command: `npm install`  •  Start command: `npm start`
4. Deploy. Render gives you a free `https://yourapp.onrender.com` URL.

### Railway.app / Glitch / Fly.io
All support `npm install && npm start` Node apps on a free tier — import the repo and deploy with default settings.

**Important:** Browsers only allow camera/mic access over `https://` (or
`localhost`). Every option above gives you HTTPS automatically, so you're
covered as soon as you deploy.

## How it works

1. Both browsers connect to the Node server over Socket.io and join the same "room" (just a shared string in the URL).
2. The server tells each peer who else is in the room.
3. Peers exchange WebRTC "offers/answers" (connection descriptions) and ICE candidates (network paths) through the server.
4. Once that handshake finishes, the browsers open a **direct** connection to each other and stream audio/video/chat — the server is no longer in that path at all.

This is why it stays free: the server's job is tiny (a few KB of text per
call), while the heavy media traffic never touches it.

## A note on scale and NAT

- This uses a **mesh** topology: every participant connects directly to every other participant. It works well for small groups (roughly 2–6 people); each additional person adds more upload bandwidth for everyone, since your camera has to be sent to every other participant separately.
- For most home/office networks, the free STUN servers are enough to establish a direct connection. A minority of networks (strict corporate firewalls, some mobile carriers) require a "TURN" relay server to connect at all — those aren't free to run at scale. If you hit connection failures only on specific networks, that's the likely cause. For a fully free hobby project this is a reasonable tradeoff; for guaranteed connectivity everywhere, you'd add a TURN server (e.g. via a provider like Twilio or self-hosted coturn), which has server bandwidth costs.
- For larger rooms (10+), you'd typically move to an SFU (Selective Forwarding Unit) architecture instead of mesh — that's a bigger project than this starter.

## File structure

```
webrtc-room/
├── server.js          # Express + Socket.io signaling server
├── package.json
└── public/
    ├── index.html      # Lobby + call UI
    ├── style.css
    └── client.js       # WebRTC mesh logic, chat, controls
```
