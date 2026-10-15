// ==========================================
// Canary & Risk-Directed VR Test Controller
// Zero-Search dynamic queue with 5-stage verification state machine
// ==========================================

import { onSelectMedia } from './controller-app.js';

export const VerificationStage = {
  IDLE: 'IDLE',
  TARGET_SELECTED: 'TARGET_SELECTED',
  IPHONE_MEDIA_PATH_MATCH: 'IPHONE_MEDIA_PATH_MATCH',
  STREAM_206: 'STREAM_206',
  FIRST_FRAME_PRESENTED: 'FIRST_FRAME_PRESENTED',
  PLAYBACK_ADVANCING: 'PLAYBACK_ADVANCING',
  BLOCKED_FAIL_CLOSED: 'BLOCKED_FAIL_CLOSED'
};

export let canaryCandidates = [];
export let activeAdmissions = new Set();
export let currentTargetCandidate = null;
export let currentVerificationStage = VerificationStage.IDLE;
export let currentTestSession = null;

let lastTelemetryCurrentTime = -1;
let lastTelemetryTimeMs = 0;
let consecutiveAdvancingCount = 0;

export async function loadCanaryQueue() {
  try {
    const res = await fetch('/api/canary-queue');
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.candidates)) {
      canaryCandidates = data.candidates;
      renderCanaryUI();
    }
  } catch (err) {
    console.warn('[Canary] Failed to load queue:', err.message);
  }
}

export async function refreshCanaryAdmissions() {
  try {
    const res = await fetch('/api/provisional-admissions');
    if (!res.ok) return;
    const data = await res.json();
    activeAdmissions.clear();
    if (Array.isArray(data.admissions)) {
      for (const a of data.admissions) {
        if (a.fingerprintId) activeAdmissions.add(a.fingerprintId);
      }
    }
    renderCanaryUI();
  } catch (err) {
    console.warn('[Canary] Failed to refresh admissions:', err.message);
  }
}

export function selectTopRiskCanary() {
  if (!canaryCandidates || canaryCandidates.length === 0) return;
  selectCanary(canaryCandidates[0].id);
}

export function advanceNextCanary() {
  if (!canaryCandidates || canaryCandidates.length === 0) return;
  if (!currentTargetCandidate) {
    selectTopRiskCanary();
    return;
  }
  const currentIndex = canaryCandidates.findIndex(c => c.id === currentTargetCandidate.id);
  const nextIndex = (currentIndex >= 0 && currentIndex + 1 < canaryCandidates.length) ? currentIndex + 1 : 0;
  selectCanary(canaryCandidates[nextIndex].id);
}

export function selectCanary(candidateId) {
  const c = canaryCandidates.find(item => item.id === candidateId);
  if (!c) return;

  currentTargetCandidate = c;
  currentVerificationStage = VerificationStage.TARGET_SELECTED;
  lastTelemetryCurrentTime = -1;
  lastTelemetryTimeMs = Date.now();
  consecutiveAdvancingCount = 0;

  currentTestSession = {
    candidateId: c.id,
    rank: c.rank,
    fingerprintId: c.fingerprintId,
    file: c.fileName,
    startedAt: new Date().toISOString(),
    stageHistory: [VerificationStage.TARGET_SELECTED],
    stallsObserved: 0,
    maxSeekLatMs: 0,
    glErrors: [],
    frameDropHistory: []
  };

  // Push selection via existing PC-to-iPhone control link
  onSelectMedia(c.relPath);
  renderCanaryUI();
  updateVerificationBadge();
}

export function handleCanaryTelemetry(telemetry) {
  if (!telemetry || !currentTargetCandidate || !currentTestSession) return;

  const currentMediaPath = telemetry.mediaPath || telemetry.mediaName || '';
  const targetFile = currentTargetCandidate.fileName || '';
  const isMatch = (targetFile && currentMediaPath.includes(targetFile)) || (currentMediaPath && targetFile.includes(currentMediaPath));

  if (!isMatch) {
    updateVerificationBadge();
    return;
  }

  // 1. Promote to IPHONE_MEDIA_PATH_MATCH
  if (currentVerificationStage === VerificationStage.TARGET_SELECTED) {
    recordStageTransition(VerificationStage.IPHONE_MEDIA_PATH_MATCH);
  }

  const pb = telemetry.playback || {};
  const isAdmitted = activeAdmissions.has(currentTargetCandidate.fingerprintId);

  // Check if admission gate denied this video
  if (!isAdmitted && (pb.networkState === 3 || pb.error || telemetry.mediaStatus === 'POLICY_BLOCKED')) {
    recordStageTransition(VerificationStage.BLOCKED_FAIL_CLOSED);
    updateVerificationBadge();
    return;
  }

  // 2. Promote to STREAM_206 if readyState indicates metadata/data loaded
  if ((currentVerificationStage === VerificationStage.IPHONE_MEDIA_PATH_MATCH) && (pb.readyState >= 2 || pb.networkState === 2 || isAdmitted)) {
    recordStageTransition(VerificationStage.STREAM_206);
  }

  // 3. Promote to FIRST_FRAME_PRESENTED
  const curTime = typeof telemetry.currentTime === 'number' ? telemetry.currentTime : 0;
  const q = pb.quality || {};
  const perf = telemetry.perf || {};
  const videoUploads = perf.cadence?.videoUploadsPerSec || 0;
  const totalFrames = q.totalVideoFrames || 0;
  const firstRender = perf.firstFrameTiming?.firstRenderAt || 0;

  if (currentVerificationStage === VerificationStage.STREAM_206 && (curTime > 0.05 || firstRender > 0 || videoUploads > 0 || totalFrames > 0)) {
    recordStageTransition(VerificationStage.FIRST_FRAME_PRESENTED);
  }

  // 4. Promote to PLAYBACK_ADVANCING
  if (currentVerificationStage === VerificationStage.FIRST_FRAME_PRESENTED || currentVerificationStage === VerificationStage.PLAYBACK_ADVANCING) {
    if (!pb.paused && !pb.ended && curTime > lastTelemetryCurrentTime && lastTelemetryCurrentTime >= 0) {
      consecutiveAdvancingCount++;
      if (consecutiveAdvancingCount >= 2) {
        recordStageTransition(VerificationStage.PLAYBACK_ADVANCING);
      }
    } else if (pb.paused) {
      consecutiveAdvancingCount = 0;
    }
  }

  lastTelemetryCurrentTime = curTime;
  lastTelemetryTimeMs = Date.now();

  if (typeof telemetry.stallCount === 'number') {
    currentTestSession.stallsObserved = Math.max(currentTestSession.stallsObserved, telemetry.stallCount);
  }

  updateVerificationBadge();
  renderLiveTelemetry(telemetry);
}

function recordStageTransition(newStage) {
  if (currentVerificationStage !== newStage) {
    currentVerificationStage = newStage;
    if (currentTestSession && !currentTestSession.stageHistory.includes(newStage)) {
      currentTestSession.stageHistory.push(newStage);
    }
  }
}

export function updateVerificationBadge() {
  const badge = document.getElementById('canaryStageBadge');
  if (!badge) return;

  const stageConfig = {
    [VerificationStage.IDLE]: { cls: 'badge badge-slate', text: '⚪ IDLE: No Target' },
    [VerificationStage.TARGET_SELECTED]: { cls: 'badge badge-amber', text: '🟡 STAGE 1: TARGET_SELECTED (Pushed)' },
    [VerificationStage.IPHONE_MEDIA_PATH_MATCH]: { cls: 'badge badge-amber', text: '🟡 STAGE 2: IPHONE_MEDIA_PATH_MATCH' },
    [VerificationStage.STREAM_206]: { cls: 'badge badge-slate', text: '🔵 STAGE 3: STREAM_206 (Buffering)' },
    [VerificationStage.FIRST_FRAME_PRESENTED]: { cls: 'badge badge-slate', text: '🟣 STAGE 4: FIRST_FRAME_PRESENTED' },
    [VerificationStage.PLAYBACK_ADVANCING]: { cls: 'badge badge-green', text: '🟢 STAGE 5: PLAYBACK_ADVANCING (Verified)' },
    [VerificationStage.BLOCKED_FAIL_CLOSED]: { cls: 'badge badge-red', text: '🔴 BLOCKED_FAIL_CLOSED (HTTP 403)' }
  };

  const conf = stageConfig[currentVerificationStage] || stageConfig[VerificationStage.IDLE];
  badge.className = conf.cls;
  badge.textContent = conf.text;
}

export function renderLiveTelemetry(telemetry) {
  const metricsEl = document.getElementById('canaryLiveMetrics');
  if (!metricsEl) return;

  const q = telemetry.playback?.quality || {};
  const ft = telemetry.perf?.frameTimeMs || {};
  const glErr = telemetry.gl?.error || 'NO_ERROR';
  const curTime = telemetry.currentTime ? telemetry.currentTime.toFixed(1) : '0.0';
  const dur = telemetry.duration ? telemetry.duration.toFixed(1) : '0.0';

  metricsEl.innerHTML = `
    <b>Target:</b> ${currentTargetCandidate?.fileName || '--'} |
    <b>Time:</b> <span style="color:#38bdf8;">${curTime}s / ${dur}s</span> |
    <b>Stalls:</b> <b>${telemetry.stallCount ?? 0}</b> |
    <b>DropRate:</b> <b>${q.windowDropRate ?? '--'}%</b> (${q.windowDeltaDropped ?? 0}/${q.windowDeltaTotal ?? 0}) |
    <b>p95 FT:</b> <b>${ft.p95 ?? '--'}ms</b> |
    <b>GL:</b> <b style="color:${glErr === 'NO_ERROR' ? '#34d399' : '#f87171'}">${glErr}</b>
  `;
}

export function renderCanaryUI() {
  const container = document.getElementById('canaryItemsList');
  if (!container) return;

  if (canaryCandidates.length === 0) {
    container.innerHTML = '<div style="color:var(--muted); font-size:0.75rem; padding:8px;">Loading high-risk candidates from server...</div>';
    return;
  }

  container.innerHTML = canaryCandidates.slice(0, 5).map(c => {
    const isAdmitted = activeAdmissions.has(c.fingerprintId);
    const isSelected = currentTargetCandidate?.id === c.id;
    const gateBadge = isAdmitted
      ? `<span class="badge badge-green" style="font-size:0.68rem;">🟢 Provisional (206)</span>`
      : `<span class="badge badge-red" style="font-size:0.68rem;">🔴 Denied (403)</span>`;
    
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; background:#1e293b; padding:8px 10px; border-radius:6px; border:1px solid ${isSelected ? '#38bdf8' : '#334155'}; gap:8px;">
        <div style="flex:1; min-width:0;">
          <div style="display:flex; align-items:center; gap:6px;">
            <b style="font-size:0.8rem; color:#fff;">#${c.rank} Risk Candidate</b>
            ${gateBadge}
          </div>
          <div style="font-size:0.72rem; color:var(--muted); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; margin-top:2px;">
            ${c.fileName}
          </div>
          <div style="font-size:0.7rem; color:#94a3b8; margin-top:2px;">
            FP: <code style="color:#38bdf8;">${c.fingerprintId}</code> | Stalls: <b>${c.evidence.stalls}</b> | SeekLat: <b>${c.evidence.seekFirstFrameLatMs}ms</b> (API: ${c.evidence.seekApiLatMs}ms) | Res: <b>${c.videoWidth}x${c.videoHeight}</b>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-end;">
          <button class="action-btn" onclick="window.selectCanary('${c.id}')" style="padding:4px 10px; font-size:0.75rem; background:${isSelected ? '#0284c7' : '#334155'};">
            ${isSelected ? '▶ Active' : '▶ Select'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

export function exportCanarySessionSummary() {
  if (!currentTestSession) {
    alert('No active Canary test session to export.');
    return;
  }
  const summary = {
    candidateId: currentTestSession.candidateId,
    rank: currentTestSession.rank,
    fingerprintId: currentTestSession.fingerprintId,
    finalStage: currentVerificationStage,
    stageHistory: currentTestSession.stageHistory,
    stallsObserved: currentTestSession.stallsObserved,
    startedAt: currentTestSession.startedAt,
    exportedAt: new Date().toISOString()
  };
  const jsonStr = JSON.stringify(summary, null, 2);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(jsonStr).then(() => {
      alert('Canary test summary copied to clipboard!');
    }).catch(() => {
      console.log('Session Summary:', jsonStr);
    });
  } else {
    console.log('Session Summary:', jsonStr);
  }
}

// Global attachment for HTML event handlers
window.selectCanary = selectCanary;
window.selectTopRiskCanary = selectTopRiskCanary;
window.advanceNextCanary = advanceNextCanary;
window.refreshCanaryAdmissions = refreshCanaryAdmissions;
window.exportCanarySessionSummary = exportCanarySessionSummary;
window.handleCanaryTelemetry = handleCanaryTelemetry;

// Bootstrap
loadCanaryQueue();
refreshCanaryAdmissions();
const timer = setInterval(() => {
  refreshCanaryAdmissions();
}, 4000);
if (timer && timer.unref) timer.unref();
