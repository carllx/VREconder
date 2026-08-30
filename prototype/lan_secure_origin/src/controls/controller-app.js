// ==========================================
// PC Calibration Controller Application
// Single Source of Truth (SSOT) Control Surface
// ==========================================

export let currentStage = 'A';
export let currentVisualMode = 'grid_only';
export let lensEnabled = false;
export let isArmed = false;
export let diagEye = 0;
export let diagOverlays = { showGrid: true, showPlumbLines: true, showHorizon: true };
export let latestSavedMyProfile = null;
export let videoList = [];

let isOnline = false;

export function setConnectedBadge(text = '🟢 Connected') {
  const badge = document.getElementById('badgeConnection');
  if (badge) {
    badge.className = 'badge badge-green';
    badge.textContent = text;
  }
}

export function initEventSource() {
  try {
    const es = new EventSource('/api/calibration/events');
    es.onopen = () => { isOnline = true; setConnectedBadge('🟢 Connected (SSE)'); };
    es.onerror = () => {};
    es.onmessage = (e) => {
      isOnline = true;
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

export function sendSeek(sec) {
  sendControl({ action: 'seek', seconds: sec });
}

export function sendSeekTo(sec) {
  sendControl({ action: 'seek_to', seconds: Math.max(0, sec) });
}

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
  document.getElementById('rngPoseYaw').value = 0;
  document.getElementById('rngPosePitch').value = 0;
  document.getElementById('rngPoseRoll').value = 0;
  onPoseChange();
}

export function setStage(stage) {
  currentStage = stage;
  ['A', 'B', 'C'].forEach(s => {
    document.getElementById('btnStage' + s)?.classList.toggle('active', s === stage);
  });
  applyStageLocks(stage);
  sendControl({ action: 'set_stage', stage: stage });
}

export function setViewerVisualMode(mode) {
  currentVisualMode = mode;
  document.getElementById('btnVisualGridOnly')?.classList.toggle('active', mode === 'grid_only');
  document.getElementById('btnVisualVideoGrid')?.classList.toggle('active', mode === 'video_grid');
  sendControl({ action: 'set_viewer_visual_mode', mode: mode });
}

export function applyStageLocks(stage) {
  const isStageC = (stage === 'C');
  const isStageA = (stage === 'A');
  const shouldLockCoeffs = isStageC || isStageA;

  const selPreset = document.getElementById('selViewerPreset');
  if (selPreset) selPreset.disabled = shouldLockCoeffs;

  ['rngK1', 'rngK2', 'rngFov', 'rngScreenToLens', 'rngInterLens', 'rngTrayToLens'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = shouldLockCoeffs;
  });

  const btnSaveViewer = document.getElementById('btnSaveViewer');
  if (btnSaveViewer) btnSaveViewer.disabled = isStageC;

  const lockNotice = document.getElementById('lockNotice');
  if (lockNotice) lockNotice.style.display = isStageC ? 'block' : 'none';
  const stageCPanel = document.getElementById('stageCVerificationPanel');
  if (stageCPanel) stageCPanel.style.display = isStageC ? 'block' : 'none';
  const stageBVisual = document.getElementById('stageBVisualRefPanel');
  if (stageBVisual) stageBVisual.style.display = (stage === 'B') ? 'block' : 'none';
}

export function populateSlidersFromProfile(p) {
  if (!p) return;
  if (p.distortion && typeof p.distortion.k1 === 'number') {
    const el = document.getElementById('rngK1'); if (el) el.value = p.distortion.k1;
    const val = document.getElementById('valK1'); if (val) val.textContent = p.distortion.k1.toFixed(3);
  }
  if (p.distortion && typeof p.distortion.k2 === 'number') {
    const el = document.getElementById('rngK2'); if (el) el.value = p.distortion.k2;
    const val = document.getElementById('valK2'); if (val) val.textContent = p.distortion.k2.toFixed(3);
  }
  if (p.screenToLensDistance) {
    const mm = p.screenToLensDistance * 1000;
    const el = document.getElementById('rngScreenToLens'); if (el) el.value = mm;
    const val = document.getElementById('valScreenToLens'); if (val) val.textContent = mm.toFixed(1);
  }
  if (p.interLensDistance) {
    const mm = p.interLensDistance * 1000;
    const el = document.getElementById('rngInterLens'); if (el) el.value = mm;
    const val = document.getElementById('valInterLens'); if (val) val.textContent = mm.toFixed(1);
  }
  if (p.trayToLensDistance) {
    const mm = p.trayToLensDistance * 1000;
    const el = document.getElementById('rngTrayToLens'); if (el) el.value = mm;
    const val = document.getElementById('valTrayToLens'); if (val) val.textContent = mm.toFixed(1);
  }
  if (p.maxFovAngles && p.maxFovAngles.outerDeg) {
    const el = document.getElementById('rngFov'); if (el) el.value = p.maxFovAngles.outerDeg;
    const val = document.getElementById('valFov'); if (val) val.textContent = p.maxFovAngles.outerDeg.toFixed(1) + '°';
  }
}

export function onViewerPresetSelect(presetId) {
  if (currentStage !== 'B') return;
  if (presetId === 'viewer:my_profile') {
    if (!latestSavedMyProfile) {
      alert('⚠️ My Viewer Profile has not been saved yet.\nPlease tune sliders and click Save My Viewer Profile.');
      return;
    }
  }
  sendControl({ action: 'set_viewer_preset', presetId: presetId });
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

export function saveMyViewerProfile() {
  sendControl({ action: 'save_viewer_profile' });
}

export function toggleReferenceGrid(checked) {
  sendControl({ action: 'set_reference_grid', enabled: checked });
}

export function toggleLensCorrection() {
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
  const fov = parseFloat(document.getElementById('rngFov')?.value || 50);
  const s2l = parseFloat(document.getElementById('rngScreenToLens')?.value || 39.3);
  const ipd = parseFloat(document.getElementById('rngInterLens')?.value || 63.9);
  const t2l = parseFloat(document.getElementById('rngTrayToLens')?.value || 35.0);

  document.getElementById('valK1').textContent = k1.toFixed(3);
  document.getElementById('valK2').textContent = k2.toFixed(3);
  document.getElementById('valFov').textContent = fov.toFixed(1) + '°';
  document.getElementById('valScreenToLens').textContent = s2l.toFixed(1);
  document.getElementById('valInterLens').textContent = ipd.toFixed(1);
  document.getElementById('valTrayToLens').textContent = t2l.toFixed(1);

  sendControl({
    action: 'set_viewer_params',
    k1: k1, k2: k2,
    maxFovDeg: fov,
    screenToLensMm: s2l,
    interLensMm: ipd,
    trayToLensMm: t2l
  });
}

export function sendAction(act) { sendControl({ action: act }); }

export function updateTelemetryUI(data) {
  if (!data) return;

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  // 1. Critical Priority: Performance Diagnostics (Always executes first)
  if (data.perf) {
    try {
      const { cadence: cad = {}, frameTimeMs: ft = {}, playback: pb = {}, display: disp = {}, webgl: wg = {} } = data.perf;
      const q = pb.quality || {};

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
      const opt = document.querySelector('#selViewerPreset option[value="viewer:my_profile"]');
      if (opt) {
        opt.textContent = data.savedMyViewerProfileExists ? 'My Viewer Profile (Saved Working Profile)' : 'My Viewer Profile (Not saved yet)';
      }
    }
    if (typeof data.showReferenceGrid === 'boolean') {
      const chk = document.getElementById('chkReferenceGrid');
      if (chk) chk.checked = data.showReferenceGrid;
    }
    if (data.viewerVisualMode && data.viewerVisualMode !== currentVisualMode) {
      currentVisualMode = data.viewerVisualMode;
      document.getElementById('btnVisualGridOnly')?.classList.toggle('active', currentVisualMode === 'grid_only');
      document.getElementById('btnVisualVideoGrid')?.classList.toggle('active', currentVisualMode === 'video_grid');
    }
    if (data.calibrationStage && data.calibrationStage !== currentStage) {
      currentStage = data.calibrationStage;
      ['A', 'B', 'C'].forEach(s => {
        document.getElementById('btnStage' + s)?.classList.toggle('active', s === currentStage);
      });
      applyStageLocks(currentStage);
    }
    if (data.videoProfile) {
      const vp = data.videoProfile;
      const vstat = document.getElementById('txtVideoMappingStatus');
      if (vstat) {
        if ((vp.confidence === 'user-confirmed' || vp.confidence === 'user-calibrated') &&
            vp.projection !== 'unknown' && vp.stereoMode !== 'unknown' && vp.eyeOrder !== 'unknown') {
          vstat.textContent = `✓ Confirmed Video Mapping (${vp.projection} / ${vp.stereoMode} / ${vp.eyeOrder})`;
          vstat.style.color = '#34d399';
        } else {
          vstat.textContent = `⚠️ Unconfirmed Video Mapping (${vp.projection || 'unknown'})`;
          vstat.style.color = '#f87171';
        }
      }
      const selProj = document.getElementById('selProjection'); if (selProj) selProj.value = vp.projection || 'unknown';
      const selStereo = document.getElementById('selStereo'); if (selStereo) selStereo.value = vp.stereoMode || 'unknown';
      const selEye = document.getElementById('selEyeOrder'); if (selEye) selEye.value = vp.eyeOrder || 'unknown';
      const selCov = document.getElementById('selCoverageFov');
      if (selCov) {
        if (!vp.projection || vp.projection === 'unknown' || vp.projection === 'flat') {
          selCov.value = 'unknown'; selCov.disabled = true;
        } else {
          selCov.disabled = false;
          const hCov = (typeof vp.horizontalCoverageDeg === 'number') ? vp.horizontalCoverageDeg : 180;
          selCov.value = (hCov > 270) ? '360' : '180';
        }
      }
      if (vp.pose) {
        const y = (typeof vp.pose.yawDeg === 'number') ? vp.pose.yawDeg : 0;
        const p = (typeof vp.pose.pitchDeg === 'number') ? vp.pose.pitchDeg : 0;
        const r = (typeof vp.pose.rollDeg === 'number') ? vp.pose.rollDeg : 0;
        const rngY = document.getElementById('rngPoseYaw'); if (rngY) rngY.value = y;
        const rngP = document.getElementById('rngPosePitch'); if (rngP) rngP.value = p;
        const rngR = document.getElementById('rngPoseRoll'); if (rngR) rngR.value = r;
        const valY = document.getElementById('valPoseYaw'); if (valY) valY.textContent = y.toFixed(1) + '°';
        const valP = document.getElementById('valPosePitch'); if (valP) valP.textContent = p.toFixed(1) + '°';
        const valR = document.getElementById('valPoseRoll'); if (valR) valR.textContent = r.toFixed(1) + '°';
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
      const selPreset = document.getElementById('selViewerPreset');
      if (selPreset) {
        selPreset.value = (vp.viewerProfileId === 'viewer:my_profile' || vp.confidence === 'working-user-tuned') ? 'viewer:my_profile' : 'cardboard:reference_50deg';
      }
      populateSlidersFromProfile(vp);
      const statEl = document.getElementById('txtProfileStatus');
      if (statEl) {
        if (vp.confidence === 'working-user-tuned' || vp.viewerProfileId === 'viewer:my_profile') {
          statEl.textContent = '⚙️ ' + (vp.name || 'My Viewer Profile') + ' [Unvalidated / User-tuned — Not Ground Truth]';
          statEl.style.color = '#38bdf8';
        } else if (vp.confidence === 'historical-reference' || vp.viewerProfileId === 'cardboard:reference_50deg') {
          statEl.textContent = '✓ ' + (vp.name || 'Cardboard Reference') + ' [Reference Optics — Not Ground Truth]';
          statEl.style.color = '#34d399';
        } else {
          statEl.textContent = '⚠️ UNCALIBRATED BASELINE (Draft edits not validated)';
          statEl.style.color = '#f87171';
        }
      }
    }
  } catch (e) {}

  // 5. Timings & Controller Inputs
  try {
    const t = data.timings;
    if (t && t.selectedAt) {
      setEl('valMetaAt', t.metadataAt ? (t.metadataAt - t.selectedAt).toFixed(1) + ' ms' : '--');
      setEl('valCanplayAt', t.canplayAt ? (t.canplayAt - t.selectedAt).toFixed(1) + ' ms' : '--');
      setEl('valDecodeAt', t.firstFrameDecodedAt ? (t.firstFrameDecodedAt - t.selectedAt).toFixed(1) + ' ms' : '--');
      setEl('valUploadAt', t.firstTextureUploadAt ? (t.firstTextureUploadAt - t.selectedAt).toFixed(1) + ' ms' : '--');
      setEl('valRenderAt', t.firstRenderAt ? (t.firstRenderAt - t.selectedAt).toFixed(1) + ' ms' : '--');
      setEl('valTotalLat', t.firstRenderAt ? (t.firstRenderAt - t.selectedAt).toFixed(1) + ' ms' : (t.statusText || '--'));
    }
    if (data.controllerInput) {
      const ci = data.controllerInput;
      const statEl = document.getElementById('valControllerStatus');
      const evtEl = document.getElementById('valControllerEvent');
      if (statEl) {
        if (ci.gamepadConnected && ci.activeGamepads && ci.activeGamepads.length > 0) {
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
  setStage, setViewerVisualMode, onPerformanceModeChange, onRenderScaleChange,
  onSelectMedia, sendSeek, toggleDiagnosticEye, toggleDiagnosticOverlay,
  onPoseChange, resetPose, onViewerPresetSelect, onVideoMappingChange,
  saveVideoMapping, saveMyViewerProfile, toggleReferenceGrid, toggleLensCorrection,
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
      isOnline = true;
      setConnectedBadge('🟢 Connected');
      const data = await res.json();
      if (data && data.latestTelemetry && data.latestTelemetry.type === 'telemetry_sync') {
        updateTelemetryUI(data.latestTelemetry);
      }
    }
  } catch (e) {
    if (!isOnline) {
      const badge = document.getElementById('badgeConnection');
      if (badge) {
        badge.className = 'badge badge-amber';
        badge.textContent = '🟡 Reconnecting...';
      }
    }
  }
}, 500);
