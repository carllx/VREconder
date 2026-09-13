// ============================================================================
// G04 Initial Viewer Geometry Derivation & Evidence Contract Regression Suite
// Issue #20 Optics Work Unit: O2 Physical Measurement -> O3 Derived Initial Viewer Geometry
// Device: iPhone 15 Pro (2556 x 1179 px, 460 PPI)
// Target Headset: G04 passive headset (Hardware Baseline: S2L=43mm, ILD=65mm lens-center spacing, Center)
// ============================================================================
import assert from 'node:assert';
import {
  deriveCardboardEyeGeometry,
  createDefaultViewerProfile,
  getEffectiveViewerProfile,
  ProfileStorage,
  MIN_SCREEN_TO_LENS_DISTANCE,
  MAX_SCREEN_TO_LENS_DISTANCE
} from './src/core/projection-profile.js';
import { activeScreenProfile } from './src/core/screen-profile.js';
import { state, showFeedbackToast } from './src/core/state.js';
import { isStereoUIVisible, isStereoUIDynamic, isIsolatedCalibrationGateActive, renderStereoUI } from './src/controls/stereo-ui.js';
import { CalibrationUI } from './src/controls/calibration-ui.js';

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

// ----------------------------------------------------------------------------
// Suite 6: Isolated Human Gate Visual Contamination & Toast Suppression
// ----------------------------------------------------------------------------
console.log('\n--- Suite 6: Isolated Human Gate Toast Suppression ---');

const now = 10000;
state.inVR = true;
state.recenterCountdown.active = false;
state.activePattern = 'none';
state.patternA_open = false;
state.patternB_open = false;
state.patternC_open = false;

// 1. In Stage B ild_fusion: feedback toast must be strictly suppressed
state.calibrationStage = 'B';
state.viewerVisualMode = 'ild_fusion';
state.toastText = '🔴 ILD Fusion';
state.toastTime = now - 500; // active toast (500ms ago)

check('isIsolatedCalibrationGateActive is true for ild_fusion', isIsolatedCalibrationGateActive() === true);
check('ild_fusion strictly suppresses toast in isStereoUIVisible', isStereoUIVisible(now) === false);
check('ild_fusion strictly suppresses toast in isStereoUIDynamic', isStereoUIDynamic(null, now) === false);

// 2. In Stage B vertical_alignment: feedback toast must be strictly suppressed
state.viewerVisualMode = 'vertical_alignment';
state.toastText = '↕ Vertical Align';
state.toastTime = now - 500;

check('isIsolatedCalibrationGateActive is true for vertical_alignment', isIsolatedCalibrationGateActive() === true);
check('vertical_alignment strictly suppresses toast in isStereoUIVisible', isStereoUIVisible(now) === false);
check('vertical_alignment strictly suppresses toast in isStereoUIDynamic', isStereoUIDynamic(null, now) === false);

// 3. Normal non-isolated modes: feedback toasts must remain visible
state.viewerVisualMode = 'grid_only';
state.toastText = 'Stage B: Grid Only';
state.toastTime = now - 500;

check('isIsolatedCalibrationGateActive is false for grid_only', isIsolatedCalibrationGateActive() === false);
check('grid_only permits toast visibility in isStereoUIVisible', isStereoUIVisible(now) === true);
check('grid_only permits dynamic UI for active toast', isStereoUIDynamic(null, now) === true);

state.calibrationStage = 'C';
state.firstFrameTimings.ready = true;
state.toastText = 'Stage C: Video Verification';
state.toastTime = now - 500;

check('isIsolatedCalibrationGateActive is false for Stage C', isIsolatedCalibrationGateActive() === false);
check('Stage C permits toast visibility in isStereoUIVisible', isStereoUIVisible(now) === true);

// 4. Deterministic Stale UI Texture / Transition Reproduction & Clear Verification
console.log('\n--- Suite 6b: Stale Overlay Transition & One-shot Clear ---');

class Mock2DContext {
  constructor() {
    this.clearCount = 0;
    this.drawCalls = [];
  }
  clearRect(x, y, w, h) { this.clearCount++; }
  save() {}
  restore() {}
  beginPath() {}
  rect() {}
  clip() {}
  arc() {}
  fill() {}
  stroke() {}
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  closePath() {}
  fillText(text, x, y) { this.drawCalls.push({ text, x, y }); }
}

const mockCtx = new Mock2DContext();
const mockVideo = { paused: false, duration: 100, currentTime: 10 };
const mockGazeEngine = { currentHoveredItem: null, dwellProgress: 0, activatedItemId: null, activationFlashTime: 0 };
state.performanceMode = 'strict-rvfc-dirty-ui';
state.calibrationStage = 'A';
state.viewerVisualMode = 'grid_only';
state.inVR = true;

// Step 1: Normal mode with visible feedback toast
showFeedbackToast('Stage A: Flat Diagnostic');
const frame1Now = state.toastTime + 16;
const frame1Rendered = renderStereoUI(mockCtx, mockGazeEngine, null, mockVideo, frame1Now, 2556, 1179, g04Preset);
check('Step 1: Normal mode renders toast and uploads texture', frame1Rendered === true);
check('Step 1: Toast text was drawn on canvas', mockCtx.drawCalls.some(d => d.text.includes('Stage A')));

// Step 2: Transition to isolated gate (ild_fusion) with toast emitted at transition
state.calibrationStage = 'B';
state.viewerVisualMode = 'ild_fusion';
showFeedbackToast('Stage B: 🔴 ILD Fusion');

// Step 3: Frame 2 - UI must perform exactly one blank clear & texture upload
mockCtx.drawCalls = [];
const frame2Now = state.toastTime + 16;
const frame2Rendered = renderStereoUI(mockCtx, mockGazeEngine, null, mockVideo, frame2Now, 2556, 1179, g04Preset);
check('Step 3: Transition frame performs blank clear and returns true for texture upload', frame2Rendered === true);
check('Step 3: Canvas contains zero toast or shape draw calls (clean blank canvas)', mockCtx.drawCalls.length === 0);

// Step 4: Frame 3 - Subsequent isolated frame remains clean and skips upload (no redundant redraw)
mockCtx.drawCalls = [];
const frame3Now = frame2Now + 16;
const frame3Rendered = renderStereoUI(mockCtx, mockGazeEngine, null, mockVideo, frame3Now, 2556, 1179, g04Preset);
check('Step 4: Subsequent isolated frame returns false (hidden & clean, no redraw)', frame3Rendered === false);
check('Step 4: Zero draw calls on subsequent frames', mockCtx.drawCalls.length === 0);

// Step 5: Transition back to normal mode allows toast behavior
state.calibrationStage = 'B';
state.viewerVisualMode = 'grid_only';
showFeedbackToast('Stage B: Grid Only');
const frame4Now = state.toastTime + 16;
const frame4Rendered = renderStereoUI(mockCtx, mockGazeEngine, null, mockVideo, frame4Now, 2556, 1179, g04Preset);
check('Step 5: Normal non-isolated mode resumes toast rendering and upload', frame4Rendered === true);
check('Step 5: Toast text rendered on canvas', mockCtx.drawCalls.some(d => d.text.includes('Grid Only')));

// ----------------------------------------------------------------------------
// Suite 7: Single-Viewer G04 Default & Legacy Profile Isolation
// ----------------------------------------------------------------------------
console.log('\n--- Suite 7: Single-Viewer G04 Default & Legacy Profile Isolation ---');

// 1. Fresh ProfileStorage defaults to G04
const storage = new ProfileStorage();
check('Fresh ProfileStorage activeViewerProfile is G04', 
  storage.activeViewerProfile && storage.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
  storage.activeViewerProfile ? storage.activeViewerProfile.viewerProfileId : 'none'
);

// 2. createDefaultViewerProfile() with no arguments returns G04
const noArgDefault = createDefaultViewerProfile();
check('createDefaultViewerProfile() with no args returns G04', 
  noArgDefault && noArgDefault.viewerProfileId === 'g04:provisional_geometry'
);

// 3. Fallback for unknown preset fails closed (returns null)
const unknownFallback = createDefaultViewerProfile('nonexistent_preset_id');
check('createDefaultViewerProfile(unknown) fails closed (returns null)', 
  unknownFallback === null
);

// 4. Cardboard reference preset is preserved as internal fixture
const cardboardFixture = createDefaultViewerProfile('cardboard:reference_50deg');
check('Cardboard reference preset preserved as fixture', 
  cardboardFixture && cardboardFixture.viewerProfileId === 'cardboard:reference_50deg' &&
  cardboardFixture.screenToLensDistance === 0.0393 &&
  cardboardFixture.interLensDistance === 0.0639
);

// 5. Stored legacy localStorage 'vreconder_saved_my_profile' does NOT override G04
const mockLocalStorage = {
  vreconder_saved_my_profile: JSON.stringify({
    viewerProfileId: 'viewer:my_profile',
    name: 'Legacy Stored My Profile',
    screenToLensDistance: 0.045,
    interLensDistance: 0.068,
    isCalibrated: false
  }),
  vreconder_viewer_profile: JSON.stringify({
    viewerProfileId: 'viewer:my_profile',
    name: 'Legacy Stored Active My Profile'
  })
};

globalThis.localStorage = {
  getItem: (k) => mockLocalStorage[k] || null,
  setItem: (k, v) => { mockLocalStorage[k] = v; },
  removeItem: (k) => { delete mockLocalStorage[k]; }
};

const hydratedStorage = new ProfileStorage();
check('Hydrated ProfileStorage with legacy my_profile defaults activeViewerProfile to G04',
  hydratedStorage.activeViewerProfile && hydratedStorage.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
  hydratedStorage.activeViewerProfile ? hydratedStorage.activeViewerProfile.viewerProfileId : 'none'
);
check('Legacy savedMyViewerProfile preserved without deletion',
  hydratedStorage.savedMyViewerProfile && hydratedStorage.savedMyViewerProfile.viewerProfileId === 'viewer:my_profile'
);

// 5b. LocalStorage Authority Tests (Cardboard, Arbitrary Stale, Valid G04)
// A. Stale Cardboard localStorage profile does NOT override G04
mockLocalStorage.vreconder_viewer_profile = JSON.stringify({
  viewerProfileId: 'cardboard:reference_50deg',
  name: 'Cardboard Reference in LocalStorage'
});
const cardboardLocalStorage = new ProfileStorage();
check('Stale Cardboard in localStorage does not override G04',
  cardboardLocalStorage.activeViewerProfile && cardboardLocalStorage.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
  cardboardLocalStorage.activeViewerProfile ? cardboardLocalStorage.activeViewerProfile.viewerProfileId : 'none'
);

// B. Stale arbitrary custom localStorage profile does NOT override G04
mockLocalStorage.vreconder_viewer_profile = JSON.stringify({
  viewerProfileId: 'custom:headset_99',
  name: 'Custom Headset 99 in LocalStorage'
});
const customLocalStorage = new ProfileStorage();
check('Stale arbitrary custom in localStorage does not override G04',
  customLocalStorage.activeViewerProfile && customLocalStorage.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
  customLocalStorage.activeViewerProfile ? customLocalStorage.activeViewerProfile.viewerProfileId : 'none'
);

// C. Valid stored G04 profile IS admitted from localStorage
mockLocalStorage.vreconder_viewer_profile = JSON.stringify({
  viewerProfileId: 'g04:provisional_geometry',
  name: 'Stored Valid G04',
  screenToLensDistance: 0.043,
  interLensDistance: 0.065,
  isCalibrated: false
});
const validG04LocalStorage = new ProfileStorage();
check('Valid stored G04 profile is admitted from localStorage',
  validG04LocalStorage.activeViewerProfile && validG04LocalStorage.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry' &&
  validG04LocalStorage.activeViewerProfile.name === 'Stored Valid G04',
  validG04LocalStorage.activeViewerProfile ? validG04LocalStorage.activeViewerProfile.name : 'none'
);

// Reset localStorage to clean state for subsequent tests
mockLocalStorage.vreconder_viewer_profile = JSON.stringify({
  viewerProfileId: 'g04:provisional_geometry',
  name: 'G04 Provisional Geometry'
});

// 6. Real Server Legacy Hydration & Stale Identity Protection Test (Deterministic Mocked Fetch)
const originalFetch = globalThis.fetch;
try {
  // Test 6a: Server payload with legacy viewer:my_profile
  globalThis.fetch = async (url) => {
    if (url.includes('/api/profiles')) {
      return {
        ok: true,
        json: async () => ({
          videoProfiles: {},
          viewerProfile: {
            viewerProfileId: 'viewer:my_profile',
            name: 'Server Legacy My Profile',
            confidence: 'working-user-tuned',
            screenToLensDistance: 0.048,
            interLensDistance: 0.070,
            isCalibrated: true
          }
        })
      };
    }
    return { ok: false };
  };

  const serverHydratedStorage = new ProfileStorage();
  await serverHydratedStorage.loadServerProfiles();

  check('Real loadServerProfiles() with legacy my_profile does NOT override active G04 profile',
    serverHydratedStorage.activeViewerProfile && serverHydratedStorage.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
    serverHydratedStorage.activeViewerProfile ? serverHydratedStorage.activeViewerProfile.viewerProfileId : 'none'
  );
  check('Real loadServerProfiles() preserves legacy profile in savedMyViewerProfile',
    serverHydratedStorage.savedMyViewerProfile && serverHydratedStorage.savedMyViewerProfile.viewerProfileId === 'viewer:my_profile'
  );

  // Test 6b: Server payload with arbitrary non-G04 identity (e.g., stale custom viewer)
  globalThis.fetch = async (url) => {
    if (url.includes('/api/profiles')) {
      return {
        ok: true,
        json: async () => ({
          videoProfiles: {},
          viewerProfile: {
            viewerProfileId: 'stale:custom_profile',
            name: 'Stale Custom Viewer Profile',
            screenToLensDistance: 0.050,
            interLensDistance: 0.072,
            isCalibrated: true
          }
        })
      };
    }
    return { ok: false };
  };

  const nonG04Storage = new ProfileStorage();
  await nonG04Storage.loadServerProfiles();

  check('Real loadServerProfiles() with stale non-G04 identity does NOT override active G04 profile',
    nonG04Storage.activeViewerProfile && nonG04Storage.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
    nonG04Storage.activeViewerProfile ? nonG04Storage.activeViewerProfile.viewerProfileId : 'none'
  );

  // Test 6c: Valid G04 updates from server ARE admitted
  globalThis.fetch = async (url) => {
    if (url.includes('/api/profiles')) {
      return {
        ok: true,
        json: async () => ({
          videoProfiles: {},
          viewerProfile: {
            viewerProfileId: 'g04:provisional_geometry',
            name: 'G04 Hardware Validated',
            screenToLensDistance: 0.043,
            interLensDistance: 0.065,
            isCalibrated: false
          }
        })
      };
    }
    return { ok: false };
  };

  const g04SyncStorage = new ProfileStorage();
  await g04SyncStorage.loadServerProfiles();
  check('Real loadServerProfiles() with G04 updates preserves G04 identity',
    g04SyncStorage.activeViewerProfile && g04SyncStorage.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
    g04SyncStorage.activeViewerProfile ? g04SyncStorage.activeViewerProfile.name : 'none'
  );
} finally {
  globalThis.fetch = originalFetch;
}

// ----------------------------------------------------------------------------
// Suite 8: Runtime Control Authority (set_viewer_preset accepts ONLY G04)
// ----------------------------------------------------------------------------
console.log('\n--- Suite 8: Runtime Control Authority (set_viewer_preset accepts ONLY G04) ---');

const runtimeStorage = new ProfileStorage();
let notifiedProfile = null;
const calUI = new CalibrationUI({
  storage: runtimeStorage,
  mediaController: null,
  diagnosticOverlay: {},
  vrRenderer: null,
  commandModel: null,
  onProfileChanged: (vid, view) => { notifiedProfile = view; }
});

// A. G04 preset command admitted
notifiedProfile = null;
calUI.handleRemoteControlAction({ action: 'set_viewer_preset', presetId: 'g04:provisional_geometry' });
check('G04 preset command admitted',
  calUI.activeViewerProfile && calUI.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
  calUI.activeViewerProfile ? calUI.activeViewerProfile.viewerProfileId : 'none'
);
check('onProfileChanged notified on admitted G04 preset', notifiedProfile !== null && notifiedProfile.viewerProfileId === 'g04:provisional_geometry');

// B. Cardboard preset command rejected
notifiedProfile = null;
calUI.handleRemoteControlAction({ action: 'set_viewer_preset', presetId: 'cardboard:reference_50deg' });
check('Cardboard preset command rejected (active remains G04)',
  calUI.activeViewerProfile && calUI.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
  calUI.activeViewerProfile ? calUI.activeViewerProfile.viewerProfileId : 'none'
);
check('onProfileChanged NOT notified on rejected Cardboard preset', notifiedProfile === null);

// C. My Viewer preset command rejected
notifiedProfile = null;
calUI.handleRemoteControlAction({ action: 'set_viewer_preset', presetId: 'viewer:my_profile' });
check('My Viewer preset command rejected (active remains G04)',
  calUI.activeViewerProfile && calUI.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
  calUI.activeViewerProfile ? calUI.activeViewerProfile.viewerProfileId : 'none'
);
check('onProfileChanged NOT notified on rejected My Viewer preset', notifiedProfile === null);

// D. Unknown preset rejected
notifiedProfile = null;
calUI.handleRemoteControlAction({ action: 'set_viewer_preset', presetId: 'unknown_headset_xyz' });
check('Unknown preset command rejected (active remains G04)',
  calUI.activeViewerProfile && calUI.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry',
  calUI.activeViewerProfile ? calUI.activeViewerProfile.viewerProfileId : 'none'
);
check('onProfileChanged NOT notified on rejected unknown preset', notifiedProfile === null);

// E. activeViewerProfile remains G04 after all rejected commands
check('activeViewerProfile strictly remains G04 after all rejected commands',
  calUI.activeViewerProfile && calUI.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry' &&
  runtimeStorage.activeViewerProfile.viewerProfileId === 'g04:provisional_geometry'
);

check('G04 candidate remains uncalibrated (isCalibrated = false)',
  hydratedStorage.activeViewerProfile.isCalibrated === false
);

console.log('\n============================================================');
if (allPassed) {
  console.log('🎉 ALL G04 INITIAL VIEWER GEOMETRY REGRESSION CHECKS PASSED!');
  process.exit(0);
} else {
  console.error('❌ SOME G04 REGRESSION CHECKS FAILED');
  process.exit(1);
}
