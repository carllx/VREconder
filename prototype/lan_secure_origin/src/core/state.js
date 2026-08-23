// ==========================================
// Global Application & Interaction State
// ==========================================
export const isStandalone = (window.navigator.standalone === true) || window.matchMedia('(display-mode: standalone)').matches;

export const state = {
  inVR: false,
  standalone: isStandalone,
  stereoMode: 1, // 1: 3D SBS Stereoscopic (True 3D VR)
  activePattern: 'B', // Default to Pattern B (Radial)
  dwellThresholdMs: 1000,
  
  // Staged Calibration Workflow: 'A' (Source Geometry), 'B' (Viewer Optics), 'C' (Real Video Verification)
  calibrationStage: 'A',
  pcConnected: false,

  // First-Frame Timing & Black-Screen Instrumentation
  firstFrameTimings: {
    selectedAt: 0,
    metadataAt: 0,
    canplayAt: 0,
    firstFrameDecodedAt: 0,
    firstTextureUploadAt: 0,
    firstRenderAt: 0,
    ready: false,
    statusText: 'Ready'
  },

  // Video Playlist
  videoList: [],
  currentVideoIndex: 0,
  videoPath: '4K/4096_2048_crf18_avc1-Kururugi Aoi - WAVR224.mp4',
  videoDuration: 0,
  videoWidth: 0,
  videoHeight: 0,

  // Render & Sensor metrics
  fps: 0,
  droppedFrames: 0,
  totalVideoFrames: 0,
  screenAngle: 0,
  motionPermission: 'unrequested',
  motionEventCount: 0,
  rawOrientation: { alpha: 0, beta: 0, gamma: 0 },
  qPose: [0, 0, 0, 1],
  qRefInv: [0, 0, 0, 1],
  qCamera: [0, 0, 0, 1],
  cameraForward: [0, 0, -1],
  cameraUp: [0, 1, 0],
  viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
  headStateText: 'Center',

  // Pattern States - Default 100% Hidden in floor zone
  patternA_open: false,
  patternB_open: false,
  patternC_open: false,

  // Recenter Posture Calibration State
  recenterCountdown: {
    active: false,
    startTime: 0,
    durationMs: 2500,
    lastSecondTick: -1,
    label: 'Recenter View'
  },

  // Toast feedback
  toastText: '',
  toastTime: 0
};

export function showFeedbackToast(msg) {
  state.toastText = msg;
  state.toastTime = performance.now();
}

export function formatTime(seconds) {
  if (isNaN(seconds)) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}
