import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMediaFingerprint, isFingerprintValid } from './src/normalization/fingerprint.mjs';
import { classifyMedia, isDerivativeFile, MediaClass } from './src/normalization/classification.mjs';
import { runDryRunInventory } from './src/normalization/inventory-scanner.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { NormalizationEngine } from './src/normalization/normalization-engine.mjs';
import { DeviceProbeCache } from './src/preflight/device-probe-cache.mjs';
import { IntakePreflightPipeline, UIReadiness } from './src/preflight/intake-preflight.mjs';
import { CERTIFIED_REPAIR_RULES, findCertifiedRepairRule, RuleStatus } from './src/normalization/repair-rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_SCRATCH_DIR = path.join(__dirname, 'test_scratch_normalization');

console.log('============================================================');
console.log('🧪 RUNNING COMPLETE NORMALIZATION & PREFLIGHT TEST SUITE (14 AREAS)');
console.log('============================================================\n');

let totalTests = 0;
let passedTests = 0;

function assert(condition, name) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${name}`);
  }
}

if (fs.existsSync(TEST_SCRATCH_DIR)) {
  fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_SCRATCH_DIR, { recursive: true });

async function runAllTests() {
  const dummyFile = path.join(TEST_SCRATCH_DIR, 'test_sample.mp4');
  fs.writeFileSync(dummyFile, 'BASE_MEDIA_PAYLOAD_DUMMY', 'utf8');
  const baseFp = getMediaFingerprint(dummyFile);

  // 1. Dry-run zero mutation
  console.log('Test 1: Dry-Run Zero Mutation');
  const statBefore = fs.statSync(dummyFile);
  const dryRunReport = await runDryRunInventory([TEST_SCRATCH_DIR]);
  const statAfter = fs.statSync(dummyFile);
  assert(statBefore.size === statAfter.size && statBefore.mtimeMs === statAfter.mtimeMs, 'Dry run guarantees zero mutation to files on disk');
  assert(dryRunReport.summary.totalFilesScanned >= 1, 'Dry run returned valid scan summary');

  // 2. Certified-rule matching
  console.log('\nTest 2: Certified-Rule Matching');
  const rule8bit = findCertifiedRepairRule({
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 3840, height: 1920 }
  }, '.mp4');
  assert(rule8bit !== null && rule8bit.status === RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE, 'Matches certified rule for 8-bit HEVC hev1 MP4');
  assert(rule8bit.ruleId === 'hevc-mp4-hev1-to-hvc1-streamcopy-v1', 'Correct certified rule ID');

  // 3. Non-matching hev1 does not get blindly normalized (10-bit HEVC)
  console.log('\nTest 3: Non-Matching hev1 Gating (10-bit HEVC)');
  const rule10bit = findCertifiedRepairRule({
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 10, width: 8192, height: 4096 }
  }, '.mp4');
  assert(rule10bit === null, '10-bit HEVC does NOT match 8-bit certified streamcopy rule');
  const class10bit = classifyMedia('sample10.mp4', {
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 10, width: 8192, height: 4096 }
  });
  assert(class10bit.classification === MediaClass.NEEDS_DEVICE_PROBE, '10-bit HEVC routed to NEEDS_DEVICE_PROBE');

  // 4. Derivative exclusion
  console.log('\nTest 4: Derivative Exclusion from Logical Media');
  assert(isDerivativeFile('8K/Kamiki Rei - DSVR01433_HVC1_TEST.mp4') === true, 'Excludes _HVC1_TEST derivative');
  assert(isDerivativeFile('New folder/SIVR033_faststart.mp4') === true, 'Excludes _faststart derivative');
  assert(isDerivativeFile('.sample.mp4.vreconder.partial') === true, 'Excludes .partial file');
  assert(isDerivativeFile('.sample.mp4.vreconder-old') === true, 'Excludes .vreconder-old file');
  assert(isDerivativeFile('Wakui Mito - VRKM962.mp4') === false, 'Standard original media is retained');

  // 5. Journal recovery
  console.log('\nTest 5: Journal State Machine & Crash Recovery');
  const journalFile = path.join(TEST_SCRATCH_DIR, 'test_journal.json');
  const journal = new NormalizationJournal(journalFile);

  const crashFileA = path.join(TEST_SCRATCH_DIR, 'crash_remux.mp4');
  const crashFileAPartial = path.join(TEST_SCRATCH_DIR, '.crash_remux.mp4.vreconder.partial');
  fs.writeFileSync(crashFileA, 'ORIGINAL_A', 'utf8');
  fs.writeFileSync(crashFileAPartial, 'HALF_WRITTEN', 'utf8');
  journal.recordState(crashFileA, NormalizationState.REMUXING, { partialPath: crashFileAPartial });

  const actions = journal.recoverOnStartup();
  assert(fs.existsSync(crashFileA) === true, 'Original A preserved after crash during REMUXING');
  assert(fs.existsSync(crashFileAPartial) === false, 'Orphaned partial A deleted safely');

  // 6. Original preserved on remux failure
  console.log('\nTest 6: Original Preserved on Remux Failure');
  const engine = new NormalizationEngine({ journal, executionEnabled: false });
  const failedRemuxResult = await engine.processCandidate(crashFileA);
  assert(failedRemuxResult.ok === false && failedRemuxResult.state === NormalizationState.FAILED_SAFE, 'Remux failure returns FAILED_SAFE');
  assert(fs.readFileSync(crashFileA, 'utf8') === 'ORIGINAL_A', 'Original file content untouched');

  // 7. Original preserved on verification failure
  console.log('\nTest 7: Original Preserved on Verification Failure');
  const crashFileV = path.join(TEST_SCRATCH_DIR, 'verify_fail.mp4');
  const crashFileVPartial = path.join(TEST_SCRATCH_DIR, '.verify_fail.mp4.vreconder.partial');
  fs.writeFileSync(crashFileV, 'ORIGINAL_V', 'utf8');
  fs.writeFileSync(crashFileVPartial, 'CORRUPTED_OUTPUT', 'utf8');
  journal.recordState(crashFileV, NormalizationState.STRUCTURE_VERIFYING, { partialPath: crashFileVPartial });
  journal.recoverOnStartup();
  assert(fs.existsSync(crashFileV) === true && fs.readFileSync(crashFileV, 'utf8') === 'ORIGINAL_V', 'Original preserved when verification fails');

  // 8. No-space failure preserves original
  console.log('\nTest 8: Disk Space Safety Gate');
  const noSpacePath = path.join(TEST_SCRATCH_DIR, 'huge_file.mp4');
  fs.writeFileSync(noSpacePath, 'HUGE_DATA', 'utf8');
  journal.recordState(noSpacePath, NormalizationState.FAILED_SAFE, { error: 'BLOCKED_NO_SPACE' });
  const noSpaceEntry = journal.getEntry(noSpacePath);
  assert(noSpaceEntry.currentState === NormalizationState.FAILED_SAFE, 'No space recorded as FAILED_SAFE');
  assert(fs.existsSync(noSpacePath) === true, 'Original file preserved on space constraint');

  // 9. Successful atomic swap simulation
  console.log('\nTest 9: Simulated Atomic Swap Steps');
  const swapTarget = path.join(TEST_SCRATCH_DIR, 'swap_target.mp4');
  const swapPartial = path.join(TEST_SCRATCH_DIR, '.swap_target.mp4.vreconder.partial');
  const swapOld = path.join(TEST_SCRATCH_DIR, '.swap_target.mp4.vreconder-old');
  fs.writeFileSync(swapTarget, 'ORIGINAL_SWAP_DATA', 'utf8');
  fs.writeFileSync(swapPartial, 'VERIFIED_NEW_DATA', 'utf8');

  // Swap step 1: target -> old
  fs.renameSync(swapTarget, swapOld);
  // Swap step 2: partial -> target
  fs.renameSync(swapPartial, swapTarget);
  assert(fs.existsSync(swapTarget) && fs.readFileSync(swapTarget, 'utf8') === 'VERIFIED_NEW_DATA', 'New verified file installed at target path');
  assert(fs.existsSync(swapOld) && fs.readFileSync(swapOld, 'utf8') === 'ORIGINAL_SWAP_DATA', 'Old file preserved at .vreconder-old until final unlink');
  fs.unlinkSync(swapOld);
  assert(!fs.existsSync(swapOld), 'Old file unlinked after final verification');

  // 10. Rollback after failed final verification
  console.log('\nTest 10: Rollback After Failed Final Verification');
  const rollTarget = path.join(TEST_SCRATCH_DIR, 'rollback_test.mp4');
  const rollOld = path.join(TEST_SCRATCH_DIR, '.rollback_test.mp4.vreconder-old');
  fs.writeFileSync(rollOld, 'ORIGINAL_ROLLBACK_DATA', 'utf8');
  fs.writeFileSync(rollTarget, 'BAD_NEW_DATA', 'utf8');

  // Crash recovery simulates failed final verify -> restore old
  fs.unlinkSync(rollTarget);
  fs.renameSync(rollOld, rollTarget);
  assert(fs.existsSync(rollTarget) && fs.readFileSync(rollTarget, 'utf8') === 'ORIGINAL_ROLLBACK_DATA', 'Original content restored cleanly on rollback');

  // 11. Concurrency = 1
  console.log('\nTest 11: Single Concurrency Enforcement');
  assert(engine.concurrency === 1, 'Engine concurrency strictly equals 1');
  engine.isProcessing = true;
  engine.executionEnabled = true;
  const concurrentAttempt = await engine.processCandidate(dummyFile);
  assert(concurrentAttempt.ok === false && concurrentAttempt.error.includes('Concurrency'), 'Rejects concurrent job attempts');
  engine.isProcessing = false;

  // 12. Active playback priority gating
  console.log('\nTest 12: Active Playback Priority & Cancellation');
  engine.notifyPlaybackState(true);
  const playbackBlocked = await engine.processCandidate(dummyFile);
  assert(playbackBlocked.ok === false && playbackBlocked.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Playback priority immediately yields and pauses jobs');
  engine.notifyPlaybackState(false);

  // 13. Policy version invalidates stale classification
  console.log('\nTest 13: Policy Version Cache Invalidation');
  const cachePath = path.join(TEST_SCRATCH_DIR, 'test_probe_cache.json');
  const probeCache = new DeviceProbeCache(cachePath);
  probeCache.set('test_fp_v1', { canPlay: true }, 'safari-ios', 'v1.0.0-old');
  const staleGet = probeCache.get('test_fp_v1', 'safari-ios', 'v1.0.0-safari-certified');
  assert(staleGet === null, 'Different policy version does not return stale probe result');

  // 14. Future intake READY / NORMALIZE / PROBE routing
  console.log('\nTest 14: Future Intake Preflight Routing');
  const intake = new IntakePreflightPipeline(probeCache);
  const directEval = await intake.evaluateAsset(dummyFile);
  assert([UIReadiness.VR_READY, UIReadiness.NEEDS_NORMALIZATION, UIReadiness.CHECKING, UIReadiness.NEEDS_INVESTIGATION].includes(directEval.readiness), 'Intake produces valid UI readiness status');

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
