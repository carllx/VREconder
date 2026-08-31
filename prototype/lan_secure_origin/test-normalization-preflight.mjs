import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMediaFingerprint, isFingerprintValid } from './src/normalization/fingerprint.mjs';
import { classifyMedia, isDerivativeFile, MediaClass } from './src/normalization/classification.mjs';
import { runDryRunInventory } from './src/normalization/inventory-scanner.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { verifyNormalizedOutput } from './src/normalization/verifier.mjs';
import { NormalizationEngine } from './src/normalization/normalization-engine.mjs';
import { DeviceProbeCache } from './src/preflight/device-probe-cache.mjs';
import { IntakePreflightPipeline, UIReadiness } from './src/preflight/intake-preflight.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_SCRATCH_DIR = path.join(__dirname, 'test_scratch_normalization');

console.log('============================================================');
console.log('🧪 RUNNING TRANSACTIONAL NORMALIZATION & PREFLIGHT TESTS');
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

// Setup temporary isolated scratch directory
if (fs.existsSync(TEST_SCRATCH_DIR)) {
  fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_SCRATCH_DIR, { recursive: true });

async function runAllTests() {
  // Test 1: Scanner derivative exclusion
  console.log('Test Suite 1: Derivative Exclusion & Logical Media Boundary');
  assert(isDerivativeFile('video_HVC1_TEST.mp4') === true, 'Matches _HVC1_TEST pattern');
  assert(isDerivativeFile('video_faststart.mp4') === true, 'Matches _faststart pattern');
  assert(isDerivativeFile('.video.mp4.vreconder.partial') === true, 'Matches .partial pattern');
  assert(isDerivativeFile('.video.mp4.vreconder-old') === true, 'Matches .vreconder-old pattern');
  assert(isDerivativeFile('Kamiki Rei - DSVR01433.mp4') === false, 'Standard original media is not derivative');

  const derivClass = classifyMedia('video_HVC1_TEST.mp4', null);
  assert(derivClass.classification === MediaClass.EXPERIMENT_DERIVATIVE, 'Derivative classified as EXPERIMENT_DERIVATIVE');

  // Test 2: Fingerprint and Cache Invalidation
  console.log('\nTest Suite 2: Fingerprint Stability & Invalidation');
  const dummyFile = path.join(TEST_SCRATCH_DIR, 'test_media.mp4');
  fs.writeFileSync(dummyFile, 'SAMPLE_VIDEO_DATA_FOR_TEST', 'utf8');
  const fp1 = getMediaFingerprint(dummyFile);
  assert(fp1 !== null && typeof fp1.fingerprintId === 'string', 'Generated valid fingerprint');

  const isValidInitial = isFingerprintValid(dummyFile, fp1);
  assert(isValidInitial === true, 'Fingerprint valid when unmodified');

  // Simulate file mutation (change size & mtime)
  await new Promise(r => setTimeout(r, 100));
  fs.appendFileSync(dummyFile, '_EXTRA_BYTES');
  const isValidAfterMutation = isFingerprintValid(dummyFile, fp1);
  assert(isValidAfterMutation === false, 'Fingerprint invalidated after file mutation');

  // Test 3: Classification Rules
  console.log('\nTest Suite 3: Media Compatibility Classification');
  const avcFacts = {
    fingerprint: fp1,
    video: { codec: 'h264', codecTag: 'avc1', bitDepth: 8, width: 4096, height: 2048 },
    audioCount: 1
  };
  assert(classifyMedia('sample.mp4', avcFacts).classification === MediaClass.READY_DIRECT, 'AVC1 classified as READY_DIRECT');

  const hvc1Facts = {
    fingerprint: fp1,
    video: { codec: 'hevc', codecTag: 'hvc1', bitDepth: 8, width: 8192, height: 4096 },
    audioCount: 1
  };
  assert(classifyMedia('sample.mp4', hvc1Facts).classification === MediaClass.READY_DIRECT, '8-bit HEVC (hvc1) classified as READY_DIRECT');

  const hev1Facts = {
    fingerprint: fp1,
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 8, width: 8192, height: 4096 },
    audioCount: 1
  };
  const hev1Class = classifyMedia('sample.mp4', hev1Facts);
  assert(hev1Class.classification === MediaClass.NORMALIZATION_CANDIDATE, '8-bit HEVC (hev1) classified as NORMALIZATION_CANDIDATE');
  assert(hev1Class.repairCandidate === 'hevc-mp4-hev1-to-hvc1-streamcopy-v1', 'Assigned repair candidate rule');

  const tenBitFacts = {
    fingerprint: fp1,
    video: { codec: 'hevc', codecTag: 'hev1', bitDepth: 10, width: 8192, height: 4096 },
    audioCount: 1
  };
  assert(classifyMedia('sample.mp4', tenBitFacts).classification === MediaClass.NEEDS_DEVICE_PROBE, '10-bit HEVC classified as NEEDS_DEVICE_PROBE');

  // Test 4: Dry-run inventory does not mutate files
  console.log('\nTest Suite 4: Dry-Run Inventory Immutability');
  const initialStat = fs.statSync(dummyFile);
  const dryRunReport = await runDryRunInventory([TEST_SCRATCH_DIR]);
  const postDryRunStat = fs.statSync(dummyFile);
  assert(initialStat.size === postDryRunStat.size && initialStat.mtimeMs === postDryRunStat.mtimeMs, 'Dry run does not mutate files on disk');
  assert(dryRunReport.summary.totalFilesScanned >= 1, 'Dry run inventory scanned media files');

  // Test 5: Journal state machine & crash recovery
  console.log('\nTest Suite 5: Journal Crash-Recovery Invariants');
  const journalPath = path.join(TEST_SCRATCH_DIR, 'test_journal.json');
  const journal = new NormalizationJournal(journalPath);

  // Scenario A: Crash during REMUXING -> orphan partial must be cleaned, original untouched
  const crashFileA = path.join(TEST_SCRATCH_DIR, 'crash_file_a.mp4');
  const crashFileAPartial = path.join(TEST_SCRATCH_DIR, '.crash_file_a.mp4.vreconder.partial');
  fs.writeFileSync(crashFileA, 'ORIGINAL_CONTENT_A', 'utf8');
  fs.writeFileSync(crashFileAPartial, 'HALF_WRITTEN_PARTIAL_A', 'utf8');

  journal.recordState(crashFileA, NormalizationState.REMUXING, { partialPath: crashFileAPartial });
  const recoveryA = journal.recoverOnStartup();
  assert(fs.existsSync(crashFileA) === true, 'Original file A strictly preserved during crash recovery');
  assert(fs.readFileSync(crashFileA, 'utf8') === 'ORIGINAL_CONTENT_A', 'Original content A untouched');
  assert(fs.existsSync(crashFileAPartial) === false, 'Orphaned partial file A cleaned up');

  // Scenario B: Crash during SWAPPING -> .vreconder-old must be restored to original filename
  const crashFileB = path.join(TEST_SCRATCH_DIR, 'crash_file_b.mp4');
  const crashFileBOld = path.join(TEST_SCRATCH_DIR, '.crash_file_b.mp4.vreconder-old');
  fs.writeFileSync(crashFileBOld, 'ORIGINAL_CONTENT_B', 'utf8');
  // Original missing because rename succeeded right before crash
  if (fs.existsSync(crashFileB)) fs.unlinkSync(crashFileB);

  journal.recordState(crashFileB, NormalizationState.SWAPPING);
  const recoveryB = journal.recoverOnStartup();
  assert(fs.existsSync(crashFileB) === true, 'Crash during SWAPPING restored .vreconder-old back to canonical name');
  assert(fs.readFileSync(crashFileB, 'utf8') === 'ORIGINAL_CONTENT_B', 'Restored original content B intact');

  // Test 6: Transactional Engine Hard Invariants
  console.log('\nTest Suite 6: Transactional Engine Safety & Concurrency');
  const engine = new NormalizationEngine({ journal, executionEnabled: false });

  // Disabled execution gate
  const disabledResult = await engine.processCandidate(crashFileA);
  assert(disabledResult.ok === false && disabledResult.state === NormalizationState.FAILED_SAFE, 'Engine safely refuses execution when executionEnabled is false');

  // Playback Priority Pause / Cancel
  engine.executionEnabled = true;
  engine.notifyPlaybackState(true);
  const playbackBlockedResult = await engine.processCandidate(crashFileA);
  assert(playbackBlockedResult.ok === false && playbackBlockedResult.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'Playback priority immediately blocks batch normalization');
  assert(fs.existsSync(crashFileA) === true, 'Original file preserved when blocked by playback');

  // Test 7: Device Probe Cache & Intake Preflight Pipeline
  console.log('\nTest Suite 7: Intake Preflight Pipeline & Device Probe Cache');
  const cachePath = path.join(TEST_SCRATCH_DIR, 'test_probe_cache.json');
  const probeCache = new DeviceProbeCache(cachePath);
  const intake = new IntakePreflightPipeline(probeCache);

  const directAvcEval = await intake.evaluateAsset(dummyFile);
  assert(typeof directAvcEval.readiness === 'string', 'Intake pipeline produces UI readiness state');

  // Test caching
  probeCache.set('mock_fp_123', { canPlay: true, videoWidth: 4096, videoHeight: 2048 }, 'safari-ios');
  const cachedEntry = probeCache.get('mock_fp_123', 'safari-ios');
  assert(cachedEntry !== null && cachedEntry.result.canPlay === true, 'Device probe result cached and retrieved correctly');

  // Cleanup test scratch
  try {
    fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n============================================================');
  console.log(`📊 TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
  console.log('============================================================\n');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
