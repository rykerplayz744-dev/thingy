// Universal Background Voice & 1-Second Chunk Audio Engine

export type CalloutSoundId = 'hop_on' | 'wait_up' | 'gg' | 'watch_out' | 'ready' | 'laugh';

export interface CapturedChunkResult {
  audioDataUrl: string;
  durationMs: number;
  peakLevel: number;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function encodeWavFromFloat32(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate = 11025
): string {
  // Downsample to targetSampleRate for compact 1-second packets (~22KB/sec)
  const ratio = sourceSampleRate / targetSampleRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const buffer = new ArrayBuffer(44 + outLength * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + outLength * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // 16-bit
  writeString(view, 36, 'data');
  view.setUint32(40, outLength * 2, true);

  let offset = 44;
  for (let i = 0; i < outLength; i++) {
    const srcIdx = Math.min(samples.length - 1, Math.floor(i * ratio));
    const s = Math.max(-1, Math.min(1, samples[srcIdx]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function base64DataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64Index = dataUrl.indexOf(';base64,');
  const base64 = base64Index !== -1 ? dataUrl.slice(base64Index + 8) : dataUrl;
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export class SquadAudioEngine {
  private ctx: AudioContext | null = null;
  private keepAliveDest: MediaStreamAudioDestinationNode | null = null;
  private keepAliveAudioEl: HTMLAudioElement | null = null;
  private masterGain: GainNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private wakeLock: any = null;

  private pcmChunks: Float32Array[] = [];
  private pcmTotalSamples = 0;
  private currentWindowPeak = 0;
  private lastChunkEmitTime = 0;
  private nextPlayTime = 0;

  public isBackgroundKeepAliveActive = false;
  public speakerVolume = 1.0;

  public async initAudioContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    if (!this.masterGain) {
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.speakerVolume;
      this.masterGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  public setSpeakerVolume(vol: number) {
    this.speakerVolume = Math.max(0, Math.min(1.5, vol));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.speakerVolume, this.ctx.currentTime);
    }
    if (this.keepAliveAudioEl) {
      this.keepAliveAudioEl.volume = Math.min(1, this.speakerVolume);
    }
  }

  /**
   * Starts the continuous background audio carrier + OS MediaSession + WebLocks
   * so pulling up another app (Roblox, Minecraft, etc.) over the browser does not
   * suspend microphone capture or incoming voice playback.
   */
  public async enableBackgroundKeepAlive(
    roomId: string,
    onToggleMute?: () => void
  ): Promise<boolean> {
    try {
      const ctx = await this.initAudioContext();

      if (!this.keepAliveDest) {
        this.keepAliveDest = ctx.createMediaStreamDestination();
        if (this.masterGain) {
          this.masterGain.connect(this.keepAliveDest);
        }

        // Sub-audible continuous carrier so mobile OS media daemon never sleeps the stream
        const osc = ctx.createOscillator();
        const carrierGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 32;
        carrierGain.gain.value = 0.00015;
        osc.connect(carrierGain);
        carrierGain.connect(this.keepAliveDest);
        osc.start();
      }

      if (!this.keepAliveAudioEl) {
        const audio = document.createElement('audio');
        audio.setAttribute('playsinline', 'true');
        audio.setAttribute('webkit-playsinline', 'true');
        audio.autoplay = true;
        audio.srcObject = this.keepAliveDest.stream;
        this.keepAliveAudioEl = audio;
      }

      await this.keepAliveAudioEl.play().catch(() => {
        // Handled on next interaction if blocked
      });

      // Configure OS Lock Screen & Control Center MediaSession
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: `SquadTalk — Room ${roomId}`,
          artist: 'Background Voice Active (1s Relay)',
          album: 'Switch apps freely — voice stays connected',
        });
        navigator.mediaSession.playbackState = 'playing';

        if (onToggleMute) {
          navigator.mediaSession.setActionHandler('play', () => {
            this.ctx?.resume();
            this.keepAliveAudioEl?.play().catch(() => {});
          });
          navigator.mediaSession.setActionHandler('pause', () => {
            onToggleMute();
            if (navigator.mediaSession) {
              navigator.mediaSession.playbackState = 'playing';
            }
          });
        }
      }

      // Request Web Lock to prevent background tab freezing in Chromium browsers
      if ('locks' in navigator && (navigator as any).locks?.request) {
        (navigator as any).locks
          .request('squadtalk_background_voice_lock', () => new Promise(() => {}))
          .catch(() => {});
      }

      // Request Screen WakeLock when visible
      if ('wakeLock' in navigator && (navigator as any).wakeLock?.request) {
        try {
          this.wakeLock = await (navigator as any).wakeLock.request('screen');
        } catch {
          // WakeLock optional
        }
      }

      this.isBackgroundKeepAliveActive = true;
      return true;
    } catch {
      return false;
    }
  }

  public async resumeIfNeeded() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }
    if (this.keepAliveAudioEl && this.keepAliveAudioEl.paused) {
      await this.keepAliveAudioEl.play().catch(() => {});
    }
  }

  /**
   * Starts microphone capture and invokes `onOneSecondChunk` every ~1000ms
   * whenever shouldTransmit() returns true.
   */
  public async startMicrophone(options: {
    shouldTransmit: (peakLevel: number) => boolean;
    onLevelChange: (level: number, freqBands: number[]) => void;
    onOneSecondChunk: (chunk: CapturedChunkResult) => void;
  }): Promise<boolean> {
    const ctx = await this.initAudioContext();

    if (!this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
    }

    // Clean up any existing nodes before re-wiring
    this. processor?.disconnect();
    this.micSource?.disconnect();

    this.micSource = ctx.createMediaStreamSource(this.micStream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 128;
    this.analyser.smoothingTimeConstant = 0.65;

    // 4096 buffer @ 44.1kHz is ~92ms per callback
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);

    this.pcmChunks = [];
    this.pcmTotalSamples = 0;
    this.currentWindowPeak = 0;
    this.lastChunkEmitTime = performance.now();

    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);

      // Compute RMS / Peak for this frame
      let sumSquares = 0;
      let framePeak = 0;
      for (let i = 0; i < input.length; i++) {
        const abs = Math.abs(input[i]);
        sumSquares += abs * abs;
        if (abs > framePeak) framePeak = abs;
      }
      const rms = Math.sqrt(sumSquares / input.length);
      const normalizedLevel = Math.min(100, Math.round(Math.pow(rms * 3.8, 0.75) * 100));

      if (normalizedLevel > this.currentWindowPeak) {
        this.currentWindowPeak = normalizedLevel;
      }

      if (this.analyser) {
        this.analyser.getByteFrequencyData(freqData);
        const bands: number[] = [];
        const step = Math.max(1, Math.floor(freqData.length / 12));
        for (let b = 0; b < 12; b++) {
          bands.push(Math.round((freqData[b * step] / 255) * 100));
        }
        options.onLevelChange(normalizedLevel, bands);
      }

      // Copy samples into current 1-second buffer
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.pcmChunks.push(copy);
      this.pcmTotalSamples += copy.length;

      const now = performance.now();
      const elapsedMs = now - this.lastChunkEmitTime;

      // Emit every ~1000ms (1 second delay window)
      if (elapsedMs >= 980 && this.pcmTotalSamples > 0) {
        const peak = this.currentWindowPeak;
        const transmit = options.shouldTransmit(peak);

        if (transmit) {
          const merged = new Float32Array(this.pcmTotalSamples);
          let offset = 0;
          for (const c of this.pcmChunks) {
            merged.set(c, offset);
            offset += c.length;
          }
          const wavDataUrl = encodeWavFromFloat32(merged, ctx.sampleRate, 11025);
          options.onOneSecondChunk({
            audioDataUrl: wavDataUrl,
            durationMs: Math.round(elapsedMs),
            peakLevel: peak,
          });
        }

        this.pcmChunks = [];
        this.pcmTotalSamples = 0;
        this.currentWindowPeak = 0;
        this.lastChunkEmitTime = now;
      }
    };

    // ScriptProcessor requires connection to destination to fire in all browsers;
    // connect through a 0-gain mute node so the user doesn't hear immediate raw self-feedback.
    const silentMonitor = ctx.createGain();
    silentMonitor.gain.value = 0;

    this.micSource.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(silentMonitor);
    silentMonitor.connect(ctx.destination);

    return true;
  }

  public FlushCurrentBuffer(): CapturedChunkResult | null {
    if (!this.ctx || this.pcmTotalSamples < this.ctx.sampleRate * 0.2) {
      this.pcmChunks = [];
      this.pcmTotalSamples = 0;
      this.currentWindowPeak = 0;
      return null;
    }
    const merged = new Float32Array(this.pcmTotalSamples);
    let offset = 0;
    for (const c of this.pcmChunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    const durationMs = Math.round((this.pcmTotalSamples / this.ctx.sampleRate) * 1000);
    const peak = this.currentWindowPeak;
    const wavDataUrl = encodeWavFromFloat32(merged, this.ctx.sampleRate, 11025);

    this.pcmChunks = [];
    this.pcmTotalSamples = 0;
    this.currentWindowPeak = 0;
    this.lastChunkEmitTime = performance.now();

    return {
      audioDataUrl: wavDataUrl,
      durationMs,
      peakLevel: Math.max(30, peak),
    };
  }

  /**
   * Plays an incoming 1-second voice chunk seamlessly through the already-unlocked
   * AudioContext + Background MediaStream so it works even when another app is in front!
   */
  public async playIncomingVoiceChunk(audioDataUrl: string): Promise<void> {
    try {
      const ctx = await this.initAudioContext();
      await this.resumeIfNeeded();

      const arrayBuffer = base64DataUrlToArrayBuffer(audioDataUrl);
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      // Boost voice clarity slightly with a gentle compressor/gain
      const voiceGain = ctx.createGain();
      voiceGain.gain.value = 1.15;

      source.connect(voiceGain);
      if (this.masterGain) {
        voiceGain.connect(this.masterGain);
      } else {
        voiceGain.connect(ctx.destination);
      }

      // Queue chunks smoothly back-to-back without overlapping stutter
      const now = ctx.currentTime;
      const startAt = Math.max(now + 0.02, this.nextPlayTime);
      source.start(startAt);
      this.nextPlayTime = startAt + audioBuffer.duration;
    } catch {
      // Fallback to standard HTMLAudioElement if decodeAudioData fails
      try {
        const fallbackAudio = new Audio(audioDataUrl);
        fallbackAudio.volume = Math.min(1, this.speakerVolume);
        await fallbackAudio.play();
      } catch {
        // Ignore playback error
      }
    }
  }

  /**
   * Plays a synthesized callout sound effect through the background audio stream
   */
  public async playCalloutSound(soundId: CalloutSoundId): Promise<void> {
    try {
      const ctx = await this.initAudioContext();
      await this.resumeIfNeeded();

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      if (this.masterGain) {
        gain.connect(this.masterGain);
      } else {
        gain.connect(ctx.destination);
      }

      if (soundId === 'hop_on') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.setValueAtTime(659.25, now + 0.1); // E5
        osc.frequency.setValueAtTime(783.99, now + 0.2); // G5
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        osc.start(now);
        osc.stop(now + 0.45);
      } else if (soundId === 'wait_up') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(659.25, now);
        osc.frequency.setValueAtTime(440, now + 0.14);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (soundId === 'gg') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(554.37, now + 0.08);
        osc.frequency.setValueAtTime(659.25, now + 0.16);
        osc.frequency.setValueAtTime(880, now + 0.24);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
        osc.start(now);
        osc.stop(now + 0.55);
      } else if (soundId === 'watch_out') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(740, now);
        osc.frequency.setValueAtTime(587.33, now + 0.12);
        osc.frequency.setValueAtTime(740, now + 0.24);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.4);
      } else if (soundId === 'ready') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880, now + 0.12);
        gain.gain.setValueAtTime(0.22, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
        osc.start(now);
        osc.stop(now + 0.32);
      } else {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(320, now + 0.25);
        gain.gain.setValueAtTime(0.22, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.start(now);
        osc.stop(now + 0.28);
      }
    } catch {
      // Ignore audio synth error
    }
  }

  public stopMicrophone() {
    this.processor?.disconnect();
    this.micSource?.disconnect();
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
  }

  public destroy() {
    this.stopMicrophone();
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
    if (this.keepAliveAudioEl) {
      this.keepAliveAudioEl.pause();
      this.keepAliveAudioEl.srcObject = null;
      this.keepAliveAudioEl = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
