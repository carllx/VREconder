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

export const telemetry = new TelemetryEngine();
