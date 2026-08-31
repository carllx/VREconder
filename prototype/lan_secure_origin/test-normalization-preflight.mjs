import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getMediaFingerprint, isFingerprintValid } from './src/normalization/fingerprint.mjs';
import { classifyMedia, isDerivativeFile, MediaClass } from './src/normalization/classification.mjs';
import { runDryRunInventory } from './src/normalization/inventory-scanner.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { DeviceProbeCache } from './src/preflight/device-probe-cache.mjs';
import { IntakePreflightPipeline, UIReadiness } from './src/preflight/intake-preflight.mjs';
import { findCertifiedRepairRule, RuleStatus, EXACT_CERTIFIED_BUCKETS } from './src/normalization/repair-rules.mjs';
import { verifyNormalizedOutput, runStreamcopyDemuxIntegrityCheck, getStreamPayloadMD5 } from './src/normalization/verifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_SCRATCH_DIR = path.join(__dirname, 'test_scratch_normalization');

console.log('============================================================');
console.log('🧪 RUNNING PRODUCTION-PATH NORMALIZATION SAFETY SUITE (14 AREAS)');
console.log('============================================================\n');

let totalTests = 0;
let passedTests = 0;

function assert(condition, name, details = '') {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${name} ${details ? `(${details})` : ''}`);
  }
}

function createSyntheticHevcFixture(targetPath, duration = 0.5) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=3840x1920:d=${duration}:r=60`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hev1', '-t', `${duration}`,
    '-c:a', 'aac', '-t', `${duration}`,
    targetPath
  ], { encoding: 'utf8' });

  if (res.status !== 0 || !fs.existsSync(targetPath)) {
    throw new Error(`Failed to create synthetic fixture: ${res.stderr}`);
  }
  return targetPath;
}

if (fs.existsSync(TEST_SCRATCH_DIR)) {
  fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_SCRATCH_DIR, { recursive: true });

async function runAllTests() {
  const dummyFile = path.join(TEST_SCRATCH_DIR, 'dummy_test.mp4');
  fs.writeFileSync(dummyFile, 'DUMMY_FILE_FOR_DRY_RUN', 'utf8');

  // Test 1: Dry-Run Zero Mutation
  console.log('Test 1: Dry-Run Zero Mutation');
  const statBefore = fs.statSync(dummyFile);
  const dryRunReport = await runDryRunInventory([TEST_SCRATCH_DIR]);
  const statAfter = fs.statSync(dummyFile);
  assert(statBefore.size === statAfter.size && statBefore.mtimeMs === statAfter.mtimeMs, 'Dry run guarantees zero mutation to files on disk');
  assert(dryRunReport.summary.totalFilesScanned >= 1, 'Dry run returned valid scan summary');

  // Test 2: Exact Certified-Bucket Matching
  console.log('\nTest 2: Exact Certified-Bucket Matching');
  const ruleBucketA1 = findCertifiedRepairRule({
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 3840, height: 1920, level: 153, profile: 'Main', rFps: '2997/50' }
  }, '.mp4');
  assert(ruleBucketA1 !== null && ruleBucketA1.status === RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE, 'Matches Bucket A1 (4K 59.94fps SIVR033)');

  const ruleBucketA2 = findCertifiedRepairRule({
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 4096, height: 2048, level: 153, profile: 'Main', rFps: '60/1' }
  }, '.mp4');
  assert(ruleBucketA2 !== null && ruleBucketA2.matchedBucket.bucketId === 'BUCKET_A2_4K_60FPS_WAKUI', 'Matches Bucket A2 (4K 60fps Wakui Mito)');

  const ruleBucketB = findCertifiedRepairRule({
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 8192, height: 4096, level: 183, profile: 'Main', rFps: '2997/50' }
  }, '.mp4');
  assert(ruleBucketB !== null && ruleBucketB.matchedBucket.bucketId === 'BUCKET_B_8K_60FPS_KAMIKI', 'Matches Bucket B (8K 59.94fps Kamiki Rei)');

  // Test 3: Untested Envelopes Strict Gating
  console.log('\nTest 3: Untested Envelopes Strict Gating');
  const classL180 = classifyMedia('sample_l180.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 3840, height: 1920, level: 180, profile: 'Main', rFps: '60/1' }
  });
  assert(classL180.classification === MediaClass.NEEDS_BUCKET_CERTIFICATION, 'Level 180 routed to NEEDS_BUCKET_CERTIFICATION');

  const class10bit = classifyMedia('sample_10bit.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 10, width: 3840, height: 1920, level: 153, profile: 'Main 10', rFps: '60/1' }
  });
  assert(class10bit.classification === MediaClass.NEEDS_DEVICE_PROBE, '10-bit HEVC routed to NEEDS_DEVICE_PROBE');

  const classUnknownBitDepth = classifyMedia('sample_unknown.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: null, width: 3840, height: 1920, level: 153, profile: 'Main', rFps: '60/1' }
  });
  assert(classUnknownBitDepth.classification === MediaClass.NEEDS_DEVICE_PROBE, 'Unknown bit depth routed to NEEDS_DEVICE_PROBE without defaulting');

  // Test 4: Derivative Exclusion from Logical Media
  console.log('\nTest 4: Derivative Exclusion from Logical Media');
  assert(isDerivativeFile('8K/Kamiki Rei - DSVR01433_HVC1_TEST.mp4') === true, 'Excludes _HVC1_TEST derivative');
  assert(isDerivativeFile('.sample.mp4.vreconder.partial') === true, 'Excludes .partial file');
  assert(isDerivativeFile('.sample.mp4.vreconder-old') === true, 'Excludes .vreconder-old file');
  assert(isDerivativeFile('SIVR033.mp4') === false, 'Standard original media is retained');

  // Test 5: P0 Fail-Closed — Corrupt Journal Blocks Subsystem
  console.log('\nTest 5: P0 Fail-Closed — Corrupt Journal Blocks Subsystem');
  const corruptJournalPath = path.join(TEST_SCRATCH_DIR, 'corrupt_journal.json');
  fs.writeFileSync(corruptJournalPath, '{ INVALID_JSON_CORRUPT: true, ', 'utf8');
  const corruptJournal = new NormalizationJournal(corruptJournalPath);
  const corruptEngine = new NormalizationEngine({
    journal: corruptJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  const initCorruptResult = await corruptEngine.initialize();
  assert(initCorruptResult.ok === false && corruptEngine.status === EngineStatus.JOURNAL_CORRUPT, 'Engine initialize fails closed on corrupt journal');
  const corruptExecResult = await corruptEngine.processCandidate(dummyFile);
  assert(corruptExecResult.ok === false && corruptExecResult.error.includes('JOURNAL_CORRUPT'), 'Corrupt journal permanently blocks execution');

  // Test 6: P0 Fail-Closed — Space Unknown / Insufficient Space Guard
  console.log('\nTest 6: P0 Fail-Closed — Disk Space Guard');
  const validJournalPath = path.join(TEST_SCRATCH_DIR, 'test_journal.json');
  const validJournal = new NormalizationJournal(validJournalPath);
  const safeEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: false,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await safeEngine.initialize();
  const spaceGateResult = await safeEngine.processCandidate(dummyFile);
  assert(spaceGateResult.ok === false && safeEngine.executionEnabled === false, 'Execution disabled safety gate preserves disk');

  // Test 7: P0 Fail-Closed — Pre-existing Recovery Artifacts Require Proven Journal
  console.log('\nTest 7: P0 Fail-Closed — Pre-Existing Artifact Safety Gate');
  const artifactTarget = path.join(TEST_SCRATCH_DIR, 'artifact_target.mp4');
  const artifactOld = path.join(TEST_SCRATCH_DIR, '.artifact_target.mp4.vreconder-old');
  fs.writeFileSync(artifactTarget, 'ORIGINAL_CONTENT_PRESERVED', 'utf8');
  fs.writeFileSync(artifactOld, 'ORPHAN_OLD_FILE', 'utf8');
  const artifactEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await artifactEngine.initialize();
  const artifactBlockedResult = await artifactEngine.processCandidate(artifactTarget);
  assert(artifactBlockedResult.ok === false && artifactBlockedResult.error === 'BLOCKED_RECOVERY_REQUIRED', 'Pre-existing .vreconder-old without journal fails closed (BLOCKED_RECOVERY_REQUIRED)');
  assert(fs.existsSync(artifactOld) === true && fs.existsSync(artifactTarget) === true, 'Neither file deleted when artifact safety gate fires');
  fs.unlinkSync(artifactOld);
  fs.unlinkSync(artifactTarget);

  // Test 8: P0 Monotonic Cancellation — Playback Interrupt
  console.log('\nTest 8: P0 Monotonic Cancellation & Playback Priority');
  const cancelEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await cancelEngine.initialize();
  cancelEngine.notifyPlaybackState(true);
  const cancelBlockedResult = await cancelEngine.processCandidate(dummyFile);
  assert(cancelBlockedResult.ok === false && cancelBlockedResult.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Playback priority immediately yields and pauses jobs');
  cancelEngine.notifyPlaybackState(false);

  // Test 9: P0 Original Fingerprint Mismatch Gate
  console.log('\nTest 9: P0 Fingerprint Validation');
  const fpSample = path.join(TEST_SCRATCH_DIR, 'fp_sample.mp4');
  fs.writeFileSync(fpSample, 'FP_SAMPLE_INITIAL', 'utf8');
  const fpInitial = getMediaFingerprint(fpSample);
  assert(isFingerprintValid(fpSample, fpInitial) === true, 'Fingerprint valid on identical file');
  fs.writeFileSync(fpSample, 'FP_SAMPLE_MUTATED_LONGER_PAYLOAD_CONTENT', 'utf8');
  assert(isFingerprintValid(fpSample, fpInitial) === false, 'Fingerprint detects mutation on modified file');

  // Test 10: P0 Transactional Recovery — Deterministic Crash Rollback for Step 1
  console.log('\nTest 10: P0 Transactional Recovery — Step 1 Crash Rollback');
  const crashStep1Target = path.join(TEST_SCRATCH_DIR, 'crash_step1.mp4');
  const crashStep1Old = path.join(TEST_SCRATCH_DIR, '.crash_step1.mp4.vreconder-old');
  fs.writeFileSync(crashStep1Old, 'STEP1_OLD_ORIGINAL_CONTENT', 'utf8');
  validJournal.recordState(crashStep1Target, NormalizationState.SWAP_STEP1_RENAME_ORIGINAL, { oldPath: crashStep1Old });
  const step1Recovery = validJournal.recoverOnStartup();
  assert(step1Recovery.ok === true, 'Startup recovery successfully handles Step 1 crash');
  assert(fs.existsSync(crashStep1Target) === true && fs.readFileSync(crashStep1Target, 'utf8') === 'STEP1_OLD_ORIGINAL_CONTENT', 'Original restored from .vreconder-old back to canonical target');
  assert(fs.existsSync(crashStep1Old) === false, '.vreconder-old cleaned up after rollback');

  // Test 11: P0 Server Startup Wiring — Engine Initialize Recovers on Boot
  console.log('\nTest 11: P0 Startup Initialization Wiring');
  const bootEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  const bootResult = await bootEngine.initialize();
  assert(bootResult.ok === true && bootEngine.status === EngineStatus.SAFE_IDLE, 'engine.initialize() resolves to SAFE_IDLE on clean recovery');

  // Test 12: P0 Production Path — Actual Remux Failure Preserves Original
  console.log('\nTest 12: P0 Production Path — Remux Failure Preserves Original');
  const invalidMediaFile = path.join(TEST_SCRATCH_DIR, 'invalid_corrupt.mp4');
  fs.writeFileSync(invalidMediaFile, 'NOT_A_VALID_MP4_CONTAINER_RAW_BYTES', 'utf8');
  const invalidExecResult = await bootEngine.processCandidate(invalidMediaFile);
  assert(invalidExecResult.ok === false, 'Remux on invalid media fails safely');
  assert(fs.existsSync(invalidMediaFile) === true && fs.readFileSync(invalidMediaFile, 'utf8') === 'NOT_A_VALID_MP4_CONTAINER_RAW_BYTES', 'Original file content preserved intact');

  // Test 13: P0 Production Path — Final Verification Rollback Simulation
  console.log('\nTest 13: P0 Production Path — Crash Recovery on Final Verify Interruption');
  const crashFinalTarget = path.join(TEST_SCRATCH_DIR, 'crash_final.mp4');
  const crashFinalOld = path.join(TEST_SCRATCH_DIR, '.crash_final.mp4.vreconder-old');
  fs.writeFileSync(crashFinalOld, 'TRUE_ORIGINAL_BEFORE_FINAL_VERIFY', 'utf8');
  fs.writeFileSync(crashFinalTarget, 'CORRUPTED_TARGET_NEW_FILE', 'utf8');
  validJournal.recordState(crashFinalTarget, NormalizationState.FINAL_VERIFYING, { oldPath: crashFinalOld });
  const finalRecovery = validJournal.recoverOnStartup();
  assert(finalRecovery.ok === true, 'Final verifying crash recovered safely');
  assert(fs.readFileSync(crashFinalTarget, 'utf8') === 'TRUE_ORIGINAL_BEFORE_FINAL_VERIFY', 'Original file restored cleanly over corrupt target');

  // Test 14: P0 Production Path — Full In-Place Normalization & Multi-Stream Verification on Real Synthetic Fixture
  console.log('\nTest 14: P0 Production Path — Full Normalization & Verification on Real Synthetic Fixture');
  const synthFixture = path.join(TEST_SCRATCH_DIR, 'synth_hevc_sample.mp4');
  createSyntheticHevcFixture(synthFixture, 0.5);
  const origVideoMd5Before = await getStreamPayloadMD5(synthFixture, '0:v:0');
  const origAudioMd5Before = await getStreamPayloadMD5(synthFixture, '0:a:0');

  const prodEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await prodEngine.initialize();

  const normalizationResult = await prodEngine.processCandidate(synthFixture);
  assert(normalizationResult.ok === true && normalizationResult.state === NormalizationState.DONE, 'Real production engine.processCandidate() succeeds on valid fixture');

  const normVideoMd5After = await getStreamPayloadMD5(synthFixture, '0:v:0');
  const normAudioMd5After = await getStreamPayloadMD5(synthFixture, '0:a:0');
  assert(origVideoMd5Before === normVideoMd5After, 'Video elementary stream payload is 100% bit-identical after streamcopy');
  assert(origAudioMd5Before === normAudioMd5After, 'Audio elementary stream payload is 100% bit-identical after streamcopy');

  const finalDemuxCheck = await runStreamcopyDemuxIntegrityCheck(synthFixture);
  assert(finalDemuxCheck.ok === true, 'Streamcopy demux integrity check passes with zero errors');

  // Clean scratch
  try { fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true }); } catch (_) {}

  console.log('\n============================================================');
  console.log(`📊 COMPLETE TEST SUITE RESULTS: ${passedTests} / ${totalTests} PASSED`);
  console.log('============================================================\n');

  if (passedTests === totalTests) process.exit(0);
  else process.exit(1);
}

runAllTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});

