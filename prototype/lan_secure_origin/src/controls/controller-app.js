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
    es.onopen = () => { setConnectedBadge('🟢 SSE Connected'); };
    es.onerror = () => {};
    es.onmessage = (e) => {
      setConnectedBadge('🟢 SSE Connected');
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'telemetry_sync') updateTelemetryUI(msg);
      } catch(err) {}
    };
  } catch (e) {}
}

export async function loadVideoList() {
  try {
    const res = await fetch('/api/videos');
    const list = await res.json();
    if (Array.isArray(list)) {
      videoList = list;
      renderVideoSelect();
    }
  } catch (e) {}
}

export function renderVideoSelect() {
  const sel = document.getElementById('selMediaList');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = videoList.map(v => {
    const sizeStr = v.sizeGB ? `[${v.sizeGB} GB] ` : '';
    return `<option value="${v.relPath}">${sizeStr}${v.name || v.relPath}</option>`;
  }).join('');
  if (cur) sel.value = cur;
}

export async function sendControl(payload) {
  await fetch('/api/calibration/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

export function onSelectMedia(relPath) {
  if (!relPath) return;
  sendControl({ action: 'select_media', relPath: relPath });
}

export function sendSeek(sec) {
  sendControl({ action: 'seek', seconds: sec });
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
    document.getElementById('rngK1').value = p.distortion.k1;
    document.getElementById('valK1').textContent = p.distortion.k1.toFixed(3);
  }
  if (p.distortion && typeof p.distortion.k2 === 'number') {
    document.getElementById('rngK2').value = p.distortion.k2;
    document.getElementById('valK2').textContent = p.distortion.k2.toFixed(3);
  }
  if (p.screenToLensDistance) {
    const mm = p.screenToLensDistance * 1000;
    document.getElementById('rngScreenToLens').value = mm;
    document.getElementById('valScreenToLens').textContent = mm.toFixed(1);
  }
  if (p.interLensDistance) {
    const mm = p.interLensDistance * 1000;
    document.getElementById('rngInterLens').value = mm;
    document.getElementById('valInterLens').textContent = mm.toFixed(1);
  }
  if (p.trayToLensDistance) {
    const mm = p.trayToLensDistance * 1000;
    document.getElementById('rngTrayToLens').value = mm;
    document.getElementById('valTrayToLens').textContent = mm.toFixed(1);
  }
  if (p.maxFovAngles && p.maxFovAngles.outerDeg) {
    document.getElementById('rngFov').value = p.maxFovAngles.outerDeg;
    document.getElementById('valFov').textContent = p.maxFovAngles.outerDeg.toFixed(1) + '°';
  }
}

export function onViewerPresetSelect(presetId) {
  if (currentStage !== 'B') return;
  if (presetId === 'viewer:my_profile') {
    if (latestSavedMyProfile) {
      populateSlidersFromProfile(latestSavedMyProfile);
      sendControl({ action: 'set_viewer_preset', presetId: presetId });
    } else {
      alert('⚠️ My Viewer Profile has not been saved yet.\nPlease tune sliders and click Save My Viewer Profile.');
    }
  } else if (presetId === 'subjective:working_candidate') {
    document.getElementById('rngK1').value = 0.145;
    document.getElementById('valK1').textContent = '0.145';
    document.getElementById('rngK2').value = 0.005;
    document.getElementById('valK2').textContent = '0.005';
    document.getElementById('rngFov').value = 65.0;
    document.getElementById('valFov').textContent = '65.0°';
    document.getElementById('rngScreenToLens').value = 42.6;
    document.getElementById('valScreenToLens').textContent = '42.6';
    document.getElementById('rngInterLens').value = 55.0;
    document.getElementById('valInterLens').textContent = '55.0';
    document.getElementById('rngTrayToLens').value = 35.0;
    document.getElementById('valTrayToLens').textContent = '35.0';
    sendControl({
      action: 'set_viewer_params',
      k1: 0.145, k2: 0.005, maxFovDeg: 65, screenToLensMm: 42.6, interLensMm: 55.0, trayToLensMm: 35.0
    });
  } else if (presetId === 'cardboard:reference_50deg') {
    document.getElementById('rngK1').value = 0.336;
    document.getElementById('valK1').textContent = '0.336';
    document.getElementById('rngK2').value = 0.553;
    document.getElementById('valK2').textContent = '0.553';
    document.getElementById('rngFov').value = 50.0;
    document.getElementById('valFov').textContent = '50.0°';
    document.getElementById('rngScreenToLens').value = 39.3;
    document.getElementById('valScreenToLens').textContent = '39.3';
    document.getElementById('rngInterLens').value = 63.9;
    document.getElementById('valInterLens').textContent = '63.9';
    document.getElementById('rngTrayToLens').value = 35.0;
    document.getElementById('valTrayToLens').textContent = '35.0';
    sendControl({ action: 'set_viewer_preset', presetId: presetId });
  }
}

export function onVideoMappingChange() {
  const proj = document.getElementById('selProjection').value;
  const stereo = document.getElementById('selStereo').value;
  const fov = parseFloat(document.getElementById('selCoverageFov').value);
  const eye = document.getElementById('selEyeOrder').value;
  sendControl({
    action: 'set_video_mapping',
    mapping: {
      projection: proj,
      stereoMode: stereo,
      horizontalCoverageDeg: fov,
      fovHorizontalDeg: fov,
      eyeOrder: eye
    }
  });
}

export function saveVideoMapping() {
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
  if (typeof data.isArmed === 'boolean') {
    isArmed = data.isArmed;
    const b = document.getElementById('badgeArmStatus');
    if (b) {
      b.className = isArmed ? 'badge badge-green' : 'badge badge-amber';
      b.textContent = isArmed ? '🟢 iPhone Armed (VR Ready)' : '🟡 Tap "Arm & Enter VR" on iPhone';
    }
  }

  if (data.mediaList && Array.isArray(data.mediaList) && data.mediaList.length > 0 && videoList.length === 0) {
    videoList = data.mediaList;
    renderVideoSelect();
  }

  if (data.mediaPath) {
    const sel = document.getElementById('selMediaList');
    if (sel && sel.value !== data.mediaPath) sel.value = data.mediaPath;
  }

  if (typeof data.currentTime === 'number') {
    const cur = data.currentTime.toFixed(2);
    const dur = data.duration ? data.duration.toFixed(2) : '--';
    const el = document.getElementById('txtVideoTime');
    if (el) el.textContent = `${cur}s / ${dur}s`;
  }

  if (typeof data.videoPaused === 'boolean') {
    const btn = document.getElementById('btnPlayPause');
    if (btn) btn.textContent = data.videoPaused ? '▶ Play' : '⏸ Freeze';
  }

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
      opt.textContent = data.savedMyViewerProfileExists
        ? 'My Viewer Profile (Saved Working Profile)'
        : 'My Viewer Profile (Not saved yet)';
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
      if (vp.confidence === 'user-confirmed' || vp.confidence === 'user-calibrated') {
        vstat.textContent = `✓ Confirmed Video Mapping (${vp.projection} / ${vp.stereoMode})`;
        vstat.style.color = '#34d399';
      } else {
        vstat.textContent = `⚠️ Unconfirmed Video Mapping (${vp.projection || 'unverified'})`;
        vstat.style.color = '#f87171';
      }
    }
    const selProj = document.getElementById('selProjection');
    if (selProj && vp.projection && vp.projection !== 'unknown') {
      selProj.value = (vp.projection === 'flat') ? 'flat' : 'equirectangular';
    }
    const selStereo = document.getElementById('selStereo');
    if (selStereo && vp.stereoMode && vp.stereoMode !== 'unknown') {
      selStereo.value = vp.stereoMode;
    }
    const selEye = document.getElementById('selEyeOrder');
    if (selEye && vp.eyeOrder && vp.eyeOrder !== 'unknown') {
      selEye.value = (vp.eyeOrder === 'right-left') ? 'right-left' : 'left-right';
    }
    const selCov = document.getElementById('selCoverageFov');
    if (selCov) {
      const hCov = vp.horizontalCoverageDeg || vp.fovHorizontalDeg || 180;
      selCov.value = (hCov > 270) ? '360' : '180';
    }
  }

  if (data.fps) document.getElementById('valFps').textContent = data.fps + ' FPS';
  if (data.mediaName) document.getElementById('valMediaName').textContent = data.mediaName;
  if (data.mediaStatus) document.getElementById('valMediaStatus').textContent = data.mediaStatus;
  if (data.devStatus) document.getElementById('valDevStatus').textContent = data.devStatus;

  const vp = data.viewerProfile;
  if (vp) {
    lensEnabled = vp.lensCorrectionEnabled === true;
    const btn = document.getElementById('btnLensToggle');
    if (btn) {
      btn.textContent = lensEnabled ? '🛡️ LENS CORRECTION: ON' : '⚪ LENS CORRECTION: OFF';
      btn.className = 'action-btn ' + (lensEnabled ? 'btn-lens-on' : 'btn-lens-off');
    }

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

  const t = data.timings;
  if (t && t.selectedAt) {
    document.getElementById('valMetaAt').textContent = t.metadataAt ? (t.metadataAt - t.selectedAt).toFixed(1) + ' ms' : '--';
    document.getElementById('valCanplayAt').textContent = t.canplayAt ? (t.canplayAt - t.selectedAt).toFixed(1) + ' ms' : '--';
    document.getElementById('valDecodeAt').textContent = t.firstFrameDecodedAt ? (t.firstFrameDecodedAt - t.selectedAt).toFixed(1) + ' ms' : '--';
    document.getElementById('valUploadAt').textContent = t.firstTextureUploadAt ? (t.firstTextureUploadAt - t.selectedAt).toFixed(1) + ' ms' : '--';
    document.getElementById('valRenderAt').textContent = t.firstRenderAt ? (t.firstRenderAt - t.selectedAt).toFixed(1) + ' ms' : '--';
    document.getElementById('valTotalLat').textContent = t.firstRenderAt ? (t.firstRenderAt - t.selectedAt).toFixed(1) + ' ms' : (t.statusText || '--');
  }
}

// Window Globals for inline HTML event handlers
window.setStage = setStage;
window.setViewerVisualMode = setViewerVisualMode;
window.onSelectMedia = onSelectMedia;
window.sendSeek = sendSeek;
window.toggleDiagnosticEye = toggleDiagnosticEye;
window.toggleDiagnosticOverlay = toggleDiagnosticOverlay;
window.onPoseChange = onPoseChange;
window.resetPose = resetPose;
window.onViewerPresetSelect = onViewerPresetSelect;
window.onVideoMappingChange = onVideoMappingChange;
window.saveVideoMapping = saveVideoMapping;
window.saveMyViewerProfile = saveMyViewerProfile;
window.toggleReferenceGrid = toggleReferenceGrid;
window.toggleLensCorrection = toggleLensCorrection;
window.onOpticsChange = onOpticsChange;
window.sendAction = sendAction;

// Start background polling and SSE
initEventSource();
loadVideoList();
applyStageLocks('A');

setInterval(async () => {
  try {
    const res = await fetch('/api/telemetry');
    const data = await res.json();
    setConnectedBadge('🟢 Live Connected');
    if (data && data.latestTelemetry && data.latestTelemetry.type === 'telemetry_sync') {
      updateTelemetryUI(data.latestTelemetry);
    }
  } catch (e) {
    const badge = document.getElementById('badgeConnection');
    if (badge) {
      badge.className = 'badge badge-amber';
      badge.textContent = '🟡 Reconnecting...';
    }
  }
}, 500);
