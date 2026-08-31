// ============================================================================
// Intermittent Full-VR Stall Diagnostic Detector & Telemetry Engine
// Low-overhead instrumentation for isolating media presentation vs data stalls
// ============================================================================

export const STALL_MEDIA_EVENTS = [
  'loadstart',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'seeking',
  'seeked',
  'waiting',
  'stalled',
  'suspend',
  'progress',
  'ended',
  'error'
];

export function serializeBufferedRanges(buffered) {
  if (!buffered || typeof buffered.length !== 'number') return [];
  const ranges = [];
  for (let i = 0; i < buffered.length; i++) {
    try {
      ranges.push({
        start: Number(buffered.start(i).toFixed(3)),
        end: Number(buffered.end(i).toFixed(3))
      });
    } catch (e) {}
  }
  return ranges;
}

export function calculateBufferAhead(buffered, currentTime) {
  if (!buffered || typeof buffered.length !== 'number') return 0;
  const cur = typeof currentTime === 'number' && isFinite(currentTime) ? currentTime : 0;
  for (let i = 0; i < buffered.length; i++) {
    try {
      const start = buffered.start(i);
      const end = buffered.end(i);
      if (cur >= start && cur <= end) {
        return Number((end - cur).toFixed(3));
      }
    } catch (e) {}
  }
  return 0;
}

export function serializeMediaError(error) {
  if (!error) return null;
  const codeNames = {
    1: 'MEDIA_ERR_ABORTED',
    2: 'MEDIA_ERR_NETWORK',
    3: 'MEDIA_ERR_DECODE',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
  };
  return {
    code: typeof error.code === 'number' ? error.code : 0,
    name: codeNames[error.code] || 'MEDIA_ERR_UNKNOWN',
    message: error.message || ''
  };
}

export function captureVisibilityContext(video) {
  const docVis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
  const docHidden = typeof document !== 'undefined' ? !!document.hidden : false;

  const videoCtx = {
    display: 'unknown',
    visibility: 'unknown',
    opacity: 'unknown',
    boundingClientRect: null,
    offsetWidth: 0,
    offsetHeight: 0,
    isConnected: false
  };

  if (video && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const style = window.getComputedStyle(video);
      videoCtx.display = style.display || 'unknown';
      videoCtx.visibility = style.visibility || 'unknown';
      videoCtx.opacity = style.opacity || 'unknown';
    } catch (e) {}
  }

  if (video) {
    try {
      if (typeof video.getBoundingClientRect === 'function') {
        const r = video.getBoundingClientRect();
        videoCtx.boundingClientRect = {
          top: Number(r.top.toFixed(1)),
          left: Number(r.left.toFixed(1)),
          width: Number(r.width.toFixed(1)),
          height: Number(r.height.toFixed(1))
        };
      }
      videoCtx.offsetWidth = video.offsetWidth || 0;
      videoCtx.offsetHeight = video.offsetHeight || 0;
      videoCtx.isConnected = !!video.isConnected;
    } catch (e) {}
  }

  return {
    documentVisibilityState: docVis,
    documentHidden: docHidden,
    video: videoCtx
  };
}

export class StallDetector {
  constructor() {
    this.video = null;
    this.boundListeners = [];

    // rVFC Tracking (In-memory only)
    this.lastRvfcAt = 0; // performance.now()
    this.lastRvfcWallClock = 0; // Date.now()
    this.lastRvfcMediaTime = null;
    this.lastPresentedFrames = null;
    this.lastRvfcMetadata = null;
    this.totalRvfcCount = 0;

    // Playback Tracking
    this.lastPlayAt = 0;
    this.inStall = false;
    this.stallDetectedAt = 0; // performance.now()
    this.stallWallClockStart = 0; // Date.now()
    this.stallMilestonesTriggered = new Set();

    // Event Ring Buffer (Bounded to 50 entries)
    this.recentEvents = [];
    this.maxEvents = 50;

    // Snapshot subscribers
    this.snapshotListeners = [];

    // Summary statistics
    this.stallCount = 0;
    this.totalStallDurationMs = 0;
    this.latestSnapshot = null;
  }

  onSnapshot(callback) {
    if (typeof callback === 'function') {
      this.snapshotListeners.push(callback);
    }
  }

  notifySnapshot(snapshot) {
    this.latestSnapshot = snapshot;
    for (const cb of this.snapshotListeners) {
      try {
        cb(snapshot);
      } catch (e) {
        console.error('[StallDetector] Error in snapshot callback:', e);
      }
    }
  }

  recordRvfc(now = (typeof performance !== 'undefined' ? performance.now() : Date.now()), metadata = null) {
    const prevRvfcAt = this.lastRvfcAt;
    this.lastRvfcAt = now;
    this.lastRvfcWallClock = Date.now();
    this.totalRvfcCount++;

    if (metadata) {
      this.lastRvfcMediaTime = typeof metadata.mediaTime === 'number' ? Number(metadata.mediaTime.toFixed(3)) : null;
      this.lastPresentedFrames = typeof metadata.presentedFrames === 'number' ? metadata.presentedFrames : null;
      this.lastRvfcMetadata = {
        mediaTime: metadata.mediaTime,
        presentedFrames: metadata.presentedFrames,
        processingDuration: metadata.processingDuration,
        expectedDisplayTime: metadata.expectedDisplayTime,
        presentationTime: metadata.presentationTime,
        width: metadata.width,
        height: metadata.height
      };
    }

    // If currently stalled, rVFC resumption marks recovery
    if (this.inStall) {
      const durationMs = Math.round(now - (prevRvfcAt > 0 ? prevRvfcAt : this.stallDetectedAt));
      const wallDurationMs = this.stallWallClockStart > 0 ? (Date.now() - this.stallWallClockStart) : durationMs;
      
      this.inStall = false;
      this.stallMilestonesTriggered.clear();
      this.totalStallDurationMs += durationMs;

      const snap = this.createSnapshot('STALL_RECOVERED', this.video, {
        stallDurationMs: durationMs,
        wallDurationMs: wallDurationMs
      });
      this.notifySnapshot(snap);
    }
  }

  recordMediaEvent(eventName, video = this.video) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const evt = {
      timestamp: new Date().toISOString(),
      timeMs: Number(now.toFixed(1)),
      event: eventName,
      currentTime: video && typeof video.currentTime === 'number' ? Number(video.currentTime.toFixed(3)) : 0,
      readyState: video ? video.readyState : 0,
      networkState: video ? video.networkState : 0,
      buffered: serializeBufferedRanges(video ? video.buffered : null)
    };

    this.recentEvents.push(evt);
    if (this.recentEvents.length > this.maxEvents) {
      this.recentEvents.shift();
    }

    if (eventName === 'play' || eventName === 'playing') {
      this.lastPlayAt = now;
      if (this.lastRvfcAt === 0) {
        this.lastRvfcAt = now;
      }
    } else if (eventName === 'pause') {
      if (this.inStall) {
        this.inStall = false;
        this.stallMilestonesTriggered.clear();
      }
    }
  }

  attachVideo(videoElement) {
    this.detachVideo();
    if (!videoElement) return;
    this.video = videoElement;

    STALL_MEDIA_EVENTS.forEach(evt => {
      const handler = () => this.recordMediaEvent(evt, videoElement);
      videoElement.addEventListener(evt, handler);
      this.boundListeners.push({ evt, handler, target: videoElement });
    });
  }

  detachVideo() {
    for (const { evt, handler, target } of this.boundListeners) {
      try {
        target.removeEventListener(evt, handler);
      } catch (e) {}
    }
    this.boundListeners = [];
    this.video = null;
  }

  checkStall(now = (typeof performance !== 'undefined' ? performance.now() : Date.now()), video = this.video) {
    if (!video || video.paused || video.ended) {
      if (this.inStall && video && video.paused) {
        this.inStall = false;
        this.stallMilestonesTriggered.clear();
      }
      return null;
    }

    const baselineTime = this.lastRvfcAt > 0 ? this.lastRvfcAt : this.lastPlayAt;
    if (baselineTime === 0) return null;

    const timeSinceLastRvfc = now - baselineTime;

    // Threshold: 2 seconds without rVFC while paused == false
    if (timeSinceLastRvfc >= 2000) {
      if (!this.inStall) {
        this.inStall = true;
        this.stallDetectedAt = now;
        this.stallWallClockStart = Date.now();
        this.stallMilestonesTriggered.clear();
        this.stallCount++;

        const snap = this.createSnapshot('STALL_BEGIN', video, {
          elapsedMs: Math.round(timeSinceLastRvfc)
        });
        this.notifySnapshot(snap);
        return snap;
      } else {
        // Milestone checks: 5s, 10s, 20s
        const milestones = [5000, 10000, 20000];
        for (const ms of milestones) {
          if (timeSinceLastRvfc >= ms && !this.stallMilestonesTriggered.has(ms)) {
            this.stallMilestonesTriggered.add(ms);
            const snap = this.createSnapshot('STALL_MILESTONE', video, {
              milestoneSec: ms / 1000,
              elapsedMs: Math.round(timeSinceLastRvfc)
            });
            this.notifySnapshot(snap);
            return snap;
          }
        }
      }
    }

    return null;
  }

  createSnapshot(phase, video = this.video, extra = {}) {
    let quality = null;
    if (video && typeof video.getVideoPlaybackQuality === 'function') {
      try {
        const q = video.getVideoPlaybackQuality();
        if (q) {
          quality = {
            totalVideoFrames: typeof q.totalVideoFrames === 'number' ? q.totalVideoFrames : null,
            droppedVideoFrames: typeof q.droppedVideoFrames === 'number' ? q.droppedVideoFrames : null,
            corruptedVideoFrames: typeof q.corruptedVideoFrames === 'number' ? q.corruptedVideoFrames : null
          };
        }
      } catch (e) {}
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const curTime = video && typeof video.currentTime === 'number' ? Number(video.currentTime.toFixed(3)) : 0;
    const bufRanges = serializeBufferedRanges(video ? video.buffered : null);
    const bufAhead = calculateBufferAhead(video ? video.buffered : null, curTime);

    return {
      type: 'STALL_SNAPSHOT',
      phase: phase, // 'STALL_BEGIN' | 'STALL_MILESTONE' | 'STALL_RECOVERED'
      timestamp: new Date().toISOString(),
      elapsedMs: typeof extra.elapsedMs === 'number' ? extra.elapsedMs : (typeof extra.stallDurationMs === 'number' ? extra.stallDurationMs : 0),
      stallDurationMs: typeof extra.stallDurationMs === 'number' ? extra.stallDurationMs : (typeof extra.elapsedMs === 'number' ? extra.elapsedMs : 0),
      wallDurationMs: typeof extra.wallDurationMs === 'number' ? extra.wallDurationMs : null,
      milestoneSec: typeof extra.milestoneSec === 'number' ? extra.milestoneSec : null,
      rvfc: {
        lastRvfcAt: this.lastRvfcAt,
        lastRvfcWallClock: this.lastRvfcWallClock,
        lastRvfcMediaTime: this.lastRvfcMediaTime,
        lastPresentedFrames: this.lastPresentedFrames,
        timeSinceLastRvfcMs: this.lastRvfcAt > 0 ? Math.round(now - this.lastRvfcAt) : null,
        totalRvfcCount: this.totalRvfcCount,
        lastMetadata: this.lastRvfcMetadata
      },
      mediaState: {
        currentTime: curTime,
        duration: video && isFinite(video.duration) ? Number(video.duration.toFixed(3)) : 0,
        paused: video ? !!video.paused : true,
        seeking: video ? !!video.seeking : false,
        ended: video ? !!video.ended : false,
        playbackRate: video ? video.playbackRate : 1.0,
        readyState: video ? video.readyState : 0,
        networkState: video ? video.networkState : 0,
        error: serializeMediaError(video ? video.error : null),
        bufferedRanges: bufRanges,
        bufferAheadSec: bufAhead,
        quality: quality
      },
      visibility: captureVisibilityContext(video),
      recentEvents: this.recentEvents.slice(-15)
    };
  }

  getSummary() {
    return {
      inStall: this.inStall,
      stallCount: this.stallCount,
      totalStallDurationMs: this.totalStallDurationMs,
      lastRvfcAt: this.lastRvfcAt,
      lastRvfcMediaTime: this.lastRvfcMediaTime,
      lastPresentedFrames: this.lastPresentedFrames,
      latestSnapshot: this.latestSnapshot
    };
  }
}

export const stallDetector = new StallDetector();
