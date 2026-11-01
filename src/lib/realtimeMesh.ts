import mqtt, { MqttClient } from 'mqtt';
import {
  Participant,
  RoomMessage,
  VoiceChunkPacket,
  SINGLE_ROOM_ID,
} from '../shared/roomStore';

// Dedicated topic scoped to this app so all tabs and devices on Vercel connect to the same room
const MESH_TOPIC = 'squadtalk/rykerplayz744-thingy-main-room-v2/events';

const PUBLIC_WSS_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

export type MeshEventPacket =
  | {
      type: 'peer:hello';
      eventId: string;
      participant: Participant;
    }
  | {
      type: 'peer:presence';
      eventId: string;
      participant: Participant;
    }
  | {
      type: 'peer:leave';
      eventId: string;
      peerId: string;
    }
  | {
      type: 'peer:history';
      eventId: string;
      toPeerId: string;
      messages: RoomMessage[];
    }
  | {
      type: 'voice:chunk';
      eventId: string;
      packet: VoiceChunkPacket;
      feedMessage?: RoomMessage;
      echoTest?: boolean;
    }
  | {
      type: 'room:message';
      eventId: string;
      message: RoomMessage;
    };

export class RealtimeMesh {
  private myPeerId: string;
  private getMyParticipant: () => Participant;
  private getRecentMessages: () => RoomMessage[];
  private onParticipantsChanged: (list: Participant[]) => void;
  private onVoiceChunk: (packet: VoiceChunkPacket, echoTest?: boolean) => void;
  private onRoomMessage: (msg: RoomMessage, isLiveEvent: boolean) => void;
  private onConnectionStatus: (status: {
    cloudConnected: boolean;
    brokerCount: number;
    localWsConnected: boolean;
  }) => void;

  private peers = new Map<string, Participant>();
  private seenEventIds = new Set<string>();
  private mqttClients: MqttClient[] = [];
  private broadcastChannel: BroadcastChannel | null = null;
  private localWs: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private apiPollTimer: number | null = null;
  private latestApiSeq = 0;
  private destroyed = false;

  constructor(options: {
    myPeerId: string;
    getMyParticipant: () => Participant;
    getRecentMessages: () => RoomMessage[];
    onParticipantsChanged: (list: Participant[]) => void;
    onVoiceChunk: (packet: VoiceChunkPacket, echoTest?: boolean) => void;
    onRoomMessage: (msg: RoomMessage, isLiveEvent: boolean) => void;
    onConnectionStatus: (status: {
      cloudConnected: boolean;
      brokerCount: number;
      localWsConnected: boolean;
    }) => void;
  }) {
    this.myPeerId = options.myPeerId;
    this.getMyParticipant = options.getMyParticipant;
    this.getRecentMessages = options.getRecentMessages;
    this.onParticipantsChanged = options.onParticipantsChanged;
    this.onVoiceChunk = options.onVoiceChunk;
    this.onRoomMessage = options.onRoomMessage;
    this.onConnectionStatus = options.onConnectionStatus;
  }

  public start() {
    const me = this.getMyParticipant();
    this.peers.set(me.id, me);
    this.emitParticipantsList();

    // 1. Same-Browser Multi-Tab BroadcastChannel (instant <2ms between tabs)
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.broadcastChannel = new BroadcastChannel('squadtalk_room_mesh_v2');
        this.broadcastChannel.onmessage = (ev) => {
          if (ev.data) {
            this.handleIncomingMeshPacket(ev.data as MeshEventPacket);
          }
        };
      } catch {
        // Ignore if unsupported
      }
    }

    // 2. Cloud WebSocket MQTT Pub/Sub Brokers (works on Vercel Hobby Plan globally with zero backend setup)
    for (const url of PUBLIC_WSS_BROKERS) {
      try {
        const client = mqtt.connect(url, {
          clientId: `st_${this.myPeerId}_${Math.random().toString(36).slice(2, 6)}`,
          clean: true,
          connectTimeout: 5000,
          reconnectPeriod: 2500,
          keepalive: 30,
        });

        client.on('connect', () => {
          if (this.destroyed) return;
          client.subscribe(MESH_TOPIC, { qos: 0 }, () => {
            this.updateStatus();
            this.publishMeshPacket({
              type: 'peer:hello',
              eventId: this.makeEventId(),
              participant: this.getMyParticipant(),
            });
          });
        });

        client.on('message', (_topic, payload) => {
          if (this.destroyed) return;
          try {
            const parsed = JSON.parse(payload.toString()) as MeshEventPacket;
            this.handleIncomingMeshPacket(parsed);
          } catch {
            // Ignore malformed JSON
          }
        });

        client.on('close', () => this.updateStatus());
        client.on('offline', () => this.updateStatus());

        this.mqttClients.push(client);
      } catch {
        // Ignore broker init failure
      }
    }

    // 3. Local WebSocket (/ws) when running on Node server (AI Studio / self-hosted)
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      this.localWs = ws;

      ws.onopen = () => {
        if (this.destroyed) return;
        this.updateStatus();
        ws.send(
          JSON.stringify({
            type: 'room:join',
            roomId: SINGLE_ROOM_ID,
            participant: this.getMyParticipant(),
          })
        );
      };

      ws.onmessage = (ev) => {
        if (this.destroyed) return;
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'room:init' || data.type === 'participants:update') {
            if (Array.isArray(data.participants)) {
              this.mergeServerParticipants(data.participants);
            }
            if (Array.isArray(data.messages)) {
              for (const m of data.messages as RoomMessage[]) {
                this.onRoomMessage(m, false);
              }
            }
          } else if (data.type === 'voice:chunk' && data.packet) {
            this.onVoiceChunk(data.packet);
            if (data.feedMessage) {
              this.onRoomMessage(data.feedMessage, true);
            }
          } else if (data.type === 'room:message' && data.message) {
            this.onRoomMessage(data.message, true);
          }
        } catch {
          // Ignore
        }
      };

      ws.onclose = () => this.updateStatus();
    } catch {
      // Ignore if /ws not available on Vercel static host
    }

    // Broadcast initial hello right away for BroadcastChannel tabs
    this.publishMeshPacket({
      type: 'peer:hello',
      eventId: this.makeEventId(),
      participant: this.getMyParticipant(),
    });

    // 4. Periodic Presence Heartbeat & Pruning (every 1.8 seconds)
    this.heartbeatTimer = window.setInterval(() => {
      if (this.destroyed) return;
      this.broadcastMyPresence();
      this.pruneStalePeers();
    }, 1800);

    // 5. Fallback HTTP /api/room poll (every 1.5 seconds)
    this.apiPollTimer = window.setInterval(() => {
      if (this.destroyed) return;
      this.pollApiRoom();
    }, 1500);
    this.pollApiRoom();

    // Send leave notification when closing tab
    window.addEventListener('beforeunload', this.handleWindowUnload);
    window.addEventListener('pagehide', this.handleWindowUnload);
  }

  private handleWindowUnload = () => {
    this.publishMeshPacket({
      type: 'peer:leave',
      eventId: this.makeEventId(),
      peerId: this.myPeerId,
    });
  };

  private makeEventId(): string {
    return `${this.myPeerId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private updateStatus() {
    const connectedBrokers = this.mqttClients.filter((c) => c.connected).length;
    const wsOpen = this.localWs?.readyState === WebSocket.OPEN;
    this.onConnectionStatus({
      cloudConnected: connectedBrokers > 0 || Boolean(this.broadcastChannel),
      brokerCount: connectedBrokers,
      localWsConnected: Boolean(wsOpen),
    });
  }

  public broadcastMyPresence() {
    const me = this.getMyParticipant();
    this.peers.set(me.id, me);
    this.emitParticipantsList();

    this.publishMeshPacket({
      type: 'peer:presence',
      eventId: this.makeEventId(),
      participant: me,
    });

    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(
        JSON.stringify({
          type: 'participant:update',
          roomId: SINGLE_ROOM_ID,
          participant: me,
        })
      );
    }
  }

  public sendVoiceChunk(
    packet: VoiceChunkPacket,
    feedMessage?: RoomMessage,
    echoTest?: boolean
  ) {
    this.publishMeshPacket({
      type: 'voice:chunk',
      eventId: packet.id,
      packet,
      feedMessage,
      echoTest,
    });

    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(
        JSON.stringify({
          type: 'voice:chunk',
          roomId: SINGLE_ROOM_ID,
          chunk: { ...packet, echoTest },
        })
      );
    }

    fetch('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'voice_chunk',
        roomId: SINGLE_ROOM_ID,
        chunk: packet,
      }),
    }).catch(() => {});
  }

  public sendRoomMessage(message: RoomMessage) {
    this.publishMeshPacket({
      type: 'room:message',
      eventId: message.id,
      message,
    });

    if (this.localWs && this.localWs.readyState === WebSocket.OPEN) {
      this.localWs.send(
        JSON.stringify({
          type: 'room:message',
          roomId: SINGLE_ROOM_ID,
          message,
        })
      );
    }

    fetch('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'message',
        roomId: SINGLE_ROOM_ID,
        message,
      }),
    }).catch(() => {});
  }

  private publishMeshPacket(packet: MeshEventPacket) {
    this.seenEventIds.add(packet.eventId);

    // Send over Same-Device BroadcastChannel
    try {
      this.broadcastChannel?.postMessage(packet);
    } catch {
      // Ignore
    }

    // Send over Connected Cloud WebSocket MQTT Brokers
    const serialized = JSON.stringify(packet);
    for (const client of this.mqttClients) {
      if (client.connected) {
        try {
          client.publish(MESH_TOPIC, serialized, { qos: 0 });
        } catch {
          // Ignore publish error
        }
      }
    }
  }

  private handleIncomingMeshPacket(packet: MeshEventPacket) {
    if (!packet || !packet.eventId) return;
    if (this.seenEventIds.has(packet.eventId)) return;
    this.seenEventIds.add(packet.eventId);

    // Keep seenEventIds bounded
    if (this.seenEventIds.size > 600) {
      const first = this.seenEventIds.values().next().value;
      if (first) this.seenEventIds.delete(first);
    }

    const now = Date.now();

    if (packet.type === 'peer:hello') {
      const p = packet.participant;
      if (p && p.id) {
        const existing = this.peers.get(p.id);
        this.peers.set(p.id, {
          ...p,
          joinedAt: existing ? existing.joinedAt : p.joinedAt || now,
          lastSeenAt: now,
        });
        this.emitParticipantsList();

        // Reply immediately with our presence & message history so the new tab/friend sees us right away!
        if (p.id !== this.myPeerId) {
          this.publishMeshPacket({
            type: 'peer:presence',
            eventId: this.makeEventId(),
            participant: this.getMyParticipant(),
          });
          const recentMsgs = this.getRecentMessages().filter(
            (m) => m.senderId !== 'system'
          );
          if (recentMsgs.length > 0) {
            this.publishMeshPacket({
              type: 'peer:history',
              eventId: this.makeEventId(),
              toPeerId: p.id,
              messages: recentMsgs.slice(-15),
            });
          }
        }
      }
    } else if (packet.type === 'peer:presence') {
      const p = packet.participant;
      if (p && p.id) {
        const existing = this.peers.get(p.id);
        this.peers.set(p.id, {
          ...p,
          joinedAt: existing ? existing.joinedAt : p.joinedAt || now,
          lastSeenAt: now,
        });
        this.emitParticipantsList();
      }
    } else if (packet.type === 'peer:leave') {
      if (packet.peerId && packet.peerId !== this.myPeerId) {
        this.peers.delete(packet.peerId);
        this.emitParticipantsList();
      }
    } else if (packet.type === 'peer:history') {
      if (packet.toPeerId === this.myPeerId && Array.isArray(packet.messages)) {
        for (const m of packet.messages) {
          this.onRoomMessage(m, false);
        }
      }
    } else if (packet.type === 'voice:chunk' && packet.packet) {
      const vc = packet.packet;
      const sender = this.peers.get(vc.senderId);
      if (sender) {
        sender.isSpeaking = true;
        sender.audioLevel = Math.max(25, vc.peakLevel || 60);
        sender.lastSeenAt = now;
        this.emitParticipantsList();
      }
      this.onVoiceChunk(vc, packet.echoTest);
      if (packet.feedMessage) {
        this.onRoomMessage(packet.feedMessage, true);
      }
    } else if (packet.type === 'room:message' && packet.message) {
      this.onRoomMessage(packet.message, true);
    }
  }

  private mergeServerParticipants(serverList: Participant[]) {
    const now = Date.now();
    for (const p of serverList) {
      if (!p || !p.id) continue;
      if (p.id === this.myPeerId) continue;
      const existing = this.peers.get(p.id);
      this.peers.set(p.id, {
        ...p,
        joinedAt: existing ? existing.joinedAt : p.joinedAt || now,
        lastSeenAt: now,
      });
    }
    this.emitParticipantsList();
  }

  private pruneStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers.entries()) {
      if (id === this.myPeerId) continue;
      if (now - p.lastSeenAt > 12_000) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emitParticipantsList();
    }
  }

  private emitParticipantsList() {
    const me = this.getMyParticipant();
    this.peers.set(me.id, me);
    const list = Array.from(this.peers.values()).sort(
      (a, b) => a.joinedAt - b.joinedAt
    );
    this.onParticipantsChanged(list);
  }

  private async pollApiRoom() {
    try {
      const me = this.getMyParticipant();
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'heartbeat',
          roomId: SINGLE_ROOM_ID,
          sinceSeq: this.latestApiSeq,
          participant: me,
        }),
      });
      if (res.ok) {
        const snapshot = await res.json();
        if (typeof snapshot.latestSeq === 'number' && snapshot.latestSeq > this.latestApiSeq) {
          this.latestApiSeq = snapshot.latestSeq;
        }
        if (Array.isArray(snapshot.participants)) {
          this.mergeServerParticipants(snapshot.participants);
        }
        if (Array.isArray(snapshot.voiceChunks)) {
          for (const pkt of snapshot.voiceChunks as VoiceChunkPacket[]) {
            this.onVoiceChunk(pkt);
          }
        }
        if (Array.isArray(snapshot.messages)) {
          for (const m of snapshot.messages as RoomMessage[]) {
            this.onRoomMessage(m, false);
          }
        }
      }
    } catch {
      // Ignore if offline
    }
  }

  public destroy() {
    this.destroyed = true;
    this.handleWindowUnload();
    window.removeEventListener('beforeunload', this.handleWindowUnload);
    window.removeEventListener('pagehide', this.handleWindowUnload);

    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.apiPollTimer !== null) clearInterval(this.apiPollTimer);

    try {
      this.broadcastChannel?.close();
    } catch {
      // Ignore
    }
    for (const c of this.mqttClients) {
      try {
        c.end(true);
      } catch {
        // Ignore
      }
    }
    try {
      this.localWs?.close();
    } catch {
      // Ignore
    }
  }
}
