import { Participant, MicMode } from '../shared/roomStore';

export class PipCallOverlay {
  private canvas: HTMLCanvasElement | null = null;
  private video: HTMLVideoElement | null = null;
  private animTimer: number | null = null;
  public isActive = false;

  public async togglePip(
    getState: () => {
      myMicMode: MicMode;
      myAudioLevel: number;
      participants: Participant[];
    },
    onStateChange: (active: boolean) => void
  ): Promise<boolean> {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture().catch(() => {});
      this.stop();
      onStateChange(false);
      return false;
    }

    try {
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = 360;
        this.canvas.height = 200;
      }

      this.drawFrame(getState());

      if (!this.video) {
        this.video = document.createElement('video');
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.setAttribute('playsinline', 'true');
        const stream = this.canvas.captureStream(12);
        this.video.srcObject = stream;
      }

      await this.video.play();
      if (this.video.requestPictureInPicture) {
        await this.video.requestPictureInPicture();
        this.isActive = true;
        onStateChange(true);

        this.video.onleavepictureinpicture = () => {
          this.isActive = false;
          this.stop();
          onStateChange(false);
        };

        this.animTimer = window.setInterval(() => {
          this.drawFrame(getState());
        }, 120);

        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private drawFrame(state: {
    myMicMode: MicMode;
    myAudioLevel: number;
    participants: Participant[];
  }) {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, 360, 200);

    ctx.fillStyle = '#1E293B';
    ctx.fillRect(0, 0, 360, 40);

    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 14px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('SQUADTALK VOICE', 14, 25);

    const micLabel =
      state.myMicMode === 'open'
        ? 'OPEN MIC ON'
        : state.myMicMode === 'ptt'
          ? 'PUSH TO TALK'
          : 'MIC MUTED';
    ctx.fillStyle =
      state.myMicMode === 'muted'
        ? '#F87171'
        : state.myAudioLevel > 12
          ? '#4ADE80'
          : '#38BDF8';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.fillText(micLabel, 240, 25);

    const list = state.participants.slice(0, 4);
    list.forEach((p, idx) => {
      const y = 56 + idx * 34;
      const speaking = p.isSpeaking || p.audioLevel > 15;

      ctx.fillStyle = speaking ? '#1E3A8A' : '#1E293B';
      ctx.fillRect(14, y, 332, 28);

      ctx.fillStyle = speaking ? '#4ADE80' : '#94A3B8';
      ctx.font = 'bold 13px "DM Sans", sans-serif';
      ctx.fillText(p.name.slice(0, 18), 24, y + 19);

      ctx.fillStyle = speaking ? '#4ADE80' : '#64748B';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillText(
        speaking ? `TALKING (${p.audioLevel}%)` : p.micMode.toUpperCase(),
        225,
        y + 18
      );
    });
  }

  public stop() {
    if (this.animTimer !== null) {
      clearInterval(this.animTimer);
      this.animTimer = null;
    }
    this.isActive = false;
  }
}
