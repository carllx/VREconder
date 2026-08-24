// ==========================================
// Application Bootstrap & Main Loop Entry
// ==========================================
import { state, showFeedbackToast, isStandalone } from './core/state.js';
import { initOrientationListeners, updateScreenOrientation, cameraMat3 } from './core/orientation.js';
import { startRecenterCalibration } from './core/recenter.js';
import { VRRenderer } from './render/vr-renderer.js';
import { DiagnosticOverlay } from './render/diagnostic-overlay.js';
import { MediaController } from './media/playback.js';
import { CommandModel } from './controls/command-model.js';
import { GazeEngine } from './controls/gaze-engine.js';
import { renderStereoUI } from './controls/stereo-ui.js';
import { telemetry } from './telemetry/telemetry.js';
import { initAudioContext } from './controls/audio-haptics.js';
import { profileStorage, computeMediaFingerprint } from './core/projection-profile.js';
import { CalibrationUI } from './controls/calibration-ui.js';

// Global error handlers & Remote Diagnostics
export function remoteLog(level, message, data = null) {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message, data, url: location.href, time: new Date().toISOString() })
  }).catch(() => {});
}

function showError(msg) {
  const banner = document.getElementById('errorBanner');
  if (banner) {
    banner.style.display = 'block';
    banner.textContent = 'Error: ' + msg;
  }
  remoteLog('ERROR', msg);
  console.error(msg);
}
window.onerror = (msg, url, line, col, err) => {
  showError(`${msg} (${url}:${line}:${col})`);
  remoteLog('ERROR', `${msg} (${url}:${line}:${col})`, err ? err.stack : null);
};
window.onunhandledrejection = (e) => {
  const reason = e.reason ? (e.reason.message || e.reason.stack || String(e.reason)) : 'Unhandled rejection';
  showError(reason);
  remoteLog('UNHANDLED_REJECTION', reason);
};

// WakeLock API
let wakeLockSentinel = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {});
    }
  } catch (err) {
    console.warn('WakeLock error:', err);
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.inVR) {
    await requestWakeLock();
  }
});

// DOM Elements
const glCanvas = document.getElementById('glCanvas');
const uiCanvas = document.getElementById('uiCanvas');
const uiCtx = uiCanvas.getContext('2d');
const uiOverlay = document.getElementById('uiOverlay');
const vrFloatingBar = document.getElementById('vrFloatingBar');
const video = document.getElementById('sourceVideo');
const videoSelect = document.getElementById('videoSelect');
const btnEnterVR = document.getElementById('btnEnterVR');
const btnVrReset = document.getElementById('btnVrReset');
const btnVrExit = document.getElementById('btnVrExit');
const btnVrSwitchPattern = document.getElementById('btnVrSwitchPattern');
const diagnosticToolbar = document.getElementById('diagnosticToolbar');

// Instantiate Subsystems
const vrRenderer = new VRRenderer(glCanvas);
const diagnosticOverlay = new DiagnosticOverlay(uiCanvas);
const mediaController = new MediaController(video, videoSelect);
const commandModel = new CommandModel(mediaController);
const gazeEngine = new GazeEngine(commandModel, video);

// Load server profiles
profileStorage.loadServerProfiles();

// Calibration UI Setup
let activeVideoProfile = null;

function onVideoSelected(videoItem) {
  const mediaId = computeMediaFingerprint(videoItem);
  activeVideoProfile = profileStorage.getVideoProfile(mediaId, videoItem ? videoItem.name : '');
  calibrationUI.setVideoProfile(activeVideoProfile);
  showFeedbackToast(`Profile loaded: ${activeVideoProfile.projection}`);
}

const calibrationUI = new CalibrationUI({
  storage: profileStorage,
  mediaController: mediaController,
  diagnosticOverlay: diagnosticOverlay,
  vrRenderer: vrRenderer,
  commandModel: commandModel,
  onProfileChanged: (vProfile, hProfile) => {
    activeVideoProfile = vProfile;
  },
  onEnterVR: () => enterVRMode(),
  onExitVR: () => exitVRMode()
});

// Override media selection to automatically load per-video profile
const originalSelectVideo = mediaController.selectVideo.bind(mediaController);
mediaController.selectVideo = (relPath) => {
  originalSelectVideo(relPath);
  const found = state.videoList.find(v => v.relPath === relPath) || { name: relPath, relPath: relPath, sizeBytes: 0 };
  onVideoSelected(found);
};

// Initialize Orientation Listeners
initOrientationListeners();

// Floating Quick Bar visibility management (Suppressed in Optics Stage B/C)
let hideBarTimeout = null;
function showFloatingBar() {
  if (!state.inVR) return;
  if (state.calibrationStage === 'B' || state.calibrationStage === 'C') return;
  vrFloatingBar.classList.remove('fade-out');
  clearTimeout(hideBarTimeout);
  hideBarTimeout = setTimeout(() => {
    vrFloatingBar.classList.add('fade-out');
  }, 4000);
}
window.addEventListener('touchstart', showFloatingBar, { passive: true });
async function localArmAndEnterVR() {
  if (btnEnterVR) {
    btnEnterVR.style.background = '#10b981';
    const span = btnEnterVR.querySelector('span');
    if (span) span.textContent = '🚀 Requesting Sensor Permission...';
  }
  const topBtn = document.getElementById('btnEnterVRTop');
  if (topBtn) {
    topBtn.style.background = '#10b981';
    const span = topBtn.querySelector('span');
    if (span) span.textContent = '🚀 Requesting Sensor Permission...';
  }

  // Genuinely request motion permission on local iPhone user gesture and await resolution
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      state.motionPermission = perm;
      if (perm === 'granted') {
        state.isArmed = true;
        updateScreenOrientation();
        requestWakeLock();
        initAudioContext();
        video.muted = false;
        video.play().catch(() => {
          video.muted = true;
          video.play().catch(e2 => console.log('Muted play error:', e2));
        });
        enterVRMode();
      } else {
        state.isArmed = false;
        showError('DeviceOrientation permission denied. Gyroscope tracking required for VR.');
        showFeedbackToast('⚠️ Motion Permission Denied');
        if (btnEnterVR) {
          btnEnterVR.style.background = '#dc2626';
          const span = btnEnterVR.querySelector('span');
          if (span) span.textContent = '❌ Permission Denied';
        }
        if (topBtn) {
          topBtn.style.background = '#dc2626';
          const span = topBtn.querySelector('span');
          if (span) span.textContent = '❌ Permission Denied';
        }
      }
    } catch (err) {
      state.isArmed = false;
      showError('Permission error: ' + (err.message || err));
      showFeedbackToast('⚠️ Sensor Permission Error');
    }
  } else {
    // Non-iOS Safari environment
    state.isArmed = true;
    updateScreenOrientation();
    requestWakeLock();
    initAudioContext();
    video.muted = false;
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(e2 => console.log('Muted play error:', e2));
    });
    enterVRMode();
  }
}

function enterVRMode() {
  if (!state.isArmed) {
    console.warn('[VR] enterVRMode blocked: Device not armed by local user gesture.');
    showFeedbackToast('⚠️ Tap Arm Calibration on iPhone first');
    return;
  }

  // If entering VR from Stage A, promote to Stage B (Synthetic Grid stereo VR)
  if (state.calibrationStage === 'A') {
    state.calibrationStage = 'B';
    if (vrRenderer) vrRenderer.sceneType = 1;
  } else if (state.calibrationStage === 'B') {
    if (vrRenderer) vrRenderer.sceneType = 1;
  } else if (state.calibrationStage === 'C') {
    if (vrRenderer) vrRenderer.sceneType = 0;
  }

  state.inVR = true;
  calibrationUI.currentMode = 'vr';
  uiOverlay.classList.add('hidden');
  uiOverlay.style.display = 'none';
  diagnosticToolbar.style.display = 'none';
  showFeedbackToast(`🛡️ VR Armed: Stage ${state.calibrationStage}`);
  remoteLog('INFO', 'Entered VR Mode', { stage: state.calibrationStage, isArmed: state.isArmed });
}

function exitVRMode() {
  state.inVR = false;
  calibrationUI.currentMode = 'diagnostic';
  uiOverlay.classList.remove('hidden');
  uiOverlay.style.display = 'flex';
  diagnosticToolbar.style.display = 'flex';
  vrFloatingBar.classList.add('fade-out');
  telemetry.syncSummary();
  remoteLog('INFO', 'Exited VR Mode');
}

// Event Listeners
if (btnEnterVR) {
  btnEnterVR.addEventListener('click', localArmAndEnterVR);
  btnEnterVR.addEventListener('touchend', (e) => {
    e.preventDefault();
    localArmAndEnterVR();
  });
}

const btnEnterVRTop = document.getElementById('btnEnterVRTop');
if (btnEnterVRTop) {
  btnEnterVRTop.addEventListener('click', localArmAndEnterVR);
  btnEnterVRTop.addEventListener('touchend', (e) => {
    e.preventDefault();
    localArmAndEnterVR();
  });
}

btnVrReset.addEventListener('click', (e) => {
  e.stopPropagation();
  commandModel.recenter();
});

btnVrSwitchPattern.addEventListener('click', (e) => {
  e.stopPropagation();
  commandModel.cyclePattern();
});

btnVrExit.addEventListener('click', (e) => {
  e.stopPropagation();
  exitVRMode();
});

// Display Mode Badge
const badgeDisplay = document.getElementById('badgeDisplayMode');
if (isStandalone) {
  badgeDisplay.className = 'status-badge badge-standalone';
  badgeDisplay.textContent = 'Standalone WebApp (Fullscreen)';
} else {
  badgeDisplay.className = 'status-badge badge-browser';
  badgeDisplay.textContent = 'Safari Browser Tab';
}

// ==========================================
// Main Render Loop
// ==========================================
let lastFpsTime = performance.now();
let frameCounter = 0;

function renderLoop(now) {
  requestAnimationFrame(renderLoop);

  frameCounter++;
  if (now - lastFpsTime >= 1000) {
    state.fps = Number(((frameCounter * 1000) / (now - lastFpsTime)).toFixed(1));
    frameCounter = 0;
    lastFpsTime = now;
  }

  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth * dpr;
  const height = window.innerHeight * dpr;

  if (glCanvas.width !== width || glCanvas.height !== height) {
    glCanvas.width = width;
    glCanvas.height = height;
    uiCanvas.width = width;
    uiCanvas.height = height;
  }

  // Upload video frame if dirty
  if (mediaController.shouldUploadTexture()) {
    vrRenderer.updateVideoTexture(video);
  }

  const isVR = state.inVR || calibrationUI.currentMode === 'vr';

  if (!isVR) {
    // 1. Diagnostic Mode: Single Rectilinear View
    vrRenderer.renderDiagnosticView(
      width,
      height,
      activeVideoProfile,
      calibrationUI.activeViewerProfile,
      calibrationUI.selectedEye,
      null, // Identity camera rotation for pure forward perspective
      calibrationUI.diagnosticFovDeg
    );

    // Draw Diagnostic Overlays (Grid, Plumb lines, Horizon, Crosshair)
    diagnosticOverlay.render(
      width,
      height,
      activeVideoProfile,
      calibrationUI.activeViewerProfile,
      calibrationUI.selectedEye,
      video.paused,
      video.currentTime,
      video.duration || 0
    );
  } else {
    // 2. Stereo VR Mode: Dual Viewports with Optional Lens Pre-Distortion
    gazeEngine.update(now);

    vrRenderer.renderStereoVR(
      width,
      height,
      activeVideoProfile,
      calibrationUI.activeViewerProfile,
      cameraMat3
    );

    renderStereoUI(uiCtx, gazeEngine, commandModel, video, now, width, height);
  }
}

requestAnimationFrame(renderLoop);

// Periodic Live Telemetry Sync to Server & PC Controller (every 500ms)
setInterval(() => {
  const payload = {
    type: 'telemetry_sync',
    fps: state.fps,
    isArmed: state.isArmed,
    inVR: state.inVR,
    calibrationStage: state.calibrationStage,
    mediaName: state.videoPath ? state.videoPath.split('/').pop() : '--',
    mediaStatus: state.firstFrameTimings.statusText || 'Ready',
    devStatus: state.inVR ? `In VR (Stage ${state.calibrationStage})` : `Diagnostic (Stage ${state.calibrationStage})`,
    showReferenceGrid: state.showReferenceGrid === true,
    viewerVisualMode: state.viewerVisualMode || 'grid_only',
    viewerProfile: calibrationUI.activeViewerProfile,
    videoProfile: activeVideoProfile,
    timings: state.firstFrameTimings
  };
  fetch('/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
  fetch('/api/calibration/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}, 500);

// Initial Video List Load
mediaController.loadVideoList();
