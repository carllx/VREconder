import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== RUNNING RIGOROUS CANARY DELIVERY & TELEMETRY REGRESSION SUITE ===\n');

// 1. DOM Mocks for importing controller modules in Node
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

// 2. Setup mock server for /api/canary-queue
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
  console.log('Test 1: Loopback GET /api/canary-queue & Risk Ordering');
  const res = await fetch(`http://127.0.0.1:${port}/api/canary-queue`);
  assert.equal(res.status, 200, 'Loopback should return 200');
  const queueData = await res.json();
  assert(queueData.count > 0, 'Queue should return candidates');
  assert(Array.isArray(queueData.topRiskCandidates), 'Should have topRiskCandidates');

  const top1 = queueData.topRiskCandidates[0];
  const top2 = queueData.topRiskCandidates[1];
  assert(top1.evidence.stalls >= top2.evidence.stalls, 'Rank 1 stalls >= Rank 2 stalls');
  if (top1.evidence.stalls === top2.evidence.stalls) {
    assert(top1.evidence.seekFirstFrameLatMs >= top2.evidence.seekFirstFrameLatMs, 'Rank 1 seekFF >= Rank 2 seekFF');
  }
  console.log(`  ✅ [PASS] Queue returned ${queueData.count} candidates; Rank 1 fp=${top1.fingerprintId} (stalls=${top1.evidence.stalls}, seekFF=${top1.evidence.seekFirstFrameLatMs}ms, seekApi=${top1.evidence.seekApiLatMs}ms)`);

  // Test 2: Non-loopback request is blocked with 403 Forbidden
  console.log('\nTest 2: Non-loopback request to /api/canary-queue blocked');
  const mockReq = { socket: { remoteAddress: '192.168.1.100' }, method: 'GET', headers: {} };
  let blockedStatus = 0;
  const mockRes = { writeHead: (code) => { blockedStatus = code; }, end: () => {} };
  await handlePreflightRoutes(mockReq, mockRes, '/api/canary-queue', __dirname, []);
  assert.equal(blockedStatus, 403, 'Non-loopback must receive 403');
  console.log('  ✅ [PASS] Remote LAN IP blocked with 403 Forbidden');

  // Load controller
  globalThis.fetch = async (url) => {
    if (url === '/api/canary-queue') return { ok: true, json: async () => queueData };
    if (url === '/api/provisional-admissions') return { ok: true, json: async () => ({ admissions: [] }) };
    return { ok: true, json: async () => ({}) };
  };

  const canaryCtrl = await import('./src/controls/canary-test-controller.js');
  await canaryCtrl.loadCanaryQueue();
  await canaryCtrl.refreshCanaryAdmissions();
  const stages = canaryCtrl.VerificationStage;

  // Test 3: Exact Path Matching (No substring false positives)
  console.log('\nTest 3: Exact Path Matching Guardrail');
  canaryCtrl.selectTopRiskCanary();
  assert.equal(canaryCtrl.currentVerificationStage, stages.TARGET_SELECTED);

  // Substring / different file does NOT match
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName + '.bak',
    perf: { playback: { readyState: 4 } }
  }, { state: 'active', ageMs: 100 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.TARGET_SELECTED, 'Substring match must NOT advance stage');
  console.log('  ✅ [PASS] Substring filename does not advance verification stage');

  // Test 4: Regression Case A - Unadmitted file cannot pass (fail-closed)
  console.log('\nTest 4: Regression Case A - Unadmitted file blocked (Fail-Closed)');
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    mediaStatus: 'POLICY_BLOCKED',
    perf: { playback: { networkState: 3 } }
  }, { state: 'active', ageMs: 100 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.BLOCKED_FAIL_CLOSED);
  console.log('  ✅ [PASS] Unadmitted video correctly blocked in BLOCKED_FAIL_CLOSED');

  // Test 5: Regression Case B - No actual decoded frames cannot pass
  console.log('\nTest 5: Regression Case B - No decoded frames cannot advance past BUFFER_ATTACHED');
  canaryCtrl.activeAdmissions.add(canaryCtrl.currentTargetCandidate.fingerprintId);
  canaryCtrl.selectCanary(canaryCtrl.currentTargetCandidate.id); // re-select candidate

  // Buffer attached (readyState 2) but zero frame progression
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 0,
    timings: { firstRenderAt: 0, selectedAt: 100 },
    perf: {
      cadence: { videoUploadsPerSec: 0, rvfcPerSec: 0 },
      playback: { readyState: 2, networkState: 2, quality: { totalVideoFrames: 0 } }
    }
  }, { state: 'active', ageMs: 100 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.BUFFER_ATTACHED);
  console.log('  ✅ [PASS] Buffer attached but zero frames halts at BUFFER_ATTACHED (no false PASS)');

  // Test 6: Regression Case C - Old frame evidence from previous video cannot be reused
  console.log('\nTest 6: Regression Case C - Old frame evidence cannot be reused after switching media');
  // First video had 5000 frames rendered in previous playback
  canaryCtrl.selectTopRiskCanary(); // re-selects candidate #1, resets baseline
  assert.equal(canaryCtrl.currentVerificationStage, stages.TARGET_SELECTED);

  // iPhone arrives with stale frame count of 5000 from previous video, but 0 new uploads
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 0.0,
    timings: { firstRenderAt: 1000, selectedAt: 900 },
    perf: {
      cadence: { videoUploadsPerSec: 0, rvfcPerSec: 0 },
      playback: { readyState: 2, quality: { totalVideoFrames: 5000 } }
    }
  }, { state: 'active', ageMs: 100 });
  // Baseline captures totalVideoFrames: 5000, firstRenderAt: 1000
  // Second telemetry still has totalVideoFrames: 5000 and firstRenderAt: 1000
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 0.0,
    timings: { firstRenderAt: 1000, selectedAt: 900 },
    perf: {
      cadence: { videoUploadsPerSec: 0, rvfcPerSec: 0 },
      playback: { readyState: 2, quality: { totalVideoFrames: 5000 } }
    }
  }, { state: 'active', ageMs: 100 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.BUFFER_ATTACHED, 'Old 5000 frames must NOT trigger FIRST_FRAME_PRESENTED');

  // When actual new frame is delivered (totalVideoFrames: 5001 or videoUploadsPerSec > 0):
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 0.05,
    timings: { firstRenderAt: 1050, selectedAt: 900 },
    perf: {
      cadence: { videoUploadsPerSec: 60, rvfcPerSec: 60 },
      playback: { readyState: 4, quality: { totalVideoFrames: 5001 } }
    }
  }, { state: 'active', ageMs: 100 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.FIRST_FRAME_PRESENTED);
  console.log('  ✅ [PASS] Previous video 5000 frames rejected; only fresh frame 5001 promoted stage');

  // Test 7: Regression Case D - Time advancing without WebGL texture upload cannot be marked VR Pass
  console.log('\nTest 7: Regression Case D - Audio/time advancing without GPU texture upload detected');
  // Telemetry advances time, but videoUploadsPerSec = 0 and rvfcPerSec = 0
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 1.0,
    inVR: true,
    perf: {
      cadence: { videoUploadsPerSec: 0, rvfcPerSec: 0 },
      playback: { paused: false, readyState: 4 }
    }
  }, { state: 'active', ageMs: 100 });
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 2.0,
    inVR: true,
    perf: {
      cadence: { videoUploadsPerSec: 0, rvfcPerSec: 0 },
      playback: { paused: false, readyState: 4 }
    }
  }, { state: 'active', ageMs: 100 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.TEXTURE_UPLOAD_STALLED);
  console.log('  ✅ [PASS] Time advancing without GPU texture upload correctly halts at TEXTURE_UPLOAD_STALLED');

  // When videoUploads > 0, rvfc > 0, but inVR is false:
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 3.0,
    inVR: false, // User has NOT entered VR mode
    perf: {
      cadence: { videoUploadsPerSec: 60, rvfcPerSec: 60 },
      playback: { paused: false, readyState: 4 },
      webgl: { glError: 'NO_ERROR', contextLostCount: 0 }
    }
  }, { state: 'active', ageMs: 100 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.FLAT_PLAYBACK_ACTIVE);
  console.log('  ✅ [PASS] Rendering frames in 2D mode identified as FLAT_PLAYBACK_ACTIVE (not false VR Pass)');

  // When inVR is true and rendering:
  canaryCtrl.handleCanaryTelemetry({
    mediaPath: canaryCtrl.currentTargetCandidate.fileName,
    currentTime: 4.0,
    inVR: true, // User enters VR stereo mode!
    perf: {
      cadence: { videoUploadsPerSec: 60, rvfcPerSec: 60 },
      playback: { paused: false, readyState: 4 },
      webgl: { glError: 'NO_ERROR', contextLostCount: 0 }
    }
  }, { state: 'active', ageMs: 100 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.VR_PLAYBACK_ACTIVE);
  console.log('  ✅ [PASS] In-VR stereo active rendering verified as VR_PLAYBACK_ACTIVE');

  // Test 8: Regression Case E - iPhone offline or telemetry stale drops verified state
  console.log('\nTest 8: Regression Case E - Offline / Stale Telemetry drops Verified state');
  // Stale (>3000ms)
  canaryCtrl.handleCanaryTelemetry(null, { state: 'stale', ageMs: 4500 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.TELEMETRY_STALE);
  console.log('  ✅ [PASS] Telemetry age > 3000ms immediately downgrades to TELEMETRY_STALE');

  // Offline
  canaryCtrl.handleCanaryTelemetry(null, { state: 'offline', ageMs: 10000 });
  assert.equal(canaryCtrl.currentVerificationStage, stages.IPHONE_OFFLINE);
  console.log('  ✅ [PASS] Disconnected iPhone immediately downgrades to IPHONE_OFFLINE');

  // Test 9: Privacy Guardrail
  console.log('\nTest 9: Privacy Guardrail in git-tracked code');
  const ctrlJs = fs.readFileSync(path.join(__dirname, 'src', 'controls', 'canary-test-controller.js'), 'utf8');
  assert(!ctrlJs.includes('Keely Rose'), 'No private titles in canary-test-controller.js');
  assert(!ctrlJs.includes('G:\\'), 'No absolute paths in canary-test-controller.js');
  console.log('  ✅ [PASS] Zero private titles or absolute paths in client source code');

  console.log('\nCANARY DELIVERY REGRESSION SUITE: ✅ ALL 9/9 SUITES PASSED');
} finally {
  server.close();
}
process.exit(0);
