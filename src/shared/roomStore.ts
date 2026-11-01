export type MicMode = 'open' | 'ptt' | 'muted';

export const SINGLE_ROOM_ID = 'MAIN';

export interface Participant {
  id: string;
  name: string;
  avatarId: string;
  color: string;
  micMode: MicMode;
  isSpeaking: boolean;
  audioLevel: number; // 0 to 100
  inBackground: boolean;
  joinedAt: number;
  lastSeenAt: number;
}

export interface VoiceChunkPacket {
  seq: number;
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  senderColor: string;
  senderAvatar: string;
  audioDataUrl: string;
  durationMs: number;
  peakLevel: number;
  timestamp: number;
  saveToFeed?: boolean;
  label?: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  senderColor: string;
  senderAvatar: string;
  type: 'text' | 'callout' | 'voice_clip';
  text: string;
  soundId?: string;
  audioDataUrl?: string;
  durationMs?: number;
  timestamp: number;
}

export interface WebRTCSignalPacket {
  id: string;
  roomId: string;
  fromPeerId: string;
  toPeerId: string;
  signalType: 'offer' | 'answer' | 'ice';
  payload: unknown;
  timestamp: number;
}

export interface RoomState {
  roomId: string;
  seqCounter: number;
  participants: Map<string, Participant>;
  voiceChunks: VoiceChunkPacket[];
  messages: RoomMessage[];
  signals: WebRTCSignalPacket[];
}

const PARTICIPANT_TTL_MS = 28_000;
const CHUNK_RETENTION_MS = 45_000;
const MAX_MESSAGES_PER_ROOM = 60;
const MAX_CHUNKS_PER_ROOM = 80;

// Global singleton so Vercel warm lambdas and Express server share state
const globalStore = globalThis as unknown as {
  __SQUADTALK_SINGLE_ROOM__?: RoomState;
};

export function normalizeRoomId(_raw?: string): string {
  return SINGLE_ROOM_ID;
}

export function getOrCreateRoom(_roomId?: string): RoomState {
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
  pruneRoom(room);
  return room;
}

export function pruneRoom(room: RoomState): void {
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
}

export function upsertParticipant(
  _roomId: string,
  participant: Omit<Participant, 'joinedAt' | 'lastSeenAt'>
): RoomState {
  const room = getOrCreateRoom();
  const existing = room.participants.get(participant.id);
  const now = Date.now();
  room.participants.set(participant.id, {
    ...participant,
    joinedAt: existing ? existing.joinedAt : now,
    lastSeenAt: now,
  });
  return room;
}

export function removeParticipant(_roomId: string, peerId: string): RoomState {
  const room = getOrCreateRoom();
  room.participants.delete(peerId);
  return room;
}

export function addVoiceChunk(
  _roomId: string,
  chunk: Omit<VoiceChunkPacket, 'seq' | 'timestamp'>
): { room: RoomState; packet: VoiceChunkPacket; feedMessage?: RoomMessage } {
  const room = getOrCreateRoom();
  const existing = room.voiceChunks.find((c) => c.id === chunk.id);
  if (existing) {
    return { room, packet: existing };
  }

  const now = Date.now();
  const packet: VoiceChunkPacket = {
    ...chunk,
    roomId: SINGLE_ROOM_ID,
    seq: room.seqCounter++,
    timestamp: now,
  };
  room.voiceChunks.push(packet);

  const sender = room.participants.get(chunk.senderId);
  if (sender) {
    sender.isSpeaking = true;
    sender.audioLevel = Math.max(25, chunk.peakLevel || 60);
    sender.lastSeenAt = now;
  }

  let feedMessage: RoomMessage | undefined;
  if (chunk.saveToFeed) {
    feedMessage = {
      id: `vc-${chunk.id}`,
      roomId: SINGLE_ROOM_ID,
      senderId: chunk.senderId,
      senderName: chunk.senderName,
      senderColor: chunk.senderColor,
      senderAvatar: chunk.senderAvatar,
      type: 'voice_clip',
      text: chunk.label || 'Voice transmission',
      audioDataUrl: chunk.audioDataUrl,
      durationMs: chunk.durationMs,
      timestamp: now,
    };
    room.messages.push(feedMessage);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages = room.messages.slice(-MAX_MESSAGES_PER_ROOM);
    }
  }

  pruneRoom(room);
  return { room, packet, feedMessage };
}

export function addRoomMessage(
  _roomId: string,
  msg: Omit<RoomMessage, 'timestamp'>
): { room: RoomState; message: RoomMessage } {
  const room = getOrCreateRoom();
  const existing = room.messages.find((m) => m.id === msg.id);
  if (existing) {
    return { room, message: existing };
  }

  const now = Date.now();
  const message: RoomMessage = {
    ...msg,
    roomId: SINGLE_ROOM_ID,
    timestamp: now,
  };
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
    room.messages = room.messages.slice(-MAX_MESSAGES_PER_ROOM);
  }
  return { room, message };
}

export function addSignalPacket(
  _roomId: string,
  signal: Omit<WebRTCSignalPacket, 'timestamp'>
): { room: RoomState; packet: WebRTCSignalPacket } {
  const room = getOrCreateRoom();
  const packet: WebRTCSignalPacket = {
    ...signal,
    roomId: SINGLE_ROOM_ID,
    timestamp: Date.now(),
  };
  room.signals.push(packet);
  return { room, packet };
}

export function getRoomSnapshot(
  _roomId: string,
  peerId: string,
  sinceSeq = 0
): {
  roomId: string;
  latestSeq: number;
  participants: Participant[];
  voiceChunks: VoiceChunkPacket[];
  messages: RoomMessage[];
  signals: WebRTCSignalPacket[];
} {
  const room = getOrCreateRoom();
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

export function getPublicRoomsSummary(): Array<{
  roomId: string;
  participantCount: number;
  participantNames: string[];
}> {
  const room = getOrCreateRoom();
  const list = Array.from(room.participants.values());
  return [
    {
      roomId: SINGLE_ROOM_ID,
      participantCount: list.length,
      participantNames: list.map((p) => p.name),
    },
  ];
}
