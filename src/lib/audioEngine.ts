// Universal Background Voice & Ultra-Low-Latency Micro-Chunk Audio Engine

export type CalloutSoundId = 'hop_on' | 'wait_up' | 'gg' | 'watch_out' | 'ready' | 'laugh';
export type LatencyPresetMs = 250 | 450 | 950;

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
  targetSampleRate = 8000
): string {
  const ratio = sourceSampleRate / targetSampleRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  // 8-bit unsigned PCM WAV (1 byte per sample = only ~2KB per 0.25s frame!)
  const buffer = new ArrayBuffer(44 + outLength);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + outLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate, true); // 1 byte per sample
  view.setUint16(32, 1, true); // Block align 1
  view.setUint16(34, 8, true); // 8-bit PCM
  writeString(view, 36, 'data');
  view.setUint32(40, outLength, true);

  let offset = 44;
  for (let i = 0; i < outLength; i++) {
    const srcIdx = Math.min(samples.length - 1, Math.floor(i * ratio));
    const s = Math.max(-1, Math.min(1, samples[srcIdx]));
    // 8-bit WAV is unsigned 0..255 with 128 as center silence
    view.setUint8(offset, Math.round((s + 1) * 127.5));
    offset += 1;
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

  public chunkIntervalMs: LatencyPresetMs = 250; // Default to ultra-fast 250ms micro-frames!
  public isBackgroundKeepAliveActive = false;
  public speakerVolume = 1.0;

  public async initAudioContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
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

  public setChunkIntervalMs(ms: LatencyPresetMs) {
    this.chunkIntervalMs = ms;
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

      await this.keepAliveAudioEl.play().catch(() => {});

      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: `SquadTalk — ${roomId}`,
          artist: 'Background Voice Active (Low-Latency Stream)',
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

      if ('locks' in navigator && (navigator as any).locks?.request) {
        (navigator as any).locks
          .request('squadtalk_background_voice_lock', () => new Promise(() => {}))
          .catch(() => {});
      }

      if ('wakeLock' in navigator && (navigator as any).wakeLock?.request) {
        try {
          this.wakeLock = await (navigator as any).wakeLock.request('screen');
        } catch {
          // Optional
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

    this.processor?.disconnect();
    this.micSource?.disconnect();

    this.micSource = ctx.createMediaStreamSource(this.micStream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 128;
    this.analyser.smoothingTimeConstant = 0.6;

    // 2048 buffer @ 44.1kHz is ~46ms callback latency (twice as responsive as 4096)
    this.processor = ctx.createScriptProcessor(2048, 1, 1);
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);

    this.pcmChunks = [];
    this.pcmTotalSamples = 0;
    this.currentWindowPeak = 0;
    this.lastChunkEmitTime = performance.now();

    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);

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

      const copy = new Float32Array(input.length);
      copy.set(input);
      this.pcmChunks.push(copy);
      this.pcmTotalSamples += copy.length;

      const now = performance.now();
      const elapsedMs = now - this.lastChunkEmitTime;

      // Emit at the configured low-latency window (default 250ms!)
      if (elapsedMs >= this.chunkIntervalMs && this.pcmTotalSamples > 0) {
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

    const silentMonitor = ctx.createGain();
    silentMonitor.gain.value = 0;

    this.micSource.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(silentMonitor);
    silentMonitor.connect(ctx.destination);

    return true;
  }

  public FlushCurrentBuffer(): CapturedChunkResult | null {
    if (!this.ctx || this.pcmTotalSamples < this.ctx.sampleRate * 0.12) {
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

  public async playIncomingVoiceChunk(audioDataUrl: string): Promise<void> {
    try {
      const ctx = await this.initAudioContext();
      await this.resumeIfNeeded();

      const arrayBuffer = base64DataUrlToArrayBuffer(audioDataUrl);
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      const voiceGain = ctx.createGain();
      voiceGain.gain.value = 1.15;

      source.connect(voiceGain);
      if (this.masterGain) {
        voiceGain.connect(this.masterGain);
      } else {
        voiceGain.connect(ctx.destination);
      }

      const now = ctx.currentTime;
      // Prevent queue buildup if behind by more than 0.6s (keeps live stream real-time!)
      if (this.nextPlayTime > now + 0.6) {
        this.nextPlayTime = now + 0.01;
      }
      const startAt = Math.max(now + 0.008, this.nextPlayTime);
      source.start(startAt);
      this.nextPlayTime = startAt + audioBuffer.duration;
    } catch {
      try {
        const fallbackAudio = new Audio(audioDataUrl);
        fallbackAudio.volume = Math.min(1, this.speakerVolume);
        await fallbackAudio.play();
      } catch {
        // Ignore
      }
    }
  }

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
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.1);
        osc.frequency.setValueAtTime(783.99, now + 0.2);
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
      // Ignore
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
