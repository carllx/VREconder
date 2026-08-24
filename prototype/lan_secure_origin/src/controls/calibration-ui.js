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
    this.stageStatusText = document.getElementById('stageStatusText');
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
    } else if (act === 'select_media' && msg.relPath && this.mediaController) {
      this.mediaController.selectVideo(msg.relPath);
      logAction('Selected media from PC: ' + msg.relPath);
    } else if (act === 'set_diagnostic_eye' && typeof msg.eye === 'number') {
      this.selectedEye = msg.eye;
      showFeedbackToast(`Eye: ${this.selectedEye === 0 ? 'Left' : 'Right'}`);
    } else if (act === 'set_diagnostic_overlay' && msg.key && this.diagnosticOverlay) {
      this.diagnosticOverlay[msg.key] = (msg.value === true);
      showFeedbackToast(`Overlay ${msg.key}: ${msg.value ? 'ON' : 'OFF'}`);
    } else if (act === 'set_video_pose' && this.activeVideoProfile) {
      const p = this.activeVideoProfile.pose || (this.activeVideoProfile.pose = {});
      if (typeof msg.yawDeg === 'number') p.yawDeg = msg.yawDeg;
      if (typeof msg.pitchDeg === 'number') p.pitchDeg = msg.pitchDeg;
      if (typeof msg.rollDeg === 'number') p.rollDeg = msg.rollDeg;
      if (this.onProfileChanged) this.onProfileChanged(this.activeVideoProfile, this.activeViewerProfile);
    } else if (act === 'set_viewer_visual_mode') {
      state.viewerVisualMode = msg.mode;
      if (state.calibrationStage === 'B' && this.vrRenderer) {
        const isVideoGrid = (msg.mode === 'video_grid');
        this.vrRenderer.sceneType = isVideoGrid ? 0 : 1;
        this.vrRenderer.showReferenceGrid = isVideoGrid;
      }
      showFeedbackToast(`Stage B Ref: ${msg.mode === 'video_grid' ? 'Video + Grid' : 'Grid Only'}`);
      logAction('Set Viewer Visual Mode: ' + msg.mode);
    } else if (act === 'set_video_mapping' && msg.mapping && this.activeVideoProfile) {
      const m = msg.mapping;
      if (m.projection) this.activeVideoProfile.projection = m.projection;
      if (m.stereoMode) this.activeVideoProfile.stereoMode = m.stereoMode;
      if (typeof m.horizontalCoverageDeg === 'number') {
        this.activeVideoProfile.horizontalCoverageDeg = m.horizontalCoverageDeg;
        this.activeVideoProfile.fovHorizontalDeg = m.horizontalCoverageDeg;
      } else if (typeof m.fovHorizontalDeg === 'number') {
        this.activeVideoProfile.horizontalCoverageDeg = m.fovHorizontalDeg;
        this.activeVideoProfile.fovHorizontalDeg = m.fovHorizontalDeg;
      }
      if (typeof m.verticalCoverageDeg === 'number') {
        this.activeVideoProfile.verticalCoverageDeg = m.verticalCoverageDeg;
        this.activeVideoProfile.fovVerticalDeg = m.verticalCoverageDeg;
      }
      if (m.eyeOrder) this.activeVideoProfile.eyeOrder = m.eyeOrder;
      if (this.onProfileChanged) this.onProfileChanged(this.activeVideoProfile, this.activeViewerProfile);
      showFeedbackToast(`Mapping: ${this.activeVideoProfile.projection} (${this.activeVideoProfile.stereoMode})`);
      logAction('Set Video Mapping from PC', m);
    } else if (act === 'set_viewer_preset' && msg.presetId) {
      if (state.calibrationStage === 'C') return;
      const presetId = msg.presetId;
      const currentLensState = this.activeViewerProfile ? this.activeViewerProfile.lensCorrectionEnabled : false;
      let targetProfile = null;
      if (presetId === 'viewer:my_profile') {
        if (this.storage && this.storage.savedMyViewerProfile) {
          targetProfile = JSON.parse(JSON.stringify(this.storage.savedMyViewerProfile));
        } else {
          showFeedbackToast('⚠️ My Viewer Profile: Not saved yet');
          return;
        }
      } else {
        targetProfile = createDefaultViewerProfile(presetId);
      }
      if (targetProfile) {
        this.activeViewerProfile = targetProfile;
        this.activeViewerProfile.lensCorrectionEnabled = currentLensState;
        if (this.onProfileChanged) this.onProfileChanged(this.activeVideoProfile, this.activeViewerProfile);
        showFeedbackToast(`Viewer Profile: ${this.activeViewerProfile.name}`);
      }
    } else if (act === 'set_reference_grid') {
      state.showReferenceGrid = (msg.enabled === true);
      if (this.vrRenderer) this.vrRenderer.showReferenceGrid = state.showReferenceGrid;
      showFeedbackToast(state.showReferenceGrid ? '▦ Reference Grid: ON' : '▦ Reference Grid: OFF');
    } else if (act === 'set_lens_correction') {
      if (this.activeViewerProfile) {
        this.activeViewerProfile.lensCorrectionEnabled = msg.enabled === true;
        if (this.onProfileChanged) this.onProfileChanged(this.activeVideoProfile, this.activeViewerProfile);
        showFeedbackToast(`Lens: ${this.activeViewerProfile.lensCorrectionEnabled ? 'ON' : 'OFF'}`);
      }
    } else if (act === 'set_viewer_params') {
      if (state.calibrationStage === 'C') return;
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
      if (this.onProfileChanged) this.onProfileChanged(this.activeVideoProfile, this.activeViewerProfile);
    } else if (act === 'recenter' && this.commandModel) {
      this.commandModel.recenter();
    } else if (act === 'exit_vr' && this.onExitVR) {
      this.switchStage('A');
    } else if (act === 'playPause' && this.commandModel) {
      this.commandModel.playPause();
    } else if (act === 'seek' && typeof msg.seconds === 'number' && this.mediaController) {
      const v = this.mediaController.video;
      v.currentTime = Math.max(0, Math.min(v.duration || 9999, v.currentTime + msg.seconds));
      showFeedbackToast(`Seek: ${v.currentTime.toFixed(1)}s`);
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
        this.storage.saveViewerProfile(this.activeViewerProfile);
        showFeedbackToast('💾 My Viewer Profile (working) Saved');
        logAction('Saved My Viewer Profile', this.activeViewerProfile);
      }
    } else if (act === 'save_video_profile' && this.activeVideoProfile) {
      if (this.activeVideoProfile.projection === 'unknown' || this.activeVideoProfile.stereoMode === 'unknown') {
        showFeedbackToast('⚠️ Select mapping before saving!');
      } else {
        this.storage.saveVideoProfile(this.activeVideoProfile);
        showFeedbackToast('💾 Video Mapping Confirmed & Saved');
        logAction('Saved Video Mapping', this.activeVideoProfile);
      }
    }
  }

  switchStage(stage) {
    state.calibrationStage = stage;
    if (this.stageStatusText) {
      this.stageStatusText.textContent = `Stage ${stage}: ${stage === 'A' ? 'Flat Diagnostic (Unobstructed)' : (stage === 'B' ? 'Viewer Optics Tuning' : 'Video Verification')} | Controlled via PC`;
    }

    if (stage === 'A') {
      if (this.onExitVR) this.onExitVR();
      if (this.vrRenderer) {
        this.vrRenderer.sceneType = 0;
        this.vrRenderer.showReferenceGrid = false;
      }
      this.currentMode = 'diagnostic';
      showFeedbackToast('Stage A: Flat Diagnostic (Unobstructed)');
    } else if (stage === 'B') {
      const isVideoGrid = (state.viewerVisualMode === 'video_grid');
      if (this.vrRenderer) {
        this.vrRenderer.sceneType = isVideoGrid ? 0 : 1;
        this.vrRenderer.showReferenceGrid = isVideoGrid;
      }
      this.currentMode = 'vr';
      if (this.onEnterVR) this.onEnterVR();
      showFeedbackToast(`Stage B: Viewer Optics (${isVideoGrid ? 'Video + Grid' : 'Grid Only'})`);
    } else if (stage === 'C') {
      if (this.vrRenderer) {
        this.vrRenderer.sceneType = 0;
        this.vrRenderer.showReferenceGrid = state.showReferenceGrid;
      }
      this.currentMode = 'vr';
      if (this.onEnterVR) this.onEnterVR();
      showFeedbackToast('Stage C: Video Verification (Locked Optics)');
    }
  }

  setVideoProfile(profile) {
    this.activeVideoProfile = profile;
  }
}
