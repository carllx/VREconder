// ==========================================
// Staged Calibration & Diagnostic UI Controls
// (Synthetic Scene Toggle, Full Custom Viewer Inputs & URI Import)
// ==========================================
import { showFeedbackToast } from '../core/state.js';
import { createDefaultViewerProfile, deriveCardboardEyeGeometry } from '../core/projection-profile.js';
import { activeScreenProfile } from '../core/screen-profile.js';

export class CalibrationUI {
  constructor(options) {
    this.storage = options.storage;
    this.mediaController = options.mediaController;
    this.diagnosticOverlay = options.diagnosticOverlay;
    this.vrRenderer = options.vrRenderer;
    this.onProfileChanged = options.onProfileChanged;
    this.onEnterVR = options.onEnterVR;
    this.onExitVR = options.onExitVR;

    this.currentMode = 'diagnostic';
    this.selectedEye = 0;
    this.diagnosticFovDeg = 85;

    this.activeVideoProfile = null;
    this.activeViewerProfile = this.storage.activeViewerProfile;

    this.initDOM();
  }

  initDOM() {
    this.panel = document.getElementById('calibrationPanel');
    this.btnModeDiagnostic = document.getElementById('btnModeDiagnostic');
    this.btnModeVR = document.getElementById('btnModeVR');
    this.btnToggleScene = document.getElementById('btnToggleScene');

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

    // Custom Viewer Manual & Import Controls
    this.customInputsArea = document.getElementById('customViewerInputs');
    this.inputScreenToLens = document.getElementById('inputScreenToLens');
    this.inputInterLens = document.getElementById('inputInterLens');
    this.selVerticalAlign = document.getElementById('selVerticalAlign');
    this.inputTrayToLens = document.getElementById('inputTrayToLens');
    this.inputMaxFov = document.getElementById('inputMaxFov');
    this.inputUriImport = document.getElementById('inputUriImport');
    this.btnImportUri = document.getElementById('btnImportUri');

    this.bindEvents();
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
        this.txtMappingStatus.textContent = '⚠️ Untagged Media (Select Candidate Projection)';
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
      const r = geom.rightEye;
      const statusStr = hp.isCalibrated ? '<span style="color:#34d399;">✓ [CALIBRATED PROFILE]</span>' : '<span style="color:#f87171;">⚠️ [UNCALIBRATED BASELINE]</span>';
      this.txtDerivedFov.innerHTML = `
        ${statusStr}<br>
        <b>Left Eye Virt FOV:</b> L:${l.fovDeg.left.toFixed(1)}° R:${l.fovDeg.right.toFixed(1)}° U:${l.fovDeg.top.toFixed(1)}° D:${l.fovDeg.bottom.toFixed(1)}°<br>
        <b>Phys Tangents:</b> [${l.physTanBounds[0].toFixed(3)}, ${l.physTanBounds[1].toFixed(3)}, ${l.physTanBounds[2].toFixed(3)}, ${l.physTanBounds[3].toFixed(3)}]<br>
        <b>Virt Tangents:</b> [${l.virtTanBounds[0].toFixed(3)}, ${l.virtTanBounds[1].toFixed(3)}, ${l.virtTanBounds[2].toFixed(3)}, ${l.virtTanBounds[3].toFixed(3)}]<br>
        <b>Lens Center:</b> [${(l.lensCenterNorm[0]*100).toFixed(1)}%, ${(l.lensCenterNorm[1]*100).toFixed(1)}%]<br>
        <span style="opacity:0.75;">Screen: ${activeScreenProfile.deviceModel} (141.2×65.1mm, Bezel: 1.55mm)</span>
      `;
    }
  }

  updateLensBtnState() {
    const isCalibrated = (this.activeViewerProfile && this.activeViewerProfile.isCalibrated === true);
    const isEnabled = (isCalibrated && this.activeViewerProfile.lensCorrectionEnabled === true);
    if (this.btnToggleLens) {
      if (!isCalibrated) {
        this.btnToggleLens.textContent = '⚪ LENS CORRECTION: OFF (Uncalibrated Baseline)';
        this.btnToggleLens.style.background = '#475569';
      } else {
        this.btnToggleLens.textContent = isEnabled ? '🛡️ LENS CORRECTION: ON (Cardboard Screen Pre-Warp)' : '⚪ LENS CORRECTION: OFF (Ideal Undistorted)';
        this.btnToggleLens.style.background = isEnabled ? '#059669' : '#475569';
      }
    }
  }

  bindEvents() {
    // Mode Switch
    if (this.btnModeDiagnostic) {
      this.btnModeDiagnostic.addEventListener('click', () => {
        this.currentMode = 'diagnostic';
        this.btnModeDiagnostic.classList.add('active');
        if (this.btnModeVR) this.btnModeVR.classList.remove('active');
        if (this.onExitVR) this.onExitVR();
      });
    }

    if (this.btnModeVR) {
      this.btnModeVR.addEventListener('click', () => {
        this.currentMode = 'vr';
        this.btnModeVR.classList.add('active');
        if (this.btnModeDiagnostic) this.btnModeDiagnostic.classList.remove('active');
        if (this.onEnterVR) this.onEnterVR();
      });
    }

    // Toggle Scene Type (Video vs Synthetic Calibration Grid)
    if (this.btnToggleScene) {
      this.btnToggleScene.addEventListener('click', () => {
        if (this.vrRenderer) {
          this.vrRenderer.sceneType = (this.vrRenderer.sceneType === 0) ? 1 : 0;
          this.btnToggleScene.textContent = (this.vrRenderer.sceneType === 1) ? '▦ Scene: Synthetic Grid' : '🎬 Scene: Video Source';
          this.btnToggleScene.classList.toggle('active', this.vrRenderer.sceneType === 1);
          showFeedbackToast(`Scene: ${this.vrRenderer.sceneType === 1 ? 'Synthetic Calibration Grid' : 'Video Source'}`);
        }
      });
    }

    // Diagnostic Toolbar
    if (this.btnFreeze) {
      this.btnFreeze.addEventListener('click', () => {
        const v = this.mediaController.video;
        if (v.paused) {
          v.play();
          this.btnFreeze.textContent = '⏸ Freeze';
        } else {
          v.pause();
          this.btnFreeze.textContent = '▶ Play';
        }
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

    // Stage A Event Listeners
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
          await this.storage.saveVideoProfile(this.activeVideoProfile);
          this.syncStageAToUI();
          showFeedbackToast('💾 Projection Profile Saved for this Video');
        }
      });
    }

    // Stage B Event Listeners
    if (this.selViewerPreset) {
      this.selViewerPreset.addEventListener('change', (e) => {
        const presetId = e.target.value;
        const currentLensState = this.activeViewerProfile ? this.activeViewerProfile.lensCorrectionEnabled : false;
        this.activeViewerProfile = createDefaultViewerProfile(presetId);
        this.activeViewerProfile.lensCorrectionEnabled = currentLensState;
        this.syncStageBToUI();
        notifyChange();
      });
    }

    if (this.btnToggleLens) {
      this.btnToggleLens.addEventListener('click', () => {
        if (!this.activeViewerProfile || !this.activeViewerProfile.isCalibrated) {
          showFeedbackToast('⚠️ Select or Import a Calibrated Viewer Profile first');
          return;
        }
        this.activeViewerProfile.lensCorrectionEnabled = !this.activeViewerProfile.lensCorrectionEnabled;
        this.updateLensBtnState();
        showFeedbackToast(`Lens Correction: ${this.activeViewerProfile.lensCorrectionEnabled ? 'ON' : 'OFF'}`);
        notifyChange();
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

    // Custom Profile Manual Input listeners
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

    // Cardboard URI / Parameter Import
    if (this.btnImportUri) {
      this.btnImportUri.addEventListener('click', () => {
        const raw = (this.inputUriImport ? this.inputUriImport.value : '').trim();
        if (!raw) return;
        try {
          // If JSON
          if (raw.startsWith('{')) {
            const parsed = JSON.parse(raw);
            this.activeViewerProfile = { ...createDefaultViewerProfile('custom:calibrated'), ...parsed, isCalibrated: true };
          } else {
            // Label as URI import
            this.activeViewerProfile = createDefaultViewerProfile('custom:calibrated');
            this.activeViewerProfile.name = 'Imported Viewer Profile';
            this.activeViewerProfile.source = 'Cardboard URI: ' + raw.substring(0, 40) + '...';
            this.activeViewerProfile.isCalibrated = true;
          }
          this.syncStageBToUI();
          notifyChange();
          showFeedbackToast('✓ Viewer Profile Imported Successfully');
        } catch (e) {
          showFeedbackToast('⚠️ Import Error: ' + e.message);
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
