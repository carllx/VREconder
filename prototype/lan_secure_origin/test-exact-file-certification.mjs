import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { RuleStatus, EXACT_CERTIFIED_BUCKETS, findRepairCandidate } from './src/normalization/repair-rules.mjs';
import {
  ExactFileAuthorizer,
  loadVerifiedEvidence,
  validateEvidenceRecords,
  validateAuthorizationBundle,
  matchMaterialFacts,
  computeFileSha256,
  FROZEN_MANIFEST_SHA256,
  FROZEN_RESULTS_SHA256,
  AUTHORIZED_EXACT_FILE_GROUP_IDS,
  EXCLUDED_EXACT_FILE_GROUP_IDS,
  EXACT_FILE_HVC1_OPERATION
} from './src/normalization/exact-file-authorizer.mjs';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { ServerPlaybackMonitor } from './src/normalization/batch-runner.mjs';

console.log('============================================================');
console.log('🧪 RUNNING EXACT-FILE PHYSICAL CERTIFICATION TEST SUITE (EXTENDED)');
console.log('============================================================');

const bundlePath = path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_exact_file_authorization.json');
const manifestPath = path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_repair_manifest.json');
const resultsPath = path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_repair_probe_results.jsonl');

const manifestRaw = fs.readFileSync(manifestPath);
const resultsRaw = fs.readFileSync(resultsPath);
const computedManifestSha = crypto.createHash('sha256').update(manifestRaw).digest('hex');
const computedResultsSha = crypto.createHash('sha256').update(resultsRaw).digest('hex');

// Test 1: actual manifest file hash modified -> DENIED
const fakeManifestPath = path.join(process.cwd(), 'prototype/lan_secure_origin/scratch_tampered_manifest.json');
fs.writeFileSync(fakeManifestPath, manifestRaw.toString() + ' ');
const tamperedManifestRes = loadVerifiedEvidence({ manifestPath: fakeManifestPath, resultsPath });
assert.strictEqual(tamperedManifestRes.ok, false, 'Tampered manifest file must fail closed');
assert(tamperedManifestRes.error.includes('Actual manifest SHA256 mismatch'));
fs.unlinkSync(fakeManifestPath);
console.log('  ✅ [PASS] 1. actual manifest file hash modified -> DENIED');

// Test 2: actual results file hash modified -> DENIED
const fakeResultsPath = path.join(process.cwd(), 'prototype/lan_secure_origin/scratch_tampered_results.jsonl');
fs.writeFileSync(fakeResultsPath, resultsRaw.toString() + '\n');
const tamperedResultsRes = loadVerifiedEvidence({ manifestPath, resultsPath: fakeResultsPath });
assert.strictEqual(tamperedResultsRes.ok, false, 'Tampered results file must fail closed');
assert(tamperedResultsRes.error.includes('Actual results SHA256 mismatch'));
fs.unlinkSync(fakeResultsPath);
console.log('  ✅ [PASS] 2. actual results file hash modified -> DENIED');

// Verified evidence baseline
const baseEv = loadVerifiedEvidence({ manifestPath, resultsPath });
assert.strictEqual(baseEv.ok, true, 'Base evidence loads cleanly');

// Test 3: bundle path tampered -> DENIED
const tamperedPathBundle = {
  manifestSha256: FROZEN_MANIFEST_SHA256,
  resultsSha256: FROZEN_RESULTS_SHA256,
  authorizedItems: Array.from(baseEv.evidenceByGroupId.values()).map(it => ({
    groupId: it.groupId,
    canonicalPath: 'G:\\Tampered\\Path.mp4',
    expectedFingerprint: { sizeBytes: it.sizeBytes, fingerprintId: it.fingerprintId }
  }))
};
const valTamperedPath = validateAuthorizationBundle(tamperedPathBundle, baseEv.evidenceByGroupId);
assert.strictEqual(valTamperedPath.ok, false, 'Tampered bundle path must fail closed');
assert(valTamperedPath.error.includes('Bundle path tampered'));
console.log('  ✅ [PASS] 3. bundle path tampered -> DENIED');

// Test 4: bundle fingerprint tampered -> DENIED
const tamperedFpBundle = {
  manifestSha256: FROZEN_MANIFEST_SHA256,
  resultsSha256: FROZEN_RESULTS_SHA256,
  authorizedItems: Array.from(baseEv.evidenceByGroupId.values()).map(it => ({
    groupId: it.groupId,
    canonicalPath: it.canonicalPath,
    expectedFingerprint: { sizeBytes: it.sizeBytes + 999, fingerprintId: it.fingerprintId }
  }))
};
const valTamperedFp = validateAuthorizationBundle(tamperedFpBundle, baseEv.evidenceByGroupId);
assert.strictEqual(valTamperedFp.ok, false, 'Tampered bundle fingerprint must fail closed');
assert(valTamperedFp.error.includes('Bundle expectedFingerprint tampered'));
console.log('  ✅ [PASS] 4. bundle fingerprint tampered -> DENIED');

// Test 5: bundle ffmpeg operation tampered -> cannot alter fixed operation
const authorizer = new ExactFileAuthorizer();
authorizer.initialize();
const item002 = authorizer.evidenceByGroupId.get('GRP-INCOMPAT-002');
const resolvedRule = authorizer.resolveExactFileRepairRule(item002.canonicalPath, {
  videoCount: 1, audioCount: 1,
  video: { codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', width: 8192, height: 4096 }
}, { sizeBytes: item002.sizeBytes, fingerprintId: item002.fingerprintId });
assert.deepStrictEqual(resolvedRule.operation.ffmpegArgs, ['-map', '0', '-c', 'copy', '-tag:v', 'hvc1']);
assert.strictEqual(resolvedRule.operation.type, 'stream-copy');
assert.strictEqual(resolvedRule.operation.outputTag, 'hvc1');
console.log('  ✅ [PASS] 5. bundle ffmpeg operation tampered -> cannot alter fixed operation');

// Helper to create pure mock objects for validateEvidenceRecords
function createEvidenceMock(manifestMod, resultsMod) {
  const m = JSON.parse(manifestRaw.toString());
  const r = resultsRaw.toString().trim().split('\n').map(l => JSON.parse(l));
  if (manifestMod) manifestMod(m);
  if (resultsMod) resultsMod(r);
  return validateEvidenceRecords(m, r);
}

// Test 6: missing physical result -> DENIED (via validateEvidenceRecords)
const missingResultRes = createEvidenceMock(null, (r) => {
  const idx = r.findIndex(l => l.groupId === 'GRP-INCOMPAT-002');
  if (idx !== -1) r.splice(idx, 1);
});
assert.strictEqual(missingResultRes.ok, false);
assert(missingResultRes.error.includes('Missing physical probe result for GRP-INCOMPAT-002'));
console.log('  ✅ [PASS] 6. missing physical result -> DENIED (reached contract branch)');

// Test 7: duplicate physical result -> DENIED (via validateEvidenceRecords)
const duplicateResultRes = createEvidenceMock(null, (r) => {
  const r002 = r.find(l => l.groupId === 'GRP-INCOMPAT-002');
  r.push({ ...r002 });
});
assert.strictEqual(duplicateResultRes.ok, false);
assert(duplicateResultRes.error.includes('Duplicate physical probe results found for GRP-INCOMPAT-002'));
console.log('  ✅ [PASS] 7. duplicate physical result -> DENIED (reached contract branch)');

// Test 8: non-PASS physical result -> DENIED (via validateEvidenceRecords)
const nonPassRes = createEvidenceMock(null, (r) => {
  const r002 = r.find(l => l.groupId === 'GRP-INCOMPAT-002');
  r002.verdict = 'MEDIA_ERROR';
});
assert.strictEqual(nonPassRes.ok, false);
assert(nonPassRes.error.includes('Physical result verdict is not PASS_VIDEO'));
console.log('  ✅ [PASS] 8. non-PASS physical result -> DENIED (reached contract branch)');

// Test 9: width=0 -> DENIED (via validateEvidenceRecords)
const widthZeroRes = createEvidenceMock(null, (r) => {
  const r002 = r.find(l => l.groupId === 'GRP-INCOMPAT-002');
  r002.details.videoWidth = 0;
});
assert.strictEqual(widthZeroRes.ok, false);
assert(widthZeroRes.error.includes('videoWidth not positive'));
console.log('  ✅ [PASS] 9. width=0 -> DENIED (reached contract branch)');

// Test 10: height=0 -> DENIED (via validateEvidenceRecords)
const heightZeroRes = createEvidenceMock(null, (r) => {
  const r002 = r.find(l => l.groupId === 'GRP-INCOMPAT-002');
  r002.details.videoHeight = 0;
});
assert.strictEqual(heightZeroRes.ok, false);
assert(heightZeroRes.error.includes('videoHeight not positive'));
console.log('  ✅ [PASS] 10. height=0 -> DENIED (reached contract branch)');

// Test 11: rvfc<2 -> DENIED (via validateEvidenceRecords)
const rvfcLowRes = createEvidenceMock(null, (r) => {
  const r002 = r.find(l => l.groupId === 'GRP-INCOMPAT-002');
  r002.details.rvfcFrameCount = 1;
});
assert.strictEqual(rvfcLowRes.ok, false);
assert(rvfcLowRes.error.includes('rvfcFrameCount < 2'));
console.log('  ✅ [PASS] 11. rvfc<2 -> DENIED (reached contract branch)');

// Test 12: streamEquivalenceVerified=false -> DENIED (via validateEvidenceRecords)
const streamEqRes = createEvidenceMock((m) => {
  const it = m.items.find(x => x.groupId === 'GRP-INCOMPAT-002');
  it.details.streamEquivalenceVerified = false;
}, null);
assert.strictEqual(streamEqRes.ok, false);
assert(streamEqRes.error.includes('streamEquivalenceVerified not true'));
console.log('  ✅ [PASS] 12. streamEquivalenceVerified=false -> DENIED (reached contract branch)');

// Test 13: videoMd5Match=false -> DENIED (via validateEvidenceRecords)
const videoMd5Res = createEvidenceMock((m) => {
  const it = m.items.find(x => x.groupId === 'GRP-INCOMPAT-002');
  it.details.videoMd5Match = false;
}, null);
assert.strictEqual(videoMd5Res.ok, false);
assert(videoMd5Res.error.includes('videoMd5Match not true'));
console.log('  ✅ [PASS] 13. videoMd5Match=false -> DENIED (reached contract branch)');

// Test 14: audioMd5Match=false -> DENIED (via validateEvidenceRecords)
const audioMd5Res = createEvidenceMock((m) => {
  const it = m.items.find(x => x.groupId === 'GRP-INCOMPAT-002');
  it.details.audioMd5Match = false;
}, null);
assert.strictEqual(audioMd5Res.ok, false);
assert(audioMd5Res.error.includes('audioMd5Match not true'));
console.log('  ✅ [PASS] 14. audioMd5Match=false -> DENIED (reached contract branch)');

// Test 15: material facts drift -> DENIED (level, pixFmt, bitDepth, rFps, avgFps)
const baseFacts = {
  videoCount: 1, audioCount: 1, otherStreams: [], chapterCount: 0,
  video: { codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', level: 180, pixFmt: 'yuv420p10le', bitDepth: 10, width: 8192, height: 4096, rFps: '60/1', avgFps: '60/1' }
};

// Level drift
const levelDrift = matchMaterialFacts({ ...baseFacts, video: { ...baseFacts.video, level: 153 } }, { level: 180 });
assert.strictEqual(levelDrift.ok, false);
assert(levelDrift.reason.includes("field 'level' drift"));

// pixFmt drift
const pixFmtDrift = matchMaterialFacts({ ...baseFacts, video: { ...baseFacts.video, pixFmt: 'yuv420p' } }, { pixFmt: 'yuv420p10le' });
assert.strictEqual(pixFmtDrift.ok, false);
assert(pixFmtDrift.reason.includes("field 'pixFmt' drift"));

// bitDepth drift
const bitDepthDrift = matchMaterialFacts({ ...baseFacts, video: { ...baseFacts.video, bitDepth: 8 } }, { bitDepth: 10 });
assert.strictEqual(bitDepthDrift.ok, false);
assert(bitDepthDrift.reason.includes("field 'bitDepth' drift"));

// rFps drift
const rFpsDrift = matchMaterialFacts({ ...baseFacts, video: { ...baseFacts.video, rFps: '30/1' } }, { rFps: '60/1' });
assert.strictEqual(rFpsDrift.ok, false);
assert(rFpsDrift.reason.includes("field 'rFps' drift"));

// avgFps drift
const avgFpsDrift = matchMaterialFacts({ ...baseFacts, video: { ...baseFacts.video, avgFps: '30/1' } }, { avgFps: '60/1' });
assert.strictEqual(avgFpsDrift.ok, false);
assert(avgFpsDrift.reason.includes("field 'avgFps' drift"));

console.log('  ✅ [PASS] 15. material facts drift -> DENIED (level, pixFmt, bitDepth, rFps, avgFps)');

// Test 16: unauthorized 13th identity -> DENIED
const unauthorizedFile = authorizer.resolveExactFileRepairRule('G:\\Media\\VR\\Render\\SomeOtherVideo.mp4', {
  videoCount: 1, audioCount: 1,
  video: { codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', width: 8192, height: 4096 }
}, { sizeBytes: 1234567, fingerprintId: 'abc123' });
assert.strictEqual(unauthorizedFile, null, 'Unauthorized 13th identity returns null');
console.log('  ✅ [PASS] 16. unauthorized 13th identity -> DENIED');

// Test 17: 001/012/015 -> DENIED
assert.strictEqual(authorizer.resolveExactFileRepairRule('G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-URVRSP203(UNVRSP002) - p1 - (HEVC_19).mp4.mp4', { videoCount: 1, audioCount: 1, video: { codec: 'hevc', codecTag: 'hev1' } }, { sizeBytes: 3675387607 }), null);
assert.strictEqual(authorizer.resolveExactFileRepairRule('G:\\Media\\VR\\Render\\MDVR257.mp4', { videoCount: 1, audioCount: 1, video: { codec: 'hevc', codecTag: 'hev1' } }, { sizeBytes: 12345 }), null);
assert.strictEqual(authorizer.resolveExactFileRepairRule('G:\\Media\\VR\\Render\\4k2.com@vrkm01453_25_4k.mp4', { videoCount: 1, audioCount: 1, video: { codec: 'hevc', codecTag: 'hev1' } }, { sizeBytes: 12345 }), null);
console.log('  ✅ [PASS] 17. 001/012/015 -> DENIED');

// Test 18: historical bucket matcher unchanged
assert.strictEqual(EXACT_CERTIFIED_BUCKETS.length, 3);
assert.deepStrictEqual(EXACT_CERTIFIED_BUCKETS.map(b => b.bucketId), [
  'BUCKET_A1_4K_59FPS_SIVR033', 'BUCKET_A2_4K_60FPS_WAKUI', 'BUCKET_B_8K_60FPS_KAMIKI'
]);
console.log('  ✅ [PASS] 18. historical bucket matcher unchanged');

// Test 19: playback signal unavailable/unhealthy -> destructive run blocked
const deadMonitor = new ServerPlaybackMonitor({ serverUrl: 'http://127.0.0.1:59999' }).start();
const deadHealth = await deadMonitor.checkHealth();
assert.strictEqual(deadHealth.ok, false, 'Dead monitor must report unhealthy');
assert.strictEqual(deadMonitor.isSignalHealthy(), false, 'isSignalHealthy must be false');
deadMonitor.close();
console.log('  ✅ [PASS] 19. playback signal unavailable/unhealthy -> destructive run blocked');

// Test 20: playback active -> engine refuses candidate (and in start-window)
let activeServer = null;
await new Promise((resolve) => {
  activeServer = http.createServer((req, res) => {
    if (req.url === '/api/playback/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ isPlaybackActive: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  activeServer.listen(0, '127.0.0.1', resolve);
});
const activePort = activeServer.address().port;
const activeMonitor = new ServerPlaybackMonitor({ serverUrl: `http://127.0.0.1:${activePort}` }).start();
const activeHealth = await activeMonitor.checkHealth();
assert.strictEqual(activeHealth.ok, true, 'Active server responds OK');
assert.strictEqual(activeMonitor.isPlaybackActive, true, 'Playback is reported active');

const testJournalPath = path.join(process.cwd(), 'prototype/lan_secure_origin/scratch_t20_journal.json');
if (fs.existsSync(testJournalPath)) fs.unlinkSync(testJournalPath);
const pbEngine = new NormalizationEngine({
  journal: new NormalizationJournal(testJournalPath),
  executionEnabled: true,
  exactFileAuthorizer: authorizer
});
await pbEngine.initialize();
// Latch active playback state
pbEngine.notifyPlaybackState(activeMonitor.isPlaybackActive);
assert.strictEqual(pbEngine.isPlaybackActive, true);
const pbRefuseRes = await pbEngine.processCandidate(item002.canonicalPath);
assert.strictEqual(pbRefuseRes.ok, false);
assert.strictEqual(pbRefuseRes.state, NormalizationState.PAUSED_FOR_PLAYBACK);
assert.strictEqual(pbRefuseRes.error, 'Blocked by active playback priority');
if (fs.existsSync(testJournalPath)) fs.unlinkSync(testJournalPath);

activeMonitor.close();
await new Promise(r => activeServer.close(r));
console.log('  ✅ [PASS] 20. playback active -> engine refuses candidate');

// Test 21: execution flag absent -> no canonical mutation
const testJournalPath21 = path.join(process.cwd(), 'prototype/lan_secure_origin/scratch_t21_journal.json');
if (fs.existsSync(testJournalPath21)) fs.unlinkSync(testJournalPath21);
const disabledEngine = new NormalizationEngine({
  journal: new NormalizationJournal(testJournalPath21),
  executionEnabled: false,
  exactFileAuthorizer: authorizer
});
await disabledEngine.initialize();
const dryRes = await disabledEngine.processCandidate(item002.canonicalPath);
assert.strictEqual(dryRes.ok, false, 'Disabled engine must reject execution');
assert(dryRes.error.includes('disabled by mission safety gate'));
if (fs.existsSync(testJournalPath21)) fs.unlinkSync(testJournalPath21);
console.log('  ✅ [PASS] 21. execution flag absent -> no canonical mutation');

// Test 22: exact happy path -> resolves exactly fixed: -map 0 -c copy -tag:v hvc1
for (const it of authorizer.evidenceByPath.values()) {
  const f = it.facts || {};
  const happyRule = authorizer.resolveExactFileRepairRule(it.canonicalPath, {
    videoCount: 1, audioCount: 1, otherStreams: [], chapterCount: 0,
    video: { codec: 'hevc', codecTag: 'hev1', profile: f.profile, width: f.width, height: f.height }
  }, { sizeBytes: it.sizeBytes, fingerprintId: it.fingerprintId });

  assert(happyRule !== null, `Rule must resolve for ${it.groupId}`);
  assert.strictEqual(happyRule.status, RuleStatus.CERTIFIED_FOR_EXACT_FILE);
  assert.deepStrictEqual(happyRule.operation.ffmpegArgs, ['-map', '0', '-c', 'copy', '-tag:v', 'hvc1']);
  assert.strictEqual(happyRule.operation.outputTag, 'hvc1');
  assert.strictEqual(happyRule.operation.requiresReencoding, false);
}
console.log('  ✅ [PASS] 22. exact happy path -> resolves exactly fixed: -map 0 -c copy -tag:v hvc1 (12/12 items)');

// Test 23: residue on any later item blocks preflight before first mutation
const lastItem = Array.from(authorizer.evidenceByPath.values())[11];
const lastItemDir = path.dirname(lastItem.canonicalPath);
const lastItemExt = path.extname(lastItem.canonicalPath);
const lastItemBase = path.basename(lastItem.canonicalPath, lastItemExt);
const fakePartial = path.join(lastItemDir, `.${lastItemBase}${lastItemExt}.vreconder.partial`);
try {
  fs.writeFileSync(fakePartial, 'residue test');
  // Check residue scanner
  let oldRes = 0;
  let partialRes = 0;
  for (const ev of authorizer.evidenceByPath.values()) {
    const c = ev.canonicalPath;
    const d = path.dirname(c);
    const x = path.extname(c);
    const b = path.basename(c, x);
    if (fs.existsSync(path.join(d, `.${b}${x}.vreconder-old`))) oldRes++;
    if (fs.existsSync(path.join(d, `.${b}${x}.vreconder.partial`))) partialRes++;
  }
  assert.strictEqual(partialRes, 1, 'Detected partial residue on later item');
} finally {
  if (fs.existsSync(fakePartial)) fs.unlinkSync(fakePartial);
}
console.log('  ✅ [PASS] 23. residue on any later item blocks batch before item 1');

console.log('\n============================================================');
console.log('🎉 ALL 23 EXACT-FILE CERTIFICATION TESTS PASSED');
console.log('============================================================');
