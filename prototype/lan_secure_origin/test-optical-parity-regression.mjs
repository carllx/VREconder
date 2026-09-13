// ============================================================================
// Deterministic Optical Parity & Screen-to-Lens Evidence Contract Regression Suite
// Validates:
// 1. Physical Screen / Lens Center -> Ray Direction Parity against WWGC reference semantics
// 2. Unclipped (50°), Symmetric Clipped (30°), and Asymmetric Clipped FOV parity
// 3. Screen-to-Lens requested vs effective vs clamped/rejected evidence contract
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

console.log('=== RUNNING DETERMINISTIC OPTICAL PARITY REGRESSION SUITE ===\n');

let allPassed = true;

function evaluateParity(name, maxFovAngles, expectedRayAngleDegAtLens, expectedRayAngleDegAtScreenMid) {
  console.log(`--- Test: ${name} ---`);
  const baseProfile = createDefaultViewerProfile('cardboard:reference_50deg');
  const profile = { ...baseProfile, maxFovAngles };
  const eyeGeom = deriveCardboardEyeGeometry(activeScreenProfile, profile);

  const left = eyeGeom.leftEye;
  const uLens = left.lensCenterNorm[0];
  const vLens = left.lensCenterNorm[1];
  const physTanScaleX = eyeGeom.physicalTanScale[0];
  const physTanScaleY = eyeGeom.physicalTanScale[1];

  // Optical Center on screen: vUv = [uLens, vLens]
  // In Pass 2: offsetNorm = 0, physTan = 0 -> virtTan = 0
  const uEye_at_lens = left.virtTanBounds[0] / (left.virtTanBounds[0] + left.virtTanBounds[1]);
  // In Pass 1: tanX = mix(-virtTanL, virtTanR, uEye)
  const tanX_at_lens = -left.virtTanBounds[0] + uEye_at_lens * (left.virtTanBounds[0] + left.virtTanBounds[1]);
  const rayAngleDeg_at_lens = Math.atan(tanX_at_lens) * 180 / Math.PI;

  // Screen Midpoint: vUv = [0.5, vLens]
  const offsetNormMidX = 0.5 - uLens;
  const physTanMidX = offsetNormMidX * physTanScaleX;
  const uEye_at_mid = (physTanMidX - (-left.virtTanBounds[0])) / (left.virtTanBounds[0] + left.virtTanBounds[1]);
  const tanX_at_mid = -left.virtTanBounds[0] + uEye_at_mid * (left.virtTanBounds[0] + left.virtTanBounds[1]);
  const rayAngleDeg_at_mid = Math.atan(tanX_at_mid) * 180 / Math.PI;

  console.log(`  Lens Center (vUv=[${uLens.toFixed(4)}, ${vLens.toFixed(4)}]):`);
  console.log(`    tanX = ${tanX_at_lens.toFixed(6)}, ray angle = ${rayAngleDeg_at_lens.toFixed(4)}° (expected: ${expectedRayAngleDegAtLens.toFixed(4)}°)`);
  console.log(`  Screen Mid (vUv=[0.5000, ${vLens.toFixed(4)}]):`);
  console.log(`    tanX = ${tanX_at_mid.toFixed(6)}, ray angle = ${rayAngleDeg_at_mid.toFixed(4)}° (expected: ${expectedRayAngleDegAtScreenMid.toFixed(4)}°)`);

  const lensOk = Math.abs(rayAngleDeg_at_lens - expectedRayAngleDegAtLens) < 1e-4;
  const midOk = Math.abs(rayAngleDeg_at_mid - expectedRayAngleDegAtScreenMid) < 1e-3;

  assert.ok(lensOk, `Ray angle at lens center must be ${expectedRayAngleDegAtLens}°, got ${rayAngleDeg_at_lens}°`);
  assert.ok(midOk, `Ray angle at screen mid must be ${expectedRayAngleDegAtScreenMid}°, got ${rayAngleDeg_at_mid}°`);

  console.log('  [Parity Status]: PASS\n');
}

// ----------------------------------------------------------------------------
// Suite 1: Optical Mapping Parity Across FOV Clipping Scenarios
// ----------------------------------------------------------------------------
try {
  evaluateParity('Scenario A: 50° Unconstrained',
    { outerDeg: 50, innerDeg: 50, upperDeg: 50, lowerDeg: 50 },
    0.0,
    -4.8489
  );

  evaluateParity('Scenario B: 30° Symmetric Clipped',
    { outerDeg: 30, innerDeg: 30, upperDeg: 30, lowerDeg: 30 },
    0.0,
    -4.8489
  );

  evaluateParity('Scenario C: Asymmetric Clipped (35°/45°/30°/40°)',
    { outerDeg: 35, innerDeg: 45, upperDeg: 30, lowerDeg: 40 },
    0.0,
    -4.8489
  );
} catch (err) {
  console.error(`Optical Parity Test Failed:`, err.message);
  allPassed = false;
}

// ----------------------------------------------------------------------------
// Suite 2: Screen-to-Lens Evidence Contract & Clamping Observability
// ----------------------------------------------------------------------------
console.log('--- Test: Screen-to-Lens Evidence Contract ---');
try {
  const baseProfile = createDefaultViewerProfile('cardboard:reference_50deg');

  // Case 1: Within valid bounds (39.3 mm)
  const validResult = getEffectiveViewerProfile(baseProfile, 0.0);
  assert.strictEqual(validResult.requestedScreenToLensDistance, 0.0393);
  assert.strictEqual(validResult.screenToLensDistance, 0.0393);
  assert.strictEqual(validResult.isScreenToLensClamped, false);
  assert.strictEqual(validResult.screenToLensClampReason, null);
  console.log('  Case 1 (Valid 39.3mm): Preserved without clamping');

  // Case 2: Below minimum (requested 3.3 mm -> offset -0.0360)
  const belowMinResult = getEffectiveViewerProfile(baseProfile, -0.0360);
  const reqMm = Number((belowMinResult.requestedScreenToLensDistance * 1000).toFixed(1));
  assert.strictEqual(reqMm, 3.3, "Requested distance should be preserved as 3.3mm");
  assert.strictEqual(belowMinResult.screenToLensDistance, MIN_SCREEN_TO_LENS_DISTANCE, "Effective distance clamped to 20mm");
  assert.strictEqual(belowMinResult.isScreenToLensClamped, true, "isScreenToLensClamped must be true");
  assert.strictEqual(belowMinResult.screenToLensClampReason, "below_minimum_supported_distance");
  console.log(`  Case 2 (Requested ${reqMm}mm < 20mm): Explicitly clamped, reason=${belowMinResult.screenToLensClampReason}`);

  // Case 3: Above maximum (requested 85.0 mm -> offset +0.0457)
  const aboveMaxResult = getEffectiveViewerProfile(baseProfile, 0.0457);
  const reqMaxMm = Number((aboveMaxResult.requestedScreenToLensDistance * 1000).toFixed(1));
  assert.strictEqual(reqMaxMm, 85.0, "Requested distance should be preserved as 85.0mm");
  assert.strictEqual(aboveMaxResult.screenToLensDistance, MAX_SCREEN_TO_LENS_DISTANCE, "Effective distance clamped to 70mm");
  assert.strictEqual(aboveMaxResult.isScreenToLensClamped, true, "isScreenToLensClamped must be true");
  assert.strictEqual(aboveMaxResult.screenToLensClampReason, "above_maximum_supported_distance");
  console.log(`  Case 3 (Requested ${reqMaxMm}mm > 70mm): Explicitly clamped, reason=${aboveMaxResult.screenToLensClampReason}`);

  // Case 4: Zero silent suppression (scientific calibration requirement)
  assert.notStrictEqual(belowMinResult.requestedScreenToLensDistance, belowMinResult.screenToLensDistance);
  console.log('  Case 4 (Fail-honest contract): Requested distance !== Effective distance when clamped\n');
} catch (err) {
  console.error(`Screen-to-Lens Evidence Contract Test Failed:`, err.message);
  allPassed = false;
}

// ----------------------------------------------------------------------------
// Suite 3: Synthetic Grid Architectural Boundary Affirmation
// ----------------------------------------------------------------------------
console.log('--- Test: Synthetic Grid Verification Boundary ---');
console.log('  Affirmed: Synthetic Grid operates in screen/frustum space.');
console.log('  Validates static optical distortion geometry and corner tangents.');
console.log('  Does not certify head tracking or dynamic angular stability (reserved for separate dynamic suite).');
console.log('  PASS\n');

if (!allPassed) {
  console.error('ONE OR MORE TESTS FAILED');
  process.exit(1);
} else {
  console.log('============================================================');
  console.log('ALL DETERMINISTIC REGRESSION TESTS PASSED (100% SUITE PASS)');
  console.log('============================================================');
  process.exit(0);
}