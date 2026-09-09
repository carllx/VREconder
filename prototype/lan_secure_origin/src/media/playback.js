// ==========================================
// Media Playback, Hardware Frame Callback & First-Frame Instrumentation
// ==========================================
import { state } from '../core/state.js';
import { perfTelemetry } from '../telemetry/telemetry.js';
import { stallDetector } from '../telemetry/stall-detector.js';

export class MediaController {
  constructor(videoElement, videoSelectElement) {
    this.video = videoElement;
    this.videoSelect = videoSelectElement;
    this.videoFrameNeedsUpload = false;
    this.lastUploadedVideoTime = -1;
    this.hasLoggedFirstFrame = false;

    // Issue #23: Media-selection generation token & teardown state
    this.currentMediaGeneration = 0;
    this.currentRvfcHandle = null;
    this.currentGenerationListeners = [];
    this.renderer = null;
    this.remoteLogHook = null;

    this.initListeners();
  }

  attachRenderer(renderer) {
    this.renderer = renderer;
  }

  setRemoteLogHook(fn) {
    if (typeof fn === 'function') {
      this.remoteLogHook = fn;
    }
  }

  scheduleNextRvfc(generation) {
    if (!this.video || !this.video.requestVideoFrameCallback) return;
    this.currentRvfcHandle = this.video.requestVideoFrameCallback((now, metadata) => {
      this.handleDecodedFrame(generation, now, metadata);
    });
  }

  handleDecodedFrame(generation, now, metadata) {
    if (generation !== this.currentMediaGeneration) {
      return; // Stale callback from previous generation discarded
    }

    this.videoFrameNeedsUpload = true;
    perfTelemetry.recordRvfc();
    stallDetector.recordRvfc(now, metadata);

    if (!state.firstFrameTimings.firstFrameDecodedAt && state.firstFrameTimings.selectedAt) {
      state.firstFrameTimings.firstFrameDecodedAt = performance.now();
      state.firstFrameTimings.statusText = 'Decoded Frame Arrived';
    }

    // Schedule next callback for current generation
    this.scheduleNextRvfc(generation);
  }

  detachGenerationListeners() {
    if (this.video && this.currentGenerationListeners.length > 0) {
      for (const { event, listener } of this.currentGenerationListeners) {
        this.video.removeEventListener(event, listener);
      }
      this.currentGenerationListeners = [];
    }
  }

  attachGenerationListeners(generation, mediaPath) {
    this.detachGenerationListeners();
    if (!this.video) return;

    const addGenListener = (event, handler) => {
      const listener = (e) => {
        if (generation !== this.currentMediaGeneration) return;
        handler(e);
      };
      this.video.addEventListener(event, listener);
      this.currentGenerationListeners.push({ event, listener });
    };

    addGenListener('loadstart', () => {
      state.firstFrameTimings.statusText = 'Loading Media Header...';
    });

    addGenListener('loadedmetadata', () => {
      state.videoDuration = this.video.duration;
      state.videoWidth = this.video.videoWidth;
      state.videoHeight = this.video.videoHeight;
      if (state.firstFrameTimings.selectedAt) {
        state.firstFrameTimings.metadataAt = performance.now();
        state.firstFrameTimings.statusText = 'Metadata Loaded';
      }
      if (typeof document !== 'undefined') {
        const elRes = document.getElementById('valVideoRes');
        const elDur = document.getElementById('valVideoDur');
        if (elRes) elRes.textContent = this.video.videoWidth + 'x' + this.video.videoHeight;
        if (elDur) elDur.textContent = this.video.duration.toFixed(1) + 's';
      }
    });

    addGenListener('canplay', () => {
      if (state.firstFrameTimings.selectedAt && !state.firstFrameTimings.canplayAt) {
        state.firstFrameTimings.canplayAt = performance.now();
        state.firstFrameTimings.statusText = 'Decoder Ready';
      }
    });

    if (!this.video.requestVideoFrameCallback) {
      addGenListener('timeupdate', () => {
        this.videoFrameNeedsUpload = true;
        stallDetector.recordRvfc(performance.now(), null);
        if (!state.firstFrameTimings.firstFrameDecodedAt && state.firstFrameTimings.selectedAt) {
          state.firstFrameTimings.firstFrameDecodedAt = performance.now();
          state.firstFrameTimings.statusText = 'Decoded Frame Arrived';
        }
      });
    }

    addGenListener('error', () => {
      let codeName = 'MEDIA_ERR_UNKNOWN';
      let codeNum = 0;
      let msg = '';
      if (this.video && this.video.error) {
        codeNum = this.video.error.code;
        msg = this.video.error.message || '';
        switch (codeNum) {
          case 1: codeName = 'MEDIA_ERR_ABORTED'; break;
          case 2: codeName = 'MEDIA_ERR_NETWORK'; break;
          case 3: codeName = 'MEDIA_ERR_DECODE'; break;
          case 4: codeName = 'MEDIA_ERR_SRC_NOT_SUPPORTED'; break;
        }
      }
      const errText = `${codeName} (code ${codeNum}${msg ? ': ' + msg : ''})`;
      console.error(`Video error [gen ${generation}]: ${errText}`);

      // Update status and fail-closed state for this generation
      state.firstFrameTimings.statusText = errText;
      state.firstFrameTimings.ready = false;
      this.videoFrameNeedsUpload = false;

      // Invalidate displayed texture so failed source never leaves stale frame
      if (this.renderer && typeof this.renderer.resetVideoTexture === 'function') {
        this.renderer.resetVideoTexture();
      }

      // Structured error event for telemetry & remote logging seam
      const errEvent = {
        generation: generation,
        mediaPath: mediaPath || '',
        mediaName: mediaPath ? mediaPath.split('/').pop() : '',
        code: codeNum,
        name: codeName,
        message: msg,
        readyState: this.video ? this.video.readyState : 0,
        networkState: this.video ? this.video.networkState : 0,
        videoWidth: this.video ? this.video.videoWidth : 0,
        videoHeight: this.video ? this.video.videoHeight : 0
      };
      if (this.remoteLogHook) {
        this.remoteLogHook('ERROR', 'MEDIA_PLAYBACK_ERROR', errEvent);
      }
    });
  }

  initListeners() {
    if (this.video) {
      stallDetector.attachVideo(this.video);
    }

    this.video.addEventListener('timeupdate', () => {
      if (typeof document !== 'undefined') {
        const elTime = document.getElementById('valVideoTime');
        if (elTime) elTime.textContent = this.video.currentTime.toFixed(1) + 's';
      }
    });

    const perfEvents = ['waiting', 'stalled', 'playing', 'canplay', 'seeking', 'seeked', 'pause', 'error'];
    perfEvents.forEach(evt => {
      this.video.addEventListener(evt, () => {
        perfTelemetry.recordEvent(evt);
      });
    });

    this.video.addEventListener('play', () => {
      if (typeof document !== 'undefined') {
        const elStat = document.getElementById('valPlayStatus');
        if (elStat) { elStat.textContent = 'Playing'; elStat.style.color = '#34d399'; }
      }
    });

    this.video.addEventListener('pause', () => {
      if (typeof document !== 'undefined') {
        const elStat = document.getElementById('valPlayStatus');
        if (elStat) { elStat.textContent = 'Paused'; elStat.style.color = '#fbbf24'; }
      }
    });

    if (this.videoSelect) {
      this.videoSelect.addEventListener('change', (e) => {
        this.selectVideo(e.target.value);
      });
    }
  }

  selectVideo(relPath) {
    // 1. Advance generation token immediately
    const generation = ++this.currentMediaGeneration;

    // 2. Explicit previous source teardown
    if (this.video) {
      try {
        if (!this.video.paused) {
          this.video.pause();
        }
      } catch (e) {}

      if (this.currentRvfcHandle !== null && this.video.cancelVideoFrameCallback) {
        try {
          this.video.cancelVideoFrameCallback(this.currentRvfcHandle);
        } catch (e) {}
        this.currentRvfcHandle = null;
      }

      // Detach generation-bound listeners from previous media
      this.detachGenerationListeners();

      // Detach and reset previous source state to clear decoder pipelines
      try {
        this.video.removeAttribute('src');
        this.video.load();
      } catch (e) {}
    }

    // 3. Fail-closed renderer texture invalidation
    this.videoFrameNeedsUpload = false;
    this.lastUploadedVideoTime = -1;
    if (this.renderer && typeof this.renderer.resetVideoTexture === 'function') {
      this.renderer.resetVideoTexture();
    }

    // 4. Reset state for new media
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

    // 5. Assign and load new source
    if (this.video) {
      // Bind generation-scoped media event listeners (loadstart, loadedmetadata, canplay, timeupdate, error)
      this.attachGenerationListeners(generation, relPath);

      this.video.src = '/video?path=' + encodeURIComponent(relPath);
      this.video.load();

      // Schedule fresh rVFC pipeline bound to this new generation
      this.scheduleNextRvfc(generation);

      if (state.inVR) {
        this.video.play().catch(e => console.log('Video play error:', e));
      }
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

