import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import roomApiHandler from './api/room.js';
import {
  addRoomMessage,
  addSignalPacket,
  addVoiceChunk,
  getRoomSnapshot,
  normalizeRoomId,
  removeParticipant,
  upsertParticipant,
} from './src/shared/roomStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ClientMeta {
  ws: WebSocket;
  roomId: string;
  peerId: string;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  // Allow up to 10MB JSON payloads for audio chunks
  app.use(express.json({ limit: '10mb' }));

  // Mount the Vercel-compatible /api/room route
  app.all('/api/room', (req, res) => {
    roomApiHandler(req, res);
  });

  // WebSocket Server on /ws for instant (<50ms) delivery when running on stateful host
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<ClientMeta>();

  function broadcastToRoom(roomId: string, payload: unknown, excludePeerId?: string) {
    const normalized = normalizeRoomId(roomId);
    const serialized = JSON.stringify(payload);
    for (const client of clients) {
      if (
        client.roomId === normalized &&
        client.ws.readyState === WebSocket.OPEN &&
        (!excludePeerId || client.peerId !== excludePeerId)
      ) {
        client.ws.send(serialized);
      }
    }
  }

  function broadcastParticipants(roomId: string) {
    const normalized = normalizeRoomId(roomId);
    const snapshot = getRoomSnapshot(normalized, '', 0);
    broadcastToRoom(normalized, {
      type: 'participants:update',
      roomId: normalized,
      participants: snapshot.participants,
    });
  }

  wss.on('connection', (ws) => {
    const meta: ClientMeta = {
      ws,
      roomId: 'SQUAD',
      peerId: '',
    };
    clients.add(meta);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const roomId = normalizeRoomId(data.roomId || meta.roomId || 'SQUAD');

        if (data.type === 'room:join' || data.type === 'participant:update') {
          const p = data.participant;
          if (p && p.id) {
            meta.roomId = roomId;
            meta.peerId = String(p.id);
            upsertParticipant(roomId, {
              id: String(p.id),
              name: String(p.name || 'Friend').slice(0, 24),
              avatarId: String(p.avatarId || 'headset'),
              color: String(p.color || 'indigo'),
              micMode: p.micMode === 'open' || p.micMode === 'ptt' ? p.micMode : 'muted',
              isSpeaking: Boolean(p.isSpeaking),
              audioLevel: Number(p.audioLevel || 0),
              inBackground: Boolean(p.inBackground),
            });

            if (data.type === 'room:join') {
              const snapshot = getRoomSnapshot(roomId, meta.peerId, 0);
              ws.send(
                JSON.stringify({
                  type: 'room:init',
                  ...snapshot,
                })
              );
            }
            broadcastParticipants(roomId);
          }
        } else if (data.type === 'voice:chunk') {
          const chunk = data.chunk;
          if (chunk && chunk.id && chunk.audioDataUrl) {
            const { packet, feedMessage } = addVoiceChunk(roomId, {
              id: String(chunk.id),
              roomId,
              senderId: String(chunk.senderId),
              senderName: String(chunk.senderName || 'Friend'),
              senderColor: String(chunk.senderColor || 'indigo'),
              senderAvatar: String(chunk.senderAvatar || 'headset'),
              audioDataUrl: String(chunk.audioDataUrl),
              durationMs: Number(chunk.durationMs || 1000),
              peakLevel: Number(chunk.peakLevel || 65),
              saveToFeed: Boolean(chunk.saveToFeed),
              label: chunk.label ? String(chunk.label) : undefined,
            });

            // Broadcast voice chunk to everyone in room (or back to sender if echoTest)
            broadcastToRoom(
              roomId,
              {
                type: 'voice:chunk',
                packet,
                feedMessage,
              },
              chunk.echoTest ? undefined : String(chunk.senderId)
            );
            broadcastParticipants(roomId);
          }
        } else if (data.type === 'room:message') {
          const msg = data.message;
          if (msg && msg.id) {
            const { message } = addRoomMessage(roomId, {
              id: String(msg.id),
              roomId,
              senderId: String(msg.senderId),
              senderName: String(msg.senderName || 'Friend'),
              senderColor: String(msg.senderColor || 'indigo'),
              senderAvatar: String(msg.senderAvatar || 'headset'),
              type: msg.type === 'callout' || msg.type === 'voice_clip' ? msg.type : 'text',
              text: String(msg.text || '').slice(0, 300),
              soundId: msg.soundId ? String(msg.soundId) : undefined,
              audioDataUrl: msg.audioDataUrl ? String(msg.audioDataUrl) : undefined,
              durationMs: msg.durationMs ? Number(msg.durationMs) : undefined,
            });
            broadcastToRoom(roomId, {
              type: 'room:message',
              message,
            });
          }
        } else if (data.type === 'webrtc:signal') {
          const sig = data.signal;
          if (sig && sig.toPeerId && sig.fromPeerId) {
            const { packet } = addSignalPacket(roomId, {
              id: String(sig.id || `${Date.now()}-${Math.random()}`),
              roomId,
              fromPeerId: String(sig.fromPeerId),
              toPeerId: String(sig.toPeerId),
              signalType: sig.signalType,
              payload: sig.payload,
            });
            for (const client of clients) {
              if (
                client.roomId === roomId &&
                client.peerId === sig.toPeerId &&
                client.ws.readyState === WebSocket.OPEN
              ) {
                client.ws.send(
                  JSON.stringify({
                    type: 'webrtc:signal',
                    signal: packet,
                  })
                );
              }
            }
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(meta);
      if (meta.peerId && meta.roomId) {
        removeParticipant(meta.roomId, meta.peerId);
        broadcastParticipants(meta.roomId);
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SquadTalk server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
