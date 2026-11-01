import {
  addRoomMessage,
  addSignalPacket,
  addVoiceChunk,
  getPublicRoomsSummary,
  getRoomSnapshot,
  normalizeRoomId,
  removeParticipant,
  upsertParticipant,
} from '../src/shared/roomStore.js';

// Compatible with Vercel Serverless Function (req, res) & Express
export default function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (req.method === 'GET') {
    const mode = String(req.query?.mode || '');
    if (mode === 'directory') {
      return res.status(200).json({
        rooms: getPublicRoomsSummary(),
        serverTime: Date.now(),
      });
    }

    const roomId = normalizeRoomId(String(req.query?.roomId || 'SQUAD'));
    const peerId = String(req.query?.peerId || '');
    const sinceSeq = Number(req.query?.sinceSeq || 0);

    const snapshot = getRoomSnapshot(roomId, peerId, sinceSeq);
    return res.status(200).json(snapshot);
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const action = body.action;
    const roomId = normalizeRoomId(body.roomId || 'SQUAD');

    if (action === 'heartbeat' || action === 'join') {
      const p = body.participant;
      if (p && p.id) {
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
      }
      const snapshot = getRoomSnapshot(
        roomId,
        String(p?.id || ''),
        Number(body.sinceSeq || 0)
      );
      return res.status(200).json(snapshot);
    }

    if (action === 'leave') {
      const peerId = String(body.peerId || '');
      if (peerId) {
        removeParticipant(roomId, peerId);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'voice_chunk') {
      const chunk = body.chunk;
      if (!chunk || !chunk.id || !chunk.audioDataUrl) {
        return res.status(400).json({ error: 'Invalid voice chunk payload' });
      }
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
      return res.status(200).json({ ok: true, packet, feedMessage });
    }

    if (action === 'message') {
      const msg = body.message;
      if (!msg || !msg.id) {
        return res.status(400).json({ error: 'Invalid message payload' });
      }
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
      return res.status(200).json({ ok: true, message });
    }

    if (action === 'signal') {
      const sig = body.signal;
      if (!sig || !sig.toPeerId || !sig.fromPeerId) {
        return res.status(400).json({ error: 'Invalid signal payload' });
      }
      const { packet } = addSignalPacket(roomId, {
        id: String(sig.id || `${Date.now()}-${Math.random()}`),
        roomId,
        fromPeerId: String(sig.fromPeerId),
        toPeerId: String(sig.toPeerId),
        signalType: sig.signalType,
        payload: sig.payload,
      });
      return res.status(200).json({ ok: true, packet });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
