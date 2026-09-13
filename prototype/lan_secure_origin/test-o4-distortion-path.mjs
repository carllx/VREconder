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
import { CalibrationUI } from './src/controls/calibration-ui.js';
import { state } from './src/core/state.js';

console.log('--- RUNNING ENHANCED O4 DISTORTION PATH & CONTROLLER REGRESSION ---');

// -------------------------------------------------------------
// Section 1: Frozen G04 Base Profile Authority
// -------------------------------------------------------------
const baseProfile = createDefaultViewerProfile();
assert.ok(baseProfile, 'G04 base profile must exist');
assert.equal(baseProfile.isCalibrated, false, 'G04 base isCalibrated must be false');
assert.equal(baseProfile.screenToLensDistance, 0.0430, 'G04 S2L must be 0.0430 (43mm)');
assert.equal(baseProfile.interLensDistance, 0.0650, 'G04 ILD must be 0.0650 (65mm)');
assert.equal(baseProfile.verticalAlignment, 'CENTER', 'G04 verticalAlignment must be CENTER');

// -------------------------------------------------------------
// Section 2: Pure Function Candidate Distortion Behavior
// -------------------------------------------------------------
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

const rDist = distortRadius(0.5, profileA.distortion.k1, profileA.distortion.k2);
const rIdent = distortRadius(0.5, 0, 0);
assert.notEqual(rDist, rIdent, 'Distorted radius must differ from identity');

const eyeA = deriveCardboardEyeGeometry(activeScreenProfile, profileA);
const eyeBase = deriveCardboardEyeGeometry(activeScreenProfile, baseProfile);
assert.notDeepEqual(eyeA.leftEye.virtTanBounds, eyeBase.leftEye.virtTanBounds, 'Eye geometry virtTanBounds under override must differ from base uncalibrated');
assert.notDeepEqual(eyeA.leftEye.fovDeg, eyeBase.leftEye.fovDeg, 'Eye geometry fovDeg under override must differ from base uncalibrated');

// -------------------------------------------------------------
// Section 3: Inactive & Stage C Boundaries
// -------------------------------------------------------------
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

const stateC = {
  calibrationStage: 'C',
  viewerVisualMode: 'grid_only',
  calibrationDistortionFittingActive: true,
  candidateDistortion: { k1: 0.15, k2: -0.05 }
};
assert.equal(isCalibrationDistortionOverrideActive(stateC), false, 'Override must be false for Stage C');
const profileC = getRenderViewerProfile(baseProfile, stateC);
assert.equal(profileC.lensCorrectionEnabled, false, 'Lens correction must remain false for Stage C on uncalibrated G04');

// -------------------------------------------------------------
// Section 4: CalibrationUI State Machine & Command Handling
// -------------------------------------------------------------
const mockStorage = {
  activeViewerProfile: createDefaultViewerProfile(),
  activeVideoProfile: {},
  saveViewerProfile: () => {},
  saveVideoProfile: () => {}
};
const calUI = new CalibrationUI({ storage: mockStorage });

// Step A: Initial state
state.calibrationStage = 'B';
state.viewerVisualMode = 'grid_only';
state.calibrationDistortionFittingActive = false;
state.candidateDistortion = { k1: 0.0, k2: 0.0 };

// Command: activate fitting mode
calUI.handleRemoteControlAction({ action: 'set_distortion_fitting_mode', enabled: true });
assert.equal(state.calibrationDistortionFittingActive, true, 'Fitting mode must activate in Stage B + grid_only');

// Command: set candidate distortion
calUI.handleRemoteControlAction({ action: 'set_candidate_distortion', k1: 0.08, k2: -0.02 });
assert.equal(state.candidateDistortion.k1, 0.08, 'Candidate k1 must be updated');
assert.equal(state.candidateDistortion.k2, -0.02, 'Candidate k2 must be updated');

// Check that base viewer profile was NOT mutated by candidate setting
assert.equal(calUI.activeViewerProfile.distortion.k1, 0.0, 'Base profile k1 must not be mutated');
assert.equal(calUI.activeViewerProfile.distortion.k2, 0.0, 'Base profile k2 must not be mutated');

// Command: attempt set_viewer_params during active fitting mode (MUST BE BLOCKED / NO-OP)
calUI.handleRemoteControlAction({
  action: 'set_viewer_params',
  screenToLensMm: 50.0,
  interLensMm: 70.0,
  maxFovDeg: 60.0
});
assert.equal(calUI.activeViewerProfile.screenToLensDistance, 0.0430, 'S2L must NOT be mutated during fitting mode');
assert.equal(calUI.activeViewerProfile.interLensDistance, 0.0650, 'ILD must NOT be mutated during fitting mode');
assert.equal(calUI.activeViewerProfile.maxFovAngles.outerDeg, 50.0, 'FOV must NOT be mutated during fitting mode');

// Command: attempt toggle lens correction during active fitting mode (MUST BE BLOCKED)
calUI.handleRemoteControlAction({ action: 'set_lens_correction', enabled: true });
assert.equal(calUI.activeViewerProfile.lensCorrectionEnabled, false, 'Base lensCorrectionEnabled must NOT be toggled during fitting mode');

// Step B: Leaving grid_only auto-clears fitting mode
calUI.handleRemoteControlAction({ action: 'set_viewer_visual_mode', mode: 'ild_fusion' });
assert.equal(state.viewerVisualMode, 'ild_fusion', 'Visual mode updated to ild_fusion');
assert.equal(state.calibrationDistortionFittingActive, false, 'Switching away from grid_only must clear fitting mode');

// Step C: Reactivating fitting mode outside grid_only must fail closed
calUI.handleRemoteControlAction({ action: 'set_distortion_fitting_mode', enabled: true });
assert.equal(state.calibrationDistortionFittingActive, false, 'Fitting mode must NOT activate outside grid_only');

// Reset to grid_only and activate
calUI.handleRemoteControlAction({ action: 'set_viewer_visual_mode', mode: 'grid_only' });
calUI.handleRemoteControlAction({ action: 'set_distortion_fitting_mode', enabled: true });
assert.equal(state.calibrationDistortionFittingActive, true, 'Fitting mode activated');

// Step D: Leaving Stage B auto-clears fitting mode
calUI.switchStage('C');
assert.equal(state.calibrationStage, 'C', 'Stage switched to C');
assert.equal(state.calibrationDistortionFittingActive, false, 'Switching to Stage C must clear fitting mode');

// Step E: Attempting to activate fitting mode in Stage C must fail closed
calUI.handleRemoteControlAction({ action: 'set_distortion_fitting_mode', enabled: true });
assert.equal(state.calibrationDistortionFittingActive, false, 'Fitting mode must NOT activate in Stage C');

// -------------------------------------------------------------
// Section 5: Telemetry Semantics Verification
// -------------------------------------------------------------
// In Stage B + grid_only + fitting mode:
state.calibrationStage = 'B';
state.viewerVisualMode = 'grid_only';
state.calibrationDistortionFittingActive = true;
state.inVR = true;

const effProf = getEffectiveViewerProfile(calUI.activeViewerProfile);
const rndProf = getRenderViewerProfile(calUI.activeViewerProfile, state);

const productionLensCorrectionApplied = !!effProf.lensCorrectionEnabled;
const calibrationDistortionOverrideActive = isCalibrationDistortionOverrideActive(state);
const calibrationDistortionOverrideApplied = !!(state.inVR && rndProf._calibrationDistortionOverrideActive);
const lensCorrectionApplied = !!(state.inVR ? rndProf.lensCorrectionEnabled : effProf.lensCorrectionEnabled);

assert.equal(productionLensCorrectionApplied, false, 'productionLensCorrectionApplied must be false for uncalibrated G04');
assert.equal(calibrationDistortionOverrideActive, true, 'calibrationDistortionOverrideActive must be true');
assert.equal(calibrationDistortionOverrideApplied, true, 'calibrationDistortionOverrideApplied must be true when rendered in VR');
assert.equal(lensCorrectionApplied, true, 'lensCorrectionApplied must report true when renderViewerProfile has override');
assert.equal(calUI.activeViewerProfile.isCalibrated, false, 'isCalibrated strictly remains false');

console.log('ALL ENHANCED O4 DISTORTION PATH & CONTROLLER ASSERTIONS PASSED!');
