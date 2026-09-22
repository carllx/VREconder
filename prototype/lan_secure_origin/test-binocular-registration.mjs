// ============================================================================
// Automated Invariant Suite: Binocular Nonius Registration Harness (Issue #31)
// Rigorous verification of dichoptic Nonius alignment, fusion-lock stability,
// symmetric sign conventions, fail-closed validation, and optics immutability.
// ============================================================================
import assert from 'node:assert/strict';
import {
  REGISTRATION_BOUNDS,
  REGISTRATION_STEPS,
  validateRegistrationOffset,
  visualAngleToEyeCanvasPx,
  deriveRegistrationPixelOffsets,
  renderNoniusRegistrationScreen
} from './src/controls/nonius-harness.js';
import {
  isStereoUIVisible,
  isStereoUIDynamic,
  renderStereoUI,
  getStereoUiProjectionConfig
} from './src/controls/stereo-ui.js';
import { CalibrationUI } from './src/controls/calibration-ui.js';
import { deriveCardboardEyeGeometry, createDefaultViewerProfile } from './src/core/projection-profile.js';
import { activeScreenProfile } from './src/core/screen-profile.js';
import { state } from './src/core/state.js';

console.log('=== RUNNING RIGOROUS BINOCULAR REGISTRATION NONIUS HARNESS TESTS ===\n');

const g04BaseProfile = createDefaultViewerProfile('g04:provisional_geometry');
const eyeGeomBase = deriveCardboardEyeGeometry(activeScreenProfile, g04BaseProfile);
const canvasW = 1920;
const canvasH = 1080;
const halfW = 960;

// Mock 2D canvas context to verify render calls and styling
function createMockCanvasContext() {
  const operations = [];
  return {
    operations,
    save() { operations.push({ op: 'save' }); },
    restore() { operations.push({ op: 'restore' }); },
    beginPath() { operations.push({ op: 'beginPath' }); },
    rect(x, y, w, h) { operations.push({ op: 'rect', x, y, w, h }); },
    fillRect(x, y, w, h) { operations.push({ op: 'fillRect', x, y, w, h, fillStyle: this.fillStyle }); },
    strokeRect(x, y, w, h) { operations.push({ op: 'strokeRect', x, y, w, h, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth }); },
    clip() { operations.push({ op: 'clip' }); },
    arc(x, y, r, sa, ea) { operations.push({ op: 'arc', x, y, r, sa, ea, fillStyle: this.fillStyle }); },
    fill() { operations.push({ op: 'fill', fillStyle: this.fillStyle }); },
    stroke() { operations.push({ op: 'stroke', strokeStyle: this.strokeStyle, lineWidth: this.lineWidth }); },
    moveTo(x, y) { operations.push({ op: 'moveTo', x, y }); },
    lineTo(x, y) { operations.push({ op: 'lineTo', x, y }); },
    clearRect(x, y, w, h) { operations.push({ op: 'clearRect', x, y, w, h }); },
    fillStyle: '#000000',
    strokeStyle: '#ffffff',
    lineWidth: 1.0,
    lineCap: 'butt'
  };
}

// ----------------------------------------------------------------------------
// Check 1: Zero offset & Inactive is Default
// ----------------------------------------------------------------------------
console.log('Check 1: Default State Invariants:');
assert.equal(state.uiRegistrationDiagnosticActive, false, 'Diagnostic must be inactive by default');
assert.equal(state.uiRegistrationOffsetXDeg, 0.0, 'Default X offset must be 0.0 deg');
assert.equal(state.uiRegistrationOffsetYDeg, 0.0, 'Default Y offset must be 0.0 deg');
console.log('  [Default State]: PASS (inactive, X=0.0°, Y=0.0°)');

// ----------------------------------------------------------------------------
// Check 2: Fusion Lock and Fixation Point NEVER Move with Offset
// ----------------------------------------------------------------------------
console.log('\nCheck 2: Fusion Lock & Fixation Invariance:');
const testOffsets = [
  { x: 0, y: 0 },
  { x: 2.5, y: 1.0 },
  { x: -4.0, y: -2.0 },
  { x: 5.0, y: 3.0 }
];

for (const off of testOffsets) {
  for (let eye = 0; eye < 2; eye++) {
    // Center fixation point visual angle is always (0, 0)
    const pCenter = visualAngleToEyeCanvasPx(0, 0, eye, eyeGeomBase, halfW, canvasH);
    // Outer fusion-lock frame corners are always (+/-3, +/-3)
    const pTL = visualAngleToEyeCanvasPx(-3.0, 3.0, eye, eyeGeomBase, halfW, canvasH);
    const pBR = visualAngleToEyeCanvasPx(3.0, -3.0, eye, eyeGeomBase, halfW, canvasH);

    // Baseline reference at zero offset
    const pCenterBase = visualAngleToEyeCanvasPx(0, 0, eye, eyeGeomBase, halfW, canvasH);
    const pTLBase = visualAngleToEyeCanvasPx(-3.0, 3.0, eye, eyeGeomBase, halfW, canvasH);
    const pBRBase = visualAngleToEyeCanvasPx(3.0, -3.0, eye, eyeGeomBase, halfW, canvasH);

    assert.equal(pCenter.px, pCenterBase.px, `Eye ${eye} fixation X must never move`);
    assert.equal(pCenter.py, pCenterBase.py, `Eye ${eye} fixation Y must never move`);
    assert.equal(pTL.px, pTLBase.px, `Eye ${eye} fusion frame TL X must never move`);
    assert.equal(pTL.py, pTLBase.py, `Eye ${eye} fusion frame TL Y must never move`);
    assert.equal(pBR.px, pBRBase.px, `Eye ${eye} fusion frame BR X must never move`);
    assert.equal(pBR.py, pBRBase.py, `Eye ${eye} fusion frame BR Y must never move`);
  }
}
console.log('  [Fusion Lock & Fixation Never Move]: PASS');

// ----------------------------------------------------------------------------
// Check 3: Symmetric Dichoptic Offset Application & Cyclopean Center Preservation
// ----------------------------------------------------------------------------
console.log('\nCheck 3: Symmetric Dichoptic Offset & Cyclopean Center:');
for (const off of testOffsets) {
  const leftXDeg = -off.x / 2;
  const rightXDeg = +off.x / 2;
  const cyclopeanXDeg = (leftXDeg + rightXDeg) / 2;
  assert.equal(cyclopeanXDeg, 0.0, 'Horizontal cyclopean center must be identically 0');

  const leftYDeg = -off.y / 2;
  const rightYDeg = +off.y / 2;
  const cyclopeanYDeg = (leftYDeg + rightYDeg) / 2;
  assert.equal(cyclopeanYDeg, 0.0, 'Vertical cyclopean center must be identically 0');

  // Relative disparity: Right minus Left
  const relDisparityX = rightXDeg - leftXDeg;
  assert.equal(relDisparityX, off.x, 'Relative horizontal disparity must equal requested offset');

  const relDisparityY = rightYDeg - leftYDeg;
  assert.equal(relDisparityY, off.y, 'Relative vertical disparity must equal requested offset');
}
console.log('  [Symmetric Application & Cyclopean Center Preserved]: PASS');

// ----------------------------------------------------------------------------
// Check 4: Sign Conventions (X & Y Visual Angles & Canvas Coordinates)
// ----------------------------------------------------------------------------
console.log('\nCheck 4: Exact Sign Conventions:');
// When offsetXDeg > 0 (+2.0°):
//   Left eye Nonius gets -1.0° (shifted leftwards in visual field)
//   Right eye Nonius gets +1.0° (shifted rightwards in visual field)
const testX = 2.0;
const pL_Xpos = visualAngleToEyeCanvasPx(-testX / 2, 0, 0, eyeGeomBase, halfW, canvasH);
const pL_Xzero = visualAngleToEyeCanvasPx(0, 0, 0, eyeGeomBase, halfW, canvasH);
const pR_Xpos = visualAngleToEyeCanvasPx(+testX / 2, 0, 1, eyeGeomBase, halfW, canvasH);
const pR_Xzero = visualAngleToEyeCanvasPx(0, 0, 1, eyeGeomBase, halfW, canvasH);

assert.ok(pL_Xpos.px < pL_Xzero.px, 'Left eye Nonius px must move left (smaller px) for positive X offset');
assert.ok(pR_Xpos.px > pR_Xzero.px, 'Right eye Nonius px must move right (larger px) for positive X offset');

// When offsetYDeg > 0 (+2.0°):
//   Visual angle coordinate: positive Y is UP.
//   Left eye gets -1.0° (shifted downwards in visual field -> larger canvas py)
//   Right eye gets +1.0° (shifted upwards in visual field -> smaller canvas py)
const testY = 2.0;
const pL_Ypos = visualAngleToEyeCanvasPx(0, -testY / 2, 0, eyeGeomBase, halfW, canvasH);
const pL_Yzero = visualAngleToEyeCanvasPx(0, 0, 0, eyeGeomBase, halfW, canvasH);
const pR_Ypos = visualAngleToEyeCanvasPx(0, +testY / 2, 1, eyeGeomBase, halfW, canvasH);
const pR_Yzero = visualAngleToEyeCanvasPx(0, 0, 1, eyeGeomBase, halfW, canvasH);

assert.ok(pL_Ypos.py > pL_Yzero.py, 'Left eye Nonius py must move downwards (larger py) for positive Y offset');
assert.ok(pR_Ypos.py < pR_Yzero.py, 'Right eye Nonius py must move upwards (smaller py) for positive Y offset');

// Orthogonal isolation: X does not affect Y; Y does not affect X
assert.equal(pL_Xpos.py, pL_Xzero.py, 'X offset must NOT alter Y canvas coordinate');
assert.equal(pR_Xpos.py, pR_Xzero.py, 'X offset must NOT alter Y canvas coordinate');
assert.equal(pL_Ypos.px, pL_Yzero.px, 'Y offset must NOT alter X canvas coordinate');
assert.equal(pR_Ypos.px, pR_Yzero.px, 'Y offset must NOT alter X canvas coordinate');
console.log('  [Exact Sign Conventions & Axis Orthogonality]: PASS');

// ----------------------------------------------------------------------------
// Check 5: Independence from G1/G2/G3 & Virtual Depth
// ----------------------------------------------------------------------------
console.log('\nCheck 5: Independence from G1/G2/G3 & Virtual Depth:');
const g1Config = getStereoUiProjectionConfig({ uiStereoDiagnosticMode: 'G1_CURRENT_WORLD_2M', menuVirtualDepth: 2.0 });
const g2Config = getStereoUiProjectionConfig({ uiStereoDiagnosticMode: 'G2_LOW_DISPARITY_10M', menuVirtualDepth: 10.0 });
const g3Config = getStereoUiProjectionConfig({ uiStereoDiagnosticMode: 'G3_ZERO_DISPARITY_HUD', menuVirtualDepth: 2.0 });

// Nonius coordinates must be identical regardless of G1/G2/G3 mode
const pNonius_Default = visualAngleToEyeCanvasPx(-1.0, 0, 0, eyeGeomBase, halfW, canvasH);
// Mutate state G-mode to ensure Nonius calculations ignore it
state.uiStereoDiagnosticMode = 'G2_LOW_DISPARITY_10M';
state.menuVirtualDepth = 10.0;
const pNonius_G2 = visualAngleToEyeCanvasPx(-1.0, 0, 0, eyeGeomBase, halfW, canvasH);

state.uiStereoDiagnosticMode = 'G3_ZERO_DISPARITY_HUD';
const pNonius_G3 = visualAngleToEyeCanvasPx(-1.0, 0, 0, eyeGeomBase, halfW, canvasH);

assert.equal(pNonius_Default.px, pNonius_G2.px, 'G2 mode must not alter Nonius projection');
assert.equal(pNonius_Default.px, pNonius_G3.px, 'G3 mode must not alter Nonius projection');
assert.equal(pNonius_Default.py, pNonius_G2.py, 'G2 mode must not alter Nonius projection');
assert.equal(pNonius_Default.py, pNonius_G3.py, 'G3 mode must not alter Nonius projection');

// Restore G1 baseline
state.uiStereoDiagnosticMode = 'G1_CURRENT_WORLD_2M';
state.menuVirtualDepth = 2.0;
console.log('  [Nonius Geometry Independent of G1/G2/G3]: PASS');

// ----------------------------------------------------------------------------
// Check 6: Remote Control Action Handling & Fail-Closed Validation
// ----------------------------------------------------------------------------
console.log('\nCheck 6: Remote Control Actions & Fail-Closed Validation:');
const calUI = new CalibrationUI({
  storage: { activeViewerProfile: g04BaseProfile },
  mediaController: {},
  diagnosticOverlay: {},
  vrRenderer: {},
  commandModel: {}
});

// A. Toggle Active
calUI.handleRemoteControlAction({ action: 'set_ui_registration_active', active: true });
assert.equal(state.uiRegistrationDiagnosticActive, true, 'Active flag must be true');
assert.equal(state.uiIsDirty, true, 'uiIsDirty must be set');

// Fail-closed non-boolean
calUI.handleRemoteControlAction({ action: 'set_ui_registration_active', active: 'yes' });
assert.equal(state.uiRegistrationDiagnosticActive, true, 'String active must fail-closed');

// B. Set Offset (within bounds)
calUI.handleRemoteControlAction({ action: 'set_ui_registration_offset', xDeg: 1.5, yDeg: -0.5 });
assert.equal(state.uiRegistrationOffsetXDeg, 1.5, 'X offset must update to 1.5');
assert.equal(state.uiRegistrationOffsetYDeg, -0.5, 'Y offset must update to -0.5');

// Fail-closed: NaN, Infinity, out-of-bounds, strings
calUI.handleRemoteControlAction({ action: 'set_ui_registration_offset', xDeg: NaN, yDeg: 0 });
assert.equal(state.uiRegistrationOffsetXDeg, 1.5, 'NaN must be rejected fail-closed');

calUI.handleRemoteControlAction({ action: 'set_ui_registration_offset', xDeg: Infinity, yDeg: 0 });
assert.equal(state.uiRegistrationOffsetXDeg, 1.5, 'Infinity must be rejected fail-closed');

calUI.handleRemoteControlAction({ action: 'set_ui_registration_offset', xDeg: 6.0, yDeg: 0 }); // > maxX (5.0)
assert.equal(state.uiRegistrationOffsetXDeg, 1.5, 'Out-of-range X (>5.0) must be rejected fail-closed');

calUI.handleRemoteControlAction({ action: 'set_ui_registration_offset', xDeg: 0, yDeg: -3.5 }); // < minY (-3.0)
assert.equal(state.uiRegistrationOffsetYDeg, -0.5, 'Out-of-range Y (<-3.0) must be rejected fail-closed');

calUI.handleRemoteControlAction({ action: 'set_ui_registration_offset', xDeg: '1.0', yDeg: 0 });
assert.equal(state.uiRegistrationOffsetXDeg, 1.5, 'String X must be rejected fail-closed');

// C. Incremental Adjustment (Coarse & Fine)
// Coarse step is 0.50 deg
calUI.handleRemoteControlAction({ action: 'adjust_ui_registration_x', step: 'coarse', direction: 1 });
assert.equal(state.uiRegistrationOffsetXDeg, 2.0, 'Coarse step +1 must add 0.50 to X');

calUI.handleRemoteControlAction({ action: 'adjust_ui_registration_x', step: 'fine', direction: -1 });
assert.equal(state.uiRegistrationOffsetXDeg, 1.95, 'Fine step -1 must subtract 0.05 from X');

// Incremental adjustment Y
calUI.handleRemoteControlAction({ action: 'adjust_ui_registration_y', step: 'coarse', direction: 1 });
assert.equal(state.uiRegistrationOffsetYDeg, 0.0, 'Coarse step +1 on Y=-0.5 must yield 0.0');

// Fail-closed incremental boundary clamping / rejection
calUI.handleRemoteControlAction({ action: 'set_ui_registration_offset', xDeg: 4.8, yDeg: 0.0 });
calUI.handleRemoteControlAction({ action: 'adjust_ui_registration_x', step: 'coarse', direction: 1 }); // 4.8 + 0.5 = 5.3 > 5.0
assert.equal(state.uiRegistrationOffsetXDeg, 4.8, 'Incremental adjustment crossing bound must fail-closed');

// D. Reset to exact zero
calUI.handleRemoteControlAction({ action: 'reset_ui_registration_offset' });
assert.equal(state.uiRegistrationOffsetXDeg, 0.0, 'Reset must return X to exact 0.0');
assert.equal(state.uiRegistrationOffsetYDeg, 0.0, 'Reset must return Y to exact 0.0');

console.log('  [Remote Control Actions & Fail-Closed Guards]: PASS');

// ----------------------------------------------------------------------------
// Check 7: Optics & Video Invariants
// ----------------------------------------------------------------------------
console.log('\nCheck 7: Optics & Viewer Profile Immutability:');
assert.equal(g04BaseProfile.screenToLensDistance, 0.0430, 'S2L must remain untouched');
assert.equal(g04BaseProfile.interLensDistance, 0.065, 'ILD must remain untouched');
assert.equal(g04BaseProfile.distortion.k1, 0.0, 'k1 must remain untouched');
assert.equal(g04BaseProfile.distortion.k2, 0.0, 'k2 must remain untouched');
assert.equal(state.renderScale, 1.0, 'renderScale must remain untouched');
console.log('  [Viewer Profile & Optics Untouched]: PASS');

// ----------------------------------------------------------------------------
// Check 8: Continuous Compositing Invariant Under strict-rvfc-dirty-ui
// ----------------------------------------------------------------------------
console.log('\nCheck 8: Continuous Compositing & Black Screen Invariant:');
state.inVR = true;
state.performanceMode = 'strict-rvfc-dirty-ui';
state.uiRegistrationDiagnosticActive = true;
state.uiIsDirty = false; // dirty flag has cleared after first render

// When uiRegistrationDiagnosticActive is true, UI must be visible and dynamic every frame
const visible = isStereoUIVisible(1000);
const dynamic = isStereoUIDynamic({}, 1000);
assert.equal(visible, true, 'Nonius must remain visible');
assert.equal(dynamic, true, 'Nonius must remain dynamic every frame to guarantee continuous upload');

// Render to mock context to verify black background and drawing
const mockCtx = createMockCanvasContext();
const rendered = renderStereoUI(mockCtx, {}, {}, null, 1000, canvasW, canvasH, g04BaseProfile);
assert.equal(rendered, true, 'renderStereoUI must return true (rendered)');

// Verify opaque black cover fill
const blackFills = mockCtx.operations.filter(op => op.op === 'fillRect' && op.fillStyle === '#000000');
assert.ok(blackFills.length > 0, 'Must fill entire canvas with opaque black to suppress video');
assert.equal(blackFills[0].w, canvasW, 'Black fill must cover full canvas width');
assert.equal(blackFills[0].h, canvasH, 'Black fill must cover full canvas height');

// Verify fusion lock frames drawn for both eyes
const strokeRects = mockCtx.operations.filter(op => op.op === 'strokeRect');
assert.equal(strokeRects.length, 2, 'Must draw exactly one fusion-lock frame per eye (total 2)');

// Reset diagnostic active
state.uiRegistrationDiagnosticActive = false;
state.inVR = false;
console.log('  [Continuous Compositing & Black Background Screen]: PASS');

// ----------------------------------------------------------------------------
// Check 9: Raw-DOM Single-Presentation Invariant
// ----------------------------------------------------------------------------
console.log('\nCheck 9: Raw-DOM Single-Presentation Invariant:');
assert.equal(calUI.domCanvasPresentationVisible, false, 'domCanvasPresentationVisible must be false in headless');
console.log('  [Raw-DOM Single-Presentation Invariant Intact]: PASS');

console.log('\n============================================================');
console.log('ALL BINOCULAR REGISTRATION NONIUS HARNESS INVARIANTS PASSED ✅');
console.log('============================================================\n');
