import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  addRoomMessage,
  addVoiceChunk,
  getRoomSnapshot,
  SINGLE_ROOM_ID,
  removeParticipant,
  upsertParticipant,
} from './src/shared/roomStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ClientMeta {
  ws: WebSocket;
  peerId: string;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<ClientMeta>();

  function broadcastToAll(payload: unknown, excludePeerId?: string) {
    const serialized = JSON.stringify(payload);
    for (const client of clients) {
      if (
        client.ws.readyState === WebSocket.OPEN &&
        (!excludePeerId || client.peerId !== excludePeerId)
      ) {
        client.ws.send(serialized);
      }
    }
  }

  function broadcastParticipants() {
    const snapshot = getRoomSnapshot(SINGLE_ROOM_ID, '', 0);
    broadcastToAll({
      type: 'participants:update',
      roomId: SINGLE_ROOM_ID,
      participants: snapshot.participants,
    });
  }

  wss.on('connection', (ws) => {
    const meta: ClientMeta = {
      ws,
      peerId: '',
    };
    clients.add(meta);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        if (data.type === 'room:join' || data.type === 'participant:update') {
          const p = data.participant;
          if (p && p.id) {
            meta.peerId = String(p.id);
            upsertParticipant(SINGLE_ROOM_ID, {
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
              const snapshot = getRoomSnapshot(SINGLE_ROOM_ID, meta.peerId, 0);
              ws.send(
                JSON.stringify({
                  type: 'room:init',
                  ...snapshot,
                })
              );
            }
            broadcastParticipants();
          }
        } else if (data.type === 'voice:chunk') {
          const chunk = data.chunk;
          if (chunk && chunk.id && chunk.audioDataUrl) {
            const { packet, feedMessage } = addVoiceChunk(SINGLE_ROOM_ID, {
              id: String(chunk.id),
              roomId: SINGLE_ROOM_ID,
              senderId: String(chunk.senderId),
              senderName: String(chunk.senderName || 'Friend'),
              senderColor: String(chunk.senderColor || 'indigo'),
              senderAvatar: String(chunk.senderAvatar || 'headset'),
              audioDataUrl: String(chunk.audioDataUrl),
              durationMs: Number(chunk.durationMs || 250),
              peakLevel: Number(chunk.peakLevel || 65),
              saveToFeed: Boolean(chunk.saveToFeed),
              label: chunk.label ? String(chunk.label) : undefined,
            });

            broadcastToAll(
              {
                type: 'voice:chunk',
                packet,
                feedMessage,
              },
              chunk.echoTest ? undefined : String(chunk.senderId)
            );
            broadcastParticipants();
          }
        } else if (data.type === 'room:message') {
          const msg = data.message;
          if (msg && msg.id) {
            const { message } = addRoomMessage(SINGLE_ROOM_ID, {
              id: String(msg.id),
              roomId: SINGLE_ROOM_ID,
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
            broadcastToAll({
              type: 'room:message',
              message,
            });
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(meta);
      if (meta.peerId) {
        removeParticipant(SINGLE_ROOM_ID, meta.peerId);
        broadcastParticipants();
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
