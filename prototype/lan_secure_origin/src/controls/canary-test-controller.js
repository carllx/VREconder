// ==========================================
// Canary & Risk-Directed VR Test Controller
// Zero-Search dynamic queue with rigorous 5-stage verification state machine
// ==========================================

import { onSelectMedia } from './controller-app.js';

export const VerificationStage = {
  IDLE: 'IDLE',
  TARGET_SELECTED: 'TARGET_SELECTED',
  IPHONE_MEDIA_PATH_MATCH: 'IPHONE_MEDIA_PATH_MATCH',
  BUFFER_ATTACHED: 'BUFFER_ATTACHED',
  FIRST_FRAME_PRESENTED: 'FIRST_FRAME_PRESENTED',
  FLAT_PLAYBACK_ACTIVE: 'FLAT_PLAYBACK_ACTIVE',
  VR_PLAYBACK_ACTIVE: 'VR_PLAYBACK_ACTIVE',
  TEXTURE_UPLOAD_STALLED: 'TEXTURE_UPLOAD_STALLED',
  WEBGL_ERROR: 'WEBGL_ERROR',
  PLAYBACK_DECODE_ERROR: 'PLAYBACK_DECODE_ERROR',
  BLOCKED_FAIL_CLOSED: 'BLOCKED_FAIL_CLOSED',
  IPHONE_OFFLINE: 'IPHONE_OFFLINE',
  TELEMETRY_STALE: 'TELEMETRY_STALE'
};

export let canaryCandidates = [];
export let activeAdmissions = new Set();
export let currentTargetCandidate = null;
export let currentVerificationStage = VerificationStage.IDLE;
export let currentTestSession = null;
export let selectionBaseline = null;

let lastObservedCurrentTime = -1;
let consecutiveAdvancingCount = 0;
let lastKnownIphoneStatus = { state: 'offline' };

export function normalizeMediaName(pathOrName) {
  if (!pathOrName || typeof pathOrName !== 'string') return '';
  const cleaned = pathOrName.replace(/\\/g, '/').trim();
  const base = cleaned.split('/').pop() || '';
  return base.toLowerCase().trim();
}

export function isExactMediaMatch(telemetryPath, targetPath) {
  const normTelem = normalizeMediaName(telemetryPath);
  const normTarget = normalizeMediaName(targetPath);
  if (!normTelem || !normTarget) return false;
  return normTelem === normTarget;
}

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
  selectionBaseline = null;
  lastObservedCurrentTime = -1;
  consecutiveAdvancingCount = 0;

  currentTestSession = {
    candidateId: c.id,
    rank: c.rank,
    fingerprintId: c.fingerprintId,
    file: c.fileName,
    selectedAtEpochMs: Date.now(),
    startedAt: new Date().toISOString(),
    stageHistory: [VerificationStage.TARGET_SELECTED],
    stallsObserved: 0,
    webglErrors: [],
    inVRVerified: false,
    finalStage: VerificationStage.TARGET_SELECTED
  };

  onSelectMedia(c.relPath);
  renderCanaryUI();
  updateVerificationBadge();
}

export function handleCanaryTelemetry(telemetry, iphoneStatus = null) {
  if (iphoneStatus) lastKnownIphoneStatus = iphoneStatus;

  if (!currentTargetCandidate || !currentTestSession) return;

  // 1. Device Freshness & Disconnection Guardrail
  if (lastKnownIphoneStatus) {
    if (lastKnownIphoneStatus.state === 'offline') {
      currentVerificationStage = VerificationStage.IPHONE_OFFLINE;
      updateVerificationBadge();
      return;
    }
    if (lastKnownIphoneStatus.state === 'stale' || (typeof lastKnownIphoneStatus.ageMs === 'number' && lastKnownIphoneStatus.ageMs > 3000)) {
      currentVerificationStage = VerificationStage.TELEMETRY_STALE;
      updateVerificationBadge();
      return;
    }
  }

  if (!telemetry) return;

  // 2. Exact Path Identity Guardrail
  const telemetryMediaPath = telemetry.mediaPath || telemetry.mediaName || '';
  if (!isExactMediaMatch(telemetryMediaPath, currentTargetCandidate.relPath)) {
    // Telemetry belongs to previous or different media - do NOT advance stages
    updateVerificationBadge();
    return;
  }

  // 3. Establish Selection Baseline on First Fresh Telemetry Arrival
  if (!selectionBaseline) {
    selectionBaseline = {
      establishedAt: Date.now(),
      totalVideoFrames: telemetry.perf?.playback?.quality?.totalVideoFrames ?? telemetry.playback?.quality?.totalVideoFrames ?? 0,
      currentTime: telemetry.currentTime ?? telemetry.perf?.playback?.currentTime ?? 0,
      firstRenderAt: telemetry.timings?.firstRenderAt ?? 0,
      selectedAt: telemetry.timings?.selectedAt ?? 0
    };
    recordStageTransition(VerificationStage.IPHONE_MEDIA_PATH_MATCH);
  }

  const pb = telemetry.perf?.playback || telemetry.playback || {};
  const isAdmitted = activeAdmissions.has(currentTargetCandidate.fingerprintId);

  // 4. Decode / Network Load / Policy Error Handling
  // Distinguish genuine media decode/network failures from policy blocks
  if (telemetry.mediaStatus === 'POLICY_BLOCKED' || pb.networkState === 3 || pb.error || telemetry.error) {
    if (telemetry.mediaStatus === 'POLICY_BLOCKED') {
      recordStageTransition(VerificationStage.BLOCKED_FAIL_CLOSED);
    } else {
      recordStageTransition(VerificationStage.PLAYBACK_DECODE_ERROR);
      if (currentTestSession && !currentTestSession.webglErrors.includes('MEDIA_ERROR')) {
        currentTestSession.webglErrors.push('MEDIA_ERROR');
      }
    }
    updateVerificationBadge();
    return;
  }

  // 5. Buffer Attached & Metadata Loaded
  if (currentVerificationStage === VerificationStage.IPHONE_MEDIA_PATH_MATCH) {
    if (pb.readyState >= 1 || pb.readyState >= 2 || (Array.isArray(pb.bufferedRanges) && pb.bufferedRanges.length > 0)) {
      recordStageTransition(VerificationStage.BUFFER_ATTACHED);
    }
  }

  // 6. First Frame Presented (Only from Fresh Post-Selection Frame Evidence Attributable to Current Media)
  // Note: videoUploadsPerSec alone is a rate metric and CANNOT prove new media first frame without frame delta/render timestamp
  const currentTotalFrames = pb.quality?.totalVideoFrames ?? 0;
  const currentFirstRender = telemetry.timings?.firstRenderAt ?? 0;
  const videoUploads = telemetry.perf?.cadence?.videoUploadsPerSec ?? 0;
  const rvfc = telemetry.perf?.cadence?.rvfcPerSec ?? 0;

  const hasFreshFrameEvidence = (currentFirstRender > selectionBaseline.firstRenderAt) ||
    (currentTotalFrames > selectionBaseline.totalVideoFrames);

  if ((currentVerificationStage === VerificationStage.BUFFER_ATTACHED) && hasFreshFrameEvidence) {
    recordStageTransition(VerificationStage.FIRST_FRAME_PRESENTED);
  }

  // 7. Video Progress, WebGL & VR Stereo Render Verification
  const curTime = telemetry.currentTime ?? pb.currentTime ?? 0;
  const inVR = Boolean(telemetry.inVR);
  const glErr = telemetry.perf?.webgl?.glError || telemetry.gl?.error || 'NO_ERROR';
  const glLoss = telemetry.perf?.webgl?.contextLostCount ?? 0;

  if (glErr !== 'NO_ERROR' || glLoss > 0) {
    recordStageTransition(VerificationStage.WEBGL_ERROR);
    if (!currentTestSession.webglErrors.includes(glErr)) currentTestSession.webglErrors.push(glErr);
  } else if (currentVerificationStage === VerificationStage.FIRST_FRAME_PRESENTED ||
             currentVerificationStage === VerificationStage.FLAT_PLAYBACK_ACTIVE ||
             currentVerificationStage === VerificationStage.VR_PLAYBACK_ACTIVE ||
             currentVerificationStage === VerificationStage.TEXTURE_UPLOAD_STALLED) {

    if (!pb.paused && curTime > lastObservedCurrentTime && lastObservedCurrentTime >= 0) {
      consecutiveAdvancingCount++;
      if (consecutiveAdvancingCount >= 2) {
        // Texture stall condition: playback time or rVFC advancing, but GPU texture uploads stalled at zero
        if (videoUploads === 0) {
          recordStageTransition(VerificationStage.TEXTURE_UPLOAD_STALLED);
        } else if (inVR && rvfc > 0 && videoUploads > 0) {
          // Strictly require inVR === true AND rvfc > 0 AND videoUploads > 0 simultaneously
          recordStageTransition(VerificationStage.VR_PLAYBACK_ACTIVE);
          currentTestSession.inVRVerified = true;
        } else {
          recordStageTransition(VerificationStage.FLAT_PLAYBACK_ACTIVE);
        }
      }
    } else if (pb.paused) {
      consecutiveAdvancingCount = 0;
    }
  }

  lastObservedCurrentTime = curTime;

  if (telemetry.stall && typeof telemetry.stall.stallCount === 'number') {
    currentTestSession.stallsObserved = Math.max(currentTestSession.stallsObserved, telemetry.stall.stallCount);
  } else if (telemetry.perf?.stall && typeof telemetry.perf.stall.stallCount === 'number') {
    currentTestSession.stallsObserved = Math.max(currentTestSession.stallsObserved, telemetry.perf.stall.stallCount);
  } else if (typeof telemetry.stallCount === 'number') {
    currentTestSession.stallsObserved = Math.max(currentTestSession.stallsObserved, telemetry.stallCount);
  }

  updateVerificationBadge();
  renderLiveTelemetry(telemetry);
}

function recordStageTransition(newStage) {
  if (currentVerificationStage !== newStage) {
    currentVerificationStage = newStage;
    if (currentTestSession) {
      currentTestSession.finalStage = newStage;
      if (!currentTestSession.stageHistory.includes(newStage)) {
        currentTestSession.stageHistory.push(newStage);
      }
    }
  }
}

export function updateVerificationBadge() {
  const badge = document.getElementById('canaryStageBadge');
  if (!badge) return;

  const stageConfig = {
    [VerificationStage.IDLE]: { cls: 'badge badge-slate', text: '⚪ IDLE: No Target' },
    [VerificationStage.TARGET_SELECTED]: { cls: 'badge badge-amber', text: '🟡 STAGE 1: TARGET_SELECTED (Pushed via SSE)' },
    [VerificationStage.IPHONE_MEDIA_PATH_MATCH]: { cls: 'badge badge-amber', text: '🟡 STAGE 2: IPHONE_MEDIA_PATH_MATCH (Path Confirmed)' },
    [VerificationStage.BUFFER_ATTACHED]: { cls: 'badge badge-slate', text: '🔵 STAGE 3: BUFFER_ATTACHED (Metadata & Buffer Loaded)' },
    [VerificationStage.FIRST_FRAME_PRESENTED]: { cls: 'badge badge-slate', text: '🟣 STAGE 4: FIRST_FRAME_PRESENTED (Fresh Frame Rendered)' },
    [VerificationStage.FLAT_PLAYBACK_ACTIVE]: { cls: 'badge badge-amber', text: '🟡 FLAT_PLAYBACK_ACTIVE (Advancing in 2D — Awaiting VR Mode)' },
    [VerificationStage.VR_PLAYBACK_ACTIVE]: { cls: 'badge badge-green', text: '🟢 STAGE 5: VR_PLAYBACK_ACTIVE (Live Cadence Active — Unverified)' },
    [VerificationStage.TEXTURE_UPLOAD_STALLED]: { cls: 'badge badge-red', text: '🔴 TEXTURE_UPLOAD_STALLED (Time/rVFC advancing but GPU upload is 0)' },
    [VerificationStage.WEBGL_ERROR]: { cls: 'badge badge-red', text: '🔴 WEBGL_ERROR (Context Lost or Shader Error)' },
    [VerificationStage.PLAYBACK_DECODE_ERROR]: { cls: 'badge badge-red', text: '🔴 DECODE_ERROR (Hardware/Decoder Failure on Safari)' },
    [VerificationStage.BLOCKED_FAIL_CLOSED]: { cls: 'badge badge-red', text: '🔴 BLOCKED_FAIL_CLOSED (Security/Path Boundary Blocked)' },
    [VerificationStage.IPHONE_OFFLINE]: { cls: 'badge badge-slate', text: '⚪ IPHONE_OFFLINE (Connection Disconnected)' },
    [VerificationStage.TELEMETRY_STALE]: { cls: 'badge badge-amber', text: '🟡 TELEMETRY_STALE (>3s ago — Dropping Active Status)' }
  };

  const conf = stageConfig[currentVerificationStage] || stageConfig[VerificationStage.IDLE];
  badge.className = conf.cls;
  badge.textContent = conf.text;
}

export function renderLiveTelemetry(telemetry) {
  const metricsEl = document.getElementById('canaryLiveMetrics');
  if (!metricsEl) return;

  const pb = telemetry.perf?.playback || telemetry.playback || {};
  const q = pb.quality || {};
  const ft = telemetry.perf?.frameTimeMs || {};
  const cad = telemetry.perf?.cadence || {};
  const gl = telemetry.perf?.webgl || telemetry.gl || {};
  const glErr = gl.glError || gl.error || 'NO_ERROR';
  const curTime = (typeof telemetry.currentTime === 'number' ? telemetry.currentTime : (pb.currentTime || 0)).toFixed(1);
  const dur = (pb.duration ? pb.duration : (telemetry.duration || 0)).toFixed(1);
  const inVRText = telemetry.inVR ? '<b style="color:#34d399;">YES (Stereo)</b>' : '<b style="color:#fbbf24;">NO (Flat)</b>';

  metricsEl.innerHTML = `
    <b>Target:</b> ${currentTargetCandidate?.fileName || '--'} |
    <b>Time:</b> <span style="color:#38bdf8;">${curTime}s / ${dur}s</span> |
    <b>inVR:</b> ${inVRText} |
    <b>rVFC:</b> <b>${cad.rvfcPerSec ?? '--'}/s</b> |
    <b>VidUp:</b> <b>${cad.videoUploadsPerSec ?? '--'}/s</b> |
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
      ? `<span class="badge badge-green" style="font-size:0.68rem;">🟢 User Authorized Trial</span>`
      : `<span class="badge badge-amber" style="font-size:0.68rem;">🟡 Unverified (Trial Allowed)</span>`;
    
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
    inVRVerified: currentTestSession.inVRVerified,
    stallsObserved: currentTestSession.stallsObserved,
    webglErrors: currentTestSession.webglErrors,
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

export async function fetchPairingPin() {
  try {
    const res = await fetch('/api/device/pin');
    const data = await res.json();
    const badge = document.getElementById('badgePairingPin');
    if (badge && data.pin) {
      badge.textContent = `🔑 PIN: ${data.pin}`;
      badge.className = 'badge badge-green';
    }
  } catch (e) {
    console.warn('Failed to fetch pairing PIN:', e);
  }
}

export async function revokeAllDeviceSessions() {
  if (!confirm('Revoke all paired device sessions? iPhone will need to re-pair.')) return;
  try {
    const res = await fetch('/api/device/revoke', { method: 'POST' });
    const data = await res.json();
    alert(data.message || 'All device sessions revoked');
    fetchPairingPin();
  } catch (e) {
    alert('Failed to revoke sessions: ' + e.message);
  }
}

// Global attachment for HTML event handlers
window.selectCanary = selectCanary;
window.selectTopRiskCanary = selectTopRiskCanary;
window.advanceNextCanary = advanceNextCanary;
window.refreshCanaryAdmissions = refreshCanaryAdmissions;
window.exportCanarySessionSummary = exportCanarySessionSummary;
window.handleCanaryTelemetry = handleCanaryTelemetry;
window.fetchPairingPin = fetchPairingPin;
window.revokeAllDeviceSessions = revokeAllDeviceSessions;

// Bootstrap
loadCanaryQueue();
refreshCanaryAdmissions();
fetchPairingPin();
const timer = setInterval(() => {
  refreshCanaryAdmissions();
}, 4000);
if (timer && timer.unref) timer.unref();
