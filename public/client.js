// client.js
// Peer-to-peer mesh WebRTC video call. The signaling server only relays
// small JSON messages (offer/answer/ICE + chat text) — actual audio/video
// travels directly between browsers.

// Free public STUN servers (no account needed). STUN just helps peers
// discover their public IP/port; it carries no media and costs nothing.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const socket = io();

// ---------- State ----------
let localStream = null;
let screenStream = null;
let roomId = null;
let myName = null;
let selfId = null;
const peers = new Map(); // socketId -> { pc, name, tile }
let micOn = true;
let camOn = true;
let chatVisible = true;
const pendingNames = new Map(); // socketId -> name, for peers announced before their offer arrives

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const lobby = $('lobby');
const callScreen = $('callScreen');
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const previewVideo = $('previewVideo');
const previewPlaceholder = $('previewPlaceholder');
const joinBtn = $('joinBtn');
const lobbyError = $('lobbyError');
const videoGrid = $('videoGrid');
const roomLabel = $('roomLabel');
const participantCount = $('participantCount');
const chatPanel = $('chatPanel');
const chatMessages = $('chatMessages');
const chatForm = $('chatForm');
const chatInput = $('chatInput');
const toast = $('toast');

// ---------- Helpers ----------
function showToast(msg, ms = 2500) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
}

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}

function randomRoomCode() {
  const words = ['coral', 'ember', 'lunar', 'quartz', 'delta', 'birch', 'amber', 'tidal', 'pixel', 'sage'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(100 + Math.random() * 900);
  return `${w}-${n}`;
}

function getRoomFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('room');
}

// ---------- Lobby: camera preview ----------
async function startLocalPreview() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    previewVideo.srcObject = localStream;
    previewPlaceholder.classList.add('hidden');
  } catch (err) {
    console.error('getUserMedia failed', err);
    previewPlaceholder.textContent = 'Camera/mic blocked — you can still join with them off';
    lobbyError.textContent = 'Could not access camera/microphone. Check browser permissions.';
  }
}

const prefill = getRoomFromURL();
if (prefill) roomInput.value = prefill;
startLocalPreview();

$('generateRoomBtn').addEventListener('click', () => {
  roomInput.value = randomRoomCode();
});

$('toggleMicLobby').addEventListener('click', (e) => {
  micOn = !micOn;
  e.currentTarget.classList.toggle('active', micOn);
  e.currentTarget.textContent = micOn ? '🎤 Mic on' : '🎤 Mic off';
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
});

$('toggleCamLobby').addEventListener('click', (e) => {
  camOn = !camOn;
  e.currentTarget.classList.toggle('active', camOn);
  e.currentTarget.textContent = camOn ? '📷 Cam on' : '📷 Cam off';
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camOn);
});

// ---------- Join flow ----------
joinBtn.addEventListener('click', joinRoom);
[nameInput, roomInput].forEach(el => el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
}));

function joinRoom() {
  const name = nameInput.value.trim() || 'Guest';
  const room = roomInput.value.trim();
  if (!room) {
    lobbyError.textContent = 'Enter a room code (or generate one) to continue.';
    return;
  }
  myName = name;
  roomId = room;

  lobby.classList.add('hidden');
  callScreen.classList.remove('hidden');
  roomLabel.textContent = `# ${roomId}`;

  addLocalTile();
  socket.emit('join-room', { roomId, name: myName });

  history.replaceState(null, '', `?room=${encodeURIComponent(roomId)}`);
}

// ---------- Video tiles ----------
function makeTile(id, name, isLocal) {
  const tile = document.createElement('div');
  tile.className = 'video-tile' + (isLocal ? ' local' : '');
  tile.id = `tile-${id}`;
  tile.innerHTML = `
    <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
    <div class="avatar-fallback">${initials(name)}</div>
    <div class="name-tag"><span class="mute-icon">🎤</span><span class="tag-name">${escapeHTML(name)}${isLocal ? ' (you)' : ''}</span></div>
  `;
  videoGrid.appendChild(tile);
  return tile;
}

function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function addLocalTile() {
  const tile = makeTile(selfId || 'local', myName, true);
  const video = tile.querySelector('video');
  if (localStream) video.srcObject = localStream;
  updateParticipantCount();
}

function updateParticipantCount() {
  participantCount.textContent = videoGrid.children.length;
}

// ---------- WebRTC peer connection management ----------
function createPeerConnection(peerId, name) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  const tile = makeTile(peerId, name, false);
  const remoteVideo = tile.querySelector('video');
  const remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: peerId, data: { type: 'ice-candidate', candidate: event.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      // Let disconnect/peer-left handle cleanup; this just logs for debugging.
      console.log(`Connection to ${peerId}: ${pc.connectionState}`);
    }
  };

  peers.set(peerId, { pc, name, tile });
  updateParticipantCount();
  return pc;
}

async function callPeer(peerId, name) {
  const pc = createPeerConnection(peerId, name);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: offer } });
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.pc.close();
  peer.tile.remove();
  peers.delete(peerId);
  updateParticipantCount();
}

// ---------- Socket signaling handlers ----------
socket.on('room-joined', ({ selfId: id, members }) => {
  selfId = id;
  document.getElementById(`tile-local`)?.setAttribute('id', `tile-${selfId}`);
  members.forEach(m => callPeer(m.id, m.name));
  addSystemMessage(`You joined the room as ${myName}.`);
});

socket.on('peer-joined', ({ id, name }) => {
  pendingNames.set(id, name);
  addSystemMessage(`${name} joined the call.`);
  // The existing peer waits for the newcomer's offer (newcomer calls everyone
  // already present, per room-joined handler above). We stash the name here
  // so that when the offer arrives (handled in 'signal' below), the tile is
  // created with the real name instead of a generic placeholder.
});

socket.on('signal', async ({ from, data }) => {
  let peer = peers.get(from);

  if (data.type === 'offer') {
    if (!peer) {
      const name = pendingNames.get(from) || 'Guest';
      createPeerConnection(from, name);
      pendingNames.delete(from);
      peer = peers.get(from);
    }
    await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });
  } else if (data.type === 'answer') {
    if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === 'ice-candidate') {
    if (peer) {
      try { await peer.pc.addIceCandidate(data.candidate); }
      catch (err) { console.warn('ICE add failed', err); }
    }
  }
});

socket.on('peer-left', ({ id }) => {
  const peer = peers.get(id);
  if (peer) addSystemMessage(`${peer.name} left the call.`);
  removePeer(id);
});

socket.on('media-state', ({ id, audio, video }) => {
  const peer = peers.get(id);
  if (!peer) return;
  peer.tile.classList.toggle('cam-off', video === false);
  peer.tile.querySelector('.mute-icon').textContent = audio === false ? '🔇' : '🎤';
});

socket.on('chat-message', ({ id, name, message }) => {
  addChatMessage(name, message, id === selfId);
});

// ---------- Chat ----------
function addChatMessage(name, message, isSelf) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="who">${escapeHTML(isSelf ? 'You' : name)}</span>${escapeHTML(message)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat-message', { roomId, name: myName, message: msg });
  chatInput.value = '';
});

// ---------- Controls ----------
$('toggleMicBtn').addEventListener('click', (e) => {
  micOn = !micOn;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  e.currentTarget.classList.toggle('active', micOn);
  e.currentTarget.classList.toggle('off', !micOn);
  socket.emit('media-state', { roomId, audio: micOn, video: camOn });
});

$('toggleCamBtn').addEventListener('click', (e) => {
  camOn = !camOn;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  e.currentTarget.classList.toggle('active', camOn);
  e.currentTarget.classList.toggle('off', !camOn);
  document.getElementById(`tile-${selfId}`)?.classList.toggle('cam-off', !camOn);
  socket.emit('media-state', { roomId, audio: micOn, video: camOn });
});

$('toggleChatBtn').addEventListener('click', () => {
  chatVisible = !chatVisible;
  chatPanel.classList.toggle('hidden', !chatVisible);
});
$('closeChatBtn').addEventListener('click', () => {
  chatVisible = false;
  chatPanel.classList.add('hidden');
});

$('copyLinkBtn').addEventListener('click', async () => {
  const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('Invite link copied to clipboard');
  } catch {
    showToast(url, 5000);
  }
});

$('shareScreenBtn').addEventListener('click', async () => {
  const btn = $('shareScreenBtn');
  if (!screenStream) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      // Swap the outgoing video track on every peer connection
      peers.forEach(({ pc }) => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      });

      // Show our own screen share in the local tile too
      const localTile = document.getElementById(`tile-${selfId}`);
      if (localTile) localTile.querySelector('video').srcObject = screenStream;

      btn.classList.add('active');
      screenTrack.onended = () => stopScreenShare();
    } catch (err) {
      console.warn('Screen share cancelled or failed', err);
    }
  } else {
    stopScreenShare();
  }
});

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;

  const camTrack = localStream ? localStream.getVideoTracks()[0] : null;
  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender && camTrack) sender.replaceTrack(camTrack);
  });

  const localTile = document.getElementById(`tile-${selfId}`);
  if (localTile && localStream) localTile.querySelector('video').srcObject = localStream;

  $('shareScreenBtn').classList.remove('active');
}

$('leaveBtn').addEventListener('click', () => {
  if (confirm('Leave the call?')) {
    window.location.href = window.location.pathname;
  }
});

window.addEventListener('beforeunload', () => {
  peers.forEach(({ pc }) => pc.close());
});
