// server.js
// Minimal signaling server for a free, peer-to-peer WebRTC video/audio chat room.
// It never touches media streams — it only relays small JSON messages
// (who joined, SDP offers/answers, ICE candidates, chat text) between browsers.
// The actual audio/video/data flows directly between peers (mesh topology),
// so this server can run on the smallest free tier available.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> Map<socketId, { name }>
const rooms = new Map();

function getRoomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.entries()).map(([id, info]) => ({ id, name: info.name }));
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || typeof roomId !== 'string') return;
    currentRoom = roomId;
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    // Tell the newcomer about everyone already in the room
    const existingMembers = getRoomMembers(roomId);
    socket.emit('room-joined', {
      selfId: socket.id,
      members: existingMembers
    });

    // Add the newcomer to the room roster
    room.set(socket.id, { name: name || 'Guest' });

    // Tell everyone else a new peer arrived
    socket.to(roomId).emit('peer-joined', { id: socket.id, name: name || 'Guest' });
  });

  // WebRTC signaling relay: offer, answer, ice-candidate
  socket.on('signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Text chat relay
  socket.on('chat-message', ({ roomId, name, message }) => {
    if (!roomId || !message) return;
    io.to(roomId).emit('chat-message', {
      id: socket.id,
      name: name || 'Guest',
      message: String(message).slice(0, 2000),
      ts: Date.now()
    });
  });

  // Media state toggles (mute/camera) so UI can show correct icons for peers
  socket.on('media-state', ({ roomId, audio, video }) => {
    if (!roomId) return;
    socket.to(roomId).emit('media-state', { id: socket.id, audio, video });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(socket.id);
      if (rooms.get(currentRoom).size === 0) {
        rooms.delete(currentRoom);
      }
      socket.to(currentRoom).emit('peer-left', { id: socket.id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});
