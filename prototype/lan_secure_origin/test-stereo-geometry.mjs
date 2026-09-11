// ==========================================
// Deterministic Stereoscopic UI Geometry Verification
// ==========================================
import { projectWorldDirToEye } from './src/controls/stereo-ui.js';
import { sphericalToDir, getActiveInteractiveItems } from './src/controls/patterns.js';
import { deriveCardboardEyeGeometry, createDefaultViewerProfile } from './src/core/projection-profile.js';
import { activeScreenProfile } from './src/core/screen-profile.js';
import { state } from './src/core/state.js';
import { qCameraInv } from './src/core/orientation.js';

console.log('=== RUNNING DETERMINISTIC STEREO UI GEOMETRY CHECKS ===\n');

// 1. Setup deterministic symmetric test eye geometry
const testViewerProfile = createDefaultViewerProfile('cardboard:reference_50deg');
const eyeGeom = deriveCardboardEyeGeometry(activeScreenProfile, testViewerProfile);

const halfW = 960;
const height = 1080;
const virtualDepth = 2.0;

// Camera at identity
qCameraInv.setIdentity();

// Optical center calculation for Left Eye (index 0)
const leftEyeData = eyeGeom.leftEye;
const [tanL, tanR, tanB, tanT] = leftEyeData.virtTanBounds;
const eyeOffset = leftEyeData.eyeFromHeadMeters; // [-halfIpd, 0, 0]

const centerTanX = -eyeOffset[0] / virtualDepth;
const centerTanY = -eyeOffset[1] / virtualDepth;
const centerU = (centerTanX + tanL) / (tanL + tanR);
const centerV = (centerTanY + tanB) / (tanB + tanT);
const eyeCenterX = centerU * halfW;
const eyeCenterY = (1.0 - centerV) * height;

console.log(`Optical Center (Left Eye): centerU=${centerU.toFixed(4)}, centerV=${centerV.toFixed(4)}, canvasX=${eyeCenterX.toFixed(1)}px, canvasY=${eyeCenterY.toFixed(1)}px`);

let pass = true;

// Check 1: World target pitch +10°
const dirPitchPlus10 = sphericalToDir(0, 10);
const projPitchPlus10 = projectWorldDirToEye(dirPitchPlus10, 0, eyeGeom, halfW, height, virtualDepth);
console.log(`\nCheck 1 (Target Pitch +10°):`);
console.log(`  dirWorld: [${dirPitchPlus10.map(v => v.toFixed(4)).join(', ')}]`);
console.log(`  computed v: ${projPitchPlus10.v.toFixed(4)} (centerV: ${centerV.toFixed(4)})`);
console.log(`  computed canvas Y: ${projPitchPlus10.y.toFixed(1)}px (eyeCenterY: ${eyeCenterY.toFixed(1)}px)`);

const c1_v = projPitchPlus10.v > centerV;
const c1_y = projPitchPlus10.y < eyeCenterY;
console.log(`  [v > centerV]: ${c1_v ? 'PASS' : 'FAIL'} | [canvas Y < centerY]: ${c1_y ? 'PASS' : 'FAIL'}`);
if (!c1_v || !c1_y) pass = false;

// Check 2: World target pitch -10°
const dirPitchMinus10 = sphericalToDir(0, -10);
const projPitchMinus10 = projectWorldDirToEye(dirPitchMinus10, 0, eyeGeom, halfW, height, virtualDepth);
console.log(`\nCheck 2 (Target Pitch -10°):`);
console.log(`  dirWorld: [${dirPitchMinus10.map(v => v.toFixed(4)).join(', ')}]`);
console.log(`  computed v: ${projPitchMinus10.v.toFixed(4)} (centerV: ${centerV.toFixed(4)})`);
console.log(`  computed canvas Y: ${projPitchMinus10.y.toFixed(1)}px (eyeCenterY: ${eyeCenterY.toFixed(1)}px)`);

const c2_y = projPitchMinus10.y > eyeCenterY;
console.log(`  [canvas Y > centerY]: ${c2_y ? 'PASS' : 'FAIL'}`);
if (!c2_y) pass = false;

// Check 3: World target yaw +10° (Right)
const dirYawPlus10 = sphericalToDir(10, 0);
const projYawPlus10 = projectWorldDirToEye(dirYawPlus10, 0, eyeGeom, halfW, height, virtualDepth);
console.log(`\nCheck 3 (Target Yaw +10° - Right):`);
console.log(`  dirWorld: [${dirYawPlus10.map(v => v.toFixed(4)).join(', ')}]`);
console.log(`  computed canvas X: ${projYawPlus10.x.toFixed(1)}px (eyeCenterX: ${eyeCenterX.toFixed(1)}px)`);

const c3_x = projYawPlus10.x > eyeCenterX;
console.log(`  [local eye X moves right]: ${c3_x ? 'PASS' : 'FAIL'}`);
if (!c3_x) pass = false;

// Check 4: World target yaw -10° (Left)
const dirYawMinus10 = sphericalToDir(-10, 0);
const projYawMinus10 = projectWorldDirToEye(dirYawMinus10, 0, eyeGeom, halfW, height, virtualDepth);
console.log(`\nCheck 4 (Target Yaw -10° - Left):`);
console.log(`  dirWorld: [${dirYawMinus10.map(v => v.toFixed(4)).join(', ')}]`);
console.log(`  computed canvas X: ${projYawMinus10.x.toFixed(1)}px (eyeCenterX: ${eyeCenterX.toFixed(1)}px)`);

const c4_x = projYawMinus10.x < eyeCenterX;
console.log(`  [local eye X moves left]: ${c4_x ? 'PASS' : 'FAIL'}`);
if (!c4_x) pass = false;

// Check 5: GazeEngine target dirWorld and visual button center origin check
console.log(`\nCheck 5 (GazeEngine target dirWorld vs Visual placement):`);
state.activePattern = 'B';
state.patternB_open = true;
const mockCmd = { closeControls: () => {}, recenter: () => {}, playPause: () => {}, previous: () => {}, next: () => {}, seekForward: () => {} };
const mockVid = { paused: false };
const items = getActiveInteractiveItems(mockCmd, mockVid);

let c5_match = true;
items.forEach(item => {
  if (!item.dirWorld) return;
  const directDir = sphericalToDir(item.yaw, item.pitch);
  const diff = Math.abs(item.dirWorld[0] - directDir[0]) + Math.abs(item.dirWorld[1] - directDir[1]) + Math.abs(item.dirWorld[2] - directDir[2]);
  if (diff > 1e-6) {
    c5_match = false;
    console.log(`  Mismatch on item ${item.id}`);
  }
});
console.log(`  [items dirWorld exact match with sphericalToDir(yaw, pitch)]: ${c5_match ? 'PASS' : 'FAIL'}`);
if (!c5_match) pass = false;

console.log(`\nOVERALL GEOMETRY DETERMINISTIC CHECK: ${pass ? '✅ ALL PASSED' : '❌ FAILED'}`);
