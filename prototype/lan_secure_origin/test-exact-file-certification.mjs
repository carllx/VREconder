import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { RuleStatus, EXACT_CERTIFIED_BUCKETS, findRepairCandidate } from './src/normalization/repair-rules.mjs';
import {
  ExactFileAuthorizer,
  loadExactFileAuthorizationBundle,
  validateAuthorizationBundle,
  FROZEN_MANIFEST_SHA256,
  FROZEN_RESULTS_SHA256,
  AUTHORIZED_EXACT_FILE_GROUP_IDS,
  EXCLUDED_EXACT_FILE_GROUP_IDS
} from './src/normalization/exact-file-authorizer.mjs';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';

console.log('============================================================');
console.log('🧪 RUNNING EXACT-FILE PHYSICAL CERTIFICATION TEST SUITE');
console.log('============================================================');

const bundlePath = path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_exact_file_authorization.json');
const manifestPath = path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_repair_manifest.json');
const resultsPath = path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_repair_probe_results.jsonl');

const manifestRaw = fs.readFileSync(manifestPath);
const resultsRaw = fs.readFileSync(resultsPath);
const computedManifestSha = crypto.createHash('sha256').update(manifestRaw).digest('hex');
const computedResultsSha = crypto.createHash('sha256').update(resultsRaw).digest('hex');

// Test 1: FROZEN_MANIFEST_SHA256 matches actual canonical_repair_manifest.json
assert.strictEqual(computedManifestSha, FROZEN_MANIFEST_SHA256, 'Manifest SHA256 must match frozen constant');
console.log('  ✅ [PASS] 1. FROZEN_MANIFEST_SHA256 matches actual canonical_repair_manifest.json');

// Test 2: FROZEN_RESULTS_SHA256 matches actual canonical_repair_probe_results.jsonl
assert.strictEqual(computedResultsSha, FROZEN_RESULTS_SHA256, 'Results SHA256 must match frozen constant');
console.log('  ✅ [PASS] 2. FROZEN_RESULTS_SHA256 matches actual canonical_repair_probe_results.jsonl');

// Test 3: EXACT_CERTIFIED_BUCKETS remains strictly 3 historical buckets
assert.strictEqual(EXACT_CERTIFIED_BUCKETS.length, 3, 'EXACT_CERTIFIED_BUCKETS must have exactly 3 buckets');
assert.deepStrictEqual(
  EXACT_CERTIFIED_BUCKETS.map(b => b.bucketId),
  ['BUCKET_A1_4K_59FPS_SIVR033', 'BUCKET_A2_4K_60FPS_WAKUI', 'BUCKET_B_8K_60FPS_KAMIKI'],
  'EXACT_CERTIFIED_BUCKETS contains only historical buckets'
);
console.log('  ✅ [PASS] 3. EXACT_CERTIFIED_BUCKETS remains strictly 3 historical buckets');

// Test 4: RuleStatus includes CERTIFIED_FOR_EXACT_FILE
assert.strictEqual(RuleStatus.CERTIFIED_FOR_EXACT_FILE, 'CERTIFIED_FOR_EXACT_FILE', 'RuleStatus contains CERTIFIED_FOR_EXACT_FILE');
console.log('  ✅ [PASS] 4. RuleStatus includes CERTIFIED_FOR_EXACT_FILE');

// Test 5: Bundle loads and validates cleanly
const bundleLoad = loadExactFileAuthorizationBundle(bundlePath);
assert.strictEqual(bundleLoad.ok, true, 'Bundle loads cleanly');
assert.strictEqual(bundleLoad.bundle.authorizedItems.length, 12, 'Bundle has exactly 12 authorized items');
console.log('  ✅ [PASS] 5. Bundle loads and validates cleanly (12 items)');

// Test 6: Tampered manifest SHA in bundle fails closed
const tamperedManifestBundle = { ...bundleLoad.bundle, manifestSha256: 'deadbeef00000000000000000000000000000000000000000000000000000000' };
assert.strictEqual(validateAuthorizationBundle(tamperedManifestBundle).ok, false, 'Tampered manifest SHA fails validation');
console.log('  ✅ [PASS] 6. Tampered manifest SHA fails validation');

// Test 7: Tampered results SHA in bundle fails closed
const tamperedResultsBundle = { ...bundleLoad.bundle, resultsSha256: 'deadbeef00000000000000000000000000000000000000000000000000000000' };
assert.strictEqual(validateAuthorizationBundle(tamperedResultsBundle).ok, false, 'Tampered results SHA fails validation');
console.log('  ✅ [PASS] 7. Tampered results SHA fails validation');

// Test 8: Missing authorized groupId fails validation
const missingItemBundle = {
  ...bundleLoad.bundle,
  authorizedItems: bundleLoad.bundle.authorizedItems.slice(0, 11)
};
assert.strictEqual(validateAuthorizationBundle(missingItemBundle).ok, false, 'Missing item bundle fails validation');
console.log('  ✅ [PASS] 8. Missing authorized groupId fails validation');

// Test 9: Extra unauthorized item fails validation
const extraItemBundle = {
  ...bundleLoad.bundle,
  authorizedItems: [
    ...bundleLoad.bundle.authorizedItems,
    { groupId: 'GRP-INCOMPAT-999', canonicalPath: 'G:\\dummy.mp4' }
  ]
};
assert.strictEqual(validateAuthorizationBundle(extraItemBundle).ok, false, 'Extra unauthorized item fails validation');
console.log('  ✅ [PASS] 9. Extra unauthorized item fails validation');

// Test 10: All 12 authorized group IDs resolve with status CERTIFIED_FOR_EXACT_FILE
const authorizer = new ExactFileAuthorizer({ bundle: bundleLoad.bundle });
const initRes = authorizer.initialize();
assert.strictEqual(initRes.ok, true, 'Authorizer initializes');

for (const item of bundleLoad.bundle.authorizedItems) {
  const rule = authorizer.resolveExactFileRepairRule(item.canonicalPath, {
    videoCount: 1,
    audioCount: 1,
    otherStreams: [],
    chapterCount: 0,
    video: { codec: 'hevc', codecTag: 'hev1', width: item.facts.width, height: item.facts.height }
  }, item.expectedFingerprint);

  assert(rule !== null, `Rule must resolve for ${item.groupId}`);
  assert.strictEqual(rule.status, RuleStatus.CERTIFIED_FOR_EXACT_FILE, `Status must be CERTIFIED_FOR_EXACT_FILE for ${item.groupId}`);
  assert.strictEqual(rule.expectedOutputTag, 'hvc1', `Output tag must be hvc1 for ${item.groupId}`);
  assert.deepStrictEqual(rule.operation.ffmpegArgs, ['-map', '0', '-c', 'copy', '-tag:v', 'hvc1'], `FFmpeg args match for ${item.groupId}`);
}
console.log('  ✅ [PASS] 10. All 12 authorized group IDs resolve with status CERTIFIED_FOR_EXACT_FILE');

// Test 11: Excluded GRP-INCOMPAT-001 fails closed (returns null)
const item001 = authorizer.resolveExactFileRepairRule('G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-URVRSP203(UNVRSP002) - p1 - (HEVC_19).mp4.mp4', {
  videoCount: 1, audioCount: 1, video: { codec: 'hevc', codecTag: 'hev1' }
}, { sizeBytes: 3675387607 });
assert.strictEqual(item001, null, 'GRP-INCOMPAT-001 must return null');
console.log('  ✅ [PASS] 11. Excluded GRP-INCOMPAT-001 returns null (fail closed)');

// Test 12: Excluded GRP-INCOMPAT-012 fails closed (returns null)
const item012 = authorizer.resolveExactFileRepairRule('G:\\Media\\VR\\Render\\MDVR257.mp4', {
  videoCount: 1, audioCount: 1, video: { codec: 'hevc', codecTag: 'hev1' }
}, { sizeBytes: 12345 });
assert.strictEqual(item012, null, 'GRP-INCOMPAT-012 must return null');
console.log('  ✅ [PASS] 12. Excluded GRP-INCOMPAT-012 returns null (fail closed)');

// Test 13: Excluded GRP-INCOMPAT-015 fails closed (returns null)
const item015 = authorizer.resolveExactFileRepairRule('G:\\Media\\VR\\Render\\4k2.com@vrkm01453_25_4k.mp4', {
  videoCount: 1, audioCount: 1, video: { codec: 'hevc', codecTag: 'hev1' }
}, { sizeBytes: 12345 });
assert.strictEqual(item015, null, 'GRP-INCOMPAT-015 must return null');
console.log('  ✅ [PASS] 13. Excluded GRP-INCOMPAT-015 returns null (fail closed)');

// Test 14: Arbitrary 13th unknown file fails closed (returns null)
const unknownFile = authorizer.resolveExactFileRepairRule('G:\\Media\\VR\\Render\\RandomVideo.mp4', {
  videoCount: 1, audioCount: 1, video: { codec: 'hevc', codecTag: 'hev1' }
}, { sizeBytes: 5000 });
assert.strictEqual(unknownFile, null, 'Unknown file must return null');
console.log('  ✅ [PASS] 14. Unknown 13th file returns null (fail closed)');

// Test 15: Authorized file with mutated sizeBytes fails closed (tamper detection)
const auth002 = bundleLoad.bundle.authorizedItems[0];
const tamperedFpResult = authorizer.resolveExactFileRepairRule(auth002.canonicalPath, {
  videoCount: 1, audioCount: 1, otherStreams: [], chapterCount: 0,
  video: { codec: 'hevc', codecTag: 'hev1' }
}, { ...auth002.expectedFingerprint, sizeBytes: auth002.expectedFingerprint.sizeBytes + 1 });
assert.strictEqual(tamperedFpResult, null, 'Tampered file size must return null');
console.log('  ✅ [PASS] 15. Mutated file sizeBytes returns null (tamper protection)');

// Test 16: NormalizationEngine rejects exact-file candidate when exactFileAuthorizer is not provided
const testJournalPath = path.join(process.cwd(), 'prototype/lan_secure_origin/scratch_test_journal.json');
if (fs.existsSync(testJournalPath)) fs.unlinkSync(testJournalPath);
const testJournal = new NormalizationJournal(testJournalPath);
const unequippedEngine = new NormalizationEngine({
  journal: testJournal,
  executionEnabled: true,
  allowUncertifiedCandidate: false
  // exactFileAuthorizer omitted!
});
await unequippedEngine.initialize();
const unequippedRes = await unequippedEngine.processCandidate(auth002.canonicalPath);
assert.strictEqual(unequippedRes.ok, false, 'ProcessCandidate without exactFileAuthorizer must fail');
assert.strictEqual(unequippedRes.error, 'No applicable repair candidate rule', 'Fails closed with no applicable rule');
console.log('  ✅ [PASS] 16. NormalizationEngine rejects candidate when exactFileAuthorizer is omitted');

// Test 17: NormalizationEngine without executionEnabled blocks execution
const disabledEngine = new NormalizationEngine({
  journal: testJournal,
  executionEnabled: false,
  exactFileAuthorizer: authorizer
});
await disabledEngine.initialize();
const disabledRes = await disabledEngine.processCandidate(auth002.canonicalPath);
assert.strictEqual(disabledRes.ok, false, 'Disabled engine must block execution');
assert(disabledRes.error.includes('disabled by mission safety gate'), 'Blocked by safety gate message');
console.log('  ✅ [PASS] 17. NormalizationEngine blocks execution when executionEnabled is false');

if (fs.existsSync(testJournalPath)) fs.unlinkSync(testJournalPath);

console.log('\n============================================================');
console.log('🎉 ALL 17 EXACT-FILE CERTIFICATION TESTS PASSED');
console.log('============================================================');
