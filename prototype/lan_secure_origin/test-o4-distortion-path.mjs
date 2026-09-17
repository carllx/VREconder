import assert from 'node:assert/strict';
import {
  createDefaultViewerProfile,
  getEffectiveViewerProfile,
  getRenderViewerProfile,
  isCalibrationDistortionOverrideActive,
  isProvisionalOpticsPreviewActive,
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
// Section 7: Session-Only Provisional Optics Preview for Normal Video (Issue #20)
// -------------------------------------------------------------
// Reset to normal video playback state in Stage C with candidate k1 = 0.250, k2 = 0.000
state.calibrationStage = 'C';
state.viewerVisualMode = 'normal';
state.calibrationDistortionFittingActive = false;
state.provisionalOpticsPreviewActive = false;
state.inVR = true;
calUI.handleRemoteControlAction({ action: 'set_candidate_distortion', k1: 0.250, k2: 0.000 });

// 1. Preview OFF + Normal Video: lens correction inactive, fail-closed policy holds
const previewOffEff = getEffectiveViewerProfile(calUI.activeViewerProfile);
const previewOffRnd = getRenderViewerProfile(calUI.activeViewerProfile, state);
assert.equal(isProvisionalOpticsPreviewActive(state), false, 'isProvisionalOpticsPreviewActive must be false when preview is OFF');
assert.equal(previewOffEff.lensCorrectionEnabled, false, 'Baseline effective profile must be fail-closed (lensCorrectionEnabled false)');
assert.equal(previewOffRnd.lensCorrectionEnabled, false, 'Render profile must NOT enable lens correction when preview is OFF');
assert.equal(previewOffRnd.isCalibrated, false, 'isCalibrated must be false when preview is OFF');

// 2. Control Action: set_provisional_optics_preview enabled: true
calUI.handleRemoteControlAction({ action: 'set_provisional_optics_preview', enabled: true });
assert.equal(state.provisionalOpticsPreviewActive, true, 'State flag provisionalOpticsPreviewActive must become true via control action');
assert.equal(isProvisionalOpticsPreviewActive(state), true, 'isProvisionalOpticsPreviewActive must be true');

// 3. Preview ON + Normal Video: provisional candidate applied to render profile
const previewOnEff = getEffectiveViewerProfile(calUI.activeViewerProfile);
const previewOnRnd = getRenderViewerProfile(calUI.activeViewerProfile, state);

// Strict baseline safety: activeViewerProfile and effectiveViewerProfile must remain fail-closed & uncalibrated
assert.equal(calUI.activeViewerProfile.isCalibrated, false, 'activeViewerProfile.isCalibrated strictly remains false');
assert.equal(calUI.activeViewerProfile.lensCorrectionEnabled, false, 'activeViewerProfile.lensCorrectionEnabled must remain false');
assert.equal(previewOnEff.lensCorrectionEnabled, false, 'Production effective lens policy must remain fail-closed (false)');
assert.equal(previewOnEff.isCalibrated, false, 'Production effective isCalibrated strictly remains false');

// Render profile receives candidate distortion under provisional-preview model
assert.equal(previewOnRnd.lensCorrectionEnabled, true, 'Render profile must enable lens correction when preview is ON');
assert.equal(previewOnRnd.isCalibrated, false, 'Render profile isCalibrated strictly remains false');
assert.equal(previewOnRnd.distortion.model, 'provisional-preview', 'Distortion model must be provisional-preview');
assert.equal(previewOnRnd.distortion.k1, 0.250, 'Distortion k1 must be 0.250');
assert.equal(previewOnRnd.distortion.k2, 0.000, 'Distortion k2 must be 0.000');
assert.equal(previewOnRnd._provisionalOpticsPreviewActive, true, '_provisionalOpticsPreviewActive must be marked true');
assert.equal(previewOnRnd._calibrationDistortionOverrideActive, false, '_calibrationDistortionOverrideActive must be false for normal video');

// Frozen geometry invariant: S2L = 43mm, ILD = 65mm, verticalAlignment = CENTER
assert.equal(previewOnRnd.screenToLensDistance, 0.0430, 'S2L must remain 43mm (0.0430)');
assert.equal(previewOnRnd.interLensDistance, 0.0650, 'ILD must remain 65mm (0.0650)');
assert.equal(previewOnRnd.verticalAlignment, 'CENTER', 'verticalAlignment must remain CENTER');

// 4. Eye Geometry derivation with preview
const eyePreview = deriveCardboardEyeGeometry(activeScreenProfile, previewOnRnd);
assert.equal(eyePreview.distortion.k1, 0.250, 'Derived eye geometry distortion k1 must be 0.250');
assert.equal(eyePreview.distortion.k2, 0.000, 'Derived eye geometry distortion k2 must be 0.000');
const eyeBaseUncal = deriveCardboardEyeGeometry(activeScreenProfile, calUI.activeViewerProfile);
assert.notDeepEqual(eyePreview.leftEye.virtTanBounds, eyeBaseUncal.leftEye.virtTanBounds, 'Virtual tan bounds under preview must differ from uncalibrated base');

// 5. Stage B Grid Only fitting precedence over general session preview
const stageBFittingState = {
  ...state,
  calibrationStage: 'B',
  viewerVisualMode: 'grid_only',
  calibrationDistortionFittingActive: true,
  provisionalOpticsPreviewActive: true
};
const rndStageB = getRenderViewerProfile(calUI.activeViewerProfile, stageBFittingState);
assert.equal(rndStageB.distortion.model, 'o4-candidate-fitting', 'Stage B Grid Only fitting model takes precedence over provisional-preview');
assert.equal(rndStageB._calibrationDistortionOverrideActive, true, 'Stage B override active must be true');

// 6. Control Action: set_provisional_optics_preview enabled: false
calUI.handleRemoteControlAction({ action: 'set_provisional_optics_preview', enabled: false });
assert.equal(state.provisionalOpticsPreviewActive, false, 'State flag provisionalOpticsPreviewActive must be toggled false');
assert.equal(isProvisionalOpticsPreviewActive(state), false, 'isProvisionalOpticsPreviewActive must report false');
const restoredRnd = getRenderViewerProfile(calUI.activeViewerProfile, state);
assert.equal(restoredRnd.lensCorrectionEnabled, false, 'Render profile reverts to lens correction disabled when preview turned OFF');
assert.equal(calUI.activeViewerProfile.isCalibrated, false, 'isCalibrated strictly remains false across all toggles');

console.log('ALL ENHANCED O4 DISTORTION PATH & CONTROLLER ASSERTIONS PASSED!');

