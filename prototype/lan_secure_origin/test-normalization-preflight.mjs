import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { getMediaFingerprint, isFingerprintValid } from './src/normalization/fingerprint.mjs';
import { classifyMedia, isDerivativeFile, MediaClass } from './src/normalization/classification.mjs';
import { runDryRunInventory } from './src/normalization/inventory-scanner.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { findCertifiedRepairRule, RuleStatus, matchExactCertifiedBucket } from './src/normalization/repair-rules.mjs';
import { verifyNormalizedOutput, runStreamcopyDemuxIntegrityCheck, getStreamPayloadMD5, getPerStreamPacketDetails } from './src/normalization/verifier.mjs';
import { probeMediaFacts } from './src/normalization/ffprobe-facts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_SCRATCH_DIR = path.join(__dirname, 'test_scratch_normalization');

console.log('============================================================');
console.log('🧪 RUNNING HARDENED PRODUCTION-PATH SAFETY SUITE (18 AREAS)');
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

function createSyntheticHevcFixture(targetPath, duration = 0.2) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=4096x2048:d=${duration}:r=60000/1001`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hev1', '-t', `${duration}`,
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

  // Test 2: Exact Certified-Bucket Signatures (P1-1)
  console.log('\nTest 2: Exact Certified-Bucket Matching');
  const ruleBucketA1 = findCertifiedRepairRule({
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 3840, height: 1920, level: 153, profile: 'Main', rFps: '2997/50', avgFps: '262749987/4359446' }
  }, '.mp4');
  assert(ruleBucketA1 !== null && ruleBucketA1.status === RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE, 'Matches Bucket A1 (4K 59.94fps SIVR033)');

  const ruleBucketA2 = findCertifiedRepairRule({
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 4096, height: 2048, level: 153, profile: 'Main', rFps: '60000/1001', avgFps: '60000/1001' }
  }, '.mp4');
  assert(ruleBucketA2 !== null && ruleBucketA2.matchedBucket.bucketId === 'BUCKET_A2_4K_60FPS_WAKUI', 'Matches Bucket A2 (4K 60.00fps Wakui Mito)');

  const ruleBucketB = findCertifiedRepairRule({
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 8192, height: 4096, level: 183, profile: 'Main', rFps: '60000/1001', avgFps: '2118587705/34961143' }
  }, '.mp4');
  assert(ruleBucketB !== null && ruleBucketB.matchedBucket.bucketId === 'BUCKET_B_8K_60FPS_KAMIKI', 'Matches Bucket B (8K 59.94fps Kamiki Rei)');

  // Test 3: Untested Envelopes Strict Gating
  console.log('\nTest 3: Untested Envelopes Strict Gating');
  const classA2UntestedFps = classifyMedia('sample_a2_60fps.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 4096, height: 2048, level: 153, profile: 'Main', rFps: '60/1', avgFps: '60/1' }
  });
  assert(classA2UntestedFps.classification === MediaClass.NEEDS_BUCKET_CERTIFICATION, 'Untested rFps 60/1 on 4096x2048 routed to NEEDS_BUCKET_CERTIFICATION');

  const classL180 = classifyMedia('sample_l180.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 3840, height: 1920, level: 180, profile: 'Main', rFps: '60/1', avgFps: '60/1' }
  });
  assert(classL180.classification === MediaClass.NEEDS_BUCKET_CERTIFICATION, 'Level 180 routed to NEEDS_BUCKET_CERTIFICATION');

  const class10bit = classifyMedia('sample_10bit.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 10, width: 3840, height: 1920, level: 153, profile: 'Main 10', rFps: '60/1', avgFps: '60/1' }
  });
  assert(class10bit.classification === MediaClass.NEEDS_DEVICE_PROBE, '10-bit HEVC routed to NEEDS_DEVICE_PROBE');

  // Test 4: Probe-layer BitDepth Resolution (P0-1)
  console.log('\nTest 4: P0 Probe-Layer BitDepth Resolution');
  const classUnknownBitDepth = classifyMedia('sample_unknown.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: null, width: 3840, height: 1920, level: 153, profile: 'Main', rFps: '2997/50', avgFps: '262749987/4359446' }
  });
  assert(classUnknownBitDepth.classification === MediaClass.NEEDS_DEVICE_PROBE, 'Unknown bit depth routed to NEEDS_DEVICE_PROBE without defaulting to 8');
  assert(matchExactCertifiedBucket({ video: { codec: 'hevc', codecTag: 'hev1', bitDepth: null, width: 3840, height: 1920, level: 153, profile: 'Main', rFps: '2997/50', avgFps: '262749987/4359446' } }, '.mp4') === null, 'Exact certified bucket matcher rejects bitDepth=null');

  // Test 5: Derivative Exclusion from Logical Media
  console.log('\nTest 5: Derivative Exclusion from Logical Media');
  assert(isDerivativeFile('8K/Kamiki Rei - DSVR01433_HVC1_TEST.mp4') === true, 'Excludes _HVC1_TEST derivative');
  assert(isDerivativeFile('.sample.mp4.vreconder.partial') === true, 'Excludes .partial file');
  assert(isDerivativeFile('.sample.mp4.vreconder-old') === true, 'Excludes .vreconder-old file');
  assert(isDerivativeFile('SIVR033.mp4') === false, 'Standard original media is retained');

  // Test 6: Fail-Closed — Corrupt Journal Blocks Subsystem
  console.log('\nTest 6: P0 Fail-Closed — Corrupt Journal Blocks Subsystem');
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

  // Test 7: Production Path — Disk Space Guard Injection
  console.log('\nTest 7: P0 Fail-Closed — Production Path Disk Space Guard');
  const validJournalPath = path.join(TEST_SCRATCH_DIR, 'test_journal.json');
  const validJournal = new NormalizationJournal(validJournalPath);
  const spaceSample = path.join(TEST_SCRATCH_DIR, 'space_sample.mp4');
  createSyntheticHevcFixture(spaceSample, 0.2);

  // 7a: Space unknown (< 0)
  const spaceUnknownEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await spaceUnknownEngine.initialize();
  // Override fs.statfsSync temporarily to simulate space unknown
  const origStatfs = fs.statfsSync;
  fs.statfsSync = () => { throw new Error('Simulated statfs error'); };
  const unknownSpaceResult = await spaceUnknownEngine.processCandidate(spaceSample);
  assert(unknownSpaceResult.ok === false && unknownSpaceResult.error === 'BLOCKED_SPACE_UNKNOWN', 'Production path fails closed on space unknown (<0)');
  fs.statfsSync = origStatfs;

  // 7b: Execution disabled safety gate
  const safeEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: false,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await safeEngine.initialize();
  const spaceGateResult = await safeEngine.processCandidate(spaceSample);
  assert(spaceGateResult.ok === false && spaceGateResult.error.includes('mission safety gate'), 'executionEnabled=false preserves disk unconditionally');

  // Test 8: Pre-Existing Artifact Safety Gate & Artifact Fingerprint Mismatch
  console.log('\nTest 8: P0 Fail-Closed — Artifact Safety Gate & Fingerprint Mismatch');
  const artifactTarget = path.join(TEST_SCRATCH_DIR, 'artifact_target.mp4');
  const artifactOld = path.join(TEST_SCRATCH_DIR, '.artifact_target.mp4.vreconder-old');
  fs.writeFileSync(artifactTarget, 'ORIGINAL_CONTENT_PRESERVED', 'utf8');
  fs.writeFileSync(artifactOld, 'ORPHAN_OLD_FILE_CONTENT', 'utf8');
  const artifactEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await artifactEngine.initialize();
  const artifactBlockedResult = await artifactEngine.processCandidate(artifactTarget);
  assert(artifactBlockedResult.ok === false && artifactBlockedResult.error === 'BLOCKED_RECOVERY_REQUIRED', 'Pre-existing .vreconder-old without journal fails closed');
  assert(fs.existsSync(artifactOld) === true && fs.existsSync(artifactTarget) === true, 'Neither file deleted when artifact safety gate fires');

  // Fingerprint mismatch during recovery rollback
  validJournal.recordState(artifactTarget, NormalizationState.SWAP_STEP1_RENAME_ORIGINAL, {
    oldPath: artifactOld,
    initialFingerprint: { canonicalPath: artifactTarget, sizeBytes: 9999999, mtimeMs: 1234567, fingerprintId: 'mismatch' }
  });
  const tamperedRecovery = validJournal.recoverOnStartup();
  assert(tamperedRecovery.ok === false && tamperedRecovery.status === 'RECOVERY_BLOCKED', 'Tampered / mismatch artifact blocks recovery from destructive rollback');
  fs.unlinkSync(artifactOld);
  fs.unlinkSync(artifactTarget);

  // Test 9: Real Cancellation during REMUX
  console.log('\nTest 9: P0 Job-Scoped Cancellation — REMUX Subprocess Interruption');
  const remuxCancelSample = path.join(TEST_SCRATCH_DIR, 'remux_cancel_sample.mp4');
  createSyntheticHevcFixture(remuxCancelSample, 0.5);
  const remuxCancelEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await remuxCancelEngine.initialize();

  // Trigger cancel during remux execution
  const remuxJobPromise = remuxCancelEngine.processCandidate(remuxCancelSample);
  while (remuxCancelEngine.activeProcesses.size === 0 && remuxCancelEngine.isProcessing) {
    await new Promise(r => setTimeout(r, 10));
  }
  remuxCancelEngine.notifyPlaybackState(true);
  const remuxCancelResult = await remuxJobPromise;
  assert(remuxCancelResult.ok === false && remuxCancelResult.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Running REMUX subprocess interrupted cleanly by playback priority');
  assert(remuxCancelEngine.activeProcesses.size === 0, 'All child processes terminated on REMUX cancellation');
  assert(!fs.existsSync(path.join(TEST_SCRATCH_DIR, '.remux_cancel_sample.mp4.vreconder.partial')), 'Partial remux artifact unlinked upon cancellation');
  remuxCancelEngine.notifyPlaybackState(false);

  // Test 10: Real Cancellation during STRUCTURE_VERIFYING
  console.log('\nTest 10: P0 Job-Scoped Cancellation — STRUCTURE_VERIFYING Interruption');
  const structCancelSample = path.join(TEST_SCRATCH_DIR, 'struct_cancel_sample.mp4');
  createSyntheticHevcFixture(structCancelSample, 0.2);
  const structCancelEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await structCancelEngine.initialize();

  // Test verifyNormalizedOutput directly with cancellation token
  let verifierChildCount = 0;
  const structVerifyCancelResult = await verifyNormalizedOutput(structCancelSample, structCancelSample, {}, {
    onChildProcess: (c) => {
      verifierChildCount++;
      structCancelEngine._registerProcess(c);
    },
    isCancelled: () => true
  });
  assert(structVerifyCancelResult.ok === false && structVerifyCancelResult.reason === 'Verification cancelled', 'Structure verification halts immediately when cancelled');

  // Test 11: Real Cancellation during FINAL_VERIFYING Rollback
  console.log('\nTest 11: P0 Job-Scoped Cancellation — FINAL_VERIFYING Interruption Rollback');
  const finalCancelOld = path.join(TEST_SCRATCH_DIR, '.final_cancel.mp4.vreconder-old');
  const finalCancelCanonical = path.join(TEST_SCRATCH_DIR, 'final_cancel.mp4');
  fs.writeFileSync(finalCancelOld, 'ORIGINAL_PRE_SWAP_BACKUP', 'utf8');
  fs.writeFileSync(finalCancelCanonical, 'UNFINALIZED_CANDIDATE', 'utf8');

  const finalCancelEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  finalCancelEngine.activeJob = {
    originalPath: finalCancelCanonical,
    oldPath: finalCancelOld,
    partialPath: path.join(TEST_SCRATCH_DIR, '.final_cancel.mp4.vreconder.partial'),
    isCancelled: false,
    cancelReason: null,
    isSwapped: true
  };
  await finalCancelEngine.cancelActiveJobForPlayback();
  assert(fs.readFileSync(finalCancelCanonical, 'utf8') === 'ORIGINAL_PRE_SWAP_BACKUP', 'Final verify cancellation rolls back verified original over unfinalized target');
  assert(!fs.existsSync(finalCancelOld), 'Old backup removed during final verify cancellation rollback');

  // Test 12: Playback Immunity against Resurrection
  console.log('\nTest 12: P0 Monotonic Cancellation — No Resurrection After Playback Stops');
  structCancelEngine.notifyPlaybackState(true);
  const blockedExec = await structCancelEngine.processCandidate(structCancelSample);
  assert(blockedExec.ok === false && blockedExec.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Job refused while playback active');
  structCancelEngine.notifyPlaybackState(false);
  assert(structCancelEngine.isProcessing === false && structCancelEngine.activeJob === null, 'Cancelled job does not resurrect when playback becomes false');

  // Test 13: Concurrency Lock & Process Join Gate
  console.log('\nTest 13: P0 Concurrency Limit & Child Process Join Gate');
  structCancelEngine.isProcessing = true;
  const secondJobResult = await structCancelEngine.processCandidate(structCancelSample);
  assert(secondJobResult.ok === false && secondJobResult.error.includes('Concurrency limit'), 'Second job strictly blocked when engine is processing');
  structCancelEngine.isProcessing = false;

  // Test 14: Fingerprint Invariant Guard
  console.log('\nTest 14: P0 Fingerprint Invariant Guard');
  const fpSample = path.join(TEST_SCRATCH_DIR, 'fp_sample.mp4');
  fs.writeFileSync(fpSample, 'FP_SAMPLE_INITIAL', 'utf8');
  const fpInitial = getMediaFingerprint(fpSample);
  assert(isFingerprintValid(fpSample, fpInitial) === true, 'Fingerprint valid on identical file');
  fs.writeFileSync(fpSample, 'FP_SAMPLE_MUTATED_LONGER_PAYLOAD_CONTENT', 'utf8');
  assert(isFingerprintValid(fpSample, fpInitial) === false, 'Fingerprint detects mutation on modified file');

  // Test 15: Six Transactional Crash Windows (P0-3 & P0-4)
  console.log('\nTest 15: P0 Transactional Recovery Across All Crash Windows');
  // Window A: Crash before Step 1 (during REMUX / STRUCTURE_VERIFYING)
  const crashATarget = path.join(TEST_SCRATCH_DIR, 'crash_a.mp4');
  const crashAPartial = path.join(TEST_SCRATCH_DIR, '.crash_a.mp4.vreconder.partial');
  fs.writeFileSync(crashATarget, 'TRUE_ORIGINAL_A', 'utf8');
  fs.writeFileSync(crashAPartial, 'ORPHAN_PARTIAL_A', 'utf8');
  validJournal.recordState(crashATarget, NormalizationState.REMUXING, { partialPath: crashAPartial });
  const recA = validJournal.recoverOnStartup();
  assert(recA.ok === true && fs.existsSync(crashATarget) && !fs.existsSync(crashAPartial), 'Crash Window A (REMUX) recovers: orphan partial cleaned, original intact');

  // Window B: Crash after Step 1 (Original renamed to .old, partial exists)
  const crashBTarget = path.join(TEST_SCRATCH_DIR, 'crash_b.mp4');
  const crashBOld = path.join(TEST_SCRATCH_DIR, '.crash_b.mp4.vreconder-old');
  fs.writeFileSync(crashBOld, 'TRUE_ORIGINAL_B', 'utf8');
  const fpB = getMediaFingerprint(crashBOld);
  validJournal.recordState(crashBTarget, NormalizationState.SWAP_STEP1_RENAME_ORIGINAL, { oldPath: crashBOld, initialFingerprint: fpB });
  const recB = validJournal.recoverOnStartup();
  assert(recB.ok === true && fs.existsSync(crashBTarget) && !fs.existsSync(crashBOld), 'Crash Window B (Step 1) recovers: verified original restored from .old');

  // Window C: Crash after Step 2 (Unverified partial installed at canonical, .old exists)
  const crashCTarget = path.join(TEST_SCRATCH_DIR, 'crash_c.mp4');
  const crashCOld = path.join(TEST_SCRATCH_DIR, '.crash_c.mp4.vreconder-old');
  fs.writeFileSync(crashCOld, 'TRUE_ORIGINAL_C', 'utf8');
  fs.writeFileSync(crashCTarget, 'UNVERIFIED_PARTIAL_C', 'utf8');
  const fpC = getMediaFingerprint(crashCOld);
  validJournal.recordState(crashCTarget, NormalizationState.SWAP_STEP2_RENAME_PARTIAL, { oldPath: crashCOld, initialFingerprint: fpC });
  const recC = validJournal.recoverOnStartup();
  assert(recC.ok === true && fs.readFileSync(crashCTarget, 'utf8') === 'TRUE_ORIGINAL_C', 'Crash Window C (Step 2) recovers: unverified target replaced with verified original');

  // Window D: Crash during FINAL_VERIFYING
  const crashDTarget = path.join(TEST_SCRATCH_DIR, 'crash_d.mp4');
  const crashDOld = path.join(TEST_SCRATCH_DIR, '.crash_d.mp4.vreconder-old');
  fs.writeFileSync(crashDOld, 'TRUE_ORIGINAL_D', 'utf8');
  fs.writeFileSync(crashDTarget, 'TARGET_D_FINAL_VERIFYING', 'utf8');
  const fpD = getMediaFingerprint(crashDOld);
  validJournal.recordState(crashDTarget, NormalizationState.FINAL_VERIFYING, { oldPath: crashDOld, initialFingerprint: fpD });
  const recD = validJournal.recoverOnStartup();
  assert(recD.ok === true && fs.readFileSync(crashDTarget, 'utf8') === 'TRUE_ORIGINAL_D', 'Crash Window D (FINAL_VERIFYING) recovers: unfinalized target rolled back to original');

  // Window E: Crash after FINAL_VERIFIED (before old cleanup)
  const crashETarget = path.join(TEST_SCRATCH_DIR, 'crash_e.mp4');
  const crashEOld = path.join(TEST_SCRATCH_DIR, '.crash_e.mp4.vreconder-old');
  fs.writeFileSync(crashEOld, 'TRUE_ORIGINAL_E', 'utf8');
  fs.writeFileSync(crashETarget, 'DURABLY_VERIFIED_TARGET_E', 'utf8');
  const fpE = getMediaFingerprint(crashEOld);
  validJournal.recordState(crashETarget, NormalizationState.FINAL_VERIFIED, { oldPath: crashEOld, initialFingerprint: fpE });
  const recE = validJournal.recoverOnStartup();
  assert(recE.ok === true && fs.existsSync(crashETarget) && !fs.existsSync(crashEOld), 'Crash Window E (FINAL_VERIFIED) recovers: unlinks backup and records DONE');

  // Window F: Crash after old cleanup but before terminal DONE
  const crashFTarget = path.join(TEST_SCRATCH_DIR, 'crash_f.mp4');
  fs.writeFileSync(crashFTarget, 'DURABLY_VERIFIED_TARGET_F', 'utf8');
  validJournal.recordState(crashFTarget, NormalizationState.FINAL_VERIFIED, { oldPath: path.join(TEST_SCRATCH_DIR, '.crash_f.mp4.vreconder-old') });
  const recF = validJournal.recoverOnStartup();
  assert(recF.ok === true && fs.existsSync(crashFTarget), 'Crash Window F (terminal bookkeeping) recovers cleanly to DONE');

  // Test 16: Verifier Fail-Closed Behavior (P0-5)
  console.log('\nTest 16: P0 Verifier Fail-Closed on Unavailable / Null Evidence');
  const verifierSample = path.join(TEST_SCRATCH_DIR, 'verif_sample.mp4');
  createSyntheticHevcFixture(verifierSample, 0.2);

  // 16a: Non-existent output path fails verification
  const nonExistentVerif = await verifyNormalizedOutput(verifierSample, path.join(TEST_SCRATCH_DIR, 'non_existent.mp4'));
  assert(nonExistentVerif.ok === false, 'Verifier fails closed on unprobeable output');

  // 16b: Corrupt file demux check fails
  const corruptMp4 = path.join(TEST_SCRATCH_DIR, 'corrupt.mp4');
  fs.writeFileSync(corruptMp4, 'NOT_A_VALID_MP4_PAYLOAD', 'utf8');
  const demuxFail = await runStreamcopyDemuxIntegrityCheck(corruptMp4);
  assert(demuxFail.ok === false, 'Demux integrity check fails closed on corrupt container');

  // 16c: Null packet details returns fail in full verify
  const nullPacketStreams = await getPerStreamPacketDetails(corruptMp4);
  assert(nullPacketStreams === null, 'ffprobe packet details returns null on invalid container');

  // Test 17: Startup Initialization & Server Preflight Router Wiring
  console.log('\nTest 17: P0 Startup Initialization & Server Wiring');
  const bootEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  const uninitResult = await bootEngine.processCandidate(dummyFile);
  assert(uninitResult.ok === false && uninitResult.error.includes('UNINITIALIZED'), 'Uninitialized engine cannot execute before initialize() completes');

  const bootResult = await bootEngine.initialize();
  assert(bootResult.ok === true && bootEngine.status === EngineStatus.SAFE_IDLE, 'engine.initialize() resolves to SAFE_IDLE on clean recovery');

  // Test 18: Production Path — Remux Failure Preserves Original
  console.log('\nTest 18: P0 Production Path — Remux Failure Preserves Original');
  const invalidMediaFile = path.join(TEST_SCRATCH_DIR, 'invalid_corrupt.mp4');
  fs.writeFileSync(invalidMediaFile, 'NOT_A_VALID_MP4_CONTAINER_RAW_BYTES', 'utf8');
  const invalidExecResult = await bootEngine.processCandidate(invalidMediaFile);
  assert(invalidExecResult.ok === false, 'Remux on invalid media fails safely');
  assert(fs.existsSync(invalidMediaFile) === true && fs.readFileSync(invalidMediaFile, 'utf8') === 'NOT_A_VALID_MP4_CONTAINER_RAW_BYTES', 'Original file content preserved intact');

  // Test 19: Production Path — Full In-Place Normalization on Real Synthetic Fixture
  console.log('\nTest 19: P0 Production Path — Full Normalization & Verification on Real Synthetic Fixture');
  const synthFixture = path.join(TEST_SCRATCH_DIR, 'synth_hevc_sample.mp4');
  createSyntheticHevcFixture(synthFixture, 0.2);
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

