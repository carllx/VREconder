// ==========================================
// Application Bootstrap & Main Loop Entry
// ==========================================
import { state, showFeedbackToast, isStandalone } from './core/state.js';
import { initOrientationListeners } from './core/orientation.js';
import { startRecenterCalibration } from './core/recenter.js';
import { VRRenderer } from './render/vr-renderer.js';
import { MediaController } from './media/playback.js';
import { CommandModel } from './controls/command-model.js';
import { GazeEngine } from './controls/gaze-engine.js';
import { renderStereoUI } from './controls/stereo-ui.js';
import { telemetry } from './telemetry/telemetry.js';
import { initAudioContext } from './controls/audio-haptics.js';

// Global error handlers
function showError(msg) {
  const banner = document.getElementById('errorBanner');
  if (banner) {
    banner.style.display = 'block';
    banner.textContent = 'Error: ' + msg;
  }
  console.error(msg);
}
window.onerror = (msg, url, line) => { showError(msg + ' (L' + line + ')'); };
window.onunhandledrejection = (e) => { showError(e.reason ? (e.reason.message || e.reason) : e); };

// WakeLock API
let wakeLockSentinel = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      const el = document.getElementById('valWakeLock');
      if (el) el.textContent = 'Active (NoSleep)';
      wakeLockSentinel.addEventListener('release', () => {
        const elR = document.getElementById('valWakeLock');
        if (elR) elR.textContent = 'Released';
      });
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
const btnResetTasks = document.getElementById('btnResetTasks');
const btnSyncTelemetry = document.getElementById('btnSyncTelemetry');

// Instantiate Subsystems
const vrRenderer = new VRRenderer(glCanvas);
const mediaController = new MediaController(video, videoSelect);
const commandModel = new CommandModel(mediaController);
const gazeEngine = new GazeEngine(commandModel, video);

// Initialize Device Orientation Listeners
initOrientationListeners();

// Floating Quick Bar visibility management
let hideBarTimeout = null;
function showFloatingBar() {
  if (!state.inVR) return;
  vrFloatingBar.classList.remove('fade-out');
  clearTimeout(hideBarTimeout);
  hideBarTimeout = setTimeout(() => {
    vrFloatingBar.classList.add('fade-out');
  }, 4000);
}
window.addEventListener('touchstart', showFloatingBar, { passive: true });
window.addEventListener('click', showFloatingBar);

// Event Listeners
btnEnterVR.addEventListener('click', () => {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then((perm) => {
      state.motionPermission = perm;
      const elPerm = document.getElementById('valMotionPerm');
      if (elPerm) elPerm.textContent = perm;
    }).catch((err) => {
      state.motionPermission = 'error: ' + err.message;
      const elPerm = document.getElementById('valMotionPerm');
      if (elPerm) elPerm.textContent = 'Err';
    });
  } else {
    state.motionPermission = 'granted_standard';
    const elPerm = document.getElementById('valMotionPerm');
    if (elPerm) elPerm.textContent = 'Standard';
  }

  requestWakeLock();
  initAudioContext();

  video.muted = false;
  video.play().catch(() => {
    video.muted = true;
    video.play().catch(e2 => console.log('Muted play error:', e2));
  });

  state.inVR = true;
  uiOverlay.classList.add('hidden');
  showFloatingBar();
  startRecenterCalibration(3000, '🥽 戴入眼镜并面朝正前方');
});

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
  state.inVR = false;
  uiOverlay.classList.remove('hidden');
  vrFloatingBar.classList.add('fade-out');
  telemetry.syncSummary();
});

btnResetTasks.addEventListener('click', () => {
  telemetry.resetTasks();
});

btnSyncTelemetry.addEventListener('click', () => {
  telemetry.syncSummary();
});

// Pattern Selector in 2D UI
const grpPatternSelect = document.getElementById('grpPatternSelect');
grpPatternSelect.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) {
    const pat = btn.getAttribute('data-pattern');
    commandModel.setPattern(pat);
  }
});

// Dwell Threshold Selector
const grpDwellThreshold = document.getElementById('grpDwellThreshold');
grpDwellThreshold.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) {
    grpDwellThreshold.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.dwellThresholdMs = parseInt(btn.getAttribute('data-dwell'), 10);
    showFeedbackToast('Dwell: ' + state.dwellThresholdMs + 'ms');
  }
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
    const elFps = document.getElementById('valFps');
    if (elFps) elFps.textContent = state.fps.toFixed(1);
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

  // Update Gaze & Dwell State
  gazeEngine.update(now);

  // WebGL 3D Stereo SBS Video Render
  if (mediaController.shouldUploadTexture()) {
    vrRenderer.updateVideoTexture(video);
  }
  vrRenderer.render(width, height);

  // 2D Stereo Overlay Canvas Render
  renderStereoUI(uiCtx, gazeEngine, commandModel, video, now, width, height);
}

requestAnimationFrame(renderLoop);

// Initial Video List Load
mediaController.loadVideoList();
