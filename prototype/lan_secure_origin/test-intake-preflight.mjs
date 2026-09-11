/**
 * Test Suite: Issue #21 Future Intake Gate & Compatibility Policy Gating.
 * 
 * Verifies deterministic intake preflight decisions, separation of evidence grade,
 * exact-envelope semantics, device cache safety, and preservation of the destructive boundary.
 * 
 * ZERO MUTATION of user media files.
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  evaluateMediaFacts,
  preflightIncomingMedia,
  IntakeClassification,
  EvidenceBasis
} from './src/preflight/intake-preflight.mjs';
import { findRepairCandidate } from './src/normalization/repair-rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('============================================================');
console.log('🧪 RUNNING ISSUE #21 FUTURE INTAKE GATE TEST SUITE');
console.log('============================================================\n');

let totalTests = 0;
let passedTests = 0;

function check(condition, name, details = '') {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${name} ${details ? `(${details})` : ''}`);
    throw new Error(`Test failed: ${name} ${details}`);
  }
}

// Synthetic media facts fixture helper
function makeVideoFacts(overrides = {}) {
  return {
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main',
    level: 153,
    bitDepth: 8,
    width: 4096,
    height: 2048,
    rFps: '60000/1001',
    avgFps: '60000/1001',
    durationSec: 60.0,
    ...overrides
  };
}

function makeFacts(overrides = {}) {
  return {
    videoCount: 1,
    video: makeVideoFacts(),
    audioCount: 1,
    audioStreams: [{ codec: 'aac', channels: 2, sampleRate: 48000 }],
    otherStreams: [],
    chapterCount: 0,
    chapters: [],
    subtitleCount: 0,
    moovLocation: 'moov_first',
    fingerprint: {
      canonicalPath: '/test/media.mp4',
      sizeBytes: 1024000,
      mtimeMs: 1700000000000,
      fingerprintId: 'mock_fp_12345'
    },
    ...overrides
  };
}

async function runAllIntakeTests() {
  // Test 1: H264/avc1 static-ready sample facts => READY_DIRECT / STATIC_POLICY_ONLY
  console.log('Test 1: H264/avc1 static-ready sample facts');
  const factsH264 = makeFacts({
    video: makeVideoFacts({
      codec: 'h264',
      codecTag: 'avc1',
      profile: 'High',
      level: 41,
      bitDepth: 8,
      width: 1920,
      height: 1080,
      rFps: '30/1',
      avgFps: '30/1'
    })
  });
  const resH264 = evaluateMediaFacts(factsH264, 'sample_h264.mp4');
  check(resH264.classification === IntakeClassification.READY_DIRECT, 'H264 classified as READY_DIRECT');
  check(resH264.evidenceBasis === EvidenceBasis.STATIC_POLICY_ONLY, 'H264 evidence basis is STATIC_POLICY_ONLY');
  check(resH264.mayPromoteToVrReady === true, 'H264 mayPromoteToVrReady is true');
  check(resH264.matchedPolicy === 'safari-static-direct-h264', 'H264 matches static H264 policy');

  // Test 2: HEVC/hvc1 8-bit static-ready facts => READY_DIRECT / STATIC_POLICY_ONLY
  console.log('\nTest 2: HEVC/hvc1 8-bit static-ready facts');
  const factsHvc1 = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hvc1',
      profile: 'Main',
      level: 153,
      bitDepth: 8,
      width: 4096,
      height: 2048,
      rFps: '60000/1001',
      avgFps: '60000/1001'
    })
  });
  const resHvc1 = evaluateMediaFacts(factsHvc1, 'sample_hevc_canonical.mp4');
  check(resHvc1.classification === IntakeClassification.READY_DIRECT, 'HEVC hvc1 8-bit classified as READY_DIRECT');
  check(resHvc1.evidenceBasis === EvidenceBasis.STATIC_POLICY_ONLY, 'HEVC hvc1 evidence basis is STATIC_POLICY_ONLY');
  check(resHvc1.mayPromoteToVrReady === true, 'HEVC hvc1 mayPromoteToVrReady is true');
  check(resHvc1.matchedPolicy === 'safari-static-direct-hvc1-8bit', 'HEVC hvc1 matches static hvc1 policy');

  // Test 3: Certified AV1 direct envelope => READY_DIRECT / CERTIFIED_PHYSICAL_DEVICE
  console.log('\nTest 3: Certified AV1 direct envelope');
  const factsAv1 = makeFacts({
    video: makeVideoFacts({
      codec: 'av1',
      codecTag: 'av01',
      profile: 'Main',
      level: 16,
      bitDepth: 8,
      width: 4320,
      height: 2160,
      rFps: '60/1',
      avgFps: '60/1'
    }),
    moovLocation: 'mdat_first'
  });
  const resAv1 = evaluateMediaFacts(factsAv1, 'sample_av1_direct.mp4');
  check(resAv1.classification === IntakeClassification.READY_DIRECT, 'AV1 4K60 classified as READY_DIRECT');
  check(resAv1.evidenceBasis === EvidenceBasis.CERTIFIED_PHYSICAL_DEVICE, 'AV1 evidence basis is CERTIFIED_PHYSICAL_DEVICE');
  check(resAv1.mayPromoteToVrReady === true, 'AV1 mayPromoteToVrReady is true');
  check(resAv1.matchedEnvelopeId === 'CERTIFIED_DIRECT_AV1_4K_60_MDAT_FIRST', 'AV1 matches mdat_first direct envelope');

  // Test 4: Older accepted HEVC certified repair envelope => NORMALIZATION_CANDIDATE_CERTIFIED
  console.log('\nTest 4: Older accepted HEVC certified repair envelope');
  const factsWakuiA2 = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main',
      level: 153,
      bitDepth: 8,
      width: 4096,
      height: 2048,
      rFps: '60000/1001',
      avgFps: '60000/1001'
    }),
    moovLocation: 'moov_first'
  });
  const resWakui = evaluateMediaFacts(factsWakuiA2, 'sample_wakui_a2.mp4');
  check(resWakui.classification === IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED, 'Wakui A2 classified as NORMALIZATION_CANDIDATE_CERTIFIED');
  check(resWakui.evidenceBasis === EvidenceBasis.CERTIFIED_PHYSICAL_DEVICE, 'Wakui A2 evidence basis is CERTIFIED_PHYSICAL_DEVICE');
  check(resWakui.mayPromoteToVrReady === false, 'Wakui A2 mayPromoteToVrReady is false');
  check(resWakui.requiresUserAuthorization === true, 'Wakui A2 requiresUserAuthorization is true');
  check(resWakui.proposedOperation.outputTag === 'hvc1', 'Wakui A2 proposed operation is hvc1 stream-copy');
  check(resWakui.normalizationPlan.destructiveAuthorizationGranted === false, 'Destructive authorization is not pre-granted');
  check(resWakui.matchedEnvelopeId === 'BUCKET_A2_4K_60FPS_WAKUI', 'Matched Wakui A2 bucket ID');

  // Test 5: Newly accepted 4320×2160 Main 10 60000/1001 repair envelope (Envelope B)
  console.log('\nTest 5: Newly accepted 4320×2160 Main 10 60000/1001 repair envelope');
  const factsEnvB = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main 10',
      level: 180,
      bitDepth: 10,
      width: 4320,
      height: 2160,
      rFps: '60000/1001',
      avgFps: '60000/1001'
    }),
    moovLocation: 'moov_first'
  });
  const resEnvB = evaluateMediaFacts(factsEnvB, 'sample_env_b.mp4');
  check(resEnvB.classification === IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED, 'Envelope B classified as NORMALIZATION_CANDIDATE_CERTIFIED');
  check(resEnvB.evidenceBasis === EvidenceBasis.CERTIFIED_PHYSICAL_DEVICE, 'Envelope B evidence basis is CERTIFIED_PHYSICAL_DEVICE');
  check(resEnvB.mayPromoteToVrReady === false, 'Envelope B mayPromoteToVrReady is false');
  check(resEnvB.matchedEnvelopeId === 'NEW_ENVELOPE_B_4320x2160_60000_1001_MAIN10_L180_MOOV_FIRST', 'Matched newly certified Envelope B');

  // Test 6: Valid HEVC clean unknown exact envelope => NEEDS_BUCKET_CERTIFICATION
  console.log('\nTest 6: Valid HEVC clean unknown exact envelope');
  const factsCleanUnknown = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main',
      level: 120,
      bitDepth: 8,
      width: 1920,
      height: 1080,
      rFps: '30/1',
      avgFps: '30/1'
    }),
    moovLocation: 'moov_first'
  });
  const resCleanUnknown = evaluateMediaFacts(factsCleanUnknown, 'sample_unknown_clean.mp4');
  check(resCleanUnknown.classification === IntakeClassification.NEEDS_BUCKET_CERTIFICATION, 'Uncertified clean HEVC classified as NEEDS_BUCKET_CERTIFICATION');
  check(resCleanUnknown.evidenceBasis === EvidenceBasis.UNCERTIFIED_HEVC, 'Evidence basis is UNCERTIFIED_HEVC');
  check(resCleanUnknown.mayPromoteToVrReady === false, 'mayPromoteToVrReady is false for uncertified clean HEVC');

  // Test 7: Unknown/chapter/data topology not covered by certified rule => fail closed
  console.log('\nTest 7: Unknown/chapter/data topology not covered by certified rule');
  const factsA1Chapters = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main',
      level: 153,
      bitDepth: 8,
      width: 3840,
      height: 1920,
      rFps: '2997/50',
      avgFps: '262749987/4359446'
    }),
    chapterCount: 3,
    chapters: [{ id: 1 }, { id: 2 }, { id: 3 }]
  });
  const resA1Chapters = evaluateMediaFacts(factsA1Chapters, 'sample_a1_chapters.mp4');
  check(resA1Chapters.classification === IntakeClassification.UNSUPPORTED_UNKNOWN_FIX, 'Untested chapter topology fails closed to UNSUPPORTED_UNKNOWN_FIX');
  check(resA1Chapters.mayPromoteToVrReady === false, 'mayPromoteToVrReady is false');

  // Test 8: Unsupported codec => UNSUPPORTED_UNKNOWN_FIX
  console.log('\nTest 8: Unsupported codec');
  const factsVp8 = makeFacts({
    video: makeVideoFacts({
      codec: 'vp8',
      codecTag: 'vp08',
      profile: '0',
      level: -1,
      bitDepth: 8,
      width: 1920,
      height: 1080,
      rFps: '30/1',
      avgFps: '30/1'
    })
  });
  const resVp8 = evaluateMediaFacts(factsVp8, 'sample_vp8.mp4');
  check(resVp8.classification === IntakeClassification.UNSUPPORTED_UNKNOWN_FIX, 'VP8 classified as UNSUPPORTED_UNKNOWN_FIX');
  check(resVp8.mayPromoteToVrReady === false, 'mayPromoteToVrReady is false for VP8');

  // Test 9: Unreadable probe => UNREADABLE_MEDIA
  console.log('\nTest 9: Unreadable probe');
  const resUnreadable = evaluateMediaFacts(null, 'sample_corrupt.mp4');
  check(resUnreadable.classification === IntakeClassification.UNREADABLE_MEDIA, 'Null facts classified as UNREADABLE_MEDIA');
  check(resUnreadable.evidenceBasis === EvidenceBasis.UNREADABLE_OR_INVALID, 'Evidence basis is UNREADABLE_OR_INVALID');
  check(resUnreadable.mayPromoteToVrReady === false, 'mayPromoteToVrReady is false for unreadable media');

  // Test 10: Missing material fact such as avgFps/bitDepth => fail closed
  console.log('\nTest 10: Missing material fact such as avgFps/bitDepth');
  const factsNullBitDepth = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main',
      level: 153,
      bitDepth: null,
      width: 4096,
      height: 2048,
      rFps: '60000/1001',
      avgFps: '60000/1001'
    })
  });
  const resNullBitDepth = evaluateMediaFacts(factsNullBitDepth, 'sample_null_bitdepth.mp4');
  check(resNullBitDepth.classification === IntakeClassification.NEEDS_DEVICE_PROBE, 'Null bitDepth fails closed to NEEDS_DEVICE_PROBE');
  check(resNullBitDepth.mayPromoteToVrReady === false, 'mayPromoteToVrReady is false');

  const factsMissingAvgFps = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main',
      level: 153,
      bitDepth: 8,
      width: 4096,
      height: 2048,
      rFps: '60000/1001',
      avgFps: ''
    })
  });
  const resMissingAvgFps = evaluateMediaFacts(factsMissingAvgFps, 'sample_empty_avgfps.mp4');
  check(resMissingAvgFps.classification === IntakeClassification.NEEDS_DEVICE_PROBE, 'Missing avgFps fails closed to NEEDS_DEVICE_PROBE');
  check(resMissingAvgFps.mayPromoteToVrReady === false, 'mayPromoteToVrReady is false');

  // Test 11: Filename containing av01 while actual probe facts say HEVC => classify from facts
  console.log('\nTest 11: Filename containing av01 while actual probe facts say HEVC');
  const factsEllieNova = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main',
      level: 153,
      bitDepth: 8,
      width: 4096,
      height: 2048,
      rFps: '60/1',
      avgFps: '60/1'
    }),
    moovLocation: 'moov_first'
  });
  const fakeAv01Path = 'Render/4320_2160_crfun_av01-Ellie Nova - This Isnt The First Time.mp4';
  const resEllie = evaluateMediaFacts(factsEllieNova, fakeAv01Path);
  check(resEllie.classification === IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED, 'Classified from probe facts as HEVC repair candidate, ignoring av01 in filename');
  check(resEllie.matchedEnvelopeId === 'NEW_ENVELOPE_C_4096x2048_60_1_MAIN_L153_MOOV_FIRST', 'Matched newly certified Envelope C');

  // Test 12: Exact-envelope fps distinction: 60/1 must not equal 60000/1001 or 2997/50
  console.log('\nTest 12: Exact-envelope FPS distinction');
  // Exact 60/1 facts
  const facts60_1 = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main 10',
      level: 180,
      bitDepth: 10,
      width: 4320,
      height: 2160,
      rFps: '60/1',
      avgFps: '60/1'
    })
  });
  const res60_1 = evaluateMediaFacts(facts60_1, 'sample_60_1.mp4');
  check(res60_1.matchedEnvelopeId === 'HISTORIC_ENVELOPE_C_4320x2160_60_1_MAIN10_L180', '60/1 matches exact 60/1 envelope');

  // Exact 60000/1001 facts
  const facts60000_1001 = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main 10',
      level: 180,
      bitDepth: 10,
      width: 4320,
      height: 2160,
      rFps: '60000/1001',
      avgFps: '60000/1001'
    }),
    moovLocation: 'moov_first'
  });
  const res60000_1001 = evaluateMediaFacts(facts60000_1001, 'sample_60000_1001.mp4');
  check(res60000_1001.matchedEnvelopeId === 'NEW_ENVELOPE_B_4320x2160_60000_1001_MAIN10_L180_MOOV_FIRST', '60000/1001 matches Envelope B, not 60/1');

  // Cross check: 60/1 facts tested against 60000/1001 envelope do NOT cross-match
  check(res60_1.matchedEnvelopeId !== res60000_1001.matchedEnvelopeId, '60/1 and 60000/1001 strictly distinguished');

  // Test 13: Device cache safety test — canPlay=true without positive video fails closed
  console.log('\nTest 13: Device cache safety test');
  const mockCacheNoVideo = {
    get(fpId) {
      return {
        cachedAt: new Date().toISOString(),
        result: { canPlay: true, videoWidth: 0, videoHeight: 0, rvfcFrameCount: 0 }
      };
    }
  };
  const factsCacheTest = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'hev1',
      profile: 'Main 10',
      level: 150,
      bitDepth: 10,
      width: 1920,
      height: 1080,
      rFps: '30/1',
      avgFps: '30/1'
    })
  });
  const resCacheNoVideo = await preflightIncomingMedia('sample_cache_test.mp4', {
    facts: factsCacheTest,
    probeCache: mockCacheNoVideo
  });
  check(resCacheNoVideo.classification === IntakeClassification.NEEDS_DEVICE_PROBE, 'canPlay=true without positive video does NOT produce READY_DIRECT');
  check(resCacheNoVideo.mayPromoteToVrReady === false, 'mayPromoteToVrReady is false when cached video is 0x0');

  // Device cache with verified positive video produces FILE_SPECIFIC_DEVICE_PROBE
  const mockCachePositive = {
    get(fpId) {
      return {
        cachedAt: new Date().toISOString(),
        result: { canPlay: true, videoWidth: 1920, videoHeight: 1080, rvfcFrameCount: 15 }
      };
    }
  };
  const resCachePositive = await preflightIncomingMedia('sample_cache_test.mp4', {
    facts: factsCacheTest,
    probeCache: mockCachePositive
  });
  check(resCachePositive.classification === IntakeClassification.READY_DIRECT, 'Positive video cached probe produces READY_DIRECT');
  check(resCachePositive.evidenceBasis === EvidenceBasis.FILE_SPECIFIC_DEVICE_PROBE, 'Evidence basis is FILE_SPECIFIC_DEVICE_PROBE, NOT CERTIFIED_PHYSICAL_DEVICE');
  check(resCachePositive.mayPromoteToVrReady === true, 'mayPromoteToVrReady is true for proven positive video');

  // Test 14: Destructive-boundary regression test
  console.log('\nTest 14: Destructive-boundary regression test');
  // For newly certified Envelope B:
  // 1. Intake evaluates it as NORMALIZATION_CANDIDATE_CERTIFIED
  check(resEnvB.classification === IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED, 'Intake recognizes newly certified repair envelope');
  // 2. Normalization execution matcher from repair-rules.mjs MUST return null (unwidened legacy tranche)
  const legacyRepairRule = findRepairCandidate(factsEnvB, '.mp4');
  check(legacyRepairRule === null, 'Existing destructive execution matcher does NOT automatically gain authorization for Envelope B');

  // Test 15: CLI Operator Entry Point
  console.log('\nTest 15: CLI Operator Entry Point execution');
  const cliPath = path.join(__dirname, 'src/preflight/intake-preflight.mjs');
  try {
    const stdout = execSync(`node "${cliPath}" non_existent_dummy_file.mp4`, {
      encoding: 'utf8',
      cwd: path.join(__dirname, '../..')
    });
    const parsed = JSON.parse(stdout);
    check(parsed.classification === IntakeClassification.UNREADABLE_MEDIA, 'CLI correctly reports UNREADABLE_MEDIA for missing file');
    check(parsed.mayPromoteToVrReady === false, 'CLI reports mayPromoteToVrReady: false');
    check(Array.isArray(parsed.allowedNextActions), 'CLI reports allowedNextActions array');
  } catch (err) {
    throw new Error(`CLI execution failed: ${err.message}`);
  }

  // Test 16: Missing chapterCount fails closed (not READY_DIRECT, cannot inherit certified repair envelope)
  console.log('\nTest 16: Missing chapterCount fails closed');
  const factsMissingChaptersReady = makeFacts({
    video: makeVideoFacts({ codec: 'h264', codecTag: 'avc1', profile: 'High', level: 41, bitDepth: 8, width: 1920, height: 1080, rFps: '30/1', avgFps: '30/1' }),
    chapterCount: undefined,
    chapters: undefined
  });
  const resMissingChaptersReady = evaluateMediaFacts(factsMissingChaptersReady, 'sample_h264.mp4');
  check(resMissingChaptersReady.classification !== IntakeClassification.READY_DIRECT, 'Missing chapterCount is NOT READY_DIRECT');
  check(resMissingChaptersReady.mayPromoteToVrReady === false, 'Missing chapterCount cannot promote to VR Ready');

  const factsMissingChaptersRepair = makeFacts({
    video: makeVideoFacts({ codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', level: 180, bitDepth: 10, width: 4320, height: 2160, rFps: '60000/1001', avgFps: '60000/1001' }),
    chapterCount: undefined,
    chapters: undefined
  });
  const resMissingChaptersRepair = evaluateMediaFacts(factsMissingChaptersRepair, 'sample_env_b.mp4');
  check(resMissingChaptersRepair.classification !== IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED, 'Missing chapterCount cannot inherit certified repair envelope');

  // Test 17: Missing otherStreams fails closed (not READY_DIRECT, cannot inherit certified repair envelope)
  console.log('\nTest 17: Missing otherStreams fails closed');
  const factsMissingOtherReady = makeFacts({
    video: makeVideoFacts({ codec: 'h264', codecTag: 'avc1', profile: 'High', level: 41, bitDepth: 8, width: 1920, height: 1080, rFps: '30/1', avgFps: '30/1' }),
    otherStreams: undefined
  });
  const resMissingOtherReady = evaluateMediaFacts(factsMissingOtherReady, 'sample_h264.mp4');
  check(resMissingOtherReady.classification !== IntakeClassification.READY_DIRECT, 'Missing otherStreams is NOT READY_DIRECT');
  check(resMissingOtherReady.mayPromoteToVrReady === false, 'Missing otherStreams cannot promote to VR Ready');

  const factsMissingOtherRepair = makeFacts({
    video: makeVideoFacts({ codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', level: 180, bitDepth: 10, width: 4320, height: 2160, rFps: '60000/1001', avgFps: '60000/1001' }),
    otherStreams: undefined
  });
  const resMissingOtherRepair = evaluateMediaFacts(factsMissingOtherRepair, 'sample_env_b.mp4');
  check(resMissingOtherRepair.classification !== IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED, 'Missing otherStreams cannot inherit certified repair envelope');

  // Test 18: Missing subtitleCount fails closed (not READY_DIRECT, cannot inherit certified repair envelope)
  console.log('\nTest 18: Missing subtitleCount fails closed');
  const factsMissingSubtitleReady = makeFacts({
    video: makeVideoFacts({ codec: 'h264', codecTag: 'avc1', profile: 'High', level: 41, bitDepth: 8, width: 1920, height: 1080, rFps: '30/1', avgFps: '30/1' }),
    subtitleCount: undefined
  });
  const resMissingSubtitleReady = evaluateMediaFacts(factsMissingSubtitleReady, 'sample_h264.mp4');
  check(resMissingSubtitleReady.classification !== IntakeClassification.READY_DIRECT, 'Missing subtitleCount is NOT READY_DIRECT');
  check(resMissingSubtitleReady.mayPromoteToVrReady === false, 'Missing subtitleCount cannot promote to VR Ready');

  const factsMissingSubtitleRepair = makeFacts({
    video: makeVideoFacts({ codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', level: 180, bitDepth: 10, width: 4320, height: 2160, rFps: '60000/1001', avgFps: '60000/1001' }),
    subtitleCount: undefined
  });
  const resMissingSubtitleRepair = evaluateMediaFacts(factsMissingSubtitleRepair, 'sample_env_b.mp4');
  check(resMissingSubtitleRepair.classification !== IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED, 'Missing subtitleCount cannot inherit certified repair envelope');

  // Test 19: Contradictory codec=hevc + codecTag=avc1 fails closed (not READY_DIRECT)
  console.log('\nTest 19: Contradictory codec=hevc + codecTag=avc1 fails closed');
  const factsContradictory = makeFacts({
    video: makeVideoFacts({
      codec: 'hevc',
      codecTag: 'avc1',
      profile: 'Main',
      level: 153,
      bitDepth: 8,
      width: 1920,
      height: 1080,
      rFps: '30/1',
      avgFps: '30/1'
    })
  });
  const resContradictory = evaluateMediaFacts(factsContradictory, 'contradictory_sample.mp4');
  check(resContradictory.classification !== IntakeClassification.READY_DIRECT, 'Contradictory codec=hevc + codecTag=avc1 is strictly NOT READY_DIRECT');
  check(resContradictory.mayPromoteToVrReady === false, 'Contradictory media mayPromoteToVrReady is false');
  check(resContradictory.matchedPolicy !== 'safari-static-direct-h264', 'Contradictory media does not match static H.264 policy');

  console.log('\n============================================================');
  console.log(`📊 INTAKE GATE TEST SUITE RESULTS: ${passedTests} / ${totalTests} PASSED`);
  console.log('============================================================\n');
}

runAllIntakeTests().catch(err => {
  console.error('Fatal test failure:', err);
  process.exit(1);
});
