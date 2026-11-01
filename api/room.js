// Plain JavaScript Vercel Hobby Plan Serverless Function (/api/room.js)
// Zero TypeScript compilation issues on Vercel + shares state with server.ts

const SINGLE_ROOM_ID = 'MAIN';
const PARTICIPANT_TTL_MS = 18_000;
const CHUNK_RETENTION_MS = 45_000;
const MAX_MESSAGES_PER_ROOM = 60;
const MAX_CHUNKS_PER_ROOM = 80;

const globalStore = globalThis;

function getRoom() {
  if (!globalStore.__SQUADTALK_SINGLE_ROOM__) {
    globalStore.__SQUADTALK_SINGLE_ROOM__ = {
      roomId: SINGLE_ROOM_ID,
      seqCounter: 1,
      participants: new Map(),
      voiceChunks: [],
      messages: [
        {
          id: 'welcome-main',
          roomId: SINGLE_ROOM_ID,
          senderId: 'system',
          senderName: 'Hangout',
          senderColor: 'indigo',
          senderAvatar: 'headset',
          type: 'text',
          text: 'Welcome! Tap Join Hangout to start talking—your mic and speaker stay active in the background when you switch to another app or game.',
          timestamp: Date.now(),
        },
      ],
      signals: [],
    };
  }
  const room = globalStore.__SQUADTALK_SINGLE_ROOM__;
  const now = Date.now();
  for (const [peerId, participant] of room.participants.entries()) {
    if (now - participant.lastSeenAt > PARTICIPANT_TTL_MS) {
      room.participants.delete(peerId);
    }
  }
  room.voiceChunks = room.voiceChunks.filter(
    (c) => now - c.timestamp < CHUNK_RETENTION_MS
  );
  if (room.voiceChunks.length > MAX_CHUNKS_PER_ROOM) {
    room.voiceChunks = room.voiceChunks.slice(-MAX_CHUNKS_PER_ROOM);
  }
  room.signals = room.signals.filter((s) => now - s.timestamp < 20_000);
  return room;
}

function getSnapshot(peerId, sinceSeq = 0) {
  const room = getRoom();
  const participants = Array.from(room.participants.values()).sort(
    (a, b) => a.joinedAt - b.joinedAt
  );
  const voiceChunks = room.voiceChunks.filter((c) => c.seq > sinceSeq);
  const signals = room.signals.filter((s) => s.toPeerId === peerId);
  if (signals.length > 0) {
    const deliveredIds = new Set(signals.map((s) => s.id));
    room.signals = room.signals.filter((s) => !deliveredIds.has(s.id));
  }
  return {
    roomId: SINGLE_ROOM_ID,
    latestSeq: room.seqCounter - 1,
    participants,
    voiceChunks,
    messages: room.messages,
    signals,
  };
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (req.method === 'GET') {
    const mode = String(req.query?.mode || '');
    if (mode === 'directory') {
      const room = getRoom();
      const list = Array.from(room.participants.values());
      return res.status(200).json({
        rooms: [
          {
            roomId: SINGLE_ROOM_ID,
            participantCount: list.length,
            participantNames: list.map((p) => p.name),
          },
        ],
        serverTime: Date.now(),
      });
    }

    const peerId = String(req.query?.peerId || '');
    const sinceSeq = Number(req.query?.sinceSeq || 0);
    return res.status(200).json(getSnapshot(peerId, sinceSeq));
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const action = body.action;
    const room = getRoom();
    const now = Date.now();

    if (action === 'heartbeat' || action === 'join') {
      const p = body.participant;
      if (p && p.id) {
        const existing = room.participants.get(String(p.id));
        room.participants.set(String(p.id), {
          id: String(p.id),
          name: String(p.name || 'Friend').slice(0, 24),
          avatarId: String(p.avatarId || 'headset'),
          color: String(p.color || 'indigo'),
          micMode: p.micMode === 'open' || p.micMode === 'ptt' ? p.micMode : 'muted',
          isSpeaking: Boolean(p.isSpeaking),
          audioLevel: Number(p.audioLevel || 0),
          inBackground: Boolean(p.inBackground),
          joinedAt: existing ? existing.joinedAt : now,
          lastSeenAt: now,
        });
      }
      return res.status(200).json(
        getSnapshot(String(p?.id || ''), Number(body.sinceSeq || 0))
      );
    }

    if (action === 'leave') {
      const peerId = String(body.peerId || '');
      if (peerId) {
        room.participants.delete(peerId);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'voice_chunk') {
      const chunk = body.chunk;
      if (!chunk || !chunk.id || !chunk.audioDataUrl) {
        return res.status(400).json({ error: 'Invalid voice chunk payload' });
      }
      let packet = room.voiceChunks.find((c) => c.id === String(chunk.id));
      let feedMessage;

      if (!packet) {
        packet = {
          id: String(chunk.id),
          roomId: SINGLE_ROOM_ID,
          seq: room.seqCounter++,
          senderId: String(chunk.senderId),
          senderName: String(chunk.senderName || 'Friend'),
          senderColor: String(chunk.senderColor || 'indigo'),
          senderAvatar: String(chunk.senderAvatar || 'headset'),
          audioDataUrl: String(chunk.audioDataUrl),
          durationMs: Number(chunk.durationMs || 1000),
          peakLevel: Number(chunk.peakLevel || 65),
          timestamp: now,
          saveToFeed: Boolean(chunk.saveToFeed),
          label: chunk.label ? String(chunk.label) : undefined,
        };
        room.voiceChunks.push(packet);

        const sender = room.participants.get(packet.senderId);
        if (sender) {
          sender.isSpeaking = true;
          sender.audioLevel = Math.max(25, packet.peakLevel);
          sender.lastSeenAt = now;
        }

        if (packet.saveToFeed) {
          feedMessage = {
            id: `vc-${packet.id}`,
            roomId: SINGLE_ROOM_ID,
            senderId: packet.senderId,
            senderName: packet.senderName,
            senderColor: packet.senderColor,
            senderAvatar: packet.senderAvatar,
            type: 'voice_clip',
            text: packet.label || 'Voice transmission',
            audioDataUrl: packet.audioDataUrl,
            durationMs: packet.durationMs,
            timestamp: now,
          };
          room.messages.push(feedMessage);
          if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
            room.messages = room.messages.slice(-MAX_MESSAGES_PER_ROOM);
          }
        }
      }

      return res.status(200).json({ ok: true, packet, feedMessage });
    }

    if (action === 'message') {
      const msg = body.message;
      if (!msg || !msg.id) {
        return res.status(400).json({ error: 'Invalid message payload' });
      }
      let message = room.messages.find((m) => m.id === String(msg.id));
      if (!message) {
        message = {
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
          timestamp: now,
        };
        room.messages.push(message);
        if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
          room.messages = room.messages.slice(-MAX_MESSAGES_PER_ROOM);
        }
      }
      return res.status(200).json({ ok: true, message });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
