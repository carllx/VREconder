// ==========================================
// Media Playback, Hardware Frame Callback & First-Frame Instrumentation
// ==========================================
import { state } from '../core/state.js';
import { perfTelemetry } from '../telemetry/telemetry.js';
import { stallDetector, serializeMediaError } from '../telemetry/stall-detector.js';

export class MediaController {
  constructor(videoElement, videoSelectElement) {
    this.video = videoElement;
    this.videoSelect = videoSelectElement;
    this.videoFrameNeedsUpload = false;
    this.lastUploadedVideoTime = -1;
    this.hasLoggedFirstFrame = false;
    this.currentMediaGeneration = 0;
    this.decodedMediaGeneration = -1;
    this.poisonedGeneration = -1;
    this.activeFallbackToken = 0;
    this.onMediaInvalidated = null;
    this.probeTimeoutMs = 5000;
    this.probeTimer = null;
    this.initListeners();
  }

  isCurrentMediaDecoded() {
    return this.currentMediaGeneration > 0 && 
           this.decodedMediaGeneration === this.currentMediaGeneration &&
           this.poisonedGeneration !== this.currentMediaGeneration;
  }

  clearProbeTimer() {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  notifyInvalidated(generation, path = state.videoPath) {
    if (typeof this.onMediaInvalidated === 'function') {
      try {
        this.onMediaInvalidated(generation, path);
      } catch (e) {
        console.warn('onMediaInvalidated error:', e);
      }
    }
  }

  onProbeTimeout(generation) {
    if (generation !== this.currentMediaGeneration) return;
    if (this.isCurrentMediaDecoded()) return;
    this.poisonedGeneration = generation;
    state.firstFrameTimings.statusText = 'No decoded video frame received within probe window (Fail closed)';
    state.firstFrameTimings.ready = false;
    this.videoFrameNeedsUpload = false;
    this.notifyInvalidated(generation, state.videoPath);
  }

  onDecodedFrame(generation, now, metadata = null) {
    if (generation !== this.currentMediaGeneration || generation === this.poisonedGeneration) {
      return false;
    }
    const w = this.video ? this.video.videoWidth : 0;
    const h = this.video ? this.video.videoHeight : 0;
    if (w <= 0 || h <= 0) {
      return false;
    }
    this.decodedMediaGeneration = generation;
    this.clearProbeTimer();
    this.videoFrameNeedsUpload = true;
    perfTelemetry.recordRvfc();
    stallDetector.recordRvfc(now, metadata);
    if (!state.firstFrameTimings.firstFrameDecodedAt && state.firstFrameTimings.selectedAt) {
      state.firstFrameTimings.firstFrameDecodedAt = performance.now();
      state.firstFrameTimings.statusText = 'Decoded Frame Arrived';
    }
    return true;
  }

  initListeners() {
    if (this.video) {
      stallDetector.attachVideo(this.video);
    }

    const queueRvfc = () => {
      if (!this.video || !this.video.requestVideoFrameCallback) return;
      const scheduledToken = this.currentMediaGeneration;
      this.video.requestVideoFrameCallback((now, metadata) => {
        this.onDecodedFrame(scheduledToken, now, metadata);
        queueRvfc();
      });
    };

    if (this.video && this.video.requestVideoFrameCallback) {
      queueRvfc();
    } else if (this.video) {
      this.video.addEventListener('timeupdate', () => {
        const token = this.activeFallbackToken || 0;
        this.onDecodedFrame(token, performance.now(), null);
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

    const perfEvents = ['waiting', 'stalled', 'playing', 'canplay', 'seeking', 'seeked', 'pause', 'error'];
    perfEvents.forEach(evt => {
      this.video.addEventListener(evt, () => {
        perfTelemetry.recordEvent(evt);
      });
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
      const errInfo = serializeMediaError(this.video ? this.video.error : null) || { code: 0, name: 'MEDIA_ERR_UNKNOWN', message: '' };
      const errText = `${errInfo.name} (code ${errInfo.code}${errInfo.message ? ': ' + errInfo.message : ''})`;
      console.error('Video error: ' + errText);
      state.firstFrameTimings.statusText = errText;
      state.firstFrameTimings.ready = false;
      this.clearProbeTimer();
      this.decodedMediaGeneration = -1;
      this.videoFrameNeedsUpload = false;
      this.notifyInvalidated(this.currentMediaGeneration, state.videoPath);
    });

    if (this.videoSelect) {
      this.videoSelect.addEventListener('change', (e) => {
        this.selectVideo(e.target.value);
      });
    }
  }

  selectVideo(relPath) {
    this.currentMediaGeneration++;
    this.decodedMediaGeneration = -1;
    this.videoFrameNeedsUpload = false;
    state.videoPath = relPath;
    stallDetector.resetForMedia(relPath);
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

    this.notifyInvalidated(this.currentMediaGeneration, relPath);

    this.clearProbeTimer();
    const token = this.currentMediaGeneration;
    this.activeFallbackToken = token;
    this.probeTimer = setTimeout(() => {
      this.onProbeTimeout(token);
    }, this.probeTimeoutMs);

    this.video.src = '/video?path=' + encodeURIComponent(relPath);
    this.video.load();
    if (state.inVR) {
      this.video.play().catch(e => console.log('Video play error:', e));
    }
  }

  async refreshVideoList() {
    try {
      const res = await fetch('/api/videos');
      const data = await res.json();
      if (data.videos && Array.isArray(data.videos)) {
        state.videoList = data.videos;
        if (this.videoSelect) {
          const prevVal = this.videoSelect.value;
          this.videoSelect.innerHTML = '';
          data.videos.forEach((v) => {
            const opt = document.createElement('option');
            opt.value = v.relPath;
            opt.textContent = '[' + v.sizeGB + '] ' + v.name;
            this.videoSelect.appendChild(opt);
          });
          if (prevVal && data.videos.some(v => v.relPath === prevVal)) {
            this.videoSelect.value = prevVal;
          }
        }
      }
    } catch (err) {
      console.warn('Failed to refresh video list', err);
    }
  }

  async loadVideoList() {
    try {
      state.firstFrameTimings.mediaListRequestAt = performance.now();
      const res = await fetch('/api/videos');
      const data = await res.json();
      state.firstFrameTimings.mediaListReadyAt = performance.now();
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
    if (this.video.readyState < 2) return false;
    if (!this.isCurrentMediaDecoded()) return false;

    // Performance Modes:
    // 'baseline': upload if videoFrameNeedsUpload OR currentTime changed while playing
    // 'strict-rvfc' / 'strict-rvfc-dirty-ui': upload ONLY when videoFrameNeedsUpload (true new decoded hardware frame)
    const isStrict = (state.performanceMode === 'strict-rvfc' || state.performanceMode === 'strict-rvfc-dirty-ui');

    if (isStrict) {
      if (this.videoFrameNeedsUpload) {
        this.videoFrameNeedsUpload = false;
        this.lastUploadedVideoTime = this.video.currentTime;
        perfTelemetry.recordVideoUpload();
        return true;
      }
      return false;
    }

    // Baseline legacy behavior
    if (this.videoFrameNeedsUpload || (this.video.currentTime !== this.lastUploadedVideoTime && !this.video.paused)) {
      this.videoFrameNeedsUpload = false;
      this.lastUploadedVideoTime = this.video.currentTime;
      perfTelemetry.recordVideoUpload();
      return true;
    }
    return false;
  }
}

