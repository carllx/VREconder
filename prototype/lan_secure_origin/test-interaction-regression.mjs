// ==========================================
// Deterministic Interaction & Gaze Dwell Regression Verification
// ==========================================
import assert from 'node:assert';
import { GazeEngine } from './src/controls/gaze-engine.js';
import { state } from './src/core/state.js';
import { TIMELINE_GEOMETRY, sphericalToDir } from './src/controls/patterns.js';
import { getEffectiveViewerProfile } from './src/core/projection-profile.js';

console.log('=== RUNNING DETERMINISTIC INTERACTION REGRESSION CHECKS ===\n');

let allPassed = true;

// 1. Check state.dwellThresholdMs finite validation
console.log('Check 1: dwellThresholdMs Finite & Established Value:');
const isFiniteVal = Number.isFinite(state.dwellThresholdMs);
const is1000 = state.dwellThresholdMs === 1000;
console.log(`  state.dwellThresholdMs: ${state.dwellThresholdMs} (isFinite: ${isFiniteVal}, === 1000: ${is1000})`);
if (!isFiniteVal || !is1000) {
  console.log('  ❌ Check 1 FAILED');
  allPassed = false;
} else {
  console.log('  ✅ Check 1 PASSED');
}

// 2. Normal Button Dwell Timing & Triggering
console.log('\nCheck 2: Normal Button Dwell Behavior (Hold < 1000ms vs > 1000ms):');
let cmdCalls = 0;
const mockCmd = {
  closeControls: () => { cmdCalls++; },
  recenter: () => { cmdCalls++; },
  seekToTime: () => {}
};
const mockVideo = { paused: false, duration: 100, currentTime: 10 };
const engine = new GazeEngine(mockCmd, mockVideo);

state.activePattern = 'B';
state.patternB_open = true;
state.inVR = true;

// Force camera looking forward at center button
state.cameraForward = sphericalToDir(0, -34); // Center dismiss button direction

// Tick at t = 0
engine.update(0);
console.log(`  t=0ms: hovered=${engine.currentHoveredItem ? engine.currentHoveredItem.id : 'none'}, dwellProgress=${engine.dwellProgress.toFixed(2)}, cmdCalls=${cmdCalls}`);

// Tick at t = 500ms (< 1000ms)
engine.update(500);
const c2_sub1 = (cmdCalls === 0 && engine.dwellProgress >= 0.49 && engine.dwellProgress <= 0.51);
console.log(`  t=500ms: dwellProgress=${engine.dwellProgress.toFixed(2)}, cmdCalls=${cmdCalls} -> ${c2_sub1 ? 'PASS (no cmd)' : 'FAIL'}`);

// Tick at t = 1050ms (> 1000ms)
engine.update(1050);
const c2_sub2 = (cmdCalls === 1);
console.log(`  t=1050ms: cmdCalls=${cmdCalls} (dwell triggered & reset) -> ${c2_sub2 ? 'PASS (exactly 1 cmd)' : 'FAIL'}`);

// Tick at t = 1200ms (still holding, should not re-trigger immediately due to cooldown)
engine.update(1200);
const c2_sub3 = (cmdCalls === 1);
console.log(`  t=1200ms: cmdCalls=${cmdCalls} -> ${c2_sub3 ? 'PASS (no duplicate)' : 'FAIL'}`);

if (!c2_sub1 || !c2_sub2 || !c2_sub3) {
  allPassed = false;
  console.log('  ❌ Check 2 FAILED');
} else {
  console.log('  ✅ Check 2 PASSED');
}

// 3. Continuous Timeline Dwell & 0.85° Anchor Reset Logic
console.log('\nCheck 3: Continuous Timeline Dwell & 0.85° Anchor Movement Reset:');
let seekCalls = 0;
let seekTarget = -1;
mockCmd.seekToTime = (time) => {
  seekCalls++;
  seekTarget = time;
};

// Reset engine and look at Timeline center (yaw=0, pitch=-12)
engine.currentHoveredItem = null;
engine.timelineHover.active = false;
engine.timelineHover.dwellAnchorDirWorld = null;
state.cameraForward = sphericalToDir(0, -12);

// t = 2000ms: Enter timeline
engine.update(2000);
console.log(`  t=2000ms: timelineActive=${engine.timelineHover.active}, fraction=${engine.timelineHover.fraction.toFixed(2)}, preview=${engine.timelineHover.previewTime.toFixed(1)}s, dwellProgress=${engine.dwellProgress.toFixed(2)}`);

// t = 2500ms: Stable gaze for 500ms
engine.update(2500);
console.log(`  t=2500ms: stable gaze, dwellProgress=${engine.dwellProgress.toFixed(2)}, seekCalls=${seekCalls}`);

// t = 2600ms: Move gaze along timeline by 2.0° (greater than 0.85° threshold)
state.cameraForward = sphericalToDir(2.0, -12);
engine.update(2600);
const c3_reset = (engine.dwellProgress < 0.05 && seekCalls === 0);
console.log(`  t=2600ms (moved 2.0° > 0.85°): dwellProgress reset to ${engine.dwellProgress.toFixed(2)} -> ${c3_reset ? 'PASS (dwell reset)' : 'FAIL'}`);

// t = 3650ms: Hold steady at new position for > 1000ms (2600 + 1050 = 3650ms)
engine.update(3650);
const c3_seek = (seekCalls === 1 && seekTarget > 0);
console.log(`  t=3650ms (held steady >1000ms): seekCalls=${seekCalls}, seekTarget=${seekTarget.toFixed(1)}s -> ${c3_seek ? 'PASS (seek executed)' : 'FAIL'}`);

if (!c3_reset || !c3_seek) {
  allPassed = false;
  console.log('  ❌ Check 3 FAILED');
} else {
  console.log('  ✅ Check 3 PASSED');
}

// 4. Fail-honest Viewer/Lens Policy Check
console.log('\nCheck 4: Fail-honest Unvalidated Viewer Profile Policy:');
const unvalidatedProfile = {
  viewerProfileId: 'viewer:my_profile',
  confidence: 'working-user-tuned',
  isCalibrated: false,
  lensCorrectionEnabled: true,
  screenToLensDistance: 0.0436
};
const effectiveProfile = getEffectiveViewerProfile(unvalidatedProfile);
console.log(`  Input Profile: isCalibrated=${unvalidatedProfile.isCalibrated}, lensCorrectionEnabled=${unvalidatedProfile.lensCorrectionEnabled}`);
console.log(`  Effective Profile: lensCorrectionEnabled=${effectiveProfile.lensCorrectionEnabled}, reason=${effectiveProfile._lensCorrectionSuppressedReason}`);

const c4_pass = (effectiveProfile.lensCorrectionEnabled === false && effectiveProfile._lensCorrectionSuppressedReason === 'unvalidated_viewer_profile');
if (!c4_pass) {
  allPassed = false;
  console.log('  ❌ Check 4 FAILED');
} else {
  console.log('  ✅ Check 4 PASSED');
}

// ============================================================================
// Issue #23: Deterministic Media Switch Failure Isolation & Recovery
// ============================================================================
import { MediaController } from './src/media/playback.js';

console.log('\n=== RUNNING ISSUE #23 DETERMINISTIC MEDIA RECOVERY CHECKS ===\n');

class MockVideoElement {
  constructor() {
    this.src = '';
    this.paused = true;
    this.readyState = 0;
    this.networkState = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.currentTime = 0;
    this.duration = 0;
    this.error = null;
    this.eventListeners = {};
    this.rvfcCallbacks = new Map();
    this.nextRvfcId = 1;
    this.loadCalls = 0;
    this.pauseCalls = 0;
    this.playCalls = 0;
    this.cancelRvfcCalls = [];
  }

  addEventListener(event, listener) {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(listener);
  }

  removeEventListener(event, listener) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(l => l !== listener);
    }
  }

  dispatchEvent(event) {
    const type = event.type || event;
    const list = this.eventListeners[type] || [];
    for (const l of list) l(event);
  }

  removeAttribute(attr) {
    if (attr === 'src') this.src = '';
  }

  load() {
    this.loadCalls++;
  }

  pause() {
    this.pauseCalls++;
    this.paused = true;
    this.dispatchEvent('pause');
  }

  play() {
    this.playCalls++;
    this.paused = false;
    this.dispatchEvent('play');
    return Promise.resolve();
  }

  requestVideoFrameCallback(cb) {
    const id = this.nextRvfcId++;
    this.rvfcCallbacks.set(id, cb);
    return id;
  }

  cancelVideoFrameCallback(id) {
    this.cancelRvfcCalls.push(id);
    this.rvfcCallbacks.delete(id);
  }

  triggerRvfc(now, metadata = {}) {
    const entries = Array.from(this.rvfcCallbacks.entries());
    this.rvfcCallbacks.clear();
    for (const [id, cb] of entries) {
      cb(now, {
        mediaTime: this.currentTime,
        presentedFrames: 1,
        width: this.videoWidth,
        height: this.videoHeight,
        ...metadata
      });
    }
  }

  triggerError(code, message = '') {
    this.error = { code, message };
    this.networkState = 3;
    this.dispatchEvent({ type: 'error' });
  }
}

class MockVRRenderer {
  constructor() {
    this.resetCalls = 0;
    this.updateCalls = 0;
  }

  resetVideoTexture() {
    this.resetCalls++;
  }

  updateVideoTexture(el) {
    this.updateCalls++;
    state.firstFrameTimings.firstTextureUploadAt = performance.now();
  }
}

// Issue 23 - Check 1: Playable A -> Unsupported B (Fail Closed)
console.log('Issue 23 - Check 1: Playable A -> Unsupported B (Fail Closed):');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();
  const loggedErrors = [];
  const controller = new MediaController(video, null);
  controller.attachRenderer(renderer);
  controller.setRemoteLogHook((level, msg, data) => loggedErrors.push({ level, msg, data }));

  // Playable A
  controller.selectVideo('4K/playable_A.mp4');
  const genA = controller.currentMediaGeneration;
  video.readyState = 4;
  video.videoWidth = 3840;
  video.videoHeight = 1920;
  video.triggerRvfc(100);
  assert(controller.shouldUploadTexture(), 'Upload allowed for A');
  renderer.updateVideoTexture(video);

  // Unsupported B
  controller.selectVideo('unsupported/broken_B.mp4');
  const genB = controller.currentMediaGeneration;
  const passGenB = (genB === genA + 1);
  const passResetB = (renderer.resetCalls === 2);
  const passUploadB = (!controller.videoFrameNeedsUpload);
  const passReadyB = (!state.firstFrameTimings.ready);

  // Trigger Code 4
  video.triggerError(4, 'Format not supported');
  const passErrorB = (state.firstFrameTimings.statusText.includes('MEDIA_ERR_SRC_NOT_SUPPORTED'));
  const passLoggedB = (loggedErrors.length === 1 && loggedErrors[0].data.code === 4);

  if (passGenB && passResetB && passUploadB && passReadyB && passErrorB && passLoggedB) {
    console.log('  ✅ Issue 23 - Check 1 PASSED');
  } else {
    console.log('  ❌ Issue 23 - Check 1 FAILED');
    allPassed = false;
  }
}

// Issue 23 - Check 2: Playable A -> Unsupported B -> Playable C (Full Recovery)
console.log('\nIssue 23 - Check 2: Playable A -> Unsupported B -> Playable C (Full Recovery):');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();
  const loggedErrors = [];
  const controller = new MediaController(video, null);
  controller.attachRenderer(renderer);
  controller.setRemoteLogHook((level, msg, data) => loggedErrors.push({ level, msg, data }));

  // A -> B (failed)
  controller.selectVideo('4K/playable_A.mp4');
  video.readyState = 4;
  video.triggerRvfc(100);
  controller.selectVideo('unsupported/broken_B.mp4');
  video.triggerError(4, 'Cannot play');

  // Select C
  const preLoads = video.loadCalls;
  controller.selectVideo('4K/playable_C.mp4');
  const genC = controller.currentMediaGeneration;
  const passTeardownC = (video.loadCalls >= preLoads + 2); // Teardown load() + new source load()
  const passSrcC = video.src.includes('playable_C.mp4');

  // C decodes
  video.error = null;
  video.readyState = 4;
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  video.triggerRvfc(200);

  const passUploadC = controller.shouldUploadTexture();
  renderer.updateVideoTexture(video);
  const passDecodedC = (state.firstFrameTimings.firstFrameDecodedAt > 0);

  if (genC === 3 && passTeardownC && passSrcC && passUploadC && passDecodedC) {
    console.log('  ✅ Issue 23 - Check 2 PASSED');
  } else {
    console.log('  ❌ Issue 23 - Check 2 FAILED');
    allPassed = false;
  }
}

// Issue 23 - Check 3: Stale Callback & Stale Event Isolation
console.log('\nIssue 23 - Check 3: Stale Callback & Event Isolation:');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();
  const controller = new MediaController(video, null);
  controller.attachRenderer(renderer);

  controller.selectVideo('media_1.mp4');
  const gen1 = controller.currentMediaGeneration;

  // Next media selected before callback fires
  controller.selectVideo('media_2.mp4');
  const gen2 = controller.currentMediaGeneration;

  // Stale callback from gen 1 arrives
  controller.handleDecodedFrame(gen1, 500, { mediaTime: 1.0 });
  const passStaleDiscarded = (controller.videoFrameNeedsUpload === false && state.firstFrameTimings.firstFrameDecodedAt === 0);
  const passRvfcCanceled = (video.cancelRvfcCalls.length > 0);

  if (passStaleDiscarded && passRvfcCanceled && gen2 === gen1 + 1) {
    console.log('  ✅ Issue 23 - Check 3 PASSED');
  } else {
    console.log('  ❌ Issue 23 - Check 3 FAILED');
    allPassed = false;
  }
}

// Issue 23 - Check 4: Ordinary Playable A -> Playable B Switching
console.log('\nIssue 23 - Check 4: Ordinary Playable A -> Playable B Switching:');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();
  const controller = new MediaController(video, null);
  controller.attachRenderer(renderer);

  controller.selectVideo('4K/vidA.mp4');
  video.readyState = 4;
  video.triggerRvfc(100);
  const passA = controller.shouldUploadTexture();
  renderer.updateVideoTexture(video);

  controller.selectVideo('4K/vidB.mp4');
  const passPreB = (!controller.shouldUploadTexture());
  video.readyState = 4;
  video.triggerRvfc(200);
  const passPostB = controller.shouldUploadTexture();
  renderer.updateVideoTexture(video);

  if (passA && passPreB && passPostB && renderer.updateCalls === 2) {
    console.log('  ✅ Issue 23 - Check 4 PASSED');
  } else {
    console.log('  ❌ Issue 23 - Check 4 FAILED');
    allPassed = false;
  }
}

// Issue 23 - Check 5: Telemetry Error Seam Event Structure
console.log('\nIssue 23 - Check 5: Telemetry Error Seam Event Structure:');
{
  const video = new MockVideoElement();
  const logged = [];
  const controller = new MediaController(video, null);
  controller.setRemoteLogHook((level, msg, data) => logged.push({ level, msg, data }));

  controller.selectVideo('bad/codec.mp4');
  video.networkState = 3;
  video.triggerError(4, 'Source not supported');

  const passLog = (logged.length === 1 &&
                   logged[0].level === 'ERROR' &&
                   logged[0].msg === 'MEDIA_PLAYBACK_ERROR' &&
                   logged[0].data.generation === controller.currentMediaGeneration &&
                   logged[0].data.code === 4 &&
                   logged[0].data.name === 'MEDIA_ERR_SRC_NOT_SUPPORTED');

  if (passLog) {
    console.log('  ✅ Issue 23 - Check 5 PASSED');
  } else {
    console.log('  ❌ Issue 23 - Check 5 FAILED');
    allPassed = false;
  }
}

console.log('\n------------------------------------------------------------');
if (allPassed) {
  console.log('OVERALL REGRESSION & ISSUE #23 VERIFICATION: ✅ ALL PASSED');
} else {
  console.log('OVERALL REGRESSION & ISSUE #23 VERIFICATION: ❌ SOME FAILED');
  process.exit(1);
}
