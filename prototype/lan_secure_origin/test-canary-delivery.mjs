import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== RUNNING CANARY DELIVERY & VERIFICATION SUITE ===\n');

// 1. Setup DOM mocks for importing controller modules
const domElements = {};
const mockElement = (id) => {
  if (!domElements[id]) {
    domElements[id] = {
      id,
      textContent: '',
      innerHTML: '',
      className: '',
      value: '0',
      style: {},
      options: [],
      disabled: false,
      classList: {
        toggle: (cls, val) => { domElements[id][cls] = val; },
        contains: (cls) => !!domElements[id][cls]
      },
      addEventListener: () => {},
      removeEventListener: () => {}
    };
  }
  return domElements[id];
};

globalThis.document = {
  getElementById: (id) => mockElement(id),
  body: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {}
};
globalThis.window = {};
globalThis.EventSource = class { constructor() {} };

// Mock server for testing /api/canary-queue
import { handlePreflightRoutes } from './src/server/preflight-router.mjs';

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://127.0.0.1');
  const handled = await handlePreflightRoutes(req, res, urlObj.pathname, __dirname, ['G:\\Media'], () => null);
  if (!handled) {
    res.writeHead(404);
    res.end('Not found');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

try {
  // Test 1: Loopback GET /api/canary-queue returns dynamic ranked queue
  console.log('Test 1: Loopback GET /api/canary-queue');
  const res = await fetch(`http://127.0.0.1:${port}/api/canary-queue`);
  assert.equal(res.status, 200, 'Loopback should return 200');
  const queueData = await res.json();
  assert(queueData.count > 0, 'Queue should return candidates');
  assert(Array.isArray(queueData.topRiskCandidates), 'Should have topRiskCandidates');
  assert(queueData.topRiskCandidates.length <= 10, 'Top risk should have up to 10 candidates');

  // Verify rank ordering: stalls desc, then seekFirstFrameLatMs desc
  const top1 = queueData.topRiskCandidates[0];
  const top2 = queueData.topRiskCandidates[1];
  assert(top1.evidence.stalls >= top2.evidence.stalls, 'Rank 1 stalls >= Rank 2 stalls');
  if (top1.evidence.stalls === top2.evidence.stalls) {
    assert(top1.evidence.seekFirstFrameLatMs >= top2.evidence.seekFirstFrameLatMs, 'Rank 1 seekFF >= Rank 2 seekFF');
  }
  console.log(`  ✅ [PASS] Queue returned ${queueData.count} candidates; Rank 1 fp=${top1.fingerprintId} (stalls=${top1.evidence.stalls}, seekFF=${top1.evidence.seekFirstFrameLatMs}ms, seekApi=${top1.evidence.seekApiLatMs}ms)`);

  // Test 2: Remote LAN IP is blocked with 403
  console.log('\nTest 2: Non-loopback request to /api/canary-queue blocked');
  const mockReq = {
    socket: { remoteAddress: '192.168.1.100' },
    method: 'GET',
    headers: {}
  };
  let blockedStatus = 0;
  let blockedBody = '';
  const mockRes = {
    writeHead: (code) => { blockedStatus = code; },
    end: (str) => { blockedBody = str; }
  };
  const wasHandled = await handlePreflightRoutes(mockReq, mockRes, '/api/canary-queue', __dirname, []);
  assert.equal(wasHandled, true, 'Handler should handle route');
  assert.equal(blockedStatus, 403, 'Non-loopback must receive 403');
  console.log('  ✅ [PASS] Remote LAN IP blocked with 403 Forbidden');

  // Test 3: Import canary controller and test 5-stage state machine
  console.log('\nTest 3: 5-Stage Verification State Machine');
  globalThis.fetch = async (url) => {
    if (url === '/api/canary-queue') return { ok: true, json: async () => queueData };
    if (url === '/api/provisional-admissions') return { ok: true, json: async () => ({ admissions: [] }) };
    return { ok: true, json: async () => ({}) };
  };

  const canaryCtrl = await import('./src/controls/canary-test-controller.js');
  await canaryCtrl.loadCanaryQueue();
  await canaryCtrl.refreshCanaryAdmissions();

  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.IDLE);

  // 3a. 1-Click Top Risk Select
  canaryCtrl.selectTopRiskCanary();
  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.TARGET_SELECTED);
  assert.equal(canaryCtrl.currentTargetCandidate.rank, 1);
  console.log('  ✅ [PASS] Stage 1 (TARGET_SELECTED): Candidate #1 selected via 1-click');

  // 3b. Mismatched mediaPath does NOT advance stage
  canaryCtrl.handleCanaryTelemetry({ mediaPath: 'some_other_video.mp4' });
  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.TARGET_SELECTED, 'Mismatched video must NOT advance stage');

  // 3c. Matching mediaPath advances to IPHONE_MEDIA_PATH_MATCH (NOT verified!)
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    playback: { readyState: 0, networkState: 1 }
  });
  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.IPHONE_MEDIA_PATH_MATCH);
  console.log('  ✅ [PASS] Stage 2 (IPHONE_MEDIA_PATH_MATCH): Path matched, verified NOT marked as pass');

  // 3d. Unadmitted file blocked by gate
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    mediaStatus: 'POLICY_BLOCKED',
    playback: { networkState: 3 }
  });
  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.BLOCKED_FAIL_CLOSED);
  console.log('  ✅ [PASS] Unadmitted file correctly transitions to BLOCKED_FAIL_CLOSED (403)');

  // 3e. Admitted file progresses: STREAM_206 -> FIRST_FRAME_PRESENTED -> PLAYBACK_ADVANCING
  canaryCtrl.activeAdmissions.add(canaryCtrl.currentTargetCandidate.fingerprintId);
  canaryCtrl.selectCanary(canaryCtrl.currentTargetCandidate.id); // re-select
  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.TARGET_SELECTED);

  // Media match + 206 readyState
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    playback: { readyState: 2, networkState: 2, paused: false }
  });
  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.STREAM_206);
  console.log('  ✅ [PASS] Stage 3 (STREAM_206): ReadyState 2 promotes to STREAM_206');

  // First frame presented
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 0.1,
    perf: { firstFrameTiming: { firstRenderAt: 120 } },
    playback: { readyState: 4, networkState: 2, paused: false }
  });
  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.FIRST_FRAME_PRESENTED);
  console.log('  ✅ [PASS] Stage 4 (FIRST_FRAME_PRESENTED): Decoded first frame promotes to FIRST_FRAME_PRESENTED');

  // Playback advancing
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 0.5,
    playback: { readyState: 4, paused: false }
  });
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 1.0,
    playback: { readyState: 4, paused: false }
  });
  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.PLAYBACK_ADVANCING);
  console.log('  ✅ [PASS] Stage 5 (PLAYBACK_ADVANCING): Increasing currentTime promotes to PLAYBACK_ADVANCING');

  // Test 4: Auto-advance to next Canary
  console.log('\nTest 4: Auto-advance to Next Canary Candidate');
  canaryCtrl.advanceNextCanary();
  assert.equal(canaryCtrl.currentTargetCandidate.rank, 2, 'advanceNextCanary should step to Rank 2');
  assert.equal(canaryCtrl.currentVerificationStage, canaryCtrl.VerificationStage.TARGET_SELECTED);
  console.log('  ✅ [PASS] Auto-advance stepped to Rank 2 candidate');

  // Test 5: Source Code Privacy Guardrail
  console.log('\nTest 5: Privacy Guardrail - No hardcoded private names in client source');
  const ctrlJs = fs.readFileSync(path.join(__dirname, 'src', 'controls', 'canary-test-controller.js'), 'utf8');
  assert(!ctrlJs.includes('Keely Rose'), 'canary-test-controller.js must not contain private video titles');
  assert(!ctrlJs.includes('Shishido Riho'), 'canary-test-controller.js must not contain private video titles');
  assert(!ctrlJs.includes('G:\\'), 'canary-test-controller.js must not contain absolute paths');
  console.log('  ✅ [PASS] Zero private filenames or absolute paths in tracked controller code');

  console.log('\nCANARY DELIVERY SUITE: ✅ ALL PASSED');
} finally {
  server.close();
}
process.exit(0);
