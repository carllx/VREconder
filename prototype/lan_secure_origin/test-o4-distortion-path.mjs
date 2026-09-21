import assert from 'node:assert/strict';
import {
  createDefaultViewerProfile,
  getEffectiveViewerProfile,
  getRenderViewerProfile,
  isCalibrationDistortionOverrideActive,
  isProvisionalOpticsPreviewActive,
  isProvisionalOpticsPreviewApplicable,
  distortRadius,
  deriveCardboardEyeGeometry
} from './src/core/projection-profile.js';
import { activeScreenProfile } from './src/core/screen-profile.js';
import { CalibrationUI } from './src/controls/calibration-ui.js';
import { state } from './src/core/state.js';
import { fsIdealSceneSource } from './src/render/shaders.js';

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

// -------------------------------------------------------------
// Section 6: Binocular-Friendly Synthetic Grid Semantics (Issue #20)
// -------------------------------------------------------------
// 1. Synthetic Grid geometry math remains unchanged
assert.ok(fsIdealSceneSource.includes('vec2 gridPos = vec2(tanX, tanY) * 2.5;'), 'Synthetic grid must use tanX, tanY coordinate space');
assert.ok(fsIdealSceneSource.includes('float tanX = mix(-uVirtTanBounds.x, uVirtTanBounds.y, vUv.x);'), 'tanX virtual ray bounds computation must remain intact');
assert.ok(fsIdealSceneSource.includes('float tanY = mix(-uVirtTanBounds.z, uVirtTanBounds.w, vUv.y);'), 'tanY virtual ray bounds computation must remain intact');

// 2. Grid density is the new sparse value (scale factor 2.5 instead of legacy dense 6.0)
const sceneType1Match = fsIdealSceneSource.match(/if\s*\(uSceneType\s*==\s*1\)\s*\{([\s\S]*?)return;\s*\}/);
assert.ok(sceneType1Match, 'uSceneType == 1 block must exist in fsIdealSceneSource');
const scene1Body = sceneType1Match[1];
assert.ok(scene1Body.includes('* 2.5;'), 'Synthetic grid scale must be 2.5 (sparse)');
assert.ok(!scene1Body.includes('* 6.0;'), 'Legacy dense 6.0 scale must be removed from uSceneType == 1');

// 3. Grid/background colors are identical for both eyes (pure black background and crisp neutral white lines)
assert.ok(scene1Body.includes('vec3 bg = vec3(0.0);'), 'Background must be pure black (vec3(0.0)) for both eyes');
assert.ok(scene1Body.includes('vec3 lineCol = vec3(0.92, 0.92, 0.92);'), 'Line color must be neutral crisp white for both eyes');

// 4. No uEye-dependent appearance remains inside Grid Only (uSceneType == 1 block)
assert.ok(!scene1Body.includes('uEye'), 'uSceneType == 1 block must NOT contain any uEye-dependent appearance branching');
assert.ok(!scene1Body.includes('eyeThemeColor'), 'uSceneType == 1 block must NOT reference eyeThemeColor');
assert.ok(!scene1Body.includes('isCenterBadge'), 'uSceneType == 1 block must NOT contain eye-rivalrous center badges');

assert.equal(calUI.activeViewerProfile.isCalibrated, false, 'isCalibrated strictly remains false');

// -------------------------------------------------------------
// Section 7: Session-Only Provisional Optics Preview Scope Invariants (Issue #20)
// -------------------------------------------------------------
// Setup candidate distortion k1 = 0.250, k2 = 0.000
calUI.handleRemoteControlAction({ action: 'set_candidate_distortion', k1: 0.250, k2: 0.000 });
calUI.handleRemoteControlAction({ action: 'set_provisional_optics_preview', enabled: true });
state.inVR = true;

assert.equal(state.provisionalOpticsPreviewActive, true, 'User session toggle is ON');
assert.equal(isProvisionalOpticsPreviewActive(state), true, 'isProvisionalOpticsPreviewActive returns true');

// A. Stage C + preview ON -> candidate applied
state.calibrationStage = 'C';
state.viewerVisualMode = 'normal';
state.calibrationDistortionFittingActive = false;
const rndA = getRenderViewerProfile(calUI.activeViewerProfile, state);
assert.equal(isProvisionalOpticsPreviewApplicable(state), true, 'Test A: preview is applicable in Stage C');
assert.equal(rndA.lensCorrectionEnabled, true, 'Test A: preview applied in Stage C');
assert.equal(rndA.distortion.model, 'provisional-preview', 'Test A: model is provisional-preview');
assert.equal(rndA.distortion.k1, 0.250, 'Test A: k1 is candidate 0.250');
assert.equal(rndA.distortion.k2, 0.000, 'Test A: k2 is candidate 0.000');
assert.equal(rndA._provisionalOpticsPreviewActive, true, 'Test A: _provisionalOpticsPreviewActive is true');
assert.equal(rndA._calibrationDistortionOverrideActive, false, 'Test A: _calibrationDistortionOverrideActive is false');

// B. Stage B ild_fusion + preview ON -> NOT applied
state.calibrationStage = 'B';
state.viewerVisualMode = 'ild_fusion';
state.calibrationDistortionFittingActive = false;
const rndB = getRenderViewerProfile(calUI.activeViewerProfile, state);
assert.equal(isProvisionalOpticsPreviewApplicable(state), false, 'Test B: preview NOT applicable in Stage B ild_fusion');
assert.equal(rndB.lensCorrectionEnabled, false, 'Test B: lens correction NOT enabled');
assert.equal(rndB._provisionalOpticsPreviewActive, undefined, 'Test B: _provisionalOpticsPreviewActive NOT active');
assert.equal(rndB.distortion.model, 'uncalibrated', 'Test B: distortion model remains baseline uncalibrated');

// C. Stage B vertical_alignment + preview ON -> NOT applied
state.calibrationStage = 'B';
state.viewerVisualMode = 'vertical_alignment';
state.calibrationDistortionFittingActive = false;
const rndC = getRenderViewerProfile(calUI.activeViewerProfile, state);
assert.equal(isProvisionalOpticsPreviewApplicable(state), false, 'Test C: preview NOT applicable in Stage B vertical_alignment');
assert.equal(rndC.lensCorrectionEnabled, false, 'Test C: lens correction NOT enabled');
assert.equal(rndC._provisionalOpticsPreviewActive, undefined, 'Test C: _provisionalOpticsPreviewActive NOT active');

// D. Stage B grid_only + preview ON + O4 fitting OFF -> preview NOT applied
state.calibrationStage = 'B';
state.viewerVisualMode = 'grid_only';
state.calibrationDistortionFittingActive = false;
const rndD = getRenderViewerProfile(calUI.activeViewerProfile, state);
assert.equal(isProvisionalOpticsPreviewApplicable(state), false, 'Test D: preview NOT applicable in Stage B grid_only with fitting OFF');
assert.equal(isCalibrationDistortionOverrideActive(state), false, 'Test D: O4 fitting is OFF');
assert.equal(rndD.lensCorrectionEnabled, false, 'Test D: lens correction NOT enabled');
assert.equal(rndD._provisionalOpticsPreviewActive, undefined, 'Test D: _provisionalOpticsPreviewActive NOT active');

// E. Stage B grid_only + O4 fitting ON -> O4 candidate path still applies
state.calibrationStage = 'B';
state.viewerVisualMode = 'grid_only';
state.calibrationDistortionFittingActive = true;
const rndE = getRenderViewerProfile(calUI.activeViewerProfile, state);
assert.equal(isCalibrationDistortionOverrideActive(state), true, 'Test E: O4 fitting active');
assert.equal(rndE.lensCorrectionEnabled, true, 'Test E: lens correction enabled via O4 fitting');
assert.equal(rndE.distortion.model, 'o4-candidate-fitting', 'Test E: model is o4-candidate-fitting (precedence preserved)');
assert.equal(rndE.distortion.k1, 0.250, 'Test E: candidate k1 applied');
assert.equal(rndE._calibrationDistortionOverrideActive, true, 'Test E: _calibrationDistortionOverrideActive is true');
assert.equal(rndE._provisionalOpticsPreviewActive, false, 'Test E: _provisionalOpticsPreviewActive is false');

// F. Stage A diagnostic + preview ON -> preview NOT applied
state.calibrationStage = 'A';
state.viewerVisualMode = 'grid_only';
state.calibrationDistortionFittingActive = false;
const rndF = getRenderViewerProfile(calUI.activeViewerProfile, state);
assert.equal(isProvisionalOpticsPreviewApplicable(state), false, 'Test F: preview NOT applicable in Stage A');
assert.equal(rndF.lensCorrectionEnabled, false, 'Test F: lens correction NOT enabled in Stage A');
assert.equal(rndF._provisionalOpticsPreviewActive, undefined, 'Test F: _provisionalOpticsPreviewActive NOT active');

// G. isCalibrated stays false everywhere
assert.equal(rndA.isCalibrated, false, 'Test G: rndA isCalibrated false');
assert.equal(rndB.isCalibrated, false, 'Test G: rndB isCalibrated false');
assert.equal(rndC.isCalibrated, false, 'Test G: rndC isCalibrated false');
assert.equal(rndD.isCalibrated, false, 'Test G: rndD isCalibrated false');
assert.equal(rndE.isCalibrated, false, 'Test G: rndE isCalibrated false');
assert.equal(rndF.isCalibrated, false, 'Test G: rndF isCalibrated false');
assert.equal(calUI.activeViewerProfile.isCalibrated, false, 'Test G: activeViewerProfile isCalibrated false');

// H. base/persisted G04 profile unchanged & frozen geometry intact
assert.equal(calUI.activeViewerProfile.lensCorrectionEnabled, false, 'Test H: activeViewerProfile lensCorrectionEnabled remains false');
assert.equal(calUI.activeViewerProfile.distortion.k1, 0.0, 'Test H: activeViewerProfile k1 remains 0');
assert.equal(calUI.activeViewerProfile.distortion.k2, 0.0, 'Test H: activeViewerProfile k2 remains 0');
assert.equal(calUI.activeViewerProfile.screenToLensDistance, 0.0430, 'Test H: S2L remains 43mm');
assert.equal(calUI.activeViewerProfile.interLensDistance, 0.0650, 'Test H: ILD remains 65mm');
assert.equal(calUI.activeViewerProfile.verticalAlignment, 'CENTER', 'Test H: verticalAlignment remains CENTER');
const effectiveBaseline = getEffectiveViewerProfile(calUI.activeViewerProfile);
assert.equal(effectiveBaseline.lensCorrectionEnabled, false, 'Test H: production lens policy strictly fail-closed');

// Control Action: toggle preview OFF reverts Stage C
calUI.handleRemoteControlAction({ action: 'set_provisional_optics_preview', enabled: false });
assert.equal(state.provisionalOpticsPreviewActive, false, 'Session preview toggle toggles OFF');
state.calibrationStage = 'C';
const rndOff = getRenderViewerProfile(calUI.activeViewerProfile, state);
assert.equal(rndOff.lensCorrectionEnabled, false, 'Render profile disables lens correction when preview is OFF');

// -------------------------------------------------------------
// Section 8: Live Telemetry Payload Invariants (Mission 5)
// -------------------------------------------------------------
// Re-execute client handoff commands:
calUI.handleRemoteControlAction({ action: 'set_candidate_distortion', k1: 0.250, k2: 0.000 });
calUI.handleRemoteControlAction({ action: 'set_provisional_optics_preview', enabled: true });
state.calibrationStage = 'C';
state.inVR = true;

const liveRenderProf = getRenderViewerProfile(calUI.activeViewerProfile, state);
const liveEffProf = getEffectiveViewerProfile(calUI.activeViewerProfile);

const liveOpticsRuntime = {
  productionLensCorrectionApplied: !!liveEffProf.lensCorrectionEnabled,
  candidateK1: (state.candidateDistortion && typeof state.candidateDistortion.k1 === 'number') ? state.candidateDistortion.k1 : 0.0,
  candidateK2: (state.candidateDistortion && typeof state.candidateDistortion.k2 === 'number') ? state.candidateDistortion.k2 : 0.0,
  provisionalOpticsPreviewActive: isProvisionalOpticsPreviewActive(state),
  provisionalOpticsPreviewApplied: !!(
    state.inVR &&
    state.calibrationStage === 'C' &&
    liveRenderProf._provisionalOpticsPreviewActive
  ),
  lensCorrectionApplied: !!(state.inVR ? liveRenderProf.lensCorrectionEnabled : liveEffProf.lensCorrectionEnabled)
};

assert.equal(liveOpticsRuntime.candidateK1, 0.250, 'candidateK1 = 0.250');
assert.equal(liveOpticsRuntime.candidateK2, 0.000, 'candidateK2 = 0.000');
assert.equal(liveOpticsRuntime.provisionalOpticsPreviewActive, true, 'provisionalOpticsPreviewActive = true');
assert.equal(liveOpticsRuntime.provisionalOpticsPreviewApplied, true, 'provisionalOpticsPreviewApplied = true');
assert.equal(liveOpticsRuntime.lensCorrectionApplied, true, 'lensCorrectionApplied = true');
assert.equal(liveOpticsRuntime.productionLensCorrectionApplied, false, 'productionLensCorrectionApplied = false');
assert.equal(calUI.activeViewerProfile.isCalibrated, false, 'isCalibrated = false');

// Switch to Stage B calibration mode while leaving Preview ON
calUI.switchStage('B');
state.viewerVisualMode = 'ild_fusion';
const liveRenderProfB = getRenderViewerProfile(calUI.activeViewerProfile, state);
const liveOpticsRuntimeB = {
  provisionalOpticsPreviewActive: isProvisionalOpticsPreviewActive(state),
  provisionalOpticsPreviewApplied: !!(
    (state.inVR || calUI.currentMode === 'vr') &&
    liveRenderProfB._provisionalOpticsPreviewActive
  ),
  lensCorrectionApplied: !!(state.inVR ? liveRenderProfB.lensCorrectionEnabled : liveEffProf.lensCorrectionEnabled)
};
assert.equal(liveOpticsRuntimeB.provisionalOpticsPreviewActive, true, 'provisionalOpticsPreviewActive remains true in Stage B');
assert.equal(liveOpticsRuntimeB.provisionalOpticsPreviewApplied, false, 'provisionalOpticsPreviewApplied = false in Stage B');
assert.equal(liveOpticsRuntimeB.lensCorrectionApplied, false, 'lensCorrectionApplied = false in Stage B ild_fusion');

console.log('ALL ENHANCED O4 DISTORTION PATH & CONTROLLER ASSERTIONS PASSED!');


