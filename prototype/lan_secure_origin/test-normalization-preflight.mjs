import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getMediaFingerprint, isFingerprintValid } from './src/normalization/fingerprint.mjs';
import { classifyMedia, isDerivativeFile, MediaClass } from './src/normalization/classification.mjs';
import { runDryRunInventory } from './src/normalization/inventory-scanner.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { findCertifiedRepairRule, RuleStatus } from './src/normalization/repair-rules.mjs';
import { verifyNormalizedOutput, runStreamcopyDemuxIntegrityCheck, getStreamPayloadMD5 } from './src/normalization/verifier.mjs';
import { probeMediaFacts, clearFactsCache } from './src/normalization/ffprobe-facts.mjs';
import { engineInitPromise, getEngineInstance } from './src/server/preflight-router.mjs';
import { createSyntheticHevcFixture, createMultiVideoFixture } from './test-fixtures-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_SCRATCH_DIR = path.join(__dirname, 'test_scratch_normalization');

console.log('============================================================');
console.log('🧪 RUNNING HARDENED PRODUCTION-PATH SAFETY SUITE (26 SUITES)');
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

if (fs.existsSync(TEST_SCRATCH_DIR)) {
  fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_SCRATCH_DIR, { recursive: true });

function getJournal(name) {
  return new NormalizationJournal(path.join(TEST_SCRATCH_DIR, `journal_${name}.json`));
}

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
    videoCount: 1, audioCount: 1, otherStreams: [], chapterCount: 0,
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 3840, height: 1920, level: 153, profile: 'Main', rFps: '2997/50', avgFps: '262749987/4359446' }
  }, '.mp4');
  assert(ruleBucketA1 !== null && ruleBucketA1.status === RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE, 'Matches Bucket A1 (4K 59.94fps SIVR033)');

  const ruleBucketA2 = findCertifiedRepairRule({
    videoCount: 1, audioCount: 1, otherStreams: [], chapterCount: 0,
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
  const corruptEngine = new NormalizationEngine({ journal: corruptJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  const initCorruptResult = await corruptEngine.initialize();
  assert(initCorruptResult.ok === false && corruptEngine.status === EngineStatus.JOURNAL_CORRUPT, 'Engine initialize fails closed on corrupt journal');
  const corruptExecResult = await corruptEngine.processCandidate(dummyFile);
  assert(corruptExecResult.ok === false && corruptExecResult.error.includes('JOURNAL_CORRUPT'), 'Corrupt journal permanently blocks execution');

  // Test 7: Production Path — Space Guards
  console.log('\nTest 7: P0 Fail-Closed — Production Path Disk Space Guard');
  const spaceSample = path.join(TEST_SCRATCH_DIR, 'space_sample.mp4');
  createSyntheticHevcFixture(spaceSample, 0.2);
  const spaceJournal = getJournal('t7');
  const spaceUnknownEngine = new NormalizationEngine({ journal: spaceJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
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
  const artifactJournal = getJournal('t8');
  const artifactEngine = new NormalizationEngine({ journal: artifactJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
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
  const remuxJournal = getJournal('t9');
  const remuxCancelEngine = new NormalizationEngine({ journal: remuxJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await remuxCancelEngine.initialize();

  let remuxCancelFired = false;
  const remuxJobPromise = remuxCancelEngine.processCandidate(remuxCancelSample);
  while (remuxCancelEngine.isProcessing && !remuxCancelFired) {
    const entry = remuxJournal.getEntry(remuxCancelSample);
    if (entry && entry.currentState === NormalizationState.REMUXING && remuxCancelEngine.activeProcesses.size > 0) {
      remuxCancelEngine.notifyPlaybackState(true);
      remuxCancelFired = true;
      break;
    }
    await new Promise(r => setTimeout(r, 5));
  }
  const remuxCancelResult = await remuxJobPromise;
  assert(remuxCancelResult.ok === false && remuxCancelResult.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Running REMUX subprocess interrupted cleanly by playback priority');
  assert(remuxCancelEngine.activeProcesses.size === 0, 'All child processes terminated on REMUX cancellation');
  assert(!fs.existsSync(path.join(TEST_SCRATCH_DIR, '.remux_cancel_sample.mp4.vreconder.partial')), 'Partial remux artifact unlinked upon cancellation');
  remuxCancelEngine.notifyPlaybackState(false);

  // Test 10: Production Path Cancellation during Running STRUCTURE_VERIFYING
  console.log('\nTest 10: P0 Job-Scoped Cancellation — Running STRUCTURE_VERIFYING Interruption');
  const structCancelSample = path.join(TEST_SCRATCH_DIR, 'struct_cancel_sample.mp4');
  createSyntheticHevcFixture(structCancelSample, 0.5);
  const structJournal = getJournal('t10');
  const structCancelEngine = new NormalizationEngine({ journal: structJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await structCancelEngine.initialize();

  let structCancelFired = false;
  const structJobPromise = structCancelEngine.processCandidate(structCancelSample);
  while (structCancelEngine.isProcessing && !structCancelFired) {
    const entry = structJournal.getEntry(structCancelSample);
    if (entry && entry.currentState === NormalizationState.STRUCTURE_VERIFYING && structCancelEngine.activeProcesses.size > 0) {
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

  // Test 11: Production Path Cancellation during Running FINAL_VERIFYING (Strict: currentState === FINAL_VERIFYING && active child)
  console.log('\nTest 11: P0 Job-Scoped Cancellation — Running FINAL_VERIFYING Interruption Rollback');
  const finalCancelSample = path.join(TEST_SCRATCH_DIR, 'final_cancel_sample.mp4');
  createSyntheticHevcFixture(finalCancelSample, 0.5);
  const originalFpBeforeFinal = getMediaFingerprint(finalCancelSample);
  const finalJournal = getJournal('t11');
  const finalCancelEngine = new NormalizationEngine({ journal: finalJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await finalCancelEngine.initialize();

  let finalCancelFired = false;
  const finalJobPromise = finalCancelEngine.processCandidate(finalCancelSample);
  while (finalCancelEngine.isProcessing && !finalCancelFired) {
    const entry = finalJournal.getEntry(finalCancelSample);
    if (entry && entry.currentState === NormalizationState.FINAL_VERIFYING && finalCancelEngine.activeProcesses.size > 0) {
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

  // Test 12: Production Path Cancellation during Initial Metadata Probe
  console.log('\nTest 12: P0 Initial Metadata Probe Real Cancellation');
  clearFactsCache();
  const probeCancelSample = path.join(TEST_SCRATCH_DIR, 'probe_cancel_sample.mp4');
  createSyntheticHevcFixture(probeCancelSample, 0.5);
  const probeJournal = getJournal('t12');
  const initialProbeEngine = new NormalizationEngine({ journal: probeJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await initialProbeEngine.initialize();

  let probeCancelFired = false;
  const initialProbeJobPromise = initialProbeEngine.processCandidate(probeCancelSample);
  while (initialProbeEngine.isProcessing && !probeCancelFired) {
    if (initialProbeEngine.activeProcesses.size > 0 && initialProbeEngine.activeJob) {
      initialProbeEngine.notifyPlaybackState(true);
      probeCancelFired = true;
      break;
    }
    await new Promise(r => setTimeout(r, 5));
  }
  const initialProbeResult = await initialProbeJobPromise;
  assert(initialProbeResult.ok === false && initialProbeResult.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Initial metadata probe cancelled and returns PAUSED_FOR_PLAYBACK');
  assert(initialProbeEngine.activeProcesses.size === 0, 'All probe subprocesses terminated and joined');
  initialProbeEngine.notifyPlaybackState(false);

  // Test 13: Stubborn Subprocess Join Timeout & Lock Preservation
  console.log('\nTest 13: P0 Stubborn Subprocess Join Timeout — Fail-Closed Lock Retention');
  const stubbornJournal = getJournal('t13');
  const stubbornEngine = new NormalizationEngine({ journal: stubbornJournal, executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await stubbornEngine.initialize();
  const { EventEmitter } = await import('node:events');
  const stubbornMockChild = new EventEmitter();
  stubbornMockChild.kill = () => {};
  stubbornEngine._registerProcess(stubbornMockChild);
  stubbornEngine.activeJob = {
    originalPath: dummyFile,
    partialPath: path.join(TEST_SCRATCH_DIR, '.stubborn.partial'),
    oldPath: path.join(TEST_SCRATCH_DIR, '.stubborn-old'),
    isCancelled: false,
    isSwapped: false
  };
  stubbornEngine.isProcessing = true;

  await stubbornEngine.cancelActiveJobForPlayback(100);
  assert(stubbornEngine.status === EngineStatus.SUBPROCESS_JOIN_TIMEOUT, 'Timeout transitions engine to SUBPROCESS_JOIN_TIMEOUT');
  assert(stubbornEngine.isProcessing === true, 'isProcessing lock is strictly preserved when subprocess fails to join');

  const blockedCandidateResult = await stubbornEngine.processCandidate(dummyFile);
  assert(blockedCandidateResult.ok === false && blockedCandidateResult.error.includes('SUBPROCESS_JOIN_TIMEOUT'), 'Second job is strictly rejected while stubborn child is alive');
  stubbornMockChild.emit('exit', 0);
  assert(stubbornEngine.activeProcesses.size === 0, 'Active processes cleared after stubborn child finally exits');

  // Test 14: FINAL_VERIFIED Startup Recovery — Canonical Identity Validation
  console.log('\nTest 14: P0 FINAL_VERIFIED Startup Recovery — Canonical Identity Validation');
  const crashMissingJournal = getJournal('t14_missing');
  const crashMissingTarget = path.join(TEST_SCRATCH_DIR, 'crash_missing.mp4');
  const crashMissingOld = path.join(TEST_SCRATCH_DIR, '.crash_missing.mp4.vreconder-old');
  fs.writeFileSync(crashMissingOld, 'ORIGINAL_BACKUP_MUST_BE_SAVED', 'utf8');
  crashMissingJournal.recordState(crashMissingTarget, NormalizationState.FINAL_VERIFIED, {
    replacementFingerprint: { sizeBytes: 1234, mtimeMs: 5678, canonicalPath: crashMissingTarget }
  });
  const recMissing = crashMissingJournal.recoverOnStartup();
  assert(recMissing.ok === false && recMissing.status === 'RECOVERY_BLOCKED', 'Missing canonical fails closed on FINAL_VERIFIED recovery');
  assert(fs.existsSync(crashMissingOld) === true, 'Original backup .old is NEVER deleted when canonical is missing');
  fs.unlinkSync(crashMissingOld);

  const crashMismatchJournal = getJournal('t14_mismatch');
  const crashMismatchTarget = path.join(TEST_SCRATCH_DIR, 'crash_mismatch.mp4');
  const crashMismatchOld = path.join(TEST_SCRATCH_DIR, '.crash_mismatch.mp4.vreconder-old');
  fs.writeFileSync(crashMismatchOld, 'ORIGINAL_BACKUP_MUST_BE_SAVED', 'utf8');
  fs.writeFileSync(crashMismatchTarget, 'TAMPERED_CANONICAL_CONTENT', 'utf8');
  crashMismatchJournal.recordState(crashMismatchTarget, NormalizationState.FINAL_VERIFIED, {
    replacementFingerprint: { sizeBytes: 999999, mtimeMs: 111111, canonicalPath: crashMismatchTarget }
  });
  const recMismatch = crashMismatchJournal.recoverOnStartup();
  assert(recMismatch.ok === false && recMismatch.status === 'RECOVERY_BLOCKED', 'Tampered canonical fails closed on FINAL_VERIFIED recovery');
  assert(fs.existsSync(crashMismatchOld) === true, 'Original backup .old is preserved on fingerprint mismatch');
  fs.unlinkSync(crashMismatchOld);
  fs.unlinkSync(crashMismatchTarget);

  const crashValidJournal = getJournal('t14_valid');
  const crashValidTarget = path.join(TEST_SCRATCH_DIR, 'crash_valid.mp4');
  const crashValidOld = path.join(TEST_SCRATCH_DIR, '.crash_valid.mp4.vreconder-old');
  fs.writeFileSync(crashValidOld, 'ORIGINAL_BACKUP_VALID', 'utf8');
  fs.writeFileSync(crashValidTarget, 'VERIFIED_REPLACEMENT_CANONICAL', 'utf8');
  const validRepFp = getMediaFingerprint(crashValidTarget);
  crashValidJournal.recordState(crashValidTarget, NormalizationState.FINAL_VERIFIED, { replacementFingerprint: validRepFp });
  const recValid = crashValidJournal.recoverOnStartup();
  assert(recValid.ok === true && fs.existsSync(crashValidTarget) && !fs.existsSync(crashValidOld), 'Valid canonical cleans .old and records DONE');

  // Test 15: SWAP Recovery when .old Backup is Missing
  console.log('\nTest 15: P0 SWAP Recovery when .old Backup is Missing');
  const step1Journal = getJournal('t15_step1');
  const step1Target = path.join(TEST_SCRATCH_DIR, 'step1_safe.mp4');
  fs.writeFileSync(step1Target, 'TRUE_ORIGINAL_STEP1', 'utf8');
  const step1Fp = getMediaFingerprint(step1Target);
  step1Journal.recordState(step1Target, NormalizationState.SWAP_STEP1_RENAME_ORIGINAL, { initialFingerprint: step1Fp });
  const recStep1 = step1Journal.recoverOnStartup();
  assert(recStep1.ok === true, 'SWAP_STEP1 with matching canonical and missing .old recovers as canonical intact');

  const step1TamperedJournal = getJournal('t15_step1_tampered');
  const step1TamperedTarget = path.join(TEST_SCRATCH_DIR, 'step1_tampered.mp4');
  fs.writeFileSync(step1TamperedTarget, 'TAMPERED_STEP1_CONTENT', 'utf8');
  step1TamperedJournal.recordState(step1TamperedTarget, NormalizationState.SWAP_STEP1_RENAME_ORIGINAL, {
    initialFingerprint: { sizeBytes: 9999, mtimeMs: 1111, canonicalPath: step1TamperedTarget }
  });
  const recStep1Tampered = step1TamperedJournal.recoverOnStartup();
  assert(recStep1Tampered.ok === false && recStep1Tampered.status === 'RECOVERY_BLOCKED', 'SWAP_STEP1 with mismatched canonical fails closed');

  const step2Journal = getJournal('t15_step2');
  const step2Target = path.join(TEST_SCRATCH_DIR, 'step2_fail.mp4');
  fs.writeFileSync(step2Target, 'UNVERIFIED_STEP2_CANONICAL', 'utf8');
  step2Journal.recordState(step2Target, NormalizationState.SWAP_STEP2_RENAME_PARTIAL, {
    initialFingerprint: { sizeBytes: 1234, mtimeMs: 5678, canonicalPath: step2Target }
  });
  const recStep2 = step2Journal.recoverOnStartup();
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
  const resEngine = new NormalizationEngine({ journal: getJournal('t17'), executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
  await resEngine.initialize();
  resEngine.notifyPlaybackState(true);
  const pausedExec = await resEngine.processCandidate(resurrectSample);
  assert(pausedExec.ok === false && pausedExec.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Candidate blocked while playback active');
  resEngine.notifyPlaybackState(false);
  assert(resEngine.isProcessing === false && resEngine.activeJob === null, 'Cancelled job does not resurrect when playback ends');

  // Test 18: Active Child Rejects Second Job
  console.log('\nTest 18: P0 Active Child Blocks Second Job');
  const busyEngine = new NormalizationEngine({ journal: getJournal('t18'), executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
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

  const prodEngine = new NormalizationEngine({ journal: getJournal('t19'), executionEnabled: true, allowedRoots: [TEST_SCRATCH_DIR] });
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

  // Test 21: Fault Injection A — Rollback Unlink Canonical Failure
  console.log('\nTest 21: Fault Injection A — Rollback Unlink Canonical Failure');
  const unlinkFailSample = path.join(TEST_SCRATCH_DIR, 'unlink_fail_sample.mp4');
  createSyntheticHevcFixture(unlinkFailSample, 0.5);
  const unlinkFailJournal = getJournal('t21');
  const unlinkFailEngine = new NormalizationEngine({
    journal: unlinkFailJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    fileOps: {
      unlinkSync: (p) => {
        if (p === unlinkFailSample) throw new Error('EPERM: simulated canonical unlink failure');
        return fs.unlinkSync(p);
      }
    }
  });
  await unlinkFailEngine.initialize();

  let unlinkCancelFired = false;
  const unlinkJobPromise = unlinkFailEngine.processCandidate(unlinkFailSample);
  while (unlinkFailEngine.isProcessing && !unlinkCancelFired) {
    const entry = unlinkFailJournal.getEntry(unlinkFailSample);
    if (entry && entry.currentState === NormalizationState.FINAL_VERIFYING && unlinkFailEngine.activeProcesses.size > 0) {
      unlinkFailEngine.notifyPlaybackState(true);
      unlinkCancelFired = true;
      break;
    }
    await new Promise(r => setTimeout(r, 5));
  }
  const unlinkJobResult = await unlinkJobPromise;
  assert(unlinkJobResult.ok === false && unlinkJobResult.state === NormalizationState.RECOVERY_REQUIRED, 'Unlink failure during rollback transitions to RECOVERY_REQUIRED');
  assert(unlinkFailEngine.status === EngineStatus.RECOVERY_BLOCKED, 'Engine status is strictly RECOVERY_BLOCKED on rollback unlink failure');
  const oldBackupPath = path.join(TEST_SCRATCH_DIR, '.unlink_fail_sample.mp4.vreconder-old');
  assert(fs.existsSync(oldBackupPath) === true, 'Original backup .old is preserved when unlink fails');
  const secondJobOnBlocked = await unlinkFailEngine.processCandidate(dummyFile);
  assert(secondJobOnBlocked.ok === false && secondJobOnBlocked.error.includes('RECOVERY_BLOCKED'), 'Second job strictly rejected when engine is in RECOVERY_BLOCKED');
  unlinkFailEngine.notifyPlaybackState(false);

  // Test 22: Fault Injection B — Rollback Rename Old -> Canonical Failure
  console.log('\nTest 22: Fault Injection B — Rollback Rename Old->Canonical Failure');
  const renameFailSample = path.join(TEST_SCRATCH_DIR, 'rename_fail_sample.mp4');
  createSyntheticHevcFixture(renameFailSample, 0.5);
  const renameFailOld = path.join(TEST_SCRATCH_DIR, '.rename_fail_sample.mp4.vreconder-old');
  const renameFailJournal = getJournal('t22');
  const renameFailEngine = new NormalizationEngine({
    journal: renameFailJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    fileOps: {
      renameSync: (from, to) => {
        if (from === renameFailOld && to === renameFailSample) throw new Error('EBUSY: simulated rename failure during rollback');
        return fs.renameSync(from, to);
      }
    }
  });
  await renameFailEngine.initialize();

  let renameCancelFired = false;
  const renameJobPromise = renameFailEngine.processCandidate(renameFailSample);
  while (renameFailEngine.isProcessing && !renameCancelFired) {
    const entry = renameFailJournal.getEntry(renameFailSample);
    if (entry && entry.currentState === NormalizationState.FINAL_VERIFYING && renameFailEngine.activeProcesses.size > 0) {
      renameFailEngine.notifyPlaybackState(true);
      renameCancelFired = true;
      break;
    }
    await new Promise(r => setTimeout(r, 5));
  }
  const renameJobResult = await renameJobPromise;
  assert(renameJobResult.ok === false && renameJobResult.state === NormalizationState.RECOVERY_REQUIRED, 'Rename failure during rollback transitions to RECOVERY_REQUIRED');
  assert(renameFailEngine.status === EngineStatus.RECOVERY_BLOCKED, 'Engine status is RECOVERY_BLOCKED on rollback rename failure');
  assert(fs.existsSync(renameFailOld) === true, 'Original backup .old is preserved when rename fails');
  renameFailEngine.notifyPlaybackState(false);

  // Test 23: Fault Injection C — Final Verify Failure + Rollback Failure
  console.log('\nTest 23: Fault Injection C — Final Verify Failure + Rollback Failure');
  const finalVerifyFailSample = path.join(TEST_SCRATCH_DIR, 'final_verify_fail_sample.mp4');
  createSyntheticHevcFixture(finalVerifyFailSample, 0.3);
  const finalVerifyFailOld = path.join(TEST_SCRATCH_DIR, '.final_verify_fail_sample.mp4.vreconder-old');
  const finalVerifyFailJournal = getJournal('t23');
  const finalVerifyFailEngine = new NormalizationEngine({
    journal: finalVerifyFailJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    fileOps: {
      renameSync: (from, to) => {
        if (from === finalVerifyFailOld && to === finalVerifyFailSample) throw new Error('EPERM: simulated rollback rename failure after final verify');
        return fs.renameSync(from, to);
      }
    }
  });
  await finalVerifyFailEngine.initialize();

  let finalSabotaged = false;
  const finalVerifyJobPromise = finalVerifyFailEngine.processCandidate(finalVerifyFailSample);
  while (finalVerifyFailEngine.isProcessing && !finalSabotaged) {
    const entry = finalVerifyFailJournal.getEntry(finalVerifyFailSample);
    if (entry && entry.currentState === NormalizationState.FINAL_VERIFYING) {
      fs.writeFileSync(finalVerifyFailSample, 'CORRUPT_FINAL_REPLACEMENT', 'utf8');
      finalSabotaged = true;
      break;
    }
    await new Promise(r => setTimeout(r, 5));
  }
  const finalVerifyFailResult = await finalVerifyJobPromise;
  assert(finalVerifyFailResult.ok === false && finalVerifyFailResult.state === NormalizationState.RECOVERY_REQUIRED, 'Final verify failure with broken rollback transitions to RECOVERY_REQUIRED');
  assert(finalVerifyFailEngine.status === EngineStatus.RECOVERY_BLOCKED, 'Engine status is strictly RECOVERY_BLOCKED');
  assert(finalVerifyFailJournal.getEntry(finalVerifyFailSample).currentState === NormalizationState.RECOVERY_REQUIRED, 'Journal records persistent RECOVERY_REQUIRED state');

  // Test 24: Fault Injection D — Idempotent Single-Owner Cancellation Race
  console.log('\nTest 24: Fault Injection D — Idempotent Single-Owner Cancellation Race');
  const raceSample = path.join(TEST_SCRATCH_DIR, 'race_sample.mp4');
  createSyntheticHevcFixture(raceSample, 0.5);
  let rollbackCallCount = 0;
  const raceJournal = getJournal('t24');
  const raceEngine = new NormalizationEngine({
    journal: raceJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    fileOps: {
      renameSync: (from, to) => {
        if (from.endsWith('.vreconder-old')) rollbackCallCount++;
        return fs.renameSync(from, to);
      }
    }
  });
  await raceEngine.initialize();

  let raceFired = false;
  const raceJobPromise = raceEngine.processCandidate(raceSample);
  while (raceEngine.isProcessing && !raceFired) {
    const entry = raceJournal.getEntry(raceSample);
    if (entry && entry.currentState === NormalizationState.FINAL_VERIFYING && raceEngine.activeProcesses.size > 0) {
      const cancelPromise = raceEngine.cancelActiveJobForPlayback();
      raceFired = true;
      await Promise.all([raceJobPromise, cancelPromise]);
      break;
    }
    await new Promise(r => setTimeout(r, 5));
  }
  assert(rollbackCallCount === 1, 'Rollback helper was executed exactly once during race condition');
  assert(raceEngine.status === EngineStatus.PAUSED_FOR_PLAYBACK, 'Final engine status is consistently PAUSED_FOR_PLAYBACK');
  raceEngine.notifyPlaybackState(false);

  // Test 25: Fault Injection E — FINAL_VERIFIED Cleanup Failure & Startup Recovery Retry
  console.log('\nTest 25: Fault Injection E — FINAL_VERIFIED Cleanup Failure & Startup Recovery Retry');
  const cleanupPendingSample = path.join(TEST_SCRATCH_DIR, 'cleanup_pending_sample.mp4');
  createSyntheticHevcFixture(cleanupPendingSample, 0.2);
  const cleanupPendingOld = path.join(TEST_SCRATCH_DIR, '.cleanup_pending_sample.mp4.vreconder-old');
  let oldUnlinkInjected = true;
  const cleanupJournal = getJournal('t25');
  const cleanupPendingEngine = new NormalizationEngine({
    journal: cleanupJournal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    fileOps: {
      unlinkSync: (p) => {
        if (p === cleanupPendingOld && oldUnlinkInjected) throw new Error('EBUSY: old backup locked');
        return fs.unlinkSync(p);
      }
    }
  });
  await cleanupPendingEngine.initialize();
  const cleanupJobResult = await cleanupPendingEngine.processCandidate(cleanupPendingSample);
  assert(cleanupJobResult.ok === false && cleanupJobResult.state === NormalizationState.CLEANUP_PENDING, 'Phase 9 unlink failure records CLEANUP_PENDING (not DONE)');
  assert(fs.existsSync(cleanupPendingOld) === true, 'Old backup is preserved on cleanup failure');
  assert(cleanupJournal.getEntry(cleanupPendingSample).currentState === NormalizationState.CLEANUP_PENDING, 'Journal is persistently in CLEANUP_PENDING');

  oldUnlinkInjected = false;
  const recCleanup = cleanupJournal.recoverOnStartup();
  assert(recCleanup.ok === true && recCleanup.status === 'RECOVERED_SAFE', 'Startup recovery retries CLEANUP_PENDING successfully');
  assert(!fs.existsSync(cleanupPendingOld), 'Old backup successfully unlinked after startup recovery');
  assert(cleanupJournal.getEntry(cleanupPendingSample).currentState === NormalizationState.DONE, 'Journal state transitions to DONE after recovery cleanup');

  // Test 26: Fault Injection F — PAUSED_FOR_PLAYBACK Startup Invariant Validation
  console.log('\nTest 26: Fault Injection F — PAUSED_FOR_PLAYBACK Startup Invariant Validation');
  const cleanPausedJournal = getJournal('t26_clean');
  const cleanPausedSample = path.join(TEST_SCRATCH_DIR, 'clean_paused.mp4');
  fs.writeFileSync(cleanPausedSample, 'CLEAN_PAUSED_ORIGINAL_CONTENT', 'utf8');
  const cleanPausedFp = getMediaFingerprint(cleanPausedSample);
  cleanPausedJournal.recordState(cleanPausedSample, NormalizationState.PAUSED_FOR_PLAYBACK, { initialFingerprint: cleanPausedFp });
  const recCleanPaused = cleanPausedJournal.recoverOnStartup();
  assert(recCleanPaused.ok === true, 'Clean PAUSED entry passes invariant on startup recovery');
  assert(cleanPausedJournal.getEntry(cleanPausedSample).currentState === NormalizationState.CANCELLED, 'Clean PAUSED entry transitions to terminal CANCELLED on startup');

  const corruptPausedJournal = getJournal('t26_corrupt');
  const corruptPausedSample = path.join(TEST_SCRATCH_DIR, 'corrupt_paused.mp4');
  const corruptPausedOld = path.join(TEST_SCRATCH_DIR, '.corrupt_paused.mp4.vreconder-old');
  fs.writeFileSync(corruptPausedSample, 'CORRUPT_PAUSED_CONTENT', 'utf8');
  fs.writeFileSync(corruptPausedOld, 'UNEXPECTED_OLD_BACKUP', 'utf8');
  corruptPausedJournal.recordState(corruptPausedSample, NormalizationState.PAUSED_FOR_PLAYBACK, {
    initialFingerprint: getMediaFingerprint(corruptPausedSample)
  });
  const recCorruptPaused = corruptPausedJournal.recoverOnStartup();
  assert(recCorruptPaused.ok === false && recCorruptPaused.status === 'RECOVERY_BLOCKED', 'Corrupted PAUSED with unexpected .old fails closed to RECOVERY_BLOCKED');
  assert(corruptPausedJournal.getEntry(corruptPausedSample).currentState === NormalizationState.RECOVERY_REQUIRED, 'Corrupted PAUSED transitions to RECOVERY_REQUIRED in journal');

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
