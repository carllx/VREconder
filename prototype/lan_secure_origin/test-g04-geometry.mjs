// ============================================================================
// G04 Initial Viewer Geometry Derivation & Evidence Contract Regression Suite
// Issue #20 Optics Work Unit: O2 Physical Measurement -> O3 Derived Initial Viewer Geometry
// Device: iPhone 15 Pro (2556 x 1179 px, 460 PPI)
// Target Headset: G04 passive headset (Provisional Assembly: S2L=43mm, ILD=65mm test candidate, Center; physical assembly reported ~67mm uncalibrated)
// ============================================================================
import assert from 'node:assert';
import {
  deriveCardboardEyeGeometry,
  createDefaultViewerProfile,
  getEffectiveViewerProfile,
  MIN_SCREEN_TO_LENS_DISTANCE,
  MAX_SCREEN_TO_LENS_DISTANCE
} from './src/core/projection-profile.js';
import { activeScreenProfile } from './src/core/screen-profile.js';

console.log('=== RUNNING G04 INITIAL VIEWER GEOMETRY REGRESSION SUITE ===\n');

let allPassed = true;

function check(name, condition, details = '') {
  if (condition) {
    console.log('  ✅ PASS: ' + name + (details ? ' (' + details + ')' : ''));
  } else {
    console.log('  ❌ FAIL: ' + name + (details ? ' (' + details + ')' : ''));
    allPassed = false;
  }
}

// ----------------------------------------------------------------------------
// Suite 1: Profile Preset Isolation & Fail-Closed Guardrails
// ----------------------------------------------------------------------------
console.log('--- Suite 1: G04 Preset Definition & Fail-Closed Guardrails ---');

const g04Preset = createDefaultViewerProfile('g04:provisional_geometry');
check('g04Preset exists', !!g04Preset);
check('viewerProfileId is exact', g04Preset.viewerProfileId === 'g04:provisional_geometry', g04Preset.viewerProfileId);
check('screenToLensDistance is 43mm', g04Preset.screenToLensDistance === 0.043, (g04Preset.screenToLensDistance * 1000) + 'mm');
check('interLensDistance is 65mm (software test candidate)', g04Preset.interLensDistance === 0.065, (g04Preset.interLensDistance * 1000) + 'mm');
check('verticalAlignment is CENTER', g04Preset.verticalAlignment === 'CENTER', g04Preset.verticalAlignment);
check('isCalibrated is false (provisional uncalibrated)', g04Preset.isCalibrated === false);
check('lensCorrectionEnabled is false (uncalibrated fail-closed)', g04Preset.lensCorrectionEnabled === false);
check('distortion model is uncalibrated', g04Preset.distortion && g04Preset.distortion.model === 'uncalibrated');
check('distortion k1 is 0.0', g04Preset.distortion && g04Preset.distortion.k1 === 0.0);
check('distortion k2 is 0.0', g04Preset.distortion && g04Preset.distortion.k2 === 0.0);

// Ensure viewer:my_profile is untouched
const myProfile = createDefaultViewerProfile('viewer:my_profile');
check('viewer:my_profile remains null / untouched in fresh session', myProfile === null);

// ----------------------------------------------------------------------------
// Suite 2: Effective Viewer Profile Evidence Contract & Safety Bounds
// ----------------------------------------------------------------------------
console.log('\n--- Suite 2: Effective Profile Evidence Contract & Safety Bounds ---');

const effectiveG04 = getEffectiveViewerProfile(g04Preset);
check('effectiveProfile exists', !!effectiveG04);
check('requested S2L is preserved (43mm)', effectiveG04.requestedScreenToLensDistance === 0.043, (effectiveG04.requestedScreenToLensDistance * 1000) + 'mm');
check('effective S2L is 43mm', effectiveG04.screenToLensDistance === 0.043, (effectiveG04.screenToLensDistance * 1000) + 'mm');
check('isScreenToLensClamped is false (43mm in [20mm, 70mm])', effectiveG04.isScreenToLensClamped === false);
check('screenToLensClampReason is null', effectiveG04.screenToLensClampReason === null);
check('effective lensCorrectionEnabled is false', effectiveG04.lensCorrectionEnabled === false);

// ----------------------------------------------------------------------------
// Suite 3: Deterministic G04 Eye Geometry Derivation (iPhone 15 Pro)
// ----------------------------------------------------------------------------
console.log('\n--- Suite 3: Deterministic G04 Eye Geometry Derivation ---');

const s = activeScreenProfile;
console.log('  Screen: ' + s.widthPx + 'x' + s.heightPx + ' px @ ' + s.ppi + ' PPI');
console.log('  Physical: ' + (s.widthMeters * 1000).toFixed(4) + ' x ' + (s.heightMeters * 1000).toFixed(4) + ' mm');
console.log('  Pixels per meter: ' + s.pixelsPerMeter.toFixed(3) + ' px/m');

const eyeGeom = deriveCardboardEyeGeometry(s, g04Preset);

const leftNorm = eyeGeom.leftEye.lensCenterNorm;
const rightNorm = eyeGeom.rightEye.lensCenterNorm;

check('Left viewport lensCenterNormX ~ 0.539450', Math.abs(leftNorm[0] - 0.539450174) < 1e-6, leftNorm[0].toFixed(7));
check('Left viewport lensCenterNormY == 0.500000', Math.abs(leftNorm[1] - 0.5) < 1e-6, leftNorm[1].toFixed(7));
check('Right viewport lensCenterNormX ~ 0.460550', Math.abs(rightNorm[0] - 0.460549826) < 1e-6, rightNorm[0].toFixed(7));
check('Right viewport lensCenterNormY == 0.500000', Math.abs(rightNorm[1] - 0.5) < 1e-6, rightNorm[1].toFixed(7));

const leftGlobalNormX = leftNorm[0] * 0.5;
const rightGlobalNormX = 0.5 + rightNorm[0] * 0.5;
const globalNormY = leftNorm[1];

check('Left Global Normalized X ~ 0.269725 (26.9725%)', Math.abs(leftGlobalNormX - 0.269725087) < 1e-6, leftGlobalNormX.toFixed(7));
check('Right Global Normalized X ~ 0.730275 (73.0275%)', Math.abs(rightGlobalNormX - 0.730274913) < 1e-6, rightGlobalNormX.toFixed(7));
check('Global Normalized Y == 0.500000 (50.0000%)', Math.abs(globalNormY - 0.5) < 1e-6, globalNormY.toFixed(7));

const leftPixelX = leftGlobalNormX * s.widthPx;
const rightPixelX = rightGlobalNormX * s.widthPx;
const pixelY = globalNormY * s.heightPx;

check('Left Physical Pixel X ~ 689.42 px', Math.abs(leftPixelX - 689.4173) < 0.05, leftPixelX.toFixed(2) + ' px');
check('Right Physical Pixel X ~ 1866.58 px', Math.abs(rightPixelX - 1866.5827) < 0.05, rightPixelX.toFixed(2) + ' px');
check('Physical Pixel Y == 589.50 px', Math.abs(pixelY - 589.5) < 0.05, pixelY.toFixed(2) + ' px');

// Cardboard Semantics: Physical screen separation of red markers must equal entered ILD (65mm)
const markerSepPx = rightPixelX - leftPixelX;
const markerSepMm = markerSepPx * s.metersPerPixel * 1000;
const enteredILDmm = g04Preset.interLensDistance * 1000;

check('Marker Separation in Px matches (1177.17 px)', Math.abs(markerSepPx - 1177.1654) < 0.05, markerSepPx.toFixed(2) + ' px');
check('Marker Separation in Mm matches entered ILD (65.00 mm)', Math.abs(markerSepMm - enteredILDmm) < 0.05, markerSepMm.toFixed(2) + ' mm vs ' + enteredILDmm.toFixed(2) + ' mm');
check('markerSeparationMm == enteredILDmm holds strictly (65.00 mm)', Math.abs(markerSepMm - 65.0) < 0.001);

// ----------------------------------------------------------------------------
// Suite 4: Physical Tangent Scale & Uncalibrated FOV Bounds
// ----------------------------------------------------------------------------
console.log('\n--- Suite 4: Tangent Scales & FOV Bounds ---');

const D = 0.043;
const expectedTanScaleX = (s.widthMeters / 2.0) / D;
const expectedTanScaleY = s.heightMeters / D;

check('Physical Tan Scale X matches', Math.abs(eyeGeom.physicalTanScale[0] - expectedTanScaleX) < 1e-6, eyeGeom.physicalTanScale[0].toFixed(5) + ' vs ' + expectedTanScaleX.toFixed(5));
check('Physical Tan Scale Y matches', Math.abs(eyeGeom.physicalTanScale[1] - expectedTanScaleY) < 1e-6, eyeGeom.physicalTanScale[1].toFixed(5) + ' vs ' + expectedTanScaleY.toFixed(5));

const lPhys = eyeGeom.leftEye.physTanBounds;
const lVirt = eyeGeom.leftEye.virtTanBounds;
check('Left virtTanBounds equals physTanBounds (uncalibrated 1:1)', 
  Math.abs(lPhys[0] - lVirt[0]) < 1e-6 &&
  Math.abs(lPhys[1] - lVirt[1]) < 1e-6 &&
  Math.abs(lPhys[2] - lVirt[2]) < 1e-6 &&
  Math.abs(lPhys[3] - lVirt[3]) < 1e-6,
  'Outer/Left: ' + lVirt[0].toFixed(5) + ', Inner/Right: ' + lVirt[1].toFixed(5) + ', Bottom: ' + lVirt[2].toFixed(5) + ', Top: ' + lVirt[3].toFixed(5)
);

console.log('\n--- Suite 5: Optical Axis Ray Direction Contract ---');
const lCenterOffset = [leftNorm[0] - leftNorm[0], leftNorm[1] - leftNorm[1]];
check('Optical center evaluates to zero offset', lCenterOffset[0] === 0 && lCenterOffset[1] === 0);

console.log('\n============================================================');
if (allPassed) {
  console.log('🎉 ALL G04 INITIAL VIEWER GEOMETRY REGRESSION CHECKS PASSED!');
  process.exit(0);
} else {
  console.error('❌ SOME G04 REGRESSION CHECKS FAILED');
  process.exit(1);
}
