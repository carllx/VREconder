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
import { ControllerInputProbe, setRemoteLogFunction } from './controls/controller-input-probe.js';

// Global error handlers & Remote Diagnostics
export function remoteLog(level, message, data = null) {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message, data, url: location.href, time: new Date().toISOString() })
  }).catch(() => {});
}
setRemoteLogFunction(remoteLog);

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

// Screen Wake Lock API & Screen Sleep Prevention Lifecycle
let wakeLockSentinel = null;
let isRequestingWakeLock = false;
let wakeLockRetryTimer = null;
let wakeLockRetryCount = 0;
const MAX_WAKE_LOCK_RETRIES = 5;

export async function requestWakeLock(reason = 'startup') {
  if (!('wakeLock' in navigator)) {
    remoteLog('WARN', 'WAKE_LOCK_UNSUPPORTED', { reason });
    return false;
  }
  if (document.visibilityState !== 'visible') {
    return false;
  }
  if (wakeLockSentinel && !wakeLockSentinel.released) {
    return true;
  }
  if (isRequestingWakeLock) {
    return false;
  }

  isRequestingWakeLock = true;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel = sentinel;
    wakeLockRetryCount = 0;
    if (wakeLockRetryTimer) {
      clearTimeout(wakeLockRetryTimer);
      wakeLockRetryTimer = null;
    }
    const eventName = (reason === 'visibilitychange' || reason === 'system_release_reacquire')
      ? 'WAKE_LOCK_REACQUIRED'
      : 'WAKE_LOCK_ACQUIRED';
    remoteLog('INFO', eventName, { reason, stage: state.calibrationStage, inVR: state.inVR });

    sentinel.addEventListener('release', () => {
      remoteLog('INFO', 'WAKE_LOCK_RELEASED', { reason: 'sentinel_release', stage: state.calibrationStage });
      wakeLockSentinel = null;
      if (document.visibilityState === 'visible' && wakeLockRetryCount < MAX_WAKE_LOCK_RETRIES) {
        wakeLockRetryCount++;
        const delay = Math.min(1000 * Math.pow(1.5, wakeLockRetryCount - 1), 5000);
        if (wakeLockRetryTimer) clearTimeout(wakeLockRetryTimer);
        wakeLockRetryTimer = setTimeout(() => {
          requestWakeLock('system_release_reacquire');
        }, delay);
      }
    });

    return true;
  } catch (err) {
    const errMsg = err.name ? `${err.name}: ${err.message}` : String(err);
    remoteLog('WARN', 'WAKE_LOCK_ERROR', { error: errMsg, reason, stage: state.calibrationStage });
    return false;
  } finally {
    isRequestingWakeLock = false;
  }
}

// Check Wake Lock support at bootstrap
if ('wakeLock' in navigator) {
  remoteLog('INFO', 'WAKE_LOCK_SUPPORTED', { supported: true });
} else {
  remoteLog('WARN', 'WAKE_LOCK_UNSUPPORTED', { supported: false });
}

// Request on initial script execution
requestWakeLock('initial_load');

// Request on any user interaction (to satisfy iOS Safari user-gesture requirement if necessary)
const onUserGestureForWakeLock = () => {
  if (!wakeLockSentinel || wakeLockSentinel.released) {
    requestWakeLock('user_gesture');
  }
};
window.addEventListener('touchstart', onUserGestureForWakeLock, { passive: true });
window.addEventListener('click', onUserGestureForWakeLock, { passive: true });

// Visibility change handler (reacquire when returning to foreground, clean up when backgrounded)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    wakeLockRetryCount = 0;
    await requestWakeLock('visibilitychange');
  } else {
    if (wakeLockRetryTimer) {
      clearTimeout(wakeLockRetryTimer);
      wakeLockRetryTimer = null;
    }
    if (wakeLockSentinel) {
      try { await wakeLockSentinel.release(); } catch (e) {}
      wakeLockSentinel = null;
    }
  }
});

// DOM Elements
const glCanvas = document.getElementById('glCanvas');
const uiCanvas = document.getElementById('uiCanvas');
const uiCtx = uiCanvas.getContext('2d');
const stageBanner = document.getElementById('stageBanner');
const vrFloatingBar = document.getElementById('vrFloatingBar');
const video = document.getElementById('sourceVideo');
const btnEnterVR = document.getElementById('btnEnterVR');
const btnVrReset = document.getElementById('btnVrReset');
const btnVrExit = document.getElementById('btnVrExit');

// Instantiate Subsystems
const vrRenderer = new VRRenderer(glCanvas);
const diagnosticOverlay = new DiagnosticOverlay(uiCanvas);
const mediaController = new MediaController(video, null);
const commandModel = new CommandModel(mediaController);
const gazeEngine = new GazeEngine(commandModel, video);
const controllerProbe = new ControllerInputProbe(commandModel);

// Load server profiles
profileStorage.loadServerProfiles();

// Calibration UI Setup
let activeVideoProfile = null;

export function getEffectiveViewerProfile(baseProfile) {
  if (!baseProfile) return baseProfile;
  const baseD = baseProfile.screenToLensDistance || 0.0433;
  const offset = state.temporaryScreenToLensOffset || 0.0;
  const effectiveD = Math.max(0.0383, Math.min(0.0483, baseD + offset));
  return {
    ...baseProfile,
    screenToLensDistance: effectiveD
  };
}

function onVideoSelected(videoItem) {
  state.temporaryScreenToLensOffset = 0.0;
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
  const found = (state.videoList || []).find(v => v.relPath === relPath) || { name: relPath, relPath: relPath, sizeBytes: 0 };
  onVideoSelected(found);
};

// Initialize Orientation Listeners
initOrientationListeners();

// Floating Quick Bar visibility management (Suppressed in Optics Stage B/C)
let hideBarTimeout = null;
function showFloatingBar() {
  if (!state.inVR) return;
  if (vrFloatingBar) vrFloatingBar.classList.remove('fade-out');
  clearTimeout(hideBarTimeout);
  hideBarTimeout = setTimeout(() => {
    if (vrFloatingBar) vrFloatingBar.classList.add('fade-out');
  }, 4000);
}
window.addEventListener('touchstart', showFloatingBar, { passive: true });

async function localArmAndEnterVR() {
  if (btnEnterVR) {
    btnEnterVR.style.background = '#10b981';
    const span = btnEnterVR.querySelector('span');
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
        requestWakeLock('arm_and_enter_vr');
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
    requestWakeLock('arm_and_enter_vr');
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
    showFeedbackToast('⚠️ Tap Arm & Enter VR on iPhone first');
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
  if (stageBanner) stageBanner.classList.add('hidden');
  showFeedbackToast(`🛡️ VR Armed: Stage ${state.calibrationStage}`);
  remoteLog('INFO', 'Entered VR Mode', { stage: state.calibrationStage, isArmed: state.isArmed });
}

function exitVRMode() {
  state.inVR = false;
  calibrationUI.currentMode = 'diagnostic';
  if (stageBanner) stageBanner.classList.remove('hidden');
  if (vrFloatingBar) vrFloatingBar.classList.add('fade-out');
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

if (btnVrReset) {
  btnVrReset.addEventListener('click', (e) => {
    e.stopPropagation();
    commandModel.recenter();
  });
}

if (btnVrExit) {
  btnVrExit.addEventListener('click', (e) => {
    e.stopPropagation();
    exitVRMode();
  });
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

  // Poll Gamepad states
  controllerProbe.pollGamepads();

  // Upload video frame if dirty
  if (mediaController.shouldUploadTexture()) {
    vrRenderer.updateVideoTexture(video);
  }

  const isVR = state.inVR || calibrationUI.currentMode === 'vr';
  const effectiveViewerProfile = getEffectiveViewerProfile(calibrationUI.activeViewerProfile);

  if (!isVR) {
    // 1. Diagnostic Mode: Single Rectilinear View
    vrRenderer.renderDiagnosticView(
      width,
      height,
      activeVideoProfile,
      effectiveViewerProfile,
      calibrationUI.selectedEye,
      null, // Identity camera rotation for pure forward perspective
      calibrationUI.diagnosticFovDeg
    );

    // Draw Diagnostic Overlays (Grid, Plumb lines, Horizon, Crosshair)
    diagnosticOverlay.render(
      width,
      height,
      activeVideoProfile,
      effectiveViewerProfile,
      calibrationUI.selectedEye,
      video.paused,
      video.currentTime,
      video.duration || 0
    );
  } else {
    // 2. Stereo VR Mode: Dual Viewports with Optional Lens Pre-Distortion
    gazeEngine.update(now);

    renderStereoUI(uiCtx, gazeEngine, commandModel, video, now, width, height, effectiveViewerProfile);

    vrRenderer.renderStereoVR(
      width,
      height,
      activeVideoProfile,
      effectiveViewerProfile,
      cameraMat3,
      uiCanvas
    );

    uiCtx.clearRect(0, 0, width, height);
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
    mediaPath: state.videoPath || '',
    mediaStatus: state.firstFrameTimings.statusText || 'Ready',
    devStatus: state.inVR ? `In VR (Stage ${state.calibrationStage})` : `Diagnostic (Stage ${state.calibrationStage})`,
    showReferenceGrid: state.showReferenceGrid === true,
    viewerVisualMode: state.viewerVisualMode || 'grid_only',
    savedMyViewerProfileExists: !!(calibrationUI.storage && calibrationUI.storage.savedMyViewerProfile),
    savedMyViewerProfile: (calibrationUI.storage && calibrationUI.storage.savedMyViewerProfile) || null,
    viewerProfile: calibrationUI.activeViewerProfile,
    videoProfile: activeVideoProfile,
    timings: state.firstFrameTimings,
    selectedEye: calibrationUI.selectedEye || 0,
    diagOverlay: {
      showGrid: !!(calibrationUI.diagnosticOverlay && calibrationUI.diagnosticOverlay.showGrid),
      showPlumbLines: !!(calibrationUI.diagnosticOverlay && calibrationUI.diagnosticOverlay.showPlumbLines),
      showHorizon: !!(calibrationUI.diagnosticOverlay && calibrationUI.diagnosticOverlay.showHorizon)
    },
    videoPaused: !!video.paused,
    currentTime: video.currentTime || 0,
    duration: video.duration || 0,
    mediaList: (state.videoList || []).map(v => ({ relPath: v.relPath, name: v.name, sizeGB: v.sizeGB })),
    controllerInput: controllerProbe.getTelemetryData()
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
