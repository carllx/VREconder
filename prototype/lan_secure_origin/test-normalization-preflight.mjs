import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { getMediaFingerprint, isFingerprintValid } from './src/normalization/fingerprint.mjs';
import { classifyMedia, isDerivativeFile, MediaClass } from './src/normalization/classification.mjs';
import { runDryRunInventory } from './src/normalization/inventory-scanner.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { findCertifiedRepairRule, RuleStatus } from './src/normalization/repair-rules.mjs';
import { verifyNormalizedOutput, runStreamcopyDemuxIntegrityCheck, getStreamPayloadMD5 } from './src/normalization/verifier.mjs';
import { probeMediaFacts, clearFactsCache } from './src/normalization/ffprobe-facts.mjs';
import { engineInitPromise, getEngineInstance } from './src/server/preflight-router.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_SCRATCH_DIR = path.join(__dirname, 'test_scratch_normalization');

console.log('============================================================');
console.log('🧪 RUNNING HARDENED PRODUCTION-PATH SAFETY SUITE (20 SUITES)');
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

function createMultiVideoFixture(targetPath, duration = 0.2) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=128x128:d=${duration}:r=30/1`,
    '-f', 'lavfi', '-i', `color=c=white:s=128x128:d=${duration}:r=30/1`,
    '-map', '0:v', '-map', '1:v',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hev1', '-t', `${duration}`,
    targetPath
  ], { encoding: 'utf8' });

  if (res.status !== 0 || !fs.existsSync(targetPath)) {
    throw new Error(`Failed to create multi-video fixture: ${res.stderr}`);
  }
  return targetPath;
}

if (fs.existsSync(TEST_SCRATCH_DIR)) {
  fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_SCRATCH_DIR, { recursive: true });

async function runAllTests() {
  const validJournalPath = path.join(TEST_SCRATCH_DIR, 'test_journal.json');
  const validJournal = new NormalizationJournal(validJournalPath);
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
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 3840, height: 1920, level: 153, profile: 'Main', rFps: '2997/50', avgFps: '262749987/4359446' }
  }, '.mp4');
  assert(ruleBucketA1 !== null && ruleBucketA1.status === RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE, 'Matches Bucket A1 (4K 59.94fps SIVR033)');

  const ruleBucketA2 = findCertifiedRepairRule({
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 4096, height: 2048, level: 153, profile: 'Main', rFps: '60000/1001', avgFps: '60000/1001' }
  }, '.mp4');
  assert(ruleBucketA2 !== null && ruleBucketA2.matchedBucket.bucketId === 'BUCKET_A2_4K_60FPS_WAKUI', 'Matches Bucket A2 (4K 60.00fps Wakui Mito)');

  // Test 3: Untested Envelopes Strict Gating
  console.log('\nTest 3: Untested Envelopes Strict Gating');
  const classA2UntestedFps = classifyMedia('sample_a2_60fps.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 4096, height: 2048, level: 153, profile: 'Main', rFps: '60/1', avgFps: '60/1' }
  });
  assert(classA2UntestedFps.classification === MediaClass.NEEDS_BUCKET_CERTIFICATION, 'Untested rFps 60/1 routed to NEEDS_BUCKET_CERTIFICATION');

  const class10bit = classifyMedia('sample_10bit.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 10, width: 3840, height: 1920, level: 153, profile: 'Main 10', rFps: '60/1', avgFps: '60/1' }
  });
  assert(class10bit.classification === MediaClass.NEEDS_DEVICE_PROBE, '10-bit HEVC routed to NEEDS_DEVICE_PROBE');

  // Test 4: Probe-layer BitDepth Resolution
  console.log('\nTest 4: P0 Probe-Layer BitDepth Resolution');
  const classUnknownBitDepth = classifyMedia('sample_unknown.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: null, width: 3840, height: 1920, level: 153, profile: 'Main', rFps: '2997/50', avgFps: '262749987/4359446' }
  });
  assert(classUnknownBitDepth.classification === MediaClass.NEEDS_DEVICE_PROBE, 'Unknown bit depth routed to NEEDS_DEVICE_PROBE without defaulting to 8');

  // Test 5: Derivative Exclusion
  console.log('\nTest 5: Derivative Exclusion from Logical Media');
  assert(isDerivativeFile('8K/Kamiki Rei - DSVR01433_HVC1_TEST.mp4') === true, 'Excludes _HVC1_TEST derivative');
  assert(isDerivativeFile('.sample.mp4.vreconder.partial') === true, 'Excludes .partial file');
  assert(isDerivativeFile('.sample.mp4.vreconder-old') === true, 'Excludes .vreconder-old file');

  // Test 6: Corrupt Journal Fail-Closed
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

  // Test 7: Production Path — Space Guards
  console.log('\nTest 7: P0 Fail-Closed — Production Path Disk Space Guard');
  const spaceSample = path.join(TEST_SCRATCH_DIR, 'space_sample.mp4');
  createSyntheticHevcFixture(spaceSample, 0.2);
  const spaceUnknownEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await spaceUnknownEngine.initialize();
  const origStatfs = fs.statfsSync;
  fs.statfsSync = () => { throw new Error('Simulated statfs error'); };
  const unknownSpaceResult = await spaceUnknownEngine.processCandidate(spaceSample);
  assert(unknownSpaceResult.ok === false && unknownSpaceResult.error === 'BLOCKED_SPACE_UNKNOWN', 'Production path fails closed on space unknown (<0)');
  fs.statfsSync = origStatfs;

  // Test 8: Pre-Existing Artifact Safety Gate & Tamper Detection
  console.log('\nTest 8: P0 Fail-Closed — Pre-Existing Artifact Safety Gate');
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
  assert(artifactBlockedResult.ok === false && artifactBlockedResult.error === 'BLOCKED_RECOVERY_REQUIRED', 'Pre-existing .vreconder-old without valid journal fails closed');
  assert(fs.existsSync(artifactOld) === true && fs.existsSync(artifactTarget) === true, 'Neither file deleted when artifact safety gate fires');
  fs.unlinkSync(artifactOld);
  fs.unlinkSync(artifactTarget);

  // Test 9: Production Path Cancellation during Running REMUX
  console.log('\nTest 9: P0 Job-Scoped Cancellation — Running REMUX Subprocess Interruption');
  const remuxCancelSample = path.join(TEST_SCRATCH_DIR, 'remux_cancel_sample.mp4');
  createSyntheticHevcFixture(remuxCancelSample, 0.5);
  const remuxCancelEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await remuxCancelEngine.initialize();

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

  // Test 10: Production Path Cancellation during Running STRUCTURE_VERIFYING
  console.log('\nTest 10: P0 Job-Scoped Cancellation — Running STRUCTURE_VERIFYING Interruption');
  const structCancelSample = path.join(TEST_SCRATCH_DIR, 'struct_cancel_sample.mp4');
  createSyntheticHevcFixture(structCancelSample, 0.5);
  const structCancelEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await structCancelEngine.initialize();

  // Trigger playback when journal enters STRUCTURE_VERIFYING
  let structCancelFired = false;
  const structJobPromise = structCancelEngine.processCandidate(structCancelSample);
  while (structCancelEngine.isProcessing && !structCancelFired) {
    const entry = validJournal.getEntry(structCancelSample);
    if (entry && entry.currentState === NormalizationState.STRUCTURE_VERIFYING) {
      structCancelEngine.notifyPlaybackState(true);
      structCancelFired = true;
      break;
    }
    await new Promise(r => setTimeout(r, 5));
  }
  const structCancelResult = await structJobPromise;
  assert(structCancelResult.ok === false && structCancelResult.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Running STRUCTURE_VERIFYING interrupted cleanly on playback priority');
  assert(structCancelEngine.activeProcesses.size === 0, 'All verifier child processes terminated and joined');
  assert(!fs.existsSync(path.join(TEST_SCRATCH_DIR, '.struct_cancel_sample.mp4.vreconder.partial')), 'Partial artifact cleaned on structure verify cancellation');
  structCancelEngine.notifyPlaybackState(false);

  // Test 11: Production Path Cancellation during Running FINAL_VERIFYING
  console.log('\nTest 11: P0 Job-Scoped Cancellation — Running FINAL_VERIFYING Interruption Rollback');
  const finalCancelSample = path.join(TEST_SCRATCH_DIR, 'final_cancel_sample.mp4');
  createSyntheticHevcFixture(finalCancelSample, 0.5);
  const originalFpBeforeFinal = getMediaFingerprint(finalCancelSample);
  const finalCancelEngine = new NormalizationEngine({
    journal: validJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await finalCancelEngine.initialize();

  let finalCancelFired = false;
  const finalJobPromise = finalCancelEngine.processCandidate(finalCancelSample);
  while (finalCancelEngine.isProcessing && !finalCancelFired) {
    const entry = validJournal.getEntry(finalCancelSample);
    if (entry && (entry.currentState === NormalizationState.FINAL_VERIFYING || entry.currentState === NormalizationState.SWAP_STEP2_RENAME_PARTIAL)) {
      finalCancelEngine.notifyPlaybackState(true);
      finalCancelFired = true;
      break;
    }
    await new Promise(r => setTimeout(r, 5));
  }
  const finalCancelResult = await finalJobPromise;
  assert(finalCancelResult.ok === false && finalCancelResult.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Running FINAL_VERIFYING interrupted cleanly');
  assert(isFingerprintValid(finalCancelSample, originalFpBeforeFinal), 'Original media rolled back and bit-proven intact after FINAL_VERIFYING interruption');
  assert(!fs.existsSync(path.join(TEST_SCRATCH_DIR, '.final_cancel_sample.mp4.vreconder-old')), 'Old backup removed during rollback');
  finalCancelEngine.notifyPlaybackState(false);

  // Test 12: Probe Subprocess Job Registration & Cancellation
  console.log('\nTest 12: P0 Verifier Probe Subprocess Job Ownership & Cancellation');
  clearFactsCache();
  const probeCancelSample = path.join(TEST_SCRATCH_DIR, 'probe_cancel_sample.mp4');
  createSyntheticHevcFixture(probeCancelSample, 0.2);
  const probeEngine = new NormalizationEngine({ journal: validJournal, executionEnabled: true });
  let probeChildTracked = false;
  let probeCancelled = false;

  const probePromise = probeMediaFacts(probeCancelSample, {
    onChildProcess: (c) => {
      probeEngine._registerProcess(c);
      probeChildTracked = true;
      probeCancelled = true;
      c.kill('SIGTERM');
    },
    isCancelled: () => probeCancelled
  });
  const probeResult = await probePromise;
  assert(probeChildTracked === true, 'ffprobe child process was registered into engine activeProcesses');
  assert(probeResult === null, 'Cancelled probe returns null and halts cleanly');
  assert(probeEngine.activeProcesses.size === 0, 'Probe child process removed from activeProcesses on exit');

  // Test 13: Stubborn Subprocess Join Timeout & Lock Preservation
  console.log('\nTest 13: P0 Stubborn Subprocess Join Timeout — Fail-Closed Lock Retention');
  const stubbornEngine = new NormalizationEngine({ journal: validJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await stubbornEngine.initialize();

  // Create deterministic stubborn process that does not exit immediately on SIGTERM
  const { EventEmitter } = await import('node:events');
  const stubbornMockChild = new EventEmitter();
  stubbornMockChild.kill = () => { /* ignores SIGTERM */ };
  stubbornEngine._registerProcess(stubbornMockChild);
  stubbornEngine.activeJob = {
    originalPath: dummyFile,
    partialPath: path.join(TEST_SCRATCH_DIR, '.stubborn.partial'),
    oldPath: path.join(TEST_SCRATCH_DIR, '.stubborn-old'),
    isCancelled: false,
    isSwapped: false
  };
  stubbornEngine.isProcessing = true;

  await stubbornEngine.cancelActiveJobForPlayback(100); // 100ms timeout
  assert(stubbornEngine.status === EngineStatus.SUBPROCESS_JOIN_TIMEOUT, 'Timeout transitions engine to SUBPROCESS_JOIN_TIMEOUT');
  assert(stubbornEngine.isProcessing === true, 'isProcessing lock is strictly preserved when subprocess fails to join');

  const blockedCandidateResult = await stubbornEngine.processCandidate(dummyFile);
  assert(blockedCandidateResult.ok === false && blockedCandidateResult.error.includes('SUBPROCESS_JOIN_TIMEOUT'), 'Second job is strictly rejected while stubborn child is alive');

  // Emit exit to clean up mock child
  stubbornMockChild.emit('exit', 0);
  assert(stubbornEngine.activeProcesses.size === 0, 'Active processes cleared after stubborn child finally exits');

  // Test 14: FINAL_VERIFIED Recovery Safety (Canonical Missing / Mismatch / Valid)
  console.log('\nTest 14: P0 FINAL_VERIFIED Startup Recovery — Canonical Identity Validation');
  // 14a: Canonical missing -> RECOVERY_BLOCKED, backup preserved
  const crashMissingTarget = path.join(TEST_SCRATCH_DIR, 'crash_missing.mp4');
  const crashMissingOld = path.join(TEST_SCRATCH_DIR, '.crash_missing.mp4.vreconder-old');
  fs.writeFileSync(crashMissingOld, 'ORIGINAL_BACKUP_MUST_BE_SAVED', 'utf8');
  validJournal.recordState(crashMissingTarget, NormalizationState.FINAL_VERIFIED, {
    oldPath: crashMissingOld,
    replacementFingerprint: { sizeBytes: 1234, mtimeMs: 5678, canonicalPath: crashMissingTarget }
  });
  const recMissing = validJournal.recoverOnStartup();
  assert(recMissing.ok === false && recMissing.status === 'RECOVERY_BLOCKED', 'Missing canonical fails closed on FINAL_VERIFIED recovery');
  assert(fs.existsSync(crashMissingOld) === true, 'Original backup .old is NEVER deleted when canonical is missing');

  // 14b: Canonical fingerprint mismatch -> RECOVERY_BLOCKED, backup preserved
  const crashMismatchTarget = path.join(TEST_SCRATCH_DIR, 'crash_mismatch.mp4');
  const crashMismatchOld = path.join(TEST_SCRATCH_DIR, '.crash_mismatch.mp4.vreconder-old');
  fs.writeFileSync(crashMismatchOld, 'ORIGINAL_BACKUP_MUST_BE_SAVED', 'utf8');
  fs.writeFileSync(crashMismatchTarget, 'TAMPERED_CANONICAL_CONTENT', 'utf8');
  validJournal.recordState(crashMismatchTarget, NormalizationState.FINAL_VERIFIED, {
    oldPath: crashMismatchOld,
    replacementFingerprint: { sizeBytes: 999999, mtimeMs: 111111, canonicalPath: crashMismatchTarget }
  });
  const recMismatch = validJournal.recoverOnStartup();
  assert(recMismatch.ok === false && recMismatch.status === 'RECOVERY_BLOCKED', 'Tampered canonical fails closed on FINAL_VERIFIED recovery');
  assert(fs.existsSync(crashMismatchOld) === true, 'Original backup .old is preserved on fingerprint mismatch');
  fs.unlinkSync(crashMissingOld);
  fs.unlinkSync(crashMismatchOld);
  fs.unlinkSync(crashMismatchTarget);

  // 14c: Canonical valid -> unlinks old, records DONE
  const crashValidTarget = path.join(TEST_SCRATCH_DIR, 'crash_valid.mp4');
  const crashValidOld = path.join(TEST_SCRATCH_DIR, '.crash_valid.mp4.vreconder-old');
  fs.writeFileSync(crashValidOld, 'ORIGINAL_BACKUP_VALID', 'utf8');
  fs.writeFileSync(crashValidTarget, 'VERIFIED_REPLACEMENT_CANONICAL', 'utf8');
  const validRepFp = getMediaFingerprint(crashValidTarget);
  validJournal.recordState(crashValidTarget, NormalizationState.FINAL_VERIFIED, {
    oldPath: crashValidOld,
    replacementFingerprint: validRepFp
  });
  const recValid = validJournal.recoverOnStartup();
  assert(recValid.ok === true && fs.existsSync(crashValidTarget) && !fs.existsSync(crashValidOld), 'Valid canonical cleans .old and records DONE');

  // Test 15: SWAP_STEP1 and SWAP_STEP2 with Old Missing
  console.log('\nTest 15: P0 SWAP Recovery when .old Backup is Missing');
  // 15a: SWAP_STEP1 + old missing + canonical matches original -> safe
  const step1Target = path.join(TEST_SCRATCH_DIR, 'step1_safe.mp4');
  fs.writeFileSync(step1Target, 'TRUE_ORIGINAL_STEP1', 'utf8');
  const step1Fp = getMediaFingerprint(step1Target);
  validJournal.recordState(step1Target, NormalizationState.SWAP_STEP1_RENAME_ORIGINAL, {
    initialFingerprint: step1Fp
  });
  const recStep1 = validJournal.recoverOnStartup();
  assert(recStep1.ok === true, 'SWAP_STEP1 with matching canonical and missing .old recovers as canonical intact');

  // 15b: SWAP_STEP1 + old missing + canonical tampered -> RECOVERY_BLOCKED
  const step1TamperedTarget = path.join(TEST_SCRATCH_DIR, 'step1_tampered.mp4');
  fs.writeFileSync(step1TamperedTarget, 'TAMPERED_STEP1_CONTENT', 'utf8');
  validJournal.recordState(step1TamperedTarget, NormalizationState.SWAP_STEP1_RENAME_ORIGINAL, {
    initialFingerprint: { sizeBytes: 9999, mtimeMs: 1111, canonicalPath: step1TamperedTarget }
  });
  const recStep1Tampered = validJournal.recoverOnStartup();
  assert(recStep1Tampered.ok === false && recStep1Tampered.status === 'RECOVERY_BLOCKED', 'SWAP_STEP1 with mismatched canonical fails closed');

  // 15c: SWAP_STEP2 / FINAL_VERIFYING + old missing -> RECOVERY_BLOCKED (Fail closed)
  const step2Target = path.join(TEST_SCRATCH_DIR, 'step2_fail.mp4');
  fs.writeFileSync(step2Target, 'UNVERIFIED_STEP2_CANONICAL', 'utf8');
  validJournal.recordState(step2Target, NormalizationState.SWAP_STEP2_RENAME_PARTIAL, {
    initialFingerprint: { sizeBytes: 1234, mtimeMs: 5678, canonicalPath: step2Target }
  });
  const recStep2 = validJournal.recoverOnStartup();
  assert(recStep2.ok === false && recStep2.status === 'RECOVERY_BLOCKED', 'SWAP_STEP2 with missing .old fails closed');

  // Test 16: Multi-Video Retained Streams Handling
  console.log('\nTest 16: P0 Multi-Video Retained Streams Handling');
  clearFactsCache();
  const multiVideoTarget = path.join(TEST_SCRATCH_DIR, 'multi_video.mp4');
  createMultiVideoFixture(multiVideoTarget, 0.2);
  const multiFacts = await probeMediaFacts(multiVideoTarget);
  assert(multiFacts !== null && multiFacts.videoCount === 2, 'ffprobe fact extractor recognizes 2 video streams');
  const multiClass = classifyMedia(multiVideoTarget, multiFacts);
  assert(multiClass.classification === MediaClass.UNSUPPORTED_UNKNOWN_FIX, 'Multi-video stream file explicitly rejected from certified normalization candidate');

  const multiVerifyResult = await verifyNormalizedOutput(multiVideoTarget, multiVideoTarget, { expectedOutputTag: 'hev1' });
  assert(multiVerifyResult.ok === true && multiVerifyResult.details.videoStreamsVerified === 2, 'Verifier validates elementary payload MD5 across all video streams');

  // Test 17: No Resurrection after Playback Stops
  console.log('\nTest 17: P0 No Resurrection after Playback Ends');
  const resurrectSample = path.join(TEST_SCRATCH_DIR, 'resurrect.mp4');
  createSyntheticHevcFixture(resurrectSample, 0.2);
  const resEngine = new NormalizationEngine({ journal: validJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await resEngine.initialize();
  resEngine.notifyPlaybackState(true);
  const pausedExec = await resEngine.processCandidate(resurrectSample);
  assert(pausedExec.ok === false && pausedExec.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Candidate blocked while playback active');
  resEngine.notifyPlaybackState(false);
  assert(resEngine.isProcessing === false && resEngine.activeJob === null, 'Cancelled job does not resurrect when playback ends');

  // Test 18: Active Child Rejects Second Job
  console.log('\nTest 18: P0 Active Child Blocks Second Job');
  const busyEngine = new NormalizationEngine({ journal: validJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await busyEngine.initialize();
  const busyChild = spawn('node', ['-e', 'setTimeout(() => {}, 1000)']);
  busyEngine._registerProcess(busyChild);
  const busyResult = await busyEngine.processCandidate(dummyFile);
  assert(busyResult.ok === false && busyResult.error.includes('Concurrency limit'), 'Second job rejected while child process is in activeProcesses');
  busyChild.kill();

  // Test 19: Full In-Place Normalization End-to-End
  console.log('\nTest 19: P0 Production Path — Full In-Place Normalization on Real Synthetic Fixture');
  clearFactsCache();
  const prodFixture = path.join(TEST_SCRATCH_DIR, 'prod_fixture.mp4');
  createSyntheticHevcFixture(prodFixture, 0.2);
  const origVideoMd5 = await getStreamPayloadMD5(prodFixture, '0:v:0');
  const origAudioMd5 = await getStreamPayloadMD5(prodFixture, '0:a:0');

  const prodEngine = new NormalizationEngine({ journal: validJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await prodEngine.initialize();
  const prodResult = await prodEngine.processCandidate(prodFixture);
  assert(prodResult.ok === true && prodResult.state === NormalizationState.DONE, 'Full in-place normalization succeeds on valid fixture');

  const normVideoMd5 = await getStreamPayloadMD5(prodFixture, '0:v:0');
  const normAudioMd5 = await getStreamPayloadMD5(prodFixture, '0:a:0');
  assert(origVideoMd5 === normVideoMd5, 'Video payload MD5 is 100% bit-identical after streamcopy');
  assert(origAudioMd5 === normAudioMd5, 'Audio payload MD5 is 100% bit-identical after streamcopy');
  const finalDemux = await runStreamcopyDemuxIntegrityCheck(prodFixture);
  assert(finalDemux.ok === true, 'Final container streamcopy demux check passes with zero errors');

  // Test 20: Server Router Startup Initialization Wiring
  console.log('\nTest 20: P0 Server Router Startup Wiring & Recovery Initialization');
  const routerInit = await engineInitPromise;
  assert(routerInit.ok === true && getEngineInstance().status === EngineStatus.SAFE_IDLE, 'Server router initializes engine and runs startup recovery');

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

