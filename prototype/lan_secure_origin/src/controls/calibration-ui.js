import { state, showFeedbackToast } from '../core/state.js';
import { createDefaultViewerProfile, deriveCardboardEyeGeometry } from '../core/projection-profile.js';
import { activeScreenProfile } from '../core/screen-profile.js';

function logAction(msg, data = null) {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: 'PHONE_ACTION', message: msg, data, time: new Date().toISOString() })
  }).catch(() => {});
}

export class CalibrationUI {
  constructor(options) {
    this.storage = options.storage;
    this.mediaController = options.mediaController;
    this.diagnosticOverlay = options.diagnosticOverlay;
    this.vrRenderer = options.vrRenderer;
    this.commandModel = options.commandModel;
    this.onProfileChanged = options.onProfileChanged;
    this.onEnterVR = options.onEnterVR;
    this.onExitVR = options.onExitVR;

    this.currentMode = 'diagnostic';
    this.selectedEye = 0;
    this.diagnosticFovDeg = 85;

    this.activeVideoProfile = null;
    this.activeViewerProfile = this.storage.activeViewerProfile;

    this.initDOM();
    this.initSSEBridge();
  }

  initDOM() {
    this.btnStageA = document.getElementById('btnStageA');
    this.btnStageB = document.getElementById('btnStageB');
    this.btnStageC = document.getElementById('btnStageC');

    // Diagnostic Toolbar buttons
    this.btnFreeze = document.getElementById('btnDiagFreeze');
    this.btnSeekBack5 = document.getElementById('btnDiagSeekBack5');
    this.btnSeekBack1 = document.getElementById('btnDiagSeekBack1');
    this.btnSeekFwd1 = document.getElementById('btnDiagSeekFwd1');
    this.btnSeekFwd5 = document.getElementById('btnDiagSeekFwd5');
    this.btnToggleEye = document.getElementById('btnDiagToggleEye');
    this.btnToggleGrid = document.getElementById('btnDiagToggleGrid');
    this.btnTogglePlumb = document.getElementById('btnDiagTogglePlumb');
    this.btnToggleHorizon = document.getElementById('btnDiagToggleHorizon');

    // Stage A Controls
    this.selProjection = document.getElementById('selProjType');
    this.selStereo = document.getElementById('selStereoType');
    this.selEyeOrder = document.getElementById('selEyeOrder');
    this.rangeCoverageH = document.getElementById('rangeCoverageH');
    this.valCoverageH = document.getElementById('valCoverageH');
    this.rangePoseYaw = document.getElementById('rangePoseYaw');
    this.valPoseYaw = document.getElementById('valPoseYaw');
    this.rangePosePitch = document.getElementById('rangePosePitch');
    this.valPosePitch = document.getElementById('valPosePitch');
    this.rangePoseRoll = document.getElementById('rangePoseRoll');
    this.valPoseRoll = document.getElementById('valPoseRoll');
    this.btnResetPose = document.getElementById('btnResetPose');
    this.btnSaveVideoProfile = document.getElementById('btnSaveVideoProfile');
    this.txtMappingStatus = document.getElementById('txtMappingStatus');

    // Stage B Controls
    this.selViewerPreset = document.getElementById('selViewerPreset');
    this.btnToggleLens = document.getElementById('btnToggleLens');
    this.rangeDistortK1 = document.getElementById('rangeDistortK1');
    this.valDistortK1 = document.getElementById('valDistortK1');
    this.rangeDistortK2 = document.getElementById('rangeDistortK2');
    this.valDistortK2 = document.getElementById('valDistortK2');
    this.btnSaveViewerProfile = document.getElementById('btnSaveViewerProfile');
    this.txtViewerSourceInfo = document.getElementById('txtViewerSourceInfo');
    this.txtDerivedFov = document.getElementById('txtDerivedFov');

    // Custom Viewer Manual & JSON Import Controls
    this.customInputsArea = document.getElementById('customViewerInputs');
    this.inputScreenToLens = document.getElementById('inputScreenToLens');
    this.inputInterLens = document.getElementById('inputInterLens');
    this.selVerticalAlign = document.getElementById('selVerticalAlign');
    this.inputTrayToLens = document.getElementById('inputTrayToLens');
    this.inputMaxFov = document.getElementById('inputMaxFov');
    this.inputJsonImport = document.getElementById('inputJsonImport');
    this.btnImportJson = document.getElementById('btnImportJson');
    this.chkStageCReferenceGrid = document.getElementById('chkStageCReferenceGrid');

    this.bindEvents();
  }

  initSSEBridge() {
    try {
      const es = new EventSource('/api/calibration/events');
      es.onopen = () => { state.pcConnected = true; };
      es.onerror = () => { state.pcConnected = false; };
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          this.handleRemoteControlAction(msg);
        } catch (err) {}
      };
    } catch (e) {}
  }

  handleRemoteControlAction(msg) {
    if (!msg || !msg.action) return;
    const act = msg.action;

    if (act === 'set_stage') {
      this.switchStage(msg.stage);
    } else if (act === 'set_viewer_preset' && msg.presetId) {
      if (state.calibrationStage === 'C') return; // Stage C Viewer Profile is fixed/read-only
      const presetId = msg.presetId;
      const currentLensState = this.activeViewerProfile ? this.activeViewerProfile.lensCorrectionEnabled : false;
      this.activeViewerProfile = createDefaultViewerProfile(presetId);
      this.activeViewerProfile.lensCorrectionEnabled = currentLensState;
      this.syncStageBToUI();
      if (this.onProfileChanged) this.onProfileChanged(this.activeVideoProfile, this.activeViewerProfile);
      showFeedbackToast(`Viewer Profile: ${presetId}`);
      logAction('Selected Viewer Preset from PC: ' + presetId);
    } else if (act === 'set_reference_grid') {
      state.showReferenceGrid = (msg.enabled === true);
      if (this.vrRenderer) this.vrRenderer.showReferenceGrid = state.showReferenceGrid;
      if (this.chkReferenceGrid) this.chkReferenceGrid.checked = state.showReferenceGrid;
      showFeedbackToast(state.showReferenceGrid ? '▦ Reference Grid: ON' : '▦ Reference Grid: OFF');
      logAction('Toggled Reference Grid from PC: ' + (state.showReferenceGrid ? 'ON' : 'OFF'));
    } else if (act === 'set_lens_correction') {
      if (this.activeViewerProfile) {
        this.activeViewerProfile.lensCorrectionEnabled = msg.enabled === true;
        // Edits remain draft/unverified until explicit save/validate step
        this.syncStageBToUI();
        if (this.onProfileChanged) this.onProfileChanged(this.activeVideoProfile, this.activeViewerProfile);
        showFeedbackToast(`Lens: ${this.activeViewerProfile.lensCorrectionEnabled ? 'ON' : 'OFF'}`);
      }
    } else if (act === 'set_viewer_params') {
      if (state.calibrationStage === 'C') return; // Stage C Viewer Profile is fixed/read-only
      if (!this.activeViewerProfile) return;
      if (!this.activeViewerProfile.distortion) this.activeViewerProfile.distortion = {};
      if (typeof msg.k1 === 'number') this.activeViewerProfile.distortion.k1 = msg.k1;
      if (typeof msg.k2 === 'number') this.activeViewerProfile.distortion.k2 = msg.k2;
      if (typeof msg.screenToLensMm === 'number') this.activeViewerProfile.screenToLensDistance = msg.screenToLensMm / 1000;
      if (typeof msg.interLensMm === 'number') this.activeViewerProfile.interLensDistance = msg.interLensMm / 1000;
      if (typeof msg.trayToLensMm === 'number') this.activeViewerProfile.trayToLensDistance = msg.trayToLensMm / 1000;
      if (typeof msg.maxFovDeg === 'number') {
        const f = msg.maxFovDeg;
        this.activeViewerProfile.maxFovAngles = { outerDeg: f, innerDeg: f, upperDeg: f, lowerDeg: f };
      }
      // Draft edits do NOT mark profile as calibrated
      this.syncStageBToUI();
      if (this.onProfileChanged) this.onProfileChanged(this.activeVideoProfile, this.activeViewerProfile);
    } else if (act === 'recenter' && this.commandModel) {
      this.commandModel.recenter();
    } else if (act === 'exit_vr' && this.onExitVR) {
      this.switchStage('A');
    } else if (act === 'playPause' && this.commandModel) {
      this.commandModel.playPause();
    } else if (act === 'seekForward' && this.commandModel) {
      this.commandModel.seekForward(5);
    } else if (act === 'seekBackward' && this.commandModel) {
      this.commandModel.seekBackward(5);
    } else if (act === 'next' && this.commandModel) {
      this.commandModel.next();
    } else if (act === 'previous' && this.commandModel) {
      this.commandModel.previous();
    } else if (act === 'save_viewer_profile') {
      if (this.activeViewerProfile) {
        this.activeViewerProfile.isCalibrated = true;
        this.activeViewerProfile.source = 'User Validated / Custom Calibrated';
        this.storage.saveViewerProfile(this.activeViewerProfile);
        this.syncStageBToUI();
        showFeedbackToast('💾 Calibrated Viewer Profile Saved');
      }
    } else if (act === 'save_video_profile' && this.activeVideoProfile) {
      this.activeVideoProfile.confidence = 'user-calibrated';
      this.storage.saveVideoProfile(this.activeVideoProfile);
      this.syncStageAToUI();
      showFeedbackToast('💾 Calibrated Video Profile Saved');
    }
  }

  switchStage(stage) {
    state.calibrationStage = stage;
    if (this.btnStageA) this.btnStageA.classList.toggle('active', stage === 'A');
    if (this.btnStageB) this.btnStageB.classList.toggle('active', stage === 'B');
    if (this.btnStageC) this.btnStageC.classList.toggle('active', stage === 'C');

    if (stage === 'A') {
      // Stage A: Flat Diagnostic View (No Optics, Real Video)
      if (this.onExitVR) this.onExitVR();
      if (this.vrRenderer) {
        this.vrRenderer.sceneType = 0;
        this.vrRenderer.showReferenceGrid = false;
      }
      this.currentMode = 'diagnostic';
      showFeedbackToast('Stage A: Flat Diagnostic');
    } else if (stage === 'B') {
      // Stage B: Viewer Optics (Synthetic Grid Only, Headset Stereo)
      if (this.vrRenderer) {
        this.vrRenderer.sceneType = 1;
        this.vrRenderer.showReferenceGrid = false;
      }
      this.currentMode = 'vr';
      if (this.onEnterVR) this.onEnterVR();
      showFeedbackToast('Stage B: Synthetic Grid');
    } else if (stage === 'C') {
      // Stage C: Real Video Verification (Headset Stereo, Fixed Optics, Optional Grid)
      if (this.vrRenderer) {
        this.vrRenderer.sceneType = 0;
        this.vrRenderer.showReferenceGrid = state.showReferenceGrid;
      }
      this.currentMode = 'vr';
      if (this.onEnterVR) this.onEnterVR();
      showFeedbackToast('Stage C: Video Verification');
    }
  }

  setVideoProfile(profile) {
    this.activeVideoProfile = profile;
    this.syncStageAToUI();
  }

  syncStageAToUI() {
    const vp = this.activeVideoProfile;
    if (!vp) return;

    if (this.selProjection) this.selProjection.value = vp.projection || 'unknown';
    if (this.selStereo) this.selStereo.value = vp.stereoMode || 'unknown';
    if (this.selEyeOrder) this.selEyeOrder.value = vp.eyeOrder || 'left-right';

    const covH = vp.fovHorizontalDeg || 180;
    if (this.rangeCoverageH) this.rangeCoverageH.value = covH;
    if (this.valCoverageH) this.valCoverageH.textContent = covH + '°';

    const pose = vp.pose || { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
    if (this.rangePoseYaw) this.rangePoseYaw.value = pose.yawDeg || 0;
    if (this.valPoseYaw) this.valPoseYaw.textContent = (pose.yawDeg || 0) + '°';

    if (this.rangePosePitch) this.rangePosePitch.value = pose.pitchDeg || 0;
    if (this.valPosePitch) this.valPosePitch.textContent = (pose.pitchDeg || 0) + '°';

    if (this.rangePoseRoll) this.rangePoseRoll.value = pose.rollDeg || 0;
    if (this.valPoseRoll) this.valPoseRoll.textContent = (pose.rollDeg || 0) + '°';

    if (this.txtMappingStatus) {
      if (vp.confidence === 'unverified' || vp.projection === 'unknown') {
        this.txtMappingStatus.textContent = '⚠️ UNVERIFIED PREVIEW (Equirect-180 Candidate)';
        this.txtMappingStatus.style.color = '#f87171';
      } else {
        this.txtMappingStatus.textContent = `✓ Calibrated: ${vp.projection} (${vp.stereoMode})`;
        this.txtMappingStatus.style.color = '#34d399';
      }
    }
  }

  syncStageBToUI() {
    const hp = this.activeViewerProfile;
    if (!hp) return;

    if (this.selViewerPreset) this.selViewerPreset.value = hp.viewerProfileId || 'unknown:uncalibrated';
    this.updateLensBtnState();

    const dist = hp.distortion || { k1: 0.0, k2: 0.0 };
    if (this.rangeDistortK1) this.rangeDistortK1.value = dist.k1 || 0;
    if (this.valDistortK1) this.valDistortK1.textContent = (dist.k1 || 0).toFixed(4);

    if (this.rangeDistortK2) this.rangeDistortK2.value = dist.k2 || 0;
    if (this.valDistortK2) this.valDistortK2.textContent = (dist.k2 || 0).toFixed(4);

    if (this.txtViewerSourceInfo) {
      this.txtViewerSourceInfo.textContent = hp.source || 'Device Specification';
    }

    if (this.customInputsArea) {
      this.customInputsArea.style.display = (hp.viewerProfileId === 'custom:calibrated') ? 'block' : 'none';
      if (this.inputScreenToLens) this.inputScreenToLens.value = ((hp.screenToLensDistance || 0.04) * 1000).toFixed(1);
      if (this.inputInterLens) this.inputInterLens.value = ((hp.interLensDistance || 0.064) * 1000).toFixed(1);
      if (this.selVerticalAlign) this.selVerticalAlign.value = hp.verticalAlignment || 'BOTTOM';
      if (this.inputTrayToLens) this.inputTrayToLens.value = ((hp.trayToLensDistance || 0.035) * 1000).toFixed(1);
      if (this.inputMaxFov) this.inputMaxFov.value = (hp.maxFovAngles ? hp.maxFovAngles.outerDeg : 50) || 50;
    }

    if (this.txtDerivedFov) {
      const geom = deriveCardboardEyeGeometry(activeScreenProfile, hp);
      const l = geom.leftEye;
      const statusStr = hp.isCalibrated ? '<span style="color:#34d399;">✓ [CALIBRATED PROFILE]</span>' : '<span style="color:#f87171;">⚠️ [UNCALIBRATED BASELINE (Draft)]</span>';
      this.txtDerivedFov.innerHTML = `
        ${statusStr}<br>
        <b>Left Eye Virt FOV:</b> L:${l.fovDeg.left.toFixed(1)}° R:${l.fovDeg.right.toFixed(1)}° U:${l.fovDeg.top.toFixed(1)}° D:${l.fovDeg.bottom.toFixed(1)}°<br>
        <b>Phys Tan:</b> [${l.physTanBounds[0].toFixed(3)}, ${l.physTanBounds[1].toFixed(3)}, ${l.physTanBounds[2].toFixed(3)}, ${l.physTanBounds[3].toFixed(3)}]<br>
        <b>Virt Tan:</b> [${l.virtTanBounds[0].toFixed(3)}, ${l.virtTanBounds[1].toFixed(3)}, ${l.virtTanBounds[2].toFixed(3)}, ${l.virtTanBounds[3].toFixed(3)}]<br>
        <b>Physical Tan Scale:</b> [${geom.physicalTanScale[0].toFixed(3)}, ${geom.physicalTanScale[1].toFixed(3)}]<br>
        <span style="opacity:0.75;">Screen: ${activeScreenProfile.deviceModel}</span>
      `;
    }
  }

  updateLensBtnState() {
    const isEnabled = (this.activeViewerProfile && this.activeViewerProfile.lensCorrectionEnabled === true);
    if (this.btnToggleLens) {
      this.btnToggleLens.textContent = isEnabled ? '🛡️ LENS CORRECTION: ON (Pre-Warp Active)' : '⚪ LENS CORRECTION: OFF (Ideal Undistorted)';
      this.btnToggleLens.style.background = isEnabled ? '#059669' : '#475569';
    }
  }

  bindEvents() {
    if (this.btnStageA) this.btnStageA.addEventListener('click', () => this.switchStage('A'));
    if (this.btnStageB) this.btnStageB.addEventListener('click', () => this.switchStage('B'));
    if (this.btnStageC) this.btnStageC.addEventListener('click', () => this.switchStage('C'));

    if (this.btnFreeze) {
      this.btnFreeze.addEventListener('click', () => {
        const v = this.mediaController.video;
        if (v.paused) { v.play(); this.btnFreeze.textContent = '⏸ Freeze'; }
        else { v.pause(); this.btnFreeze.textContent = '▶ Play'; }
      });
    }

    const seekBy = (sec) => {
      const v = this.mediaController.video;
      v.currentTime = Math.max(0, Math.min(v.duration || 9999, v.currentTime + sec));
      showFeedbackToast(`Seek: ${v.currentTime.toFixed(1)}s`);
    };

    if (this.btnSeekBack5) this.btnSeekBack5.addEventListener('click', () => seekBy(-5));
    if (this.btnSeekBack1) this.btnSeekBack1.addEventListener('click', () => seekBy(-1));
    if (this.btnSeekFwd1) this.btnSeekFwd1.addEventListener('click', () => seekBy(1));
    if (this.btnSeekFwd5) this.btnSeekFwd5.addEventListener('click', () => seekBy(5));

    if (this.btnToggleEye) {
      this.btnToggleEye.addEventListener('click', () => {
        this.selectedEye = (this.selectedEye === 0) ? 1 : 0;
        this.btnToggleEye.textContent = `👁 Eye: ${this.selectedEye === 0 ? 'Left' : 'Right'}`;
      });
    }

    if (this.btnToggleGrid) {
      this.btnToggleGrid.addEventListener('click', () => {
        this.diagnosticOverlay.showGrid = !this.diagnosticOverlay.showGrid;
        this.btnToggleGrid.classList.toggle('active', this.diagnosticOverlay.showGrid);
      });
    }

    if (this.btnTogglePlumb) {
      this.btnTogglePlumb.addEventListener('click', () => {
        this.diagnosticOverlay.showPlumbLines = !this.diagnosticOverlay.showPlumbLines;
        this.btnTogglePlumb.classList.toggle('active', this.diagnosticOverlay.showPlumbLines);
      });
    }

    if (this.btnToggleHorizon) {
      this.btnToggleHorizon.addEventListener('click', () => {
        this.diagnosticOverlay.showHorizon = !this.diagnosticOverlay.showHorizon;
        this.btnToggleHorizon.classList.toggle('active', this.diagnosticOverlay.showHorizon);
      });
    }

    if (this.chkStageCReferenceGrid) {
      this.chkStageCReferenceGrid.addEventListener('change', (e) => {
        state.showReferenceGrid = e.target.checked;
        if (this.vrRenderer) this.vrRenderer.showReferenceGrid = state.showReferenceGrid;
        showFeedbackToast(state.showReferenceGrid ? '▦ Reference Grid: ON' : '▦ Reference Grid: OFF');
        logAction('Toggled Reference Grid: ' + (state.showReferenceGrid ? 'ON' : 'OFF'));
      });
    }

    const notifyChange = () => {
      if (this.onProfileChanged) this.onProfileChanged(this.activeVideoProfile, this.activeViewerProfile);
    };

    if (this.selProjection) {
      this.selProjection.addEventListener('change', (e) => {
        if (this.activeVideoProfile) {
          this.activeVideoProfile.projection = e.target.value;
          if (this.activeVideoProfile.stereoMode === 'unknown') {
            this.activeVideoProfile.stereoMode = 'left-right';
            if (this.selStereo) this.selStereo.value = 'left-right';
          }
        }
        this.syncStageAToUI();
        notifyChange();
      });
    }

    if (this.selStereo) {
      this.selStereo.addEventListener('change', (e) => {
        if (this.activeVideoProfile) this.activeVideoProfile.stereoMode = e.target.value;
        this.syncStageAToUI();
        notifyChange();
      });
    }

    if (this.selEyeOrder) {
      this.selEyeOrder.addEventListener('change', (e) => {
        if (this.activeVideoProfile) this.activeVideoProfile.eyeOrder = e.target.value;
        notifyChange();
      });
    }

    if (this.rangeCoverageH) {
      this.rangeCoverageH.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (this.activeVideoProfile) this.activeVideoProfile.fovHorizontalDeg = val;
        if (this.valCoverageH) this.valCoverageH.textContent = val + '°';
        notifyChange();
      });
    }

    const updatePose = () => {
      if (!this.activeVideoProfile) return;
      if (!this.activeVideoProfile.pose) this.activeVideoProfile.pose = {};
      this.activeVideoProfile.pose.yawDeg = parseFloat(this.rangePoseYaw ? this.rangePoseYaw.value : 0);
      this.activeVideoProfile.pose.pitchDeg = parseFloat(this.rangePosePitch ? this.rangePosePitch.value : 0);
      this.activeVideoProfile.pose.rollDeg = parseFloat(this.rangePoseRoll ? this.rangePoseRoll.value : 0);
      if (this.valPoseYaw) this.valPoseYaw.textContent = this.activeVideoProfile.pose.yawDeg + '°';
      if (this.valPosePitch) this.valPosePitch.textContent = this.activeVideoProfile.pose.pitchDeg + '°';
      if (this.valPoseRoll) this.valPoseRoll.textContent = this.activeVideoProfile.pose.rollDeg + '°';
      notifyChange();
    };

    if (this.rangePoseYaw) this.rangePoseYaw.addEventListener('input', updatePose);
    if (this.rangePosePitch) this.rangePosePitch.addEventListener('input', updatePose);
    if (this.rangePoseRoll) this.rangePoseRoll.addEventListener('input', updatePose);

    if (this.btnResetPose) {
      this.btnResetPose.addEventListener('click', () => {
        if (this.activeVideoProfile) this.activeVideoProfile.pose = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
        this.syncStageAToUI();
        notifyChange();
      });
    }

    if (this.btnSaveVideoProfile) {
      this.btnSaveVideoProfile.addEventListener('click', async () => {
        if (this.activeVideoProfile) {
          this.activeVideoProfile.confidence = 'user-calibrated';
          await this.storage.saveVideoProfile(this.activeVideoProfile);
          this.syncStageAToUI();
          showFeedbackToast('💾 Projection Profile Saved');
          logAction('Saved Video Profile', this.activeVideoProfile);
        }
      });
    }

    if (this.selViewerPreset) {
      this.selViewerPreset.addEventListener('change', (e) => {
        const presetId = e.target.value;
        const currentLensState = this.activeViewerProfile ? this.activeViewerProfile.lensCorrectionEnabled : false;
        this.activeViewerProfile = createDefaultViewerProfile(presetId);
        this.activeViewerProfile.lensCorrectionEnabled = currentLensState;
        this.syncStageBToUI();
        notifyChange();
        logAction('Selected Viewer Preset: ' + presetId);
      });
    }

    if (this.btnToggleLens) {
      this.btnToggleLens.addEventListener('click', () => {
        if (!this.activeViewerProfile) return;
        this.activeViewerProfile.lensCorrectionEnabled = !this.activeViewerProfile.lensCorrectionEnabled;
        this.updateLensBtnState();
        showFeedbackToast(`Lens: ${this.activeViewerProfile.lensCorrectionEnabled ? 'ON' : 'OFF'}`);
        notifyChange();
        logAction('Toggled Lens: ' + (this.activeViewerProfile.lensCorrectionEnabled ? 'ON' : 'OFF'));
      });
    }

    const updateDistort = () => {
      if (!this.activeViewerProfile) return;
      if (!this.activeViewerProfile.distortion) this.activeViewerProfile.distortion = {};
      this.activeViewerProfile.distortion.k1 = parseFloat(this.rangeDistortK1 ? this.rangeDistortK1.value : 0);
      this.activeViewerProfile.distortion.k2 = parseFloat(this.rangeDistortK2 ? this.rangeDistortK2.value : 0);
      if (this.valDistortK1) this.valDistortK1.textContent = this.activeViewerProfile.distortion.k1.toFixed(4);
      if (this.valDistortK2) this.valDistortK2.textContent = this.activeViewerProfile.distortion.k2.toFixed(4);
      this.syncStageBToUI();
      notifyChange();
    };

    if (this.rangeDistortK1) this.rangeDistortK1.addEventListener('input', updateDistort);
    if (this.rangeDistortK2) this.rangeDistortK2.addEventListener('input', updateDistort);

    const updateCustomParams = () => {
      if (!this.activeViewerProfile) return;
      this.activeViewerProfile.screenToLensDistance = parseFloat(this.inputScreenToLens.value || 40) / 1000;
      this.activeViewerProfile.interLensDistance = parseFloat(this.inputInterLens.value || 64) / 1000;
      this.activeViewerProfile.verticalAlignment = this.selVerticalAlign.value || 'BOTTOM';
      this.activeViewerProfile.trayToLensDistance = parseFloat(this.inputTrayToLens.value || 35) / 1000;
      const fovVal = parseFloat(this.inputMaxFov.value || 50);
      this.activeViewerProfile.maxFovAngles = { outerDeg: fovVal, innerDeg: fovVal, upperDeg: fovVal, lowerDeg: fovVal };
      this.activeViewerProfile.isCalibrated = true;
      this.syncStageBToUI();
      notifyChange();
    };

    if (this.inputScreenToLens) this.inputScreenToLens.addEventListener('input', updateCustomParams);
    if (this.inputInterLens) this.inputInterLens.addEventListener('input', updateCustomParams);
    if (this.selVerticalAlign) this.selVerticalAlign.addEventListener('change', updateCustomParams);
    if (this.inputTrayToLens) this.inputTrayToLens.addEventListener('input', updateCustomParams);
    if (this.inputMaxFov) this.inputMaxFov.addEventListener('input', updateCustomParams);

    if (this.btnImportJson) {
      this.btnImportJson.addEventListener('click', () => {
        const raw = (this.inputJsonImport ? this.inputJsonImport.value : '').trim();
        if (!raw || !raw.startsWith('{')) {
          showFeedbackToast('⚠️ Paste JSON Profile');
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          this.activeViewerProfile = { ...createDefaultViewerProfile('custom:calibrated'), ...parsed, isCalibrated: true };
          this.syncStageBToUI();
          notifyChange();
          showFeedbackToast('✓ Profile JSON Imported');
        } catch (e) {
          showFeedbackToast('⚠️ JSON Error: ' + e.message);
        }
      });
    }

    if (this.btnSaveViewerProfile) {
      this.btnSaveViewerProfile.addEventListener('click', async () => {
        if (this.activeViewerProfile) {
          await this.storage.saveViewerProfile(this.activeViewerProfile);
          showFeedbackToast('💾 Viewer Profile Saved');
        }
      });
    }
  }
}
