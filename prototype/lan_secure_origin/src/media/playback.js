// ==========================================
// Media Playback, Hardware Frame Callback & First-Frame Instrumentation
// ==========================================
import { state } from '../core/state.js';

export class MediaController {
  constructor(videoElement, videoSelectElement) {
    this.video = videoElement;
    this.videoSelect = videoSelectElement;
    this.videoFrameNeedsUpload = false;
    this.lastUploadedVideoTime = -1;
    this.hasLoggedFirstFrame = false;
    this.initListeners();
  }

  initListeners() {
    const onFrame = () => {
      this.videoFrameNeedsUpload = true;
      if (!state.firstFrameTimings.firstFrameDecodedAt && state.firstFrameTimings.selectedAt) {
        state.firstFrameTimings.firstFrameDecodedAt = performance.now();
        state.firstFrameTimings.statusText = 'Decoded Frame Arrived';
      }
      if (this.video.requestVideoFrameCallback) {
        this.video.requestVideoFrameCallback(onFrame);
      }
    };

    if (this.video.requestVideoFrameCallback) {
      this.video.requestVideoFrameCallback(onFrame);
    } else {
      this.video.addEventListener('timeupdate', () => {
        this.videoFrameNeedsUpload = true;
        if (!state.firstFrameTimings.firstFrameDecodedAt && state.firstFrameTimings.selectedAt) {
          state.firstFrameTimings.firstFrameDecodedAt = performance.now();
          state.firstFrameTimings.statusText = 'Decoded Frame Arrived';
        }
      });
    }

    this.video.addEventListener('loadstart', () => {
      state.firstFrameTimings.statusText = 'Loading Media Header...';
    });

    this.video.addEventListener('loadedmetadata', () => {
      state.videoDuration = this.video.duration;
      state.videoWidth = this.video.videoWidth;
      state.videoHeight = this.video.videoHeight;
      if (state.firstFrameTimings.selectedAt) {
        state.firstFrameTimings.metadataAt = performance.now();
        state.firstFrameTimings.statusText = 'Metadata Loaded';
      }
      const elRes = document.getElementById('valVideoRes');
      const elDur = document.getElementById('valVideoDur');
      if (elRes) elRes.textContent = this.video.videoWidth + 'x' + this.video.videoHeight;
      if (elDur) elDur.textContent = this.video.duration.toFixed(1) + 's';
    });

    this.video.addEventListener('canplay', () => {
      if (state.firstFrameTimings.selectedAt && !state.firstFrameTimings.canplayAt) {
        state.firstFrameTimings.canplayAt = performance.now();
        state.firstFrameTimings.statusText = 'Decoder Ready';
      }
    });

    this.video.addEventListener('timeupdate', () => {
      const elTime = document.getElementById('valVideoTime');
      if (elTime) elTime.textContent = this.video.currentTime.toFixed(1) + 's';
    });

    this.video.addEventListener('play', () => {
      const elStat = document.getElementById('valPlayStatus');
      if (elStat) { elStat.textContent = 'Playing'; elStat.style.color = '#34d399'; }
    });

    this.video.addEventListener('pause', () => {
      const elStat = document.getElementById('valPlayStatus');
      if (elStat) { elStat.textContent = 'Paused'; elStat.style.color = '#fbbf24'; }
    });

    this.video.addEventListener('error', () => {
      const err = this.video.error ? (this.video.error.code + ': ' + this.video.error.message) : 'unknown error';
      console.error('Video decode error: ' + err);
      state.firstFrameTimings.statusText = 'Decode Error: ' + err;
    });

    if (this.videoSelect) {
      this.videoSelect.addEventListener('change', (e) => {
        this.selectVideo(e.target.value);
      });
    }
  }

  selectVideo(relPath) {
    state.videoPath = relPath;
    this.hasLoggedFirstFrame = false;
    const now = performance.now();
    state.firstFrameTimings = {
      selectedAt: now,
      metadataAt: 0,
      canplayAt: 0,
      firstFrameDecodedAt: 0,
      firstTextureUploadAt: 0,
      firstRenderAt: 0,
      ready: false,
      statusText: 'Opening ' + relPath.split('/').pop()
    };

    this.video.src = '/video?path=' + encodeURIComponent(relPath);
    this.video.load();
    this.videoFrameNeedsUpload = true;
    if (state.inVR) {
      this.video.play().catch(e => console.log('Video play error:', e));
    }
  }

  async loadVideoList() {
    try {
      const res = await fetch('/api/videos');
      const data = await res.json();
      if (data.videos && data.videos.length > 0) {
        state.videoList = data.videos;
        if (this.videoSelect) {
          this.videoSelect.innerHTML = '';
          data.videos.forEach((v) => {
            const opt = document.createElement('option');
            opt.value = v.relPath;
            opt.textContent = '[' + v.sizeGB + '] ' + v.name;
            this.videoSelect.appendChild(opt);
          });
        }
        this.selectVideo(data.videos[0].relPath);
      }
    } catch (err) {
      console.warn('Fallback: Using default media item', err);
      this.selectVideo('4K/4096_2048_crf18_avc1-Kururugi Aoi - WAVR224.mp4');
    }
  }

  shouldUploadTexture() {
    if (this.video.readyState >= 2 && (this.videoFrameNeedsUpload || (this.video.currentTime !== this.lastUploadedVideoTime && !this.video.paused))) {
      this.videoFrameNeedsUpload = false;
      this.lastUploadedVideoTime = this.video.currentTime;
      if (!state.firstFrameTimings.firstTextureUploadAt && state.firstFrameTimings.selectedAt) {
        state.firstFrameTimings.firstTextureUploadAt = performance.now();
        state.firstFrameTimings.ready = true;
        state.firstFrameTimings.statusText = 'VR Ready';
      }
      return true;
    }
    return false;
  }

  recordRenderedFrame() {
    if (!state.firstFrameTimings.firstRenderAt && state.firstFrameTimings.firstTextureUploadAt) {
      state.firstFrameTimings.firstRenderAt = performance.now();
      if (!this.hasLoggedFirstFrame) {
        this.hasLoggedFirstFrame = true;
        const t = state.firstFrameTimings;
        const totalMs = (t.firstRenderAt - t.selectedAt).toFixed(1);
        const metaMs = (t.metadataAt ? (t.metadataAt - t.selectedAt).toFixed(1) : '--');
        const canplayMs = (t.canplayAt ? (t.canplayAt - t.metadataAt).toFixed(1) : '--');
        const decodeMs = (t.firstFrameDecodedAt ? (t.firstFrameDecodedAt - t.canplayAt).toFixed(1) : '--');
        const uploadMs = (t.firstTextureUploadAt - (t.firstFrameDecodedAt || t.canplayAt)).toFixed(1);
        console.log(`[First Frame Timing] Total: ${totalMs}ms | Meta: ${metaMs}ms | CanPlay: ${canplayMs}ms | Decode: ${decodeMs}ms | Upload: ${uploadMs}ms`);
      }
    }
  }
}
