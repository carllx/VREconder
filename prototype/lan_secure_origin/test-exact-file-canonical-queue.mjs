import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildExact12CanonicalQueue,
  handleMediaHealthRoutes,
  EXACT12_CANONICAL_RESULTS_FILE
} from './src/health/media-health-router.mjs';
import {
  AUTHORIZED_EXACT_FILE_GROUP_IDS,
  EXCLUDED_EXACT_FILE_GROUP_IDS,
  FROZEN_MANIFEST_SHA256,
  FROZEN_RESULTS_SHA256,
  computeFileSha256
} from './src/normalization/exact-file-authorizer.mjs';
import { AUTHORITATIVE_HEALTH_ROOTS } from './src/health/media-health-types.mjs';
import { getMediaFingerprint } from './src/normalization/fingerprint.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOTYPE_DIR = __dirname;

console.log('============================================================');
console.log('🧪 RUNNING EXACT-12 CANONICAL QUEUE & VERIFICATION RUNNER TESTS');
console.log('============================================================');

// 1. Frozen evidence integrity
const manifestPath = path.join(PROTOTYPE_DIR, 'canonical_repair_manifest.json');
const resultsPath = path.join(PROTOTYPE_DIR, 'canonical_repair_probe_results.jsonl');

assert.strictEqual(
  computeFileSha256(manifestPath),
  FROZEN_MANIFEST_SHA256,
  'canonical_repair_manifest.json must strictly match FROZEN_MANIFEST_SHA256'
);
console.log('  ✅ [PASS] 1. Frozen manifest SHA-256 strictly preserved');

assert.strictEqual(
  computeFileSha256(resultsPath),
  FROZEN_RESULTS_SHA256,
  'canonical_repair_probe_results.jsonl must strictly match FROZEN_RESULTS_SHA256'
);
console.log('  ✅ [PASS] 2. Frozen results SHA-256 strictly preserved');

// 2. Queue builds successfully and contains exactly 12 items
const queue = buildExact12CanonicalQueue(PROTOTYPE_DIR);
assert.strictEqual(queue.length, 12, 'Canonical queue length must be exactly 12');
console.log('  ✅ [PASS] 3. Canonical queue length is strictly 12');

// 3. Queue includes all 12 authorized IDs and strictly excludes 001, 012, 015
const queueGroupIds = queue.map(item => item.groupId);
assert.deepStrictEqual(
  queueGroupIds,
  [...AUTHORIZED_EXACT_FILE_GROUP_IDS],
  'Queue groupIds must strictly match AUTHORIZED_EXACT_FILE_GROUP_IDS'
);

for (const excludedId of EXCLUDED_EXACT_FILE_GROUP_IDS) {
  assert.strictEqual(queueGroupIds.includes(excludedId), false, 'Queue must NOT include ' + excludedId);
}
console.log('  ✅ [PASS] 4. Queue contains strictly authorized IDs and excludes 001, 012, 015');

// 4. Invariants for every item in queue
const journalPath = path.join(PROTOTYPE_DIR, 'normalization_journal.json');
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const repairProbeRoot = path.normalize('G:\\VREconder_Repair_Probe');

for (const item of queue) {
  // A. item structure
  assert.strictEqual(item.type, 'CANONICAL_REPAIRED_PROBE');
  assert.strictEqual(item.targetTimeoutSec, 15);
  assert.strictEqual(item.expectedResult, 'PASS_VIDEO');

  // B. file path is canonical in G:\Media\VR\... and NOT in G:\VREconder_Repair_Probe
  assert.strictEqual(item.filePath.toLowerCase().startsWith(repairProbeRoot.toLowerCase()), false, item.groupId + ' must not be in repair probe dir');
  const withinAuthRoots = AUTHORITATIVE_HEALTH_ROOTS.some(r => {
    const rel = path.relative(path.normalize(r), item.filePath);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  assert.strictEqual(withinAuthRoots, true, item.groupId + ' must be within authoritative roots');

  // C. Physical file exists
  assert.strictEqual(fs.existsSync(item.filePath), true, 'Physical file must exist: ' + item.filePath);

  // D. Normalization journal entry is DONE
  const jEntry = journal.entries[item.filePath];
  assert.ok(jEntry, 'Journal entry must exist for ' + item.filePath);
  assert.strictEqual(jEntry.currentState, 'DONE', 'Journal state must be DONE for ' + item.groupId);

  // E. Replacement fingerprint matches live file
  const liveFp = getMediaFingerprint(item.filePath);
  assert.ok(liveFp, 'Live fingerprint must be obtainable for ' + item.filePath);
  const expectedFp = jEntry.replacementFingerprint || jEntry.meta?.replacementFingerprint;
  assert.strictEqual(liveFp.sizeBytes, expectedFp.sizeBytes, 'Size mismatch for ' + item.groupId);
  assert.strictEqual(liveFp.mtimeMs, expectedFp.mtimeMs, 'mtime mismatch for ' + item.groupId);
}
console.log('  ✅ [PASS] 5. All 12 items satisfy canonical path, existence, journal DONE, and replacement fingerprint');

// 5. Existing historical endpoints /api/repair/queue and /api/repair/result remain functional and untouched
let resData = null;
let resStatusCode = null;
let resHeaders = {};

function createMockRes() {
  return {
    writeHead(code, headers) {
      resStatusCode = code;
      resHeaders = headers;
    },
    setHeader(k, v) {
      resHeaders[k] = v;
    },
    end(chunk) {
      resData = chunk;
    }
  };
}

// Test GET /api/repair/queue (historical)
let mockReq = { method: 'GET', url: '/api/repair/queue' };
let mockRes = createMockRes();
let handled = handleMediaHealthRoutes(mockReq, mockRes, '/api/repair/queue');
assert.strictEqual(handled, true);
assert.strictEqual(resStatusCode, 200);
const historicalQueue = JSON.parse(resData).queue;
assert.strictEqual(historicalQueue.length, 14, 'Historical queue has 14 items');
console.log('  ✅ [PASS] 6. Historical /api/repair/queue intact (14 items)');

// Test GET /api/repair/canonical-queue
mockReq = { method: 'GET', url: '/api/repair/canonical-queue' };
mockRes = createMockRes();
handled = handleMediaHealthRoutes(mockReq, mockRes, '/api/repair/canonical-queue');
assert.strictEqual(handled, true);
assert.strictEqual(resStatusCode, 200);
const canonicalQueueResp = JSON.parse(resData);
assert.strictEqual(canonicalQueueResp.ok, true);
assert.strictEqual(canonicalQueueResp.queue.length, 12);
console.log('  ✅ [PASS] 7. Dedicated /api/repair/canonical-queue returns 12 items');

// Test POST /api/repair/canonical-result (isolation check)
const testArtifactPath = path.join(PROTOTYPE_DIR, EXACT12_CANONICAL_RESULTS_FILE);
const artifactBefore = fs.existsSync(testArtifactPath) ? fs.readFileSync(testArtifactPath, 'utf8') : null;
const resultsFileBefore = fs.readFileSync(resultsPath, 'utf8');

const testPayload = {
  groupId: 'GRP-INCOMPAT-002',
  type: 'CANONICAL_REPAIRED_PROBE',
  filePath: queue[0].filePath,
  verdict: 'PASS_VIDEO',
  details: { test: true },
  timestamp: new Date().toISOString()
};

mockReq = {
  method: 'POST',
  url: '/api/repair/canonical-result',
  on(event, handler) {
    if (event === 'data') handler(JSON.stringify(testPayload));
    if (event === 'end') handler();
  }
};
mockRes = createMockRes();
handled = handleMediaHealthRoutes(mockReq, mockRes, '/api/repair/canonical-result');
assert.strictEqual(handled, true);
assert.strictEqual(resStatusCode, 200);
assert.strictEqual(JSON.parse(resData).ok, true);

// Verify written to testArtifactPath and NOT to frozen resultsPath
const resultsFileAfter = fs.readFileSync(resultsPath, 'utf8');
assert.strictEqual(resultsFileAfter, resultsFileBefore, 'Frozen results file must NOT be modified');
assert.strictEqual(
  computeFileSha256(resultsPath),
  FROZEN_RESULTS_SHA256,
  'Frozen results file SHA must remain completely intact'
);

const artifactAfter = fs.readFileSync(testArtifactPath, 'utf8');
assert(artifactAfter.includes('"groupId":"GRP-INCOMPAT-002"'), 'Artifact must contain recorded result');

// Restore artifact file to pre-test state
if (artifactBefore === null) {
  fs.unlinkSync(testArtifactPath);
} else {
  fs.writeFileSync(testArtifactPath, artifactBefore, 'utf8');
}
console.log('  ✅ [PASS] 8. Result isolation: written to ignored artifact, frozen results untouched');

// 6. Check runner HTML contains canonical mode logic and references correct endpoints
const htmlPath = path.join(PROTOTYPE_DIR, 'repair-probe-runner.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');
assert(htmlContent.includes('/api/repair/canonical-queue'), 'HTML must reference /api/repair/canonical-queue');
assert(htmlContent.includes('/api/repair/canonical-result'), 'HTML must reference /api/repair/canonical-result');
assert(htmlContent.includes('mode'), 'HTML must inspect mode param');
assert(htmlContent.includes('Exact-12 Canonical Mode'), 'HTML must provide canonical mode title');
console.log('  ✅ [PASS] 9. Runner HTML cleanly integrates canonical mode');

// 7. Verify code structure limits (< 600 physical lines)
const routerFile = path.join(PROTOTYPE_DIR, 'src/health/media-health-router.mjs');
const routerLines = fs.readFileSync(routerFile, 'utf8').split('\n').length;
assert(routerLines < 600, 'media-health-router.mjs exceeds 600 lines: ' + routerLines);

const testLines = fs.readFileSync(__filename, 'utf8').split('\n').length;
assert(testLines < 600, 'test-exact-file-canonical-queue.mjs exceeds 600 lines: ' + testLines);
console.log('  ✅ [PASS] 10. File line limits satisfied (router=' + routerLines + ', test=' + testLines + ' < 600)');

console.log('============================================================');
console.log('🎉 ALL 10 TEST SECTIONS PASSED SUCCESSFULLY!');
console.log('============================================================');
