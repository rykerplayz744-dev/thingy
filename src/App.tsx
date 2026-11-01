import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Mic,
  MicOff,
  Radio,
  Volume2,
  VolumeX,
  Share2,
  Check,
  Play,
  Send,
  Headphones,
  Gamepad2,
  Smile,
  Zap,
  ShieldCheck,
  PictureInPicture2,
  RefreshCw,
  LogOut,
  Users,
  MessageSquare,
  Sliders,
  Sparkles,
} from 'lucide-react';
import {
  MicMode,
  Participant,
  RoomMessage,
  VoiceChunkPacket,
  SINGLE_ROOM_ID,
} from './shared/roomStore';
import { SquadAudioEngine, CalloutSoundId } from './lib/audioEngine';
import { PipCallOverlay } from './lib/pipOverlay';
import { RealtimeMesh } from './lib/realtimeMesh';

const AVATAR_OPTIONS = [
  { id: 'headset', label: 'Headset' },
  { id: 'gamepad', label: 'Controller' },
  { id: 'zap', label: 'Bolt' },
  { id: 'smile', label: 'Smile' },
] as const;

const COLOR_OPTIONS = [
  { id: 'indigo', label: 'Indigo', bg: 'bg-indigo-600', text: 'text-indigo-600' },
  { id: 'emerald', label: 'Emerald', bg: 'bg-emerald-600', text: 'text-emerald-600' },
  { id: 'amber', label: 'Amber', bg: 'bg-amber-600', text: 'text-amber-600' },
  { id: 'rose', label: 'Rose', bg: 'bg-rose-600', text: 'text-rose-600' },
  { id: 'sky', label: 'Sky', bg: 'bg-sky-600', text: 'text-sky-600' },
] as const;

const CALLOUT_PRESETS: Array<{ id: CalloutSoundId; label: string; sub: string }> = [
  { id: 'hop_on', label: 'Hop on!', sub: 'Chime alert' },
  { id: 'wait_up', label: 'Wait up!', sub: 'Two-tone call' },
  { id: 'gg', label: 'GG!', sub: 'Victory chord' },
  { id: 'watch_out', label: 'Behind you!', sub: 'Warning buzz' },
  { id: 'ready', label: 'Ready up!', sub: 'Ready ping' },
  { id: 'laugh', label: 'Haha!', sub: 'Quick laugh' },
];

function getColorMeta(colorId: string) {
  return COLOR_OPTIONS.find((c) => c.id === colorId) || COLOR_OPTIONS[0];
}

function AvatarIcon({ avatarId, className = 'w-5 h-5' }: { avatarId: string; className?: string }) {
  switch (avatarId) {
    case 'gamepad':
      return <Gamepad2 className={className} />;
    case 'zap':
      return <Zap className={className} />;
    case 'smile':
      return <Smile className={className} />;
    default:
      return <Headphones className={className} />;
  }
}

export default function App() {
  // Unique Peer ID per tab instance so opening multiple tabs lets you test and interact with yourself
  const [peerId] = useState<string>(() => {
    return `peer-${Math.random().toString(36).slice(2, 10)}`;
  });

  const [joinedAt] = useState<number>(() => Date.now());

  const [myName, setMyName] = useState<string>(() => {
    const savedSession = sessionStorage.getItem('squadtalk_tab_name');
    if (savedSession) return savedSession;
    const next = `Friend${Math.floor(10 + Math.random() * 89)}`;
    sessionStorage.setItem('squadtalk_tab_name', next);
    return next;
  });

  const [myAvatar, setMyAvatar] = useState<string>(() => {
    return sessionStorage.getItem('squadtalk_tab_avatar') || 'headset';
  });

  const [myColor, setMyColor] = useState<string>(() => {
    const saved = sessionStorage.getItem('squadtalk_tab_color');
    if (saved) return saved;
    const randomColor = COLOR_OPTIONS[Math.floor(Math.random() * COLOR_OPTIONS.length)].id;
    sessionStorage.setItem('squadtalk_tab_color', randomColor);
    return randomColor;
  });

  // Call & Audio States
  const [isJoined, setIsJoined] = useState<boolean>(false);
  const [micMode, setMicMode] = useState<MicMode>('open');
  const [isPttPressed, setIsPttPressed] = useState<boolean>(false);
  const [isRecordingNote, setIsRecordingNote] = useState<boolean>(false);
  const [vadThreshold, setVadThreshold] = useState<number>(12);
  const [speakerVolume, setSpeakerVolume] = useState<number>(1.0);
  const [isSpeakerMuted, setIsSpeakerMuted] = useState<boolean>(false);
  const [echoTestEnabled, setEchoTestEnabled] = useState<boolean>(false);

  // Real-time Telemetry & Room State
  const [myAudioLevel, setMyAudioLevel] = useState<number>(0);
  const [myFreqBands, setMyFreqBands] = useState<number[]>(new Array(12).fill(4));
  const [inBackground, setInBackground] = useState<boolean>(false);
  const [bgShieldActive, setBgShieldActive] = useState<boolean>(false);
  const [pipActive, setPipActive] = useState<boolean>(false);
  const [connStatus, setConnStatus] = useState<{
    cloudConnected: boolean;
    brokerCount: number;
    localWsConnected: boolean;
  }>({
    cloudConnected: false,
    brokerCount: 0,
    localWsConnected: false,
  });
  const [chunksSentCount, setChunksSentCount] = useState<number>(0);
  const [chunksReceivedCount, setChunksReceivedCount] = useState<number>(0);
  const [micError, setMicError] = useState<string | null>(null);

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([
    {
      id: 'welcome-main',
      roomId: SINGLE_ROOM_ID,
      senderId: 'system',
      senderName: 'Hangout',
      senderColor: 'indigo',
      senderAvatar: 'headset',
      type: 'text',
      text: 'Welcome! Open another tab or share the link with friends—everyone connects automatically to this room.',
      timestamp: Date.now(),
    },
  ]);

  const [chatText, setChatText] = useState<string>('');
  const [copiedInvite, setCopiedInvite] = useState<boolean>(false);
  const [showProfileEditor, setShowProfileEditor] = useState<boolean>(false);
  const [activeSection, setActiveSection] = useState<'room' | 'feed' | 'guide' | 'vercel'>('room');

  // Refs
  const audioEngineRef = useRef<SquadAudioEngine | null>(null);
  const pipOverlayRef = useRef<PipCallOverlay | null>(null);
  const meshRef = useRef<RealtimeMesh | null>(null);
  const playedChunkIdsRef = useRef<Set<string>>(new Set());
  const playedMessageIdsRef = useRef<Set<string>>(new Set(['welcome-main']));

  const stateRef = useRef({
    peerId,
    joinedAt,
    myName,
    myAvatar,
    myColor,
    isJoined,
    micMode,
    isPttPressed,
    isRecordingNote,
    vadThreshold,
    myAudioLevel,
    inBackground,
    echoTestEnabled,
    isSpeakerMuted,
    participants,
    messages,
  });

  useEffect(() => {
    stateRef.current = {
      peerId,
      joinedAt,
      myName,
      myAvatar,
      myColor,
      isJoined,
      micMode,
      isPttPressed,
      isRecordingNote,
      vadThreshold,
      myAudioLevel,
      inBackground,
      echoTestEnabled,
      isSpeakerMuted,
      participants,
      messages,
    };
  }, [
    peerId,
    joinedAt,
    myName,
    myAvatar,
    myColor,
    isJoined,
    micMode,
    isPttPressed,
    isRecordingNote,
    vadThreshold,
    myAudioLevel,
    inBackground,
    echoTestEnabled,
    isSpeakerMuted,
    participants,
    messages,
  ]);

  // Save per-tab profile preferences and broadcast immediately when changed
  useEffect(() => {
    sessionStorage.setItem('squadtalk_tab_name', myName);
    sessionStorage.setItem('squadtalk_tab_avatar', myAvatar);
    sessionStorage.setItem('squadtalk_tab_color', myColor);
    meshRef.current?.broadcastMyPresence();
  }, [myName, myAvatar, myColor, isJoined, micMode, inBackground]);

  // Instantiate Audio Engine & PiP helper once
  useEffect(() => {
    audioEngineRef.current = new SquadAudioEngine();
    pipOverlayRef.current = new PipCallOverlay();
    return () => {
      audioEngineRef.current?.destroy();
      pipOverlayRef.current?.stop();
    };
  }, []);

  // Handle incoming voice chunk playback
  const handleIncomingPacket = useCallback((packet: VoiceChunkPacket) => {
    if (playedChunkIdsRef.current.has(packet.id)) return;
    playedChunkIdsRef.current.add(packet.id);

    const st = stateRef.current;
    if (packet.senderId === st.peerId) {
      if (st.echoTestEnabled && !st.isSpeakerMuted) {
        window.setTimeout(() => {
          audioEngineRef.current?.playIncomingVoiceChunk(packet.audioDataUrl);
          setChunksReceivedCount((c) => c + 1);
        }, 1200);
      }
      return;
    }

    if (!st.isSpeakerMuted) {
      audioEngineRef.current?.playIncomingVoiceChunk(packet.audioDataUrl);
      setChunksReceivedCount((c) => c + 1);
    }
  }, []);

  // Handle incoming room message
  const handleIncomingMessage = useCallback((msg: RoomMessage, isLiveEvent: boolean) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      const next = [...prev, msg].sort((a, b) => a.timestamp - b.timestamp);
      return next.slice(-60);
    });

    if (
      isLiveEvent &&
      msg.type === 'callout' &&
      msg.soundId &&
      !playedMessageIdsRef.current.has(msg.id)
    ) {
      playedMessageIdsRef.current.add(msg.id);
      if (msg.senderId !== stateRef.current.peerId && !stateRef.current.isSpeakerMuted) {
        audioEngineRef.current?.playCalloutSound(msg.soundId as CalloutSoundId);
      }
    } else {
      playedMessageIdsRef.current.add(msg.id);
    }
  }, []);

  // Start RealtimeMesh (Cloud WebSocket MQTT + Multi-Tab BroadcastChannel + Server API)
  useEffect(() => {
    const mesh = new RealtimeMesh({
      myPeerId: peerId,
      getMyParticipant: () => {
        const st = stateRef.current;
        const speakingNow =
          st.isJoined &&
          ((st.micMode === 'open' && st.myAudioLevel >= st.vadThreshold) ||
            (st.micMode === 'ptt' && st.isPttPressed) ||
            st.isRecordingNote);
        return {
          id: st.peerId,
          name: st.myName,
          avatarId: st.myAvatar,
          color: st.myColor,
          micMode: st.isJoined ? st.micMode : 'muted',
          isSpeaking: speakingNow,
          audioLevel: st.isJoined ? st.myAudioLevel : 0,
          inBackground: st.inBackground,
          joinedAt: st.joinedAt,
          lastSeenAt: Date.now(),
        };
      },
      getRecentMessages: () => stateRef.current.messages,
      onParticipantsChanged: (list) => setParticipants(list),
      onVoiceChunk: (packet) => handleIncomingPacket(packet),
      onRoomMessage: (msg, isLive) => handleIncomingMessage(msg, isLive),
      onConnectionStatus: (status) => setConnStatus(status),
    });

    meshRef.current = mesh;
    mesh.start();

    return () => {
      mesh.destroy();
      meshRef.current = null;
    };
  }, [peerId, handleIncomingPacket, handleIncomingMessage]);

  // Transmit 1-second voice chunk over RealtimeMesh
  const transmitVoiceChunk = useCallback(
    async (chunk: {
      audioDataUrl: string;
      durationMs: number;
      peakLevel: number;
      saveToFeed?: boolean;
      label?: string;
    }) => {
      const st = stateRef.current;
      const now = Date.now();
      const chunkId = `${st.peerId}-${now}-${Math.random().toString(36).slice(2, 6)}`;
      setChunksSentCount((c) => c + 1);

      if (st.echoTestEnabled && !st.isSpeakerMuted) {
        playedChunkIdsRef.current.add(chunkId);
        window.setTimeout(() => {
          audioEngineRef.current?.playIncomingVoiceChunk(chunk.audioDataUrl);
          setChunksReceivedCount((c) => c + 1);
        }, 1400);
      }

      const packet: VoiceChunkPacket = {
        seq: now,
        id: chunkId,
        roomId: SINGLE_ROOM_ID,
        senderId: st.peerId,
        senderName: st.myName,
        senderColor: st.myColor,
        senderAvatar: st.myAvatar,
        audioDataUrl: chunk.audioDataUrl,
        durationMs: chunk.durationMs,
        peakLevel: chunk.peakLevel,
        timestamp: now,
        saveToFeed: Boolean(chunk.saveToFeed),
        label: chunk.label,
      };

      let feedMessage: RoomMessage | undefined;
      if (chunk.saveToFeed) {
        feedMessage = {
          id: `vc-${chunkId}`,
          roomId: SINGLE_ROOM_ID,
          senderId: st.peerId,
          senderName: st.myName,
          senderColor: st.myColor,
          senderAvatar: st.myAvatar,
          type: 'voice_clip',
          text: chunk.label || 'Voice transmission',
          audioDataUrl: chunk.audioDataUrl,
          durationMs: chunk.durationMs,
          timestamp: now,
        };
        handleIncomingMessage(feedMessage, false);
      }

      meshRef.current?.sendVoiceChunk(packet, feedMessage, st.echoTestEnabled);
    },
    [handleIncomingMessage]
  );

  // Join & Start Background Audio + Microphone
  const joinHangout = useCallback(async () => {
    setMicError(null);
    const engine = audioEngineRef.current;
    if (!engine) return;

    const shieldOk = await engine.enableBackgroundKeepAlive(SINGLE_ROOM_ID, () => {
      setMicMode((prev) => (prev === 'muted' ? 'open' : 'muted'));
    });
    setBgShieldActive(shieldOk);

    try {
      await engine.startMicrophone({
        shouldTransmit: (peakLevel) => {
          const st = stateRef.current;
          if (st.isRecordingNote) return false;
          if (st.micMode === 'muted') return false;
          if (st.micMode === 'ptt') return st.isPttPressed;
          return peakLevel >= st.vadThreshold;
        },
        onLevelChange: (level, bands) => {
          setMyAudioLevel(level);
          setMyFreqBands(bands);
        },
        onOneSecondChunk: (captured) => {
          transmitVoiceChunk({
            ...captured,
            saveToFeed: stateRef.current.micMode === 'ptt',
            label:
              stateRef.current.micMode === 'ptt'
                ? 'Walkie-Talkie Transmission'
                : undefined,
          });
        },
      });
    } catch {
      setMicError(
        'Microphone permission was blocked or unavailable. You can still listen to friends in the background and use Soundboard Callouts!'
      );
      setMicMode('muted');
    }

    setIsJoined(true);
    window.setTimeout(() => meshRef.current?.broadcastMyPresence(), 50);
  }, [transmitVoiceChunk]);

  const leaveHangout = useCallback(async () => {
    setIsJoined(false);
    setMyAudioLevel(0);
    audioEngineRef.current?.stopMicrophone();
    window.setTimeout(() => meshRef.current?.broadcastMyPresence(), 50);
  }, []);

  // Track Document Visibility (when user pulls up another app over the browser)
  useEffect(() => {
    const handleVisibility = () => {
      const hidden = document.visibilityState === 'hidden';
      setInBackground(hidden);
      audioEngineRef.current?.resumeIfNeeded();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', () => {
      audioEngineRef.current?.resumeIfNeeded();
    });
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // Spacebar shortcut for Push-to-Talk on Desktop
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.code === 'Space' &&
        stateRef.current.isJoined &&
        stateRef.current.micMode === 'ptt' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        setIsPttPressed(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (
        e.code === 'Space' &&
        stateRef.current.isJoined &&
        stateRef.current.micMode === 'ptt'
      ) {
        setIsPttPressed(false);
        const flushed = audioEngineRef.current?.FlushCurrentBuffer();
        if (flushed) {
          transmitVoiceChunk({
            ...flushed,
            saveToFeed: true,
            label: 'Walkie-Talkie Transmission',
          });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [transmitVoiceChunk]);

  // Send quick callout + play sound
  const sendCallout = async (preset: { id: CalloutSoundId; label: string }) => {
    await audioEngineRef.current?.initAudioContext();
    if (!isSpeakerMuted) {
      audioEngineRef.current?.playCalloutSound(preset.id);
    }

    const now = Date.now();
    const msgId = `msg-${peerId}-${now}`;
    playedMessageIdsRef.current.add(msgId);
    const message: RoomMessage = {
      id: msgId,
      roomId: SINGLE_ROOM_ID,
      senderId: peerId,
      senderName: myName,
      senderColor: myColor,
      senderAvatar: myAvatar,
      type: 'callout',
      text: preset.label,
      soundId: preset.id,
      timestamp: now,
    };

    handleIncomingMessage(message, false);
    meshRef.current?.sendRoomMessage(message);
  };

  // Send text message
  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = chatText.trim();
    if (!trimmed) return;
    setChatText('');

    const now = Date.now();
    const msgId = `msg-${peerId}-${now}`;
    playedMessageIdsRef.current.add(msgId);
    const message: RoomMessage = {
      id: msgId,
      roomId: SINGLE_ROOM_ID,
      senderId: peerId,
      senderName: myName,
      senderColor: myColor,
      senderAvatar: myAvatar,
      type: 'text',
      text: trimmed,
      timestamp: now,
    };

    handleIncomingMessage(message, false);
    meshRef.current?.sendRoomMessage(message);
  };

  const handleCopyInvite = () => {
    navigator.clipboard.writeText(window.location.origin).catch(() => {});
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2200);
  };

  const handleTogglePip = async () => {
    if (!pipOverlayRef.current) return;
    await pipOverlayRef.current.togglePip(
      () => ({
        myMicMode: stateRef.current.micMode,
        myAudioLevel: stateRef.current.myAudioLevel,
        participants: stateRef.current.participants,
      }),
      (active) => setPipActive(active)
    );
  };

  const isCurrentlyTransmitting =
    isJoined &&
    ((micMode === 'open' && myAudioLevel >= vadThreshold) ||
      (micMode === 'ptt' && isPttPressed) ||
      isRecordingNote);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200 px-4 sm:px-6 lg:px-8 py-3.5">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-8">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('room');
            }}
            className="text-lg font-extrabold tracking-tight text-slate-900 whitespace-nowrap shrink-0 font-display"
          >
            SquadTalk
          </a>

          {/* Zone 2: 4 concise single-line navigation links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={() => setActiveSection('room')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeSection === 'room'
                  ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-indigo-600'
                  : ''
              }`}
            >
              Live Hangout
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('feed')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeSection === 'feed'
                  ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-indigo-600'
                  : ''
              }`}
            >
              Voice Feed
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('guide')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeSection === 'guide'
                  ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-indigo-600'
                  : ''
              }`}
            >
              Background Guide
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('vercel')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeSection === 'vercel'
                  ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-indigo-600'
                  : ''
              }`}
            >
              Vercel Setup
            </button>
          </nav>

          {/* Zone 3: 1 primary action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleCopyInvite}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 active:scale-[0.98] transition-all flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedInvite ? (
                <>
                  <Check className="w-4 h-4" />
                  <span>Invite Link Copied</span>
                </>
              ) : (
                <>
                  <Share2 className="w-4 h-4" />
                  <span>Copy Invite Link</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Identity & Single Hangout Status Bar */}
        <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="tabular-nums font-semibold text-slate-900">
                  {participants.length} {participants.length === 1 ? 'Person' : 'People'} in Room
                </span>
                <span aria-hidden="true">·</span>
                <span className="text-emerald-700 font-medium">
                  {connStatus.brokerCount > 0
                    ? `Global WebSocket Mesh Connected (${connStatus.brokerCount} Relays)`
                    : connStatus.localWsConnected
                      ? 'Live WebSocket Connected'
                      : 'Multi-Tab & HTTP Relay Active'}
                </span>
                {bgShieldActive && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-indigo-700 font-medium">
                      Background Keep-Alive On
                    </span>
                  </>
                )}
              </div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 font-display">
                {isJoined
                  ? 'You’re Live — Switch to any game or open another tab to test'
                  : 'Tap Join Hangout to talk with your friends'}
              </h1>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowProfileEditor((v) => !v)}
                className="min-h-[42px] px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl flex items-center gap-2.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span
                  className={`w-6 h-6 rounded-lg ${getColorMeta(myColor).bg} text-white flex items-center justify-center`}
                >
                  <AvatarIcon avatarId={myAvatar} className="w-3.5 h-3.5" />
                </span>
                <span>{myName}</span>
                <span className="text-indigo-600">Change Name / Icon</span>
              </button>
            </div>
          </div>

          {/* Expandable Profile Customizer */}
          {showProfileEditor && (
            <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Your Display Name
                </label>
                <input
                  type="text"
                  value={myName}
                  onChange={(e) => setMyName(e.target.value.slice(0, 20))}
                  placeholder="Enter your name"
                  className="w-full min-h-[42px] px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Pick Icon
                </label>
                <div className="flex items-center gap-2">
                  {AVATAR_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setMyAvatar(opt.id)}
                      className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs font-semibold flex items-center gap-1.5 cursor-pointer ${
                        myAvatar === opt.id
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <AvatarIcon avatarId={opt.id} className="w-4 h-4" />
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Pick Color
                </label>
                <div className="flex items-center gap-2">
                  {COLOR_OPTIONS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setMyColor(c.id)}
                      className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs font-semibold cursor-pointer ${
                        myColor === c.id
                          ? `${c.bg} text-white border-transparent`
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Guide & Vercel Setup Views if selected from Top Nav */}
        {activeSection === 'guide' && (
          <section className="bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900 font-display">
                  How Background Talking Works Over Games & Other Apps
                </h2>
                <p className="text-sm text-slate-600 mt-1">
                  Designed so you and your friends can open Roblox, Minecraft, Brawl Stars, or any app over this browser tab and keep talking smoothly.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveSection('room')}
                className="min-h-[40px] px-4 py-2 text-xs font-semibold bg-slate-900 text-white rounded-xl hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Back to Hangout
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2">
              <div className="p-5 bg-slate-50 rounded-xl space-y-2">
                <div className="text-xs font-mono font-semibold text-indigo-600">
                  01. CONTINUOUS AUDIO STREAM
                </div>
                <h3 className="text-base font-bold text-slate-900">
                  Never Gets Suspended by iOS or Android
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  When you tap <strong>Join Hangout</strong>, SquadTalk starts a continuous background media stream and registers with your phone or tablet&apos;s Lock Screen Media Controls. This prevents the OS from putting the browser tab to sleep when you switch to a game.
                </p>
              </div>

              <div className="p-5 bg-slate-50 rounded-xl space-y-2">
                <div className="text-xs font-mono font-semibold text-indigo-600">
                  02. FLOATING GAME OVERLAY (PiP)
                </div>
                <h3 className="text-base font-bold text-slate-900">
                  Optional Mini Call Window on Top of Games
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Tap <strong>Pop-Out Game Overlay</strong> inside the voice controls to open a tiny Picture-in-Picture window that floats over your other apps, showing who is talking and keeping the browser at 100% foreground priority.
                </p>
              </div>

              <div className="p-5 bg-slate-50 rounded-xl space-y-2">
                <div className="text-xs font-mono font-semibold text-indigo-600">
                  03. TEST IT YOURSELF IN 5 SECONDS
                </div>
                <h3 className="text-base font-bold text-slate-900">
                  Built-In Echo Loopback Test
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Turn on <strong>Echo Loopback Test</strong>, pull up another app over your browser, and talk! You will hear your own voice echoed back 1.4 seconds later—proving both your mic and speaker work in the background.
                </p>
              </div>
            </div>
          </section>
        )}

        {activeSection === 'vercel' && (
          <section className="bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900 font-display">
                  How Multiplayer Works on Vercel Hobby Plan (Zero Setup)
                </h2>
                <p className="text-sm text-slate-600 mt-1">
                  Connects all tabs and devices automatically over encrypted Cloud WebSocket MQTT relays + Multi-Tab BroadcastChannel so Vercel doesn&apos;t need a database.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveSection('room')}
                className="min-h-[40px] px-4 py-2 text-xs font-semibold bg-slate-900 text-white rounded-xl hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Back to Hangout
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="p-5 bg-slate-50 rounded-xl space-y-3">
                <h3 className="text-base font-bold text-slate-900">
                  Why Stateless Vercel Functions Alone Aren&apos;t Enough
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  On Vercel&apos;s Hobby plan, serverless functions spin up separate isolated instances and don&apos;t share live WebSocket state across users. SquadTalk solves this by connecting browsers directly to redundant public WebSocket MQTT relays (<code className="font-mono text-xs">wss://broker.emqx.io</code> and <code className="font-mono text-xs">wss://broker.hivemq.com</code>) plus <code className="font-mono text-xs">BroadcastChannel</code> for instant multi-tab testing.
                </p>
              </div>

              <div className="p-5 bg-slate-50 rounded-xl space-y-3">
                <h3 className="text-base font-bold text-slate-900">
                  Test Across Two Tabs Right Now
                </h3>
                <ol className="text-sm text-slate-600 space-y-2 list-decimal list-inside">
                  <li>Open this URL in two separate browser tabs (or on your phone and computer).</li>
                  <li>Both tabs immediately appear under <strong>Friends Online</strong> with their own username.</li>
                  <li>Tap <strong>Join Hangout</strong> or click any <strong>Quick Game Callout</strong> in one tab and hear it in the other tab!</li>
                </ol>
              </div>
            </div>
          </section>
        )}

        {/* Primary 2-Column Workspace: Left Voice Deck & Squad Grid (7 cols) + Right Callouts & Voice Feed (5 cols) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left 7 Columns: Tactile Voice Controls & Connected Friends */}
          <div
            className={`lg:col-span-7 space-y-6 ${
              activeSection === 'feed' ? 'hidden lg:block' : ''
            }`}
          >
            {/* Big Messenger-Kids-Simple Voice Deck */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-6">
              {!isJoined ? (
                <div className="text-center py-6 space-y-5">
                  <div className="w-16 h-16 rounded-2xl bg-indigo-600 text-white flex items-center justify-center mx-auto shadow-sm">
                    <Headphones className="w-8 h-8" />
                  </div>
                  <div className="space-y-2 max-w-md mx-auto">
                    <h2 className="text-2xl font-bold text-slate-900 font-display text-balance">
                      Ready to Talk with Friends?
                    </h2>
                    <p className="text-sm text-slate-600">
                      One tap turns on your microphone and activates Background Audio Keep-Alive so you can pull up your game right over this page and keep talking.
                    </p>
                  </div>

                  <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                    <button
                      type="button"
                      onClick={joinHangout}
                      className="w-full sm:w-auto min-h-[54px] px-8 py-3.5 text-base font-bold text-white bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] rounded-2xl shadow-sm transition-all flex items-center justify-center gap-3 cursor-pointer"
                    >
                      <Mic className="w-5 h-5" />
                      <span>Join Hangout & Enable Background Voice</span>
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Top Status & Leave / Overlay Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`w-3 h-3 rounded-full ${
                          micMode === 'muted'
                            ? 'bg-rose-500'
                            : isCurrentlyTransmitting
                              ? 'bg-emerald-500'
                              : 'bg-indigo-600'
                        }`}
                      />
                      <span className="text-sm font-bold text-slate-900">
                        {micMode === 'muted'
                          ? 'Microphone Muted (Still Hearing Friends)'
                          : isCurrentlyTransmitting
                            ? 'Transmitting Your Voice Live (1s Relay)'
                            : micMode === 'open'
                              ? 'Open Mic Listening — Just Talk Anytime'
                              : 'Push-to-Talk Mode — Hold Button to Speak'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleTogglePip}
                        className={`min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-xl border transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                          pipActive
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        <PictureInPicture2 className="w-4 h-4" />
                        <span>{pipActive ? 'Overlay Active' : 'Pop-Out Game Overlay'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={leaveHangout}
                        className="min-h-[38px] px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-xl flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Leave</span>
                      </button>
                    </div>
                  </div>

                  {micError && (
                    <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                      {micError}
                    </div>
                  )}

                  {/* 3 Big Tactile Mode Selector Buttons */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <button
                      type="button"
                      onClick={() => setMicMode('open')}
                      className={`min-h-[68px] p-4 rounded-2xl border text-left transition-all flex items-center gap-3.5 cursor-pointer ${
                        micMode === 'open'
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                          : 'bg-slate-50 text-slate-800 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          micMode === 'open' ? 'bg-white/20 text-white' : 'bg-white text-indigo-600'
                        }`}
                      >
                        <Mic className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-bold truncate">Open Mic</div>
                        <div
                          className={`text-xs truncate ${
                            micMode === 'open' ? 'text-indigo-100' : 'text-slate-500'
                          }`}
                        >
                          Hands-free for games
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setMicMode('ptt')}
                      className={`min-h-[68px] p-4 rounded-2xl border text-left transition-all flex items-center gap-3.5 cursor-pointer ${
                        micMode === 'ptt'
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                          : 'bg-slate-50 text-slate-800 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          micMode === 'ptt' ? 'bg-white/20 text-white' : 'bg-white text-indigo-600'
                        }`}
                      >
                        <Radio className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-bold truncate">Push to Talk</div>
                        <div
                          className={`text-xs truncate ${
                            micMode === 'ptt' ? 'text-indigo-100' : 'text-slate-500'
                          }`}
                        >
                          Walkie-talkie button
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setMicMode('muted')}
                      className={`min-h-[68px] p-4 rounded-2xl border text-left transition-all flex items-center gap-3.5 cursor-pointer ${
                        micMode === 'muted'
                          ? 'bg-rose-600 text-white border-rose-600 shadow-xs'
                          : 'bg-slate-50 text-slate-800 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          micMode === 'muted' ? 'bg-white/20 text-white' : 'bg-white text-rose-600'
                        }`}
                      >
                        <MicOff className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-bold truncate">Mute Mic</div>
                        <div
                          className={`text-xs truncate ${
                            micMode === 'muted' ? 'text-rose-100' : 'text-slate-500'
                          }`}
                        >
                          Listen only in background
                        </div>
                      </div>
                    </button>
                  </div>

                  {/* Giant Tactile Walkie-Talkie Pad when in Push-to-Talk Mode */}
                  {micMode === 'ptt' && (
                    <button
                      type="button"
                      onMouseDown={() => setIsPttPressed(true)}
                      onMouseUp={() => {
                        setIsPttPressed(false);
                        const flushed = audioEngineRef.current?.FlushCurrentBuffer();
                        if (flushed) {
                          transmitVoiceChunk({
                            ...flushed,
                            saveToFeed: true,
                            label: 'Walkie-Talkie Transmission',
                          });
                        }
                      }}
                      onTouchStart={(e) => {
                        e.preventDefault();
                        setIsPttPressed(true);
                      }}
                      onTouchEnd={(e) => {
                        e.preventDefault();
                        setIsPttPressed(false);
                        const flushed = audioEngineRef.current?.FlushCurrentBuffer();
                        if (flushed) {
                          transmitVoiceChunk({
                            ...flushed,
                            saveToFeed: true,
                            label: 'Walkie-Talkie Transmission',
                          });
                        }
                      }}
                      className={`w-full min-h-[104px] rounded-2xl border-2 transition-all flex flex-col items-center justify-center gap-1.5 select-none cursor-pointer ${
                        isPttPressed
                          ? 'bg-emerald-600 border-emerald-500 text-white scale-[0.99]'
                          : 'bg-slate-900 border-slate-900 text-white hover:bg-slate-800'
                      }`}
                    >
                      <Radio className="w-7 h-7" />
                      <span className="text-base font-bold">
                        {isPttPressed
                          ? 'Talking Now — Release When Done'
                          : 'Hold Down to Talk (or Hold Spacebar)'}
                      </span>
                      <span className="text-xs opacity-80">
                        Sends live 1-second chunks + saves voice bubble to feed
                      </span>
                    </button>
                  )}

                  {/* Real-Time Microphone Spectrum Visualizer & Sensitivity Controls */}
                  <div className="p-4 bg-slate-50 rounded-2xl space-y-4">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-700">
                        Live Mic Input Level & Voice Trigger
                      </span>
                      <span className="font-mono font-semibold text-slate-900 tabular-nums">
                        Mic: {myAudioLevel}% · Trigger Threshold: {vadThreshold}%
                      </span>
                    </div>

                    <div className="flex items-end gap-1.5 h-10 px-2 py-1 bg-white border border-slate-200 rounded-xl">
                      {myFreqBands.map((val, i) => {
                        const active = isJoined && micMode !== 'muted' && myAudioLevel >= vadThreshold;
                        return (
                          <div
                            key={i}
                            className="flex-1 bg-slate-100 rounded-sm h-full flex items-end overflow-hidden"
                          >
                            <div
                              style={{ height: `${Math.max(10, val)}%` }}
                              className={`w-full transition-all duration-75 rounded-sm ${
                                active ? 'bg-emerald-500' : 'bg-indigo-400'
                              }`}
                            />
                          </div>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs text-slate-600">
                          <span className="flex items-center gap-1.5 font-medium">
                            <Sliders className="w-3.5 h-3.5" />
                            <span>Open Mic Sensitivity</span>
                          </span>
                          <span className="font-mono tabular-nums">{vadThreshold}%</span>
                        </div>
                        <input
                          type="range"
                          min={4}
                          max={45}
                          value={vadThreshold}
                          onChange={(e) => setVadThreshold(Number(e.target.value))}
                          className="w-full accent-indigo-600 cursor-pointer"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs text-slate-600">
                          <button
                            type="button"
                            onClick={() => setIsSpeakerMuted((m) => !m)}
                            className="flex items-center gap-1.5 font-medium hover:text-slate-900 cursor-pointer"
                          >
                            {isSpeakerMuted ? (
                              <VolumeX className="w-3.5 h-3.5 text-rose-600" />
                            ) : (
                              <Volume2 className="w-3.5 h-3.5 text-indigo-600" />
                            )}
                            <span>
                              {isSpeakerMuted ? 'Speaker Muted' : 'Incoming Voice Volume'}
                            </span>
                          </button>
                          <span className="font-mono tabular-nums">
                            {isSpeakerMuted ? '0%' : `${Math.round(speakerVolume * 100)}%`}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0.1}
                          max={1.5}
                          step={0.05}
                          value={isSpeakerMuted ? 0 : speakerVolume}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setIsSpeakerMuted(false);
                            setSpeakerVolume(v);
                            audioEngineRef.current?.setSpeakerVolume(v);
                          }}
                          className="w-full accent-indigo-600 cursor-pointer"
                        />
                      </div>
                    </div>

                    {/* Background Self-Test & Telemetry Strip */}
                    <div className="pt-3 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-3">
                      <div className="text-xs text-slate-500 font-mono tabular-nums">
                        Sent: {chunksSentCount} chunks · Heard: {chunksReceivedCount} chunks
                      </div>

                      <button
                        type="button"
                        onClick={() => setEchoTestEnabled((v) => !v)}
                        className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-xl border transition-colors flex items-center gap-1.5 cursor-pointer ${
                          echoTestEnabled
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>
                          {echoTestEnabled
                            ? 'Echo Loopback Test ON (Hear Yourself After 1.4s)'
                            : 'Test Background Mic & Speaker (Echo Test)'}
                        </span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Connected Friends Grid */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users className="w-5 h-5 text-slate-700" />
                  <h2 className="text-lg font-bold text-slate-900 font-display">
                    Friends Online
                  </h2>
                </div>
                <span className="text-xs text-slate-500 tabular-nums">
                  {participants.length} {participants.length === 1 ? 'person' : 'people'} connected
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {participants.map((p) => {
                  const isMe = p.id === peerId;
                  const colorMeta = getColorMeta(p.color);
                  const speaking = isMe
                    ? isCurrentlyTransmitting
                    : p.isSpeaking || p.audioLevel > 14;
                  const level = isMe ? myAudioLevel : p.audioLevel;

                  return (
                    <div
                      key={p.id}
                      className={`p-4 rounded-2xl border transition-all ${
                        speaking
                          ? 'bg-emerald-50/60 border-emerald-400 shadow-xs'
                          : 'bg-slate-50/70 border-slate-200'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`w-12 h-12 rounded-2xl ${colorMeta.bg} text-white flex items-center justify-center shrink-0 ${
                              speaking ? 'ring-4 ring-emerald-400/50' : ''
                            }`}
                          >
                            <AvatarIcon avatarId={p.avatarId} className="w-6 h-6" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-slate-900 truncate">
                              {p.name} {isMe ? '(You)' : ''}
                            </div>
                            <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                              <span>
                                {p.micMode === 'muted'
                                  ? 'Listening (Muted)'
                                  : speaking
                                    ? 'Talking Now'
                                    : p.micMode === 'open'
                                      ? 'Open Mic'
                                      : 'Push-to-Talk'}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>
                                {p.inBackground ? 'In Background App' : 'In App'}
                              </span>
                            </div>
                          </div>
                        </div>

                        <span className="font-mono text-xs font-semibold text-slate-600 tabular-nums shrink-0">
                          {p.micMode === 'muted' ? 'MUTE' : `${level}%`}
                        </span>
                      </div>

                      <div className="mt-3 h-1.5 w-full bg-slate-200/80 rounded-full overflow-hidden">
                        <div
                          style={{
                            width: `${
                              p.micMode === 'muted' ? 0 : Math.min(100, Math.max(4, level))
                            }%`,
                          }}
                          className={`h-full transition-all duration-150 ${
                            speaking ? 'bg-emerald-500' : 'bg-indigo-500'
                          }`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right 5 Columns: Instant Soundboard Callouts & Voice/Chat Feed */}
          <div
            className={`lg:col-span-5 space-y-6 ${
              activeSection === 'room' ? 'block' : ''
            }`}
          >
            {/* Instant Soundboard Callouts */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-indigo-600" />
                  <h2 className="text-base font-bold text-slate-900 font-display">
                    Quick Game Callouts & Chimes
                  </h2>
                </div>
                <span className="text-xs text-slate-500">Plays in background</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {CALLOUT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => sendCallout(preset)}
                    className="min-h-[52px] px-3 py-2 bg-slate-50 hover:bg-indigo-50 active:scale-[0.98] border border-slate-200 hover:border-indigo-200 rounded-xl text-left transition-all cursor-pointer"
                  >
                    <div className="text-xs font-bold text-slate-900 truncate">
                      {preset.label}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">{preset.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Live Voice Clips & Chat Feed */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col h-[480px]">
              <div className="flex items-center justify-between pb-3.5 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-slate-700" />
                  <h2 className="text-base font-bold text-slate-900 font-display">
                    Voice Bubbles & Chat
                  </h2>
                </div>

                {isJoined && (
                  <button
                    type="button"
                    onMouseDown={() => setIsRecordingNote(true)}
                    onMouseUp={() => {
                      setIsRecordingNote(false);
                      const flushed = audioEngineRef.current?.FlushCurrentBuffer();
                      if (flushed) {
                        transmitVoiceChunk({
                          ...flushed,
                          saveToFeed: true,
                          label: 'Voice Bubble',
                        });
                      }
                    }}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      setIsRecordingNote(true);
                    }}
                    onTouchEnd={(e) => {
                      e.preventDefault();
                      setIsRecordingNote(false);
                      const flushed = audioEngineRef.current?.FlushCurrentBuffer();
                      if (flushed) {
                        transmitVoiceChunk({
                          ...flushed,
                          saveToFeed: true,
                          label: 'Voice Bubble',
                        });
                      }
                    }}
                    className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                      isRecordingNote
                        ? 'bg-rose-600 text-white'
                        : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                    }`}
                  >
                    <Mic className="w-3.5 h-3.5" />
                    <span>
                      {isRecordingNote ? 'Release to Send Voice Bubble' : 'Hold for Voice Bubble'}
                    </span>
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto py-4 space-y-3 pr-1">
                {messages.map((m) => {
                  const isMe = m.senderId === peerId;
                  const timeStr = new Date(m.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  });

                  return (
                    <div
                      key={m.id}
                      className={`p-3.5 rounded-2xl border ${
                        isMe
                          ? 'bg-indigo-50/50 border-indigo-200/80 ml-4'
                          : 'bg-slate-50 border-slate-200/80 mr-4'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs text-slate-500 mb-1">
                        <span className="font-bold text-slate-800">{m.senderName}</span>
                        <span className="font-mono tabular-nums">{timeStr}</span>
                      </div>

                      {m.type === 'voice_clip' && m.audioDataUrl ? (
                        <div className="flex items-center justify-between gap-3 pt-1">
                          <span className="text-xs font-medium text-slate-700">
                            {m.text} ({((m.durationMs || 1000) / 1000).toFixed(1)}s)
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              audioEngineRef.current?.playIncomingVoiceChunk(m.audioDataUrl!)
                            }
                            className="min-h-[36px] px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 shrink-0 cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>Replay Voice</span>
                          </button>
                        </div>
                      ) : m.type === 'callout' ? (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-bold text-indigo-700">
                            Sound Callout: {m.text}
                          </span>
                          {m.soundId && (
                            <button
                              type="button"
                              onClick={() =>
                                audioEngineRef.current?.playCalloutSound(
                                  m.soundId as CalloutSoundId
                                )
                              }
                              className="text-xs font-semibold text-indigo-600 hover:underline cursor-pointer"
                            >
                              Hear Chime
                            </button>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-slate-800 break-words leading-relaxed">
                          {m.text}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <form
                onSubmit={handleSendText}
                className="pt-3 border-t border-slate-100 flex items-center gap-2"
              >
                <input
                  type="text"
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  placeholder="Send a message..."
                  className="flex-1 min-h-[44px] px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-600"
                />
                <button
                  type="submit"
                  className="min-h-[44px] min-w-[44px] px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  <span>Send</span>
                </button>
              </form>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white px-4 sm:px-6 lg:px-8 py-4 mt-8">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>
              SquadTalk — Global WebSocket Mesh + Multi-Tab Voice Hangout (Vercel Hobby Ready)
            </span>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setActiveSection('guide')}
              className="hover:text-slate-900 underline-offset-4 hover:underline cursor-pointer"
            >
              Background Audio Tips
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('vercel')}
              className="hover:text-slate-900 underline-offset-4 hover:underline cursor-pointer"
            >
              Vercel Hobby Plan Guide
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
