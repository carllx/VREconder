// PC Calibration Controller Application (SSOT Control Surface)

export let currentStage = 'A';
export let currentVisualMode = 'grid_only';
export let lensEnabled = false;
export let isArmed = false;
export let diagEye = 0;
export let diagOverlays = { showGrid: true, showPlumbLines: true, showHorizon: true };
export let latestSavedMyProfile = null;
export let videoList = [];
export let o4FittingActive = false;
export let candidateDistortion = { k1: 0.0, k2: 0.0 };
export let currentIphoneStatus = { state: 'offline' };
export let pendingAck = null; // { type: 'stage'|'visual_mode'|'fitting', target, requestedAt }

let isServerOnline = false;
export function setServerConnectionBadge(online = true, text = '') {
  isServerOnline = online;
  const badge = document.getElementById('badgeServerConnection');
  if (badge) {
    badge.className = online ? 'badge badge-green' : 'badge badge-amber';
    badge.textContent = text || (online ? '🟢 Server: Connected' : '🟡 Server: Reconnecting...');
  }
}

export function setIphoneConnectionBadge(status = {}) {
  const badge = document.getElementById('badgeIphoneConnection');
  const card = document.getElementById('cardPerfTelemetry');
  const freshness = document.getElementById('badgePerfFreshness');
  const st = status.state || 'offline';
  const ageSec = status.ageMs !== null ? (status.ageMs / 1000).toFixed(1) : null;
  if (badge) {
    badge.className = st === 'active' ? 'badge badge-green' : (st === 'stale' ? 'badge badge-amber' : 'badge badge-slate');
    badge.textContent = st === 'active' ? '🟢 iPhone: Active' : (st === 'stale' ? `🟡 iPhone: Stale (${ageSec}s ago)` : '⚪ iPhone: Offline');
  }
  if (freshness) {
    freshness.textContent = st === 'active' ? '🟢 Live Telemetry Stream' : (st === 'stale' ? `🟡 Cached Data (${ageSec}s ago)` : '⚪ Disconnected / Offline');
    freshness.style.color = st === 'active' ? '#34d399' : (st === 'stale' ? '#fbbf24' : '#94a3b8');
  }
  if (card) card.classList.toggle('card-dim', st === 'offline');
}

export function initEventSource() {
  try {
    const es = new EventSource('/api/calibration/events');
    es.onopen = () => { setServerConnectionBadge(true, '🟢 Server: Connected (SSE)'); };
    es.onerror = () => { setServerConnectionBadge(false, '🟡 Server: Reconnecting (SSE)...'); };
    es.onmessage = (e) => {
      setServerConnectionBadge(true);
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'telemetry_sync') updateTelemetryUI(msg);
      } catch(err) {}
    };
  } catch (e) {}
}

export let lastAuthoritativeMediaPath = '';

export async function loadVideoList() {
  try {
    const res = await fetch('/api/videos');
    const data = await res.json();
    if (data && Array.isArray(data.videos)) {
      videoList = data.videos;
    } else if (Array.isArray(data)) {
      videoList = data;
    }
    renderVideoSelect();
  } catch (e) {
    videoList = [];
    renderVideoSelect();
  }
}

export function renderVideoSelect() {
  const sel = document.getElementById('selMediaList');
  if (!sel) return;

  if (!videoList || videoList.length === 0) {
    sel.innerHTML = '<option value="">No media available</option>';
    sel.value = '';
    return;
  }

  const previousVal = sel.value;
  sel.innerHTML = videoList.map(v => {
    const sizeStr = v.sizeGB ? `[${v.sizeGB}] ` : '';
    return `<option value="${v.relPath}">${sizeStr}${v.name || v.relPath}</option>`;
  }).join('');

  const listHasAuthoritative = lastAuthoritativeMediaPath && videoList.some(v => v.relPath === lastAuthoritativeMediaPath);
  const listHasPrevious = previousVal && videoList.some(v => v.relPath === previousVal);

  if (listHasAuthoritative) {
    sel.value = lastAuthoritativeMediaPath;
  } else if (listHasPrevious) {
    sel.value = previousVal;
  } else {
    sel.value = videoList[0].relPath;
  }
}

export async function sendControl(payload) {
  try {
    await fetch('/api/calibration/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Failed to send control command', e);
  }
}

import { initMediaRootController, initTimelineScrubber, isScrubbing, formatTime } from './media-root-controller.js';

export function onSelectMedia(relPath) {
  if (!relPath) return;
  lastAuthoritativeMediaPath = relPath;
  sendControl({ action: 'select_media', relPath: relPath });
}

export function sendSeek(sec) { sendControl({ action: 'seek', seconds: sec }); }
export function sendSeekTo(sec) { sendControl({ action: 'seek_to', seconds: Math.max(0, sec) }); }

export function toggleDiagnosticEye() {
  diagEye = (diagEye === 0) ? 1 : 0;
  const btn = document.getElementById('btnDiagEye');
  if (btn) btn.textContent = `👁 Eye: ${diagEye === 0 ? 'Left' : 'Right'}`;
  sendControl({ action: 'set_diagnostic_eye', eye: diagEye });
}

export function toggleDiagnosticOverlay(key) {
  diagOverlays[key] = !diagOverlays[key];
  const btnMap = { showGrid: 'btnDiagGrid', showPlumbLines: 'btnDiagPlumb', showHorizon: 'btnDiagHorizon' };
  const btn = document.getElementById(btnMap[key]);
  if (btn) btn.classList.toggle('active', diagOverlays[key]);
  sendControl({ action: 'set_diagnostic_overlay', key: key, value: diagOverlays[key] });
}

export function onPoseChange() {
  const yaw = parseFloat(document.getElementById('rngPoseYaw')?.value || 0);
  const pitch = parseFloat(document.getElementById('rngPosePitch')?.value || 0);
  const roll = parseFloat(document.getElementById('rngPoseRoll')?.value || 0);
  document.getElementById('valPoseYaw').textContent = yaw + '°';
  document.getElementById('valPosePitch').textContent = pitch + '°';
  document.getElementById('valPoseRoll').textContent = roll + '°';
  sendControl({ action: 'set_video_pose', yawDeg: yaw, pitchDeg: pitch, rollDeg: roll });
}

export function resetPose() {
  ['rngPoseYaw', 'rngPosePitch', 'rngPoseRoll'].forEach(id => { const el = document.getElementById(id); if (el) el.value = 0; });
  onPoseChange();
}

function isPhoneActive() { return currentIphoneStatus && currentIphoneStatus.state === 'active'; }
function notifyFailClosed(msg) {
  const f = document.getElementById('optics-feedback') || document.getElementById('valDevStatus');
  if (f) f.textContent = '⚠️ iPhone not active — ' + msg;
}

export function setStage(stage) {
  if (!isPhoneActive()) { notifyFailClosed('cannot change stage while offline/stale'); return; }
  pendingAck = { type: 'stage', target: stage, requestedAt: Date.now() };
  currentStage = stage;
  if (stage !== 'B' && o4FittingActive) setO4FittingActive(false);
  ['A', 'B', 'C'].forEach(s => document.getElementById('btnStage' + s)?.classList.toggle('active', s === stage));
  applyStageLocks(stage);
  sendControl({ action: 'set_stage', stage });
}

export function setViewerVisualMode(mode) {
  if (!isPhoneActive()) { notifyFailClosed('cannot change visual mode while offline/stale'); return; }
  pendingAck = { type: 'visual_mode', target: mode, requestedAt: Date.now() };
  currentVisualMode = mode;
  if (mode !== 'grid_only' && o4FittingActive) setO4FittingActive(false);
  const vmMap = { grid_only: 'btnVisualGridOnly', ild_fusion: 'btnVisualIldFusion', vertical_alignment: 'btnVisualVerticalAlign', video_grid: 'btnVisualVideoGrid' };
  Object.entries(vmMap).forEach(([m, id]) => document.getElementById(id)?.classList.toggle('active', m === mode));
  applyStageLocks(currentStage);
  sendControl({ action: 'set_viewer_visual_mode', mode });
}

export function setO4FittingActive(active) {
  o4FittingActive = (active === true);
  const btn = document.getElementById('btnToggleO4Fitting'), banner = document.getElementById('bannerO4FittingActive');
  if (btn) {
    btn.textContent = o4FittingActive ? '🔬 O4 Distortion Fitting: ACTIVE' : '⚪ O4 Distortion Fitting: OFF';
    btn.style.background = o4FittingActive ? '#7e22ce' : '#334155';
    btn.style.color = o4FittingActive ? '#f3e8ff' : '#cbd5e1';
    btn.style.borderColor = o4FittingActive ? '#a855f7' : '#475569';
  }
  if (banner) banner.style.display = o4FittingActive ? 'block' : 'none';
  applyStageLocks(currentStage);
  sendControl({ action: 'set_distortion_fitting_mode', enabled: o4FittingActive });
}

export function toggleO4FittingMode() {
  const desired = !o4FittingActive;
  if (desired) {
    if (!isPhoneActive()) { notifyFailClosed('O4 fitting requires active iPhone'); return; }
    if (pendingAck) { notifyFailClosed('waiting for command acknowledgement'); return; }
    if (currentStage !== 'B' || currentVisualMode !== 'grid_only') {
      notifyFailClosed('O4 fitting requires confirmed Stage B + Grid Only');
      return;
    }
  }
  pendingAck = { type: 'fitting', target: desired, requestedAt: Date.now() };
  setO4FittingActive(desired);
}

export function applyStageLocks(stage) {
  const isStageC = (stage === 'C'), lockNonDist = (isStageC || stage === 'A') || o4FittingActive;
  const setDis = (id, dis) => { const el = document.getElementById(id); if (el) el.disabled = dis; };
  const setDisp = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? 'block' : 'none'; };
  ['selViewerPreset', 'btnLensToggle', 'btnSaveViewer'].forEach(id => setDis(id, isStageC || o4FittingActive));
  ['rngK1', 'rngK2'].forEach(id => setDis(id, isStageC || stage === 'A'));
  ['rngFov', 'rngScreenToLens', 'rngInterLens', 'rngTrayToLens'].forEach(id => setDis(id, lockNonDist));
  setDisp('lockNotice', isStageC); setDisp('stageCVerificationPanel', isStageC);
  setDisp('stageBVisualRefPanel', stage === 'B'); setDisp('stageBEvidencePanel', stage === 'B');
  setDisp('panelO4Fitting', stage === 'B' && currentVisualMode === 'grid_only');
}

export function populateSlidersFromProfile(p) {
  if (!p) return;
  const setSlider = (rngId, valId, val, fmt) => {
    const el = document.getElementById(rngId); if (el) el.value = val;
    const txt = document.getElementById(valId); if (txt) txt.textContent = fmt;
  };
  if (!o4FittingActive && p.distortion) {
    if (typeof p.distortion.k1 === 'number') setSlider('rngK1', 'valK1', p.distortion.k1, p.distortion.k1.toFixed(3));
    if (typeof p.distortion.k2 === 'number') setSlider('rngK2', 'valK2', p.distortion.k2, p.distortion.k2.toFixed(3));
  }
  if (p.screenToLensDistance) setSlider('rngScreenToLens', 'valScreenToLens', p.screenToLensDistance * 1000, (p.screenToLensDistance * 1000).toFixed(1));
  if (p.interLensDistance) setSlider('rngInterLens', 'valInterLens', p.interLensDistance * 1000, (p.interLensDistance * 1000).toFixed(1));
  if (p.trayToLensDistance) setSlider('rngTrayToLens', 'valTrayToLens', p.trayToLensDistance * 1000, (p.trayToLensDistance * 1000).toFixed(1));
  if (p.maxFovAngles && p.maxFovAngles.outerDeg) setSlider('rngFov', 'valFov', p.maxFovAngles.outerDeg, p.maxFovAngles.outerDeg.toFixed(1) + '°');
}

export function onVideoMappingChange() {
  const proj = document.getElementById('selProjection').value;
  const stereo = document.getElementById('selStereo').value;
  const covVal = document.getElementById('selCoverageFov').value;
  const eye = document.getElementById('selEyeOrder').value;
  const fov = (covVal === 'unknown' || isNaN(parseFloat(covVal))) ? 180 : parseFloat(covVal);
  sendControl({
    action: 'set_video_mapping',
    mapping: {
      projection: proj,
      stereoMode: stereo,
      horizontalCoverageDeg: fov,
      verticalCoverageDeg: 180,
      eyeOrder: eye
    }
  });
}

export function saveVideoMapping() {
  const proj = document.getElementById('selProjection')?.value;
  const stereo = document.getElementById('selStereo')?.value;
  const eye = document.getElementById('selEyeOrder')?.value;
  if (!proj || proj === 'unknown' || !stereo || stereo === 'unknown' || !eye || eye === 'unknown') {
    alert('⚠️ Cannot save unconfirmed video mapping.\nPlease select Projection, Stereo Mode, and Eye Order first.');
    return;
  }
  sendControl({ action: 'save_video_profile' });
}

export function toggleReferenceGrid(checked) {
  sendControl({ action: 'set_reference_grid', enabled: checked });
}

export function toggleLensCorrection() {
  if (o4FittingActive) return;
  lensEnabled = !lensEnabled;
  const btn = document.getElementById('btnLensToggle');
  if (btn) {
    btn.textContent = lensEnabled ? '🛡️ LENS CORRECTION: ON' : '⚪ LENS CORRECTION: OFF';
    btn.className = 'action-btn ' + (lensEnabled ? 'btn-lens-on' : 'btn-lens-off');
  }
  sendControl({ action: 'set_lens_correction', enabled: lensEnabled });
}

export function onOpticsChange() {
  if (currentStage !== 'B') return;
  const k1 = parseFloat(document.getElementById('rngK1')?.value || 0);
  const k2 = parseFloat(document.getElementById('rngK2')?.value || 0);
  document.getElementById('valK1').textContent = k1.toFixed(3);
  document.getElementById('valK2').textContent = k2.toFixed(3);

  if (o4FittingActive && currentVisualMode === 'grid_only') {
    candidateDistortion.k1 = k1;
    candidateDistortion.k2 = k2;
    const txtK1 = document.getElementById('txtO4CandK1'); if (txtK1) txtK1.textContent = k1.toFixed(3);
    const txtK2 = document.getElementById('txtO4CandK2'); if (txtK2) txtK2.textContent = k2.toFixed(3);
    sendControl({ action: 'set_candidate_distortion', k1, k2 });
    return;
  }

  const g = id => parseFloat(document.getElementById(id)?.value || 0);
  const fov = g('rngFov') || 50, s2l = g('rngScreenToLens') || 39.3, ipd = g('rngInterLens') || 63.9, t2l = g('rngTrayToLens') || 35.0;
  const sTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  sTxt('valFov', fov.toFixed(1) + '°'); sTxt('valScreenToLens', s2l.toFixed(1)); sTxt('valInterLens', ipd.toFixed(1)); sTxt('valTrayToLens', t2l.toFixed(1));
  sendControl({ action: 'set_viewer_params', k1, k2, maxFovDeg: fov, screenToLensMm: s2l, interLensMm: ipd, trayToLensMm: t2l });
}

export function sendAction(act) { sendControl({ action: act }); }

export function updateTelemetryUI(data) {
  if (!data) return;

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  // 1. Critical Priority: Performance Diagnostics (Always executes first)
  if (data.perf) {
    try {
      const { cadence: cad = {}, frameTimeMs: ft = {}, playback: pb = {}, display: disp = {}, webgl: wg = {} } = data.perf, q = pb.quality || {};
      setEl('valPerfCadence', `rAF: ${cad.rafPerSec || 0}/s | rVFC: ${cad.rvfcPerSec || 0}/s`);
      setEl('valUploadCadence', `VidUp: ${cad.videoUploadsPerSec || 0}/s | UIUp: ${cad.uiUploadsPerSec || 0}/s`);
      setEl('valFrameTimeAvg', `avg: ${ft.avg || 0}ms | p95: ${ft.p95 || 0}ms`);
      setEl('valFrameTimeMax', `max: ${ft.max || 0}ms (${ft.samples || 0} frames)`);
      setEl('valVideoQuality', `total: ${q.totalVideoFrames} | drop: ${q.droppedVideoFrames}`);
      setEl('valVideoDropRate', (typeof q.dropRate === 'number') ? `${q.dropRate}% dropped` : String(q.dropRate));
      setEl('valDisplayViewport', `VP: ${disp.cssViewport || '--'} (DPR: ${disp.dpr || '--'})`);
      setEl('valDrawingBuffer', `DrawBuf: ${disp.drawingBuffer || '--'} | FBO: ${disp.eyeFbo || '--'}`);
      setEl('valPlaybackStates', `ready: ${pb.readyState} | net: ${pb.networkState} | ${pb.paused ? '⏸' : '▶'}`);
      setEl('valBufferDetails', `ahead: ${pb.bufferAheadSec}s`);
      setEl('valGlError', wg.glError || 'NO_ERROR');
      setEl('valGlContextLoss', `Loss/Rest: ${wg.contextLostCount || 0}/${wg.contextRestoredCount || 0}`);
      setEl('valActivePerfMode', data.perf.performanceMode || 'baseline');
      setEl('valActiveRenderScale', (data.perf.renderScale || 1.0).toFixed(2) + 'x');
      setEl('valEyeFboSize', disp.eyeFbo || '--');
      setEl('valBufferAhead', `${pb.bufferAheadSec}s`);
    } catch (e) {
      console.warn('Error updating perf telemetry UI:', e);
    }
  }

  // 2. Armed & General Status
  try {
    if (typeof data.isArmed === 'boolean') {
      isArmed = data.isArmed;
      const b = document.getElementById('badgeArmStatus');
      if (b) {
        b.className = isArmed ? 'badge badge-green' : 'badge badge-amber';
        b.textContent = isArmed ? '🟢 iPhone Armed (VR Ready)' : '🟡 Tap "Arm & Enter VR" on iPhone';
      }
    }
  } catch (e) {}

  // 3. Media & Transport
  try {
    if (data.mediaList && Array.isArray(data.mediaList) && data.mediaList.length > 0 && videoList.length === 0) {
      videoList = data.mediaList;
      renderVideoSelect();
    }
    if (data.mediaPath) {
      const sel = document.getElementById('selMediaList');
      const optionExists = sel ? Array.from(sel.options).some(o => o.value === data.mediaPath) : videoList.some(v => v.relPath === data.mediaPath);
      if (optionExists) {
        lastAuthoritativeMediaPath = data.mediaPath;
        if (sel && sel.value !== data.mediaPath) sel.value = data.mediaPath;
      }
    }
    if (typeof data.currentTime === 'number') {
      const cur = data.currentTime;
      const dur = (typeof data.duration === 'number' && data.duration > 0) ? data.duration : 0;
      if (!isScrubbing) {
        const scrubber = document.getElementById('timelineScrubber');
        if (scrubber) {
          if (dur > 0 && Math.abs(parseFloat(scrubber.max) - dur) > 0.5) scrubber.max = dur;
          scrubber.value = cur;
        }
        const el = document.getElementById('transportVideoTime');
        if (el) el.textContent = `${formatTime(cur)} / ${dur > 0 ? formatTime(dur) : '--'}`;
      }
    }
    if (typeof data.videoPaused === 'boolean') {
      const btn = document.getElementById('btnPlayPause');
      if (btn) btn.textContent = data.videoPaused ? '▶ Play' : '⏸ Freeze';
    }
  } catch (e) {}

  // 4. Overlays, Calibration, Optics
  try {
    if (typeof data.selectedEye === 'number') {
      diagEye = data.selectedEye;
      const btn = document.getElementById('btnDiagEye');
      if (btn) btn.textContent = `👁 Eye: ${diagEye === 0 ? 'Left' : 'Right'}`;
    }
    if (data.diagOverlay) {
      ['showGrid', 'showPlumbLines', 'showHorizon'].forEach(k => {
        if (typeof data.diagOverlay[k] === 'boolean') {
          diagOverlays[k] = data.diagOverlay[k];
          const btnMap = { showGrid: 'btnDiagGrid', showPlumbLines: 'btnDiagPlumb', showHorizon: 'btnDiagHorizon' };
          const btn = document.getElementById(btnMap[k]);
          if (btn) btn.classList.toggle('active', diagOverlays[k]);
        }
      });
    }
    if (typeof data.savedMyViewerProfileExists === 'boolean') {
      latestSavedMyProfile = data.savedMyViewerProfile || null;
    }
    if (typeof data.showReferenceGrid === 'boolean') {
      const chk = document.getElementById('chkReferenceGrid');
      if (chk) chk.checked = data.showReferenceGrid;
    }
    if (isPhoneActive()) {
      if (pendingAck) {
        if (Date.now() - pendingAck.requestedAt > 3000) pendingAck = null;
        else if (pendingAck.type === 'stage' && data.calibrationStage === pendingAck.target) pendingAck = null;
        else if (pendingAck.type === 'visual_mode' && data.viewerVisualMode === pendingAck.target) pendingAck = null;
        else if (pendingAck.type === 'fitting' && data.opticsRuntime?.calibrationDistortionOverrideActive === pendingAck.target) pendingAck = null;
      }
      if (!pendingAck || pendingAck.type !== 'visual_mode') {
        if (data.viewerVisualMode && data.viewerVisualMode !== currentVisualMode) {
          currentVisualMode = data.viewerVisualMode;
          if (currentVisualMode !== 'grid_only' && o4FittingActive) setO4FittingActive(false);
          const vmMap = { grid_only: 'btnVisualGridOnly', ild_fusion: 'btnVisualIldFusion', vertical_alignment: 'btnVisualVerticalAlign', video_grid: 'btnVisualVideoGrid' };
          Object.entries(vmMap).forEach(([m, id]) => document.getElementById(id)?.classList.toggle('active', m === currentVisualMode));
        }
      }
      if (!pendingAck || pendingAck.type !== 'stage') {
        if (data.calibrationStage && data.calibrationStage !== currentStage) {
          currentStage = data.calibrationStage;
          if (currentStage !== 'B' && o4FittingActive) setO4FittingActive(false);
          ['A', 'B', 'C'].forEach(s => document.getElementById('btnStage' + s)?.classList.toggle('active', s === currentStage));
          applyStageLocks(currentStage);
        }
      }
      const remoteFittingActive = !!(data.opticsRuntime?.calibrationDistortionOverrideActive);
      if (!pendingAck || pendingAck.type !== 'fitting') {
        if (remoteFittingActive !== o4FittingActive) {
          o4FittingActive = remoteFittingActive;
          const b = document.getElementById('btnToggleO4Fitting'), ban = document.getElementById('bannerO4FittingActive');
          if (b) {
            b.textContent = o4FittingActive ? '🔬 O4 Distortion Fitting: ACTIVE' : '⚪ O4 Distortion Fitting: OFF';
            b.style.background = o4FittingActive ? '#7e22ce' : '#334155';
            b.style.color = o4FittingActive ? '#f3e8ff' : '#cbd5e1';
            b.style.borderColor = o4FittingActive ? '#a855f7' : '#475569';
          }
          if (ban) ban.style.display = o4FittingActive ? 'block' : 'none';
          applyStageLocks(currentStage);
        }
      }
    }
    if (data.videoProfile) {
      const vp = data.videoProfile;
      const vstat = document.getElementById('txtVideoMappingStatus');
      if (vstat) {
        const isConfirmed = (vp.confidence === 'user-confirmed' || vp.confidence === 'user-calibrated') &&
            vp.projection !== 'unknown' && vp.stereoMode !== 'unknown' && vp.eyeOrder !== 'unknown';
        vstat.textContent = isConfirmed ? `✓ Confirmed Video Mapping (${vp.projection} / ${vp.stereoMode} / ${vp.eyeOrder})` : `⚠️ Unconfirmed Video Mapping (${vp.projection || 'unknown'})`;
        vstat.style.color = isConfirmed ? '#34d399' : '#f87171';
      }
      const setSel = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
      setSel('selProjection', vp.projection || 'unknown'); setSel('selStereo', vp.stereoMode || 'unknown'); setSel('selEyeOrder', vp.eyeOrder || 'unknown');
      const selCov = document.getElementById('selCoverageFov');
      if (selCov) {
        const isFlat = !vp.projection || vp.projection === 'unknown' || vp.projection === 'flat';
        selCov.disabled = isFlat;
        selCov.value = isFlat ? 'unknown' : (((typeof vp.horizontalCoverageDeg === 'number' ? vp.horizontalCoverageDeg : 180) > 270) ? '360' : '180');
      }
      if (vp.pose) {
        const y = vp.pose.yawDeg || 0, p = vp.pose.pitchDeg || 0, r = vp.pose.rollDeg || 0;
        const setPose = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        setPose('rngPoseYaw', y); setPose('rngPosePitch', p); setPose('rngPoseRoll', r);
        setEl('valPoseYaw', y.toFixed(1) + '°'); setEl('valPosePitch', p.toFixed(1) + '°'); setEl('valPoseRoll', r.toFixed(1) + '°');
      }
    }
    if (data.fps) setEl('valFps', data.fps + ' FPS');
    if (data.mediaName) setEl('valMediaName', data.mediaName);
    if (data.mediaStatus) setEl('valMediaStatus', data.mediaStatus);
    if (data.devStatus) setEl('valDevStatus', data.devStatus);

    const vp = data.viewerProfile;
    if (vp) {
      lensEnabled = vp.lensCorrectionEnabled === true;
      const btn = document.getElementById('btnLensToggle');
      if (btn) {
        btn.textContent = lensEnabled ? '🛡️ LENS CORRECTION: ON' : '⚪ LENS CORRECTION: OFF';
        btn.className = 'action-btn ' + (lensEnabled ? 'btn-lens-on' : 'btn-lens-off');
      }
      populateSlidersFromProfile(vp);
      const statEl = document.getElementById('txtProfileStatus');
      if (statEl) {
        if (vp.confidence === 'working-user-tuned' || vp.viewerProfileId === 'viewer:my_profile') {
          statEl.textContent = '⚙️ ' + (vp.name || 'My Viewer Profile') + ' [Unvalidated / User-tuned — Not Ground Truth]';
          statEl.style.color = '#38bdf8';
        } else if (vp.viewerProfileId === 'g04:provisional_geometry') {
          statEl.textContent = '🔬 ' + (vp.name || 'G04 Provisional Geometry') + ' [Provisional Assembly — Not Ground Truth]';
          statEl.style.color = '#a855f7';
        } else if (vp.confidence === 'historical-reference' || vp.viewerProfileId === 'cardboard:reference_50deg') {
          statEl.textContent = '✓ ' + (vp.name || 'Cardboard Reference') + ' [Reference Optics — Not Ground Truth]';
          statEl.style.color = '#34d399';
        } else {
          statEl.textContent = '⚠️ UNCALIBRATED BASELINE (Draft edits not validated)';
          statEl.style.color = '#f87171';
        }
      }
      if (data.opticsRuntime && data.opticsRuntime.evidenceMarkers) {
        const em = data.opticsRuntime.evidenceMarkers;
        setEl('txtMarkerSepPx', em.markerSeparationPx ? `${em.markerSeparationPx.toFixed(2)} px` : '--');
        setEl('txtMarkerSepMm', em.markerSeparationMm ? `${em.markerSeparationMm.toFixed(2)} mm` : '--');
        setEl('txtEnteredIld', em.enteredILDmm ? `${em.enteredILDmm.toFixed(2)} mm` : '--');
        setEl('txtLeftNormX', em.leftMarkerGlobalX ? em.leftMarkerGlobalX.toFixed(6) : '--');
        setEl('txtRightNormX', em.rightMarkerGlobalX ? em.rightMarkerGlobalX.toFixed(6) : '--');
        const badge = document.getElementById('badgeIldMatch');
        if (badge) { badge.className = em.markerSeparationMatchesILD ? 'badge badge-green' : 'badge badge-amber'; badge.textContent = em.markerSeparationMatchesILD ? 'ILD Match: Verified' : 'ILD Match: Deviation'; }
      }
      if (data.opticsRuntime) {
        const ort = data.opticsRuntime;
        if (typeof ort.candidateK1 === 'number') {
          const txtK1 = document.getElementById('txtO4CandK1'); if (txtK1) txtK1.textContent = ort.candidateK1.toFixed(3);
        }
        if (typeof ort.candidateK2 === 'number') {
          const txtK2 = document.getElementById('txtO4CandK2'); if (txtK2) txtK2.textContent = ort.candidateK2.toFixed(3);
        }
      }
    }
  } catch (e) {}

  // 5. Timings & Controller Inputs
  try {
    const t = data.timings;
    if (t && t.selectedAt) {
      const ms = at => at ? (at - t.selectedAt).toFixed(1) + ' ms' : '--';
      setEl('valMetaAt', ms(t.metadataAt)); setEl('valCanplayAt', ms(t.canplayAt));
      setEl('valDecodeAt', ms(t.firstFrameDecodedAt)); setEl('valUploadAt', ms(t.firstTextureUploadAt));
      setEl('valRenderAt', ms(t.firstRenderAt)); setEl('valTotalLat', t.firstRenderAt ? ms(t.firstRenderAt) : (t.statusText || '--'));
    }
    if (data.controllerInput) {
      const ci = data.controllerInput;
      const statEl = document.getElementById('valControllerStatus');
      const evtEl = document.getElementById('valControllerEvent');
      if (statEl) {
        if (ci.activeGamepads && ci.activeGamepads.length > 0) {
          statEl.textContent = `🎮 Gamepad Active (${ci.activeGamepads[0].id || 'SHINECON'})`;
        } else if (ci.lastKeyDown) {
          statEl.textContent = `⌨️ Keyboard (${ci.lastKeyDown.key || ci.lastKeyDown.code})`;
        } else if (ci.lastPointer) {
          statEl.textContent = `🖱️ Pointer (${ci.lastPointer.pointerType})`;
        } else {
          statEl.textContent = 'Standby (Listening)';
        }
      }
      if (evtEl && ci.lastEvent) {
        evtEl.textContent = `${ci.lastEvent.type}: ${JSON.stringify(ci.lastEvent.data || {})}`;
      }
    }
  } catch (e) {}
}

export function onPerformanceModeChange(mode) { sendControl({ action: 'set_performance_mode', mode }); }
export function onRenderScaleChange(scaleVal) { sendControl({ action: 'set_render_scale', scale: parseFloat(scaleVal) || 1.0 }); }

// Window Globals for inline HTML event handlers
Object.assign(window, {
  setStage, setViewerVisualMode, toggleO4FittingMode, setO4FittingActive,
  onPerformanceModeChange, onRenderScaleChange,
  onSelectMedia, sendSeek, toggleDiagnosticEye, toggleDiagnosticOverlay,
  onPoseChange, resetPose, onVideoMappingChange,
  saveVideoMapping, toggleReferenceGrid, toggleLensCorrection,
  onOpticsChange, sendAction, sendSeekTo
});

// Start background polling, SSE, and UI initializers
initEventSource();
loadVideoList();
initTimelineScrubber(sendControl);
initMediaRootController();
applyStageLocks('A');

setInterval(async () => {
  try {
    const res = await fetch('/api/telemetry');
    if (res.ok) {
      setServerConnectionBadge(true);
      const data = await res.json();
      if (data && data.iphoneStatus) {
        currentIphoneStatus = data.iphoneStatus;
        setIphoneConnectionBadge(data.iphoneStatus);
      }
      if (data && data.latestTelemetry && data.latestTelemetry.type === 'telemetry_sync') {
        updateTelemetryUI(data.latestTelemetry);
      }
    } else {
      setServerConnectionBadge(false);
    }
  } catch (e) {
    if (!isServerOnline) {
      setServerConnectionBadge(false);
      setIphoneConnectionBadge({ state: 'offline' });
    }
  }
}, 500);
