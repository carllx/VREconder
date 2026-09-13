import assert from 'node:assert/strict';
import {
  createDefaultViewerProfile,
  getEffectiveViewerProfile,
  getRenderViewerProfile,
  isCalibrationDistortionOverrideActive,
  distortRadius,
  deriveCardboardEyeGeometry
} from './src/core/projection-profile.js';
import { activeScreenProfile } from './src/core/screen-profile.js';

console.log('--- RUNNING O4 DISTORTION PATH VERIFICATION ---');

const baseProfile = createDefaultViewerProfile();
assert.ok(baseProfile, 'G04 base profile must exist');
assert.equal(baseProfile.isCalibrated, false, 'G04 base isCalibrated must be false');
assert.equal(baseProfile.screenToLensDistance, 0.0430, 'G04 S2L must be 0.0430 (43mm)');
assert.equal(baseProfile.interLensDistance, 0.0650, 'G04 ILD must be 0.0650 (65mm)');
assert.equal(baseProfile.verticalAlignment, 'CENTER', 'G04 verticalAlignment must be CENTER');

// Test 1: Criteria A - Candidate k1/k2 applied ONLY when:
// calibrationStage === 'B' && viewerVisualMode === 'grid_only' && calibrationDistortionFittingActive === true
const stateA = {
  calibrationStage: 'B',
  viewerVisualMode: 'grid_only',
  calibrationDistortionFittingActive: true,
  candidateDistortion: { k1: 0.15, k2: -0.05 }
};
assert.equal(isCalibrationDistortionOverrideActive(stateA), true, 'Override must be active for State A');

const profileA = getRenderViewerProfile(baseProfile, stateA);
assert.equal(profileA.lensCorrectionEnabled, true, 'Lens correction must be enabled in renderViewerProfile under override');
assert.equal(profileA.distortion.k1, 0.15, 'k1 must match candidateDistortion');
assert.equal(profileA.distortion.k2, -0.05, 'k2 must match candidateDistortion');
assert.equal(profileA.isCalibrated, false, 'isCalibrated must strictly remain false in renderViewerProfile');
assert.equal(profileA.screenToLensDistance, 0.0430, 'S2L must remain 43mm');
assert.equal(profileA.interLensDistance, 0.0650, 'ILD must remain 65mm');
assert.equal(profileA.verticalAlignment, 'CENTER', 'verticalAlignment must remain CENTER');

// Verify distortRadius and eye geometry changes under candidate coefficients
const rDist = distortRadius(0.5, profileA.distortion.k1, profileA.distortion.k2);
const rIdent = distortRadius(0.5, 0, 0);
assert.notEqual(rDist, rIdent, 'Distorted radius must differ from identity');

const eyeA = deriveCardboardEyeGeometry(activeScreenProfile, profileA);
const eyeBase = deriveCardboardEyeGeometry(activeScreenProfile, baseProfile);
assert.notDeepEqual(eyeA.leftEye.virtTanBounds, eyeBase.leftEye.virtTanBounds, 'Eye geometry virtTanBounds under override must differ from base uncalibrated');
assert.notDeepEqual(eyeA.leftEye.fovDeg, eyeBase.leftEye.fovDeg, 'Eye geometry fovDeg under override must differ from base uncalibrated');

// Test 2: Criteria B - Stage B without fitting mode
const stateB = {
  calibrationStage: 'B',
  viewerVisualMode: 'grid_only',
  calibrationDistortionFittingActive: false,
  candidateDistortion: { k1: 0.15, k2: -0.05 }
};
assert.equal(isCalibrationDistortionOverrideActive(stateB), false, 'Override must be false when fitting mode is inactive');
const profileB = getRenderViewerProfile(baseProfile, stateB);
assert.equal(profileB.lensCorrectionEnabled, false, 'Lens correction must remain false when fitting mode is inactive');
assert.equal(profileB.isCalibrated, false, 'isCalibrated must be false');

// Test 3: Criteria C - Stage C (should never apply override even if fitting mode is true)
const stateC = {
  calibrationStage: 'C',
  viewerVisualMode: 'grid_only',
  calibrationDistortionFittingActive: true,
  candidateDistortion: { k1: 0.15, k2: -0.05 }
};
assert.equal(isCalibrationDistortionOverrideActive(stateC), false, 'Override must be false for Stage C');
const profileC = getRenderViewerProfile(baseProfile, stateC);
assert.equal(profileC.lensCorrectionEnabled, false, 'Lens correction must remain false for Stage C on uncalibrated G04');

// Test 4: Criteria D - Ordinary video playback (visualMode !== grid_only or stage !== B)
const stateD1 = {
  calibrationStage: 'B',
  viewerVisualMode: 'normal',
  calibrationDistortionFittingActive: true,
  candidateDistortion: { k1: 0.15, k2: -0.05 }
};
assert.equal(isCalibrationDistortionOverrideActive(stateD1), false, 'Override must be false when visualMode is normal');
const profileD1 = getRenderViewerProfile(baseProfile, stateD1);
assert.equal(profileD1.lensCorrectionEnabled, false, 'Lens correction must remain false when visualMode is normal');

const stateD2 = {
  calibrationStage: 'playback',
  viewerVisualMode: 'normal',
  calibrationDistortionFittingActive: false,
  candidateDistortion: { k1: 0.15, k2: -0.05 }
};
assert.equal(isCalibrationDistortionOverrideActive(stateD2), false, 'Override must be false during regular playback');
const profileD2 = getRenderViewerProfile(baseProfile, stateD2);
assert.equal(profileD2.lensCorrectionEnabled, false, 'Lens correction must remain false during regular playback');

// Test 5: Criteria E & F - Production getEffectiveViewerProfile is NEVER mutated or overridden
const effectiveProfile = getEffectiveViewerProfile(baseProfile);
assert.equal(effectiveProfile.isCalibrated, false, 'Production getEffectiveViewerProfile must preserve isCalibrated = false');
assert.equal(effectiveProfile.lensCorrectionEnabled, false, 'Production getEffectiveViewerProfile must preserve lensCorrectionEnabled = false for G04');
assert.equal(effectiveProfile.screenToLensDistance, 0.0430, 'Production profile S2L strictly 43mm');
assert.equal(effectiveProfile.interLensDistance, 0.0650, 'Production profile ILD strictly 65mm');
assert.equal(effectiveProfile.verticalAlignment, 'CENTER', 'Production profile verticalAlignment strictly CENTER');

console.log('ALL O4 DISTORTION PATH ASSERTIONS PASSED!');
