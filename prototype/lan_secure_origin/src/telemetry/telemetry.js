// ==========================================
// UX Interaction Telemetry Engine
// ==========================================
import { state, showFeedbackToast } from '../core/state.js';
import { playAudioFeedback, triggerHaptic } from '../controls/audio-haptics.js';

export class TelemetryEngine {
  constructor() {
    this.metrics = {
      A: { activations: 0, cancels: 0, dwellTimes: [], menuToCmdTimes: [], travelDeg: 0 },
      B: { activations: 0, cancels: 0, dwellTimes: [], menuToCmdTimes: [], travelDeg: 0 },
      C: { activations: 0, cancels: 0, dwellTimes: [], menuToCmdTimes: [], travelDeg: 0 }
    };
    this.completedTasks = {
      pause: false,
      play: false,
      seekForward: false,
      seekBackward: false,
      next: false,
      previous: false,
      recenter: false
    };
    this.currentHoverTarget = null;
    this.hoverStartTime = 0;
    this.menuOpenTime = performance.now();
    this.lastHeadFwd = [0, 0, -1];
  }

  onHeadMove(newFwd) {
    const dot = this.lastHeadFwd[0] * newFwd[0] + this.lastHeadFwd[1] * newFwd[1] + this.lastHeadFwd[2] * newFwd[2];
    const rad = Math.acos(Math.max(-1, Math.min(1, dot)));
    const deg = rad * (180 / Math.PI);
    if (deg > 0.05 && deg < 45) {
      this.metrics[state.activePattern].travelDeg += deg;
    }
    this.lastHeadFwd = [newFwd[0], newFwd[1], newFwd[2]];
  }

  recordTargetEnter(pattern, targetId) {
    this.currentHoverTarget = targetId;
    this.hoverStartTime = performance.now();
    playAudioFeedback('hover');
    this.sendEvent('targetEnter', { pattern: pattern, target: targetId });
  }

  recordDwellCancel(pattern, targetId, dwellMs) {
    this.metrics[pattern].cancels++;
    this.sendEvent('dwellCancel', { pattern: pattern, target: targetId, dwellMs: Math.round(dwellMs) });
    this.currentHoverTarget = null;
    this.hoverStartTime = 0;
    this.updateTable();
  }

  recordDwellComplete(pattern, targetId, dwellMs) {
    this.metrics[pattern].activations++;
    this.metrics[pattern].dwellTimes.push(dwellMs);
    const timeToCmd = Math.max(0, performance.now() - this.menuOpenTime);
    this.metrics[pattern].menuToCmdTimes.push(timeToCmd);

    playAudioFeedback('activate');
    triggerHaptic();

    this.sendEvent('dwellComplete', { pattern: pattern, target: targetId, dwellMs: Math.round(dwellMs), timeToCmdMs: Math.round(timeToCmd) });
    this.currentHoverTarget = null;
    this.hoverStartTime = 0;
    this.updateTable();
  }

  recordCommand(commandId, videoElement) {
    const timeToCmd = Math.max(0, performance.now() - this.menuOpenTime);
    this.sendEvent('commandInvoked', { pattern: state.activePattern, command: commandId, timeToCmdMs: Math.round(timeToCmd) });
    
    if (commandId === 'playPause') {
      if (videoElement && videoElement.paused) this.markTaskDone('pause');
      else this.markTaskDone('play');
    } else if (commandId === 'seekForward_10s') {
      this.markTaskDone('seekForward');
    } else if (commandId === 'seekBackward_10s') {
      this.markTaskDone('seekBackward');
    } else if (commandId === 'next') {
      this.markTaskDone('next');
    } else if (commandId === 'previous') {
      this.markTaskDone('previous');
    } else if (commandId === 'recenter') {
      this.markTaskDone('recenter');
    }
  }

  markTaskDone(taskKey) {
    this.completedTasks[taskKey] = true;
    if (typeof document !== 'undefined') {
      const row = document.querySelector('.checklist-row[data-task="' + taskKey + '"] .chk-status');
      if (row) {
        row.textContent = '✓ Done';
        row.className = 'chk-status chk-done';
      }
    }
  }

  resetTasks() {
    for (const k in this.completedTasks) this.completedTasks[k] = false;
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.checklist-row .chk-status').forEach(el => {
        el.textContent = 'Pending';
        el.className = 'chk-status chk-pending';
      });
    }
  }

  updateTable() {
    if (typeof document === 'undefined') return;
    ['A', 'B', 'C'].forEach(p => {
      const m = this.metrics[p];
      const row = document.getElementById('row-' + p);
      if (!row) return;
      const avgDwell = m.dwellTimes.length ? (m.dwellTimes.reduce((a,b)=>a+b, 0) / m.dwellTimes.length).toFixed(0) + 'ms' : '--';
      const avgTimeToCmd = m.menuToCmdTimes.length ? (m.menuToCmdTimes.reduce((a,b)=>a+b, 0) / m.menuToCmdTimes.length).toFixed(0) + 'ms' : '--';
      const pName = p === 'A' ? 'A (Bottom Arc)' : p === 'B' ? 'B (Floor Radial)' : 'C (Floor HUD)';
      row.innerHTML = '<td>' + pName + '</td><td>' + m.activations + '</td><td>' + m.cancels + '</td><td>' + avgDwell + '</td><td>' + avgTimeToCmd + '</td><td>' + m.travelDeg.toFixed(1) + '°</td>';
    });
  }

  async sendEvent(eventName, data = {}) {
    try {
      const payload = {
        type: 'ux_event',
        event: eventName,
        pattern: data.pattern || state.activePattern,
        target: data.target || null,
        dwellMs: data.dwellMs || 0,
        timeToCmdMs: data.timeToCmdMs || 0,
        travelDeg: this.metrics[state.activePattern].travelDeg,
        timestamp: new Date().toISOString()
      };
      fetch('/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(()=>{});
    } catch (e) {}
  }

  async syncSummary() {
    const summary = {
      type: 'ux_summary',
      timestamp: new Date().toISOString(),
      patterns: this.metrics,
      activePattern: state.activePattern,
      dwellThresholdMs: state.dwellThresholdMs,
      completedTasks: this.completedTasks
    };
    try {
      await fetch('/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(summary)
      });
      showFeedbackToast('Telemetry Synced to PC');
    } catch (e) {
      console.error('Telemetry sync failed: ' + e.message);
    }
  }
}

export class PerformanceTelemetry {
  constructor() {
    this.windowStart = performance.now();
    this.windowSeq = 0;
    this.rafCount = 0;
    this.rvfcCount = 0;
    this.videoUploadCount = 0;
    this.uiUploadCount = 0;
    this.orientationCount = 0;
    this.frameTimes = [];
    this.glContextLostCount = 0;
    this.glContextRestoredCount = 0;
    this.recentEvents = [];
    this.lastTotalFrames = -1;
    this.lastDroppedFrames = -1;
    this.latestSnapshot = {
      windowSeq: 0,
      timestamp: new Date().toISOString(),
      performanceMode: 'strict-rvfc-dirty-ui',
      renderScale: 1.0,
      cadence: { rafPerSec: 0, rvfcPerSec: 0, videoUploadsPerSec: 0, uiUploadsPerSec: 0, orientationPerSec: 0 },
      frameTimeMs: { avg: 0, p95: 0, max: 0, samples: 0 },
      playback: { currentTime: 0, duration: 0, paused: true, readyState: 0, networkState: 0, bufferAheadSec: 0, quality: { totalVideoFrames: 0, droppedVideoFrames: 0, dropRate: 0 }, recentEvents: [] },
      display: { cssViewport: '--', dpr: 1, renderScale: 1.0, drawingBuffer: '--', eyeFbo: '--' },
      webgl: { glError: 'NO_ERROR', contextLostCount: 0, contextRestoredCount: 0 }
    };
  }

  recordEvent(name) {
    this.recentEvents.push({ event: name, time: Number(performance.now().toFixed(1)) });
    if (this.recentEvents.length > 20) this.recentEvents.shift();
  }

  recordRaf() { this.rafCount++; }
  recordRvfc() { this.rvfcCount++; }
  recordVideoUpload() { this.videoUploadCount++; }
  recordUiUpload() { this.uiUploadCount++; }
  recordOrientation() { this.orientationCount++; }
  recordFrameTime(dtMs) { this.frameTimes.push(dtMs); }
  recordGlContextLost() {
    this.glContextLostCount++;
    this.recordEvent('webglcontextlost');
  }
  recordGlContextRestored() {
    this.glContextRestoredCount++;
    this.recordEvent('webglcontextrestored');
  }

  updateWindow(now, video, canvas, renderer) {
    const elapsed = now - this.windowStart;
    if (elapsed < 1000) return this.latestSnapshot;

    this.windowSeq++;
    const scale = 1000 / elapsed;
    const rafRate = Number((this.rafCount * scale).toFixed(1));
    const rvfcRate = Number((this.rvfcCount * scale).toFixed(1));
    const videoUploadRate = Number((this.videoUploadCount * scale).toFixed(1));
    const uiUploadRate = Number((this.uiUploadCount * scale).toFixed(1));
    const orientationRate = Number((this.orientationCount * scale).toFixed(1));

    let avgFrameTimeMs = 0;
    let p95FrameTimeMs = 0;
    let maxFrameTimeMs = 0;
    if (this.frameTimes.length > 0) {
      const sorted = [...this.frameTimes].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      avgFrameTimeMs = Number((sum / sorted.length).toFixed(2));
      const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
      p95FrameTimeMs = Number(sorted[p95Idx].toFixed(2));
      maxFrameTimeMs = Number(sorted[sorted.length - 1].toFixed(2));
    }

    let quality = { totalVideoFrames: 'unavailable', droppedVideoFrames: 'unavailable', dropRate: 'unavailable', windowDeltaTotal: 0, windowDeltaDropped: 0, windowDropRate: 0 };
    if (video && typeof video.getVideoPlaybackQuality === 'function') {
      try {
        const q = video.getVideoPlaybackQuality();
        if (q && typeof q.totalVideoFrames === 'number') {
          const tot = q.totalVideoFrames;
          const drop = q.droppedVideoFrames || 0;
          const rate = tot > 0 ? Number(((drop / tot) * 100).toFixed(2)) : 0;

          const deltaTot = (this.lastTotalFrames >= 0 && tot >= this.lastTotalFrames) ? (tot - this.lastTotalFrames) : 0;
          const deltaDrop = (this.lastDroppedFrames >= 0 && drop >= this.lastDroppedFrames) ? (drop - this.lastDroppedFrames) : 0;
          const winDropRate = deltaTot > 0 ? Number(((deltaDrop / deltaTot) * 100).toFixed(2)) : 0;

          this.lastTotalFrames = tot;
          this.lastDroppedFrames = drop;

          quality = {
            totalVideoFrames: tot,
            droppedVideoFrames: drop,
            dropRate: rate,
            windowDeltaTotal: deltaTot,
            windowDeltaDropped: deltaDrop,
            windowDropRate: winDropRate
          };
        }
      } catch (e) {}
    }

    let bufferAhead = 0;
    const curTime = (video && typeof video.currentTime === 'number') ? video.currentTime : 0;
    if (video && video.buffered && video.buffered.length > 0) {
      for (let i = 0; i < video.buffered.length; i++) {
        const start = video.buffered.start(i);
        const end = video.buffered.end(i);
        if (curTime >= start && curTime <= end) {
          bufferAhead = Number((end - curTime).toFixed(2));
          break;
        }
      }
    }

    let glErrStr = 'NO_ERROR';
    if (renderer && renderer.gl) {
      const err = renderer.gl.getError();
      if (err !== renderer.gl.NO_ERROR) glErrStr = 'GL_ERR_' + err;
    }

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const cssW = (typeof window !== 'undefined') ? window.innerWidth : 0;
    const cssH = (typeof window !== 'undefined') ? window.innerHeight : 0;
    const drawW = canvas ? canvas.width : 0;
    const drawH = canvas ? canvas.height : 0;
    const fboW = renderer ? renderer.fboWidth : 0;
    const fboH = renderer ? renderer.fboHeight : 0;

    this.latestSnapshot = {
      windowSeq: this.windowSeq,
      timestamp: new Date().toISOString(),
      performanceMode: state.performanceMode || 'baseline',
      renderScale: state.renderScale || 1.0,
      cadence: {
        rafPerSec: rafRate,
        rvfcPerSec: rvfcRate,
        videoUploadsPerSec: videoUploadRate,
        uiUploadsPerSec: uiUploadRate,
        orientationPerSec: orientationRate
      },
      frameTimeMs: {
        avg: avgFrameTimeMs,
        p95: p95FrameTimeMs,
        max: maxFrameTimeMs,
        samples: this.frameTimes.length
      },
      playback: {
        currentTime: Number(curTime.toFixed(2)),
        duration: (video && isFinite(video.duration)) ? Number(video.duration.toFixed(2)) : 0,
        paused: video ? !!video.paused : false,
        readyState: video ? video.readyState : 0,
        networkState: video ? video.networkState : 0,
        bufferAheadSec: bufferAhead,
        quality: quality,
        recentEvents: [...this.recentEvents]
      },
      display: {
        cssViewport: `${cssW}x${cssH}`,
        dpr: Number(dpr.toFixed(2)),
        renderScale: state.renderScale || 1.0,
        drawingBuffer: `${drawW}x${drawH}`,
        eyeFbo: `${fboW}x${fboH}`
      },
      webgl: {
        glError: glErrStr,
        contextLostCount: this.glContextLostCount,
        contextRestoredCount: this.glContextRestoredCount
      }
    };

    this.windowStart = now;
    this.rafCount = 0;
    this.rvfcCount = 0;
    this.videoUploadCount = 0;
    this.uiUploadCount = 0;
    this.orientationCount = 0;
    this.frameTimes = [];
    this.recentEvents = [];

    return this.latestSnapshot;
  }
}

export const telemetry = new TelemetryEngine();
export const perfTelemetry = new PerformanceTelemetry();

