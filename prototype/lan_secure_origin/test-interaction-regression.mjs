// ==========================================
// Deterministic Interaction & Gaze Dwell Regression Verification
// ==========================================
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

console.log(`\nOVERALL INTERACTION & POLICY REGRESSION CHECK: ${allPassed ? '✅ ALL PASSED' : '❌ FAILED'}`);
