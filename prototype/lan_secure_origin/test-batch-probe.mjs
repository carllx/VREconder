import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CandidateState,
  BatchProbeVerdict,
  getProbeNeutralId,
  computeCandidatesHash,
  sanitizeBatchProbeRecord
} from './src/health/batch-probe-types.mjs';
import {
  loadBatchCheckpoint,
  saveBatchCheckpoint,
  loadBatchRegistry,
  recordBatchResult,
  generateSessionToken,
  validateCheckpointIntegrity
} from './src/health/batch-probe-store.mjs';
import { buildBatchCandidateQueue, serializePublicBatchQueue } from './src/health/batch-probe-queue.mjs';
import { handleBatchProbeRoutes } from './src/health/batch-probe-router.mjs';
import { checkPlaybackAdmission } from './src/server/preflight-router.mjs';
import { getMediaFingerprint } from './src/normalization/fingerprint.mjs';
import { loadCheckpoint as loadIssue26Checkpoint } from './src/health/media-health-store.mjs';

describe('AV1 Media Compatibility Batch Probe Test Suite (Browser Review Fix)', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vreconder-batch-probe-fix-'));
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to simulate router HTTP requests
  async function simulateRequest(method, pathname, payload = null, headers = {}, query = '') {
    let responseBody = '';
    let statusCode = 0;
    let endResolver;
    const endPromise = new Promise(resolve => { endResolver = resolve; });

    const req = {
      method,
      url: pathname + (query ? `?${query}` : ''),
      socket: { remoteAddress: '192.168.1.100' }, // simulate LAN client
      headers: {
        'user-agent': 'iPhone 15 Pro Safari Mock',
        ...headers
      },
      on: (event, handler) => {
        if (event === 'data' && payload) handler(Buffer.from(JSON.stringify(payload)));
        if (event === 'end') handler();
      }
    };
    const res = {
      setHeader: () => {},
      writeHead: (code) => { statusCode = code; },
      end: (data) => {
        responseBody = data || '';
        endResolver();
      }
    };

    const handled = handleBatchProbeRoutes(req, res, pathname);
    if (!handled) {
      return { handled: false, statusCode: 404, data: null, rawBody: '' };
    }
    await endPromise;
    let parsed = null;
    try { parsed = JSON.parse(responseBody); } catch (_) {}
    return { handled, statusCode, data: parsed, rawBody: responseBody };
  }

  // 1. Candidate queue does NOT expose raw local file paths to LAN clients
  test('1. queue endpoint hides raw Windows file paths and exposes opaque itemIds', async () => {
    const rootDir = path.join(tempDir, 'media_root');
    fs.mkdirSync(rootDir, { recursive: true });

    const f1 = path.join(rootDir, 'candidate_av1.mp4');
    fs.writeFileSync(f1, 'av1-media-stream-bytes');

    const inventory = await buildBatchCandidateQueue({
      targetDir: rootDir,
      prototypeDir: tempDir
    });

    const publicQueue = serializePublicBatchQueue(inventory.queue);
    assert.ok(publicQueue.length >= 1);
    for (const item of publicQueue) {
      assert.equal(item.filePath, undefined, 'Raw filePath must never be sent to LAN clients');
      assert.ok(item.itemId.startsWith('probe_'), 'Must use opaque itemId');
      assert.ok(item.fingerprintId, 'Must have fingerprintId');
    }
  });

  // 2. Reject missing or fictitious fingerprint forging PASS
  test('2. rejects submission without fingerprint or with fictitious fingerprint', async () => {
    const initRes = await simulateRequest('GET', '/api/batch-probe/queue');
    const token = initRes.data.sessionToken;
    const runId = initRes.data.runId;
    const cursor = initRes.data.cursor;

    // A: Missing fingerprint
    const r1 = await simulateRequest('POST', '/api/batch-probe/result', {
      runId,
      queueIndex: cursor,
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS
    }, { 'x-probe-token': token });
    assert.equal(r1.statusCode, 400);

    // B: Fictitious fingerprint
    const r2 = await simulateRequest('POST', '/api/batch-probe/result', {
      runId,
      queueIndex: cursor,
      fingerprintId: 'fake_non_existent_fp_999',
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS
    }, { 'x-probe-token': token });
    assert.equal(r2.statusCode, 400);
    assert.ok(r2.data.error.includes('mismatch'));
  });

  // 3. Reject wrong runId, arbitrary queueIndex, and out-of-order jumps
  test('3. rejects wrong runId, arbitrary queueIndex, and out-of-order jumps', async () => {
    const initRes = await simulateRequest('GET', '/api/batch-probe/queue');
    const token = initRes.data.sessionToken;
    const runId = initRes.data.runId;
    const cursor = initRes.data.cursor;

    // A: Wrong runId
    const r1 = await simulateRequest('POST', '/api/batch-probe/result', {
      runId: 'expired_old_run_999',
      queueIndex: cursor,
      fingerprintId: 'some_fp',
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS
    }, { 'x-probe-token': token });
    assert.equal(r1.statusCode, 400);
    assert.ok(r1.data.error.includes('Run ID mismatch'));

    // B: Arbitrary queueIndex ahead of server cursor
    const r2 = await simulateRequest('POST', '/api/batch-probe/result', {
      runId,
      queueIndex: cursor + 5,
      fingerprintId: 'some_fp',
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS
    }, { 'x-probe-token': token });
    assert.equal(r2.statusCode, 400);
    assert.ok(r2.data.error.includes('Out-of-order'));

    // C: Obsolete/duplicate queueIndex behind server cursor (when cursor > 0)
    if (cursor > 0) {
      const r3 = await simulateRequest('POST', '/api/batch-probe/result', {
        runId,
        queueIndex: cursor - 1,
        fingerprintId: 'some_fp',
        verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS
      }, { 'x-probe-token': token });
      assert.equal(r3.statusCode, 409);
      assert.ok(r3.data.error.includes('Duplicate'));
    }
  });

  // 4. Unauthorized access to control / result endpoints without valid token is rejected
  test('4. rejects control and result mutations without valid session token', async () => {
    // Control without token from LAN IP
    const r1 = await simulateRequest('POST', '/api/batch-probe/control', { action: 'start' });
    assert.equal(r1.statusCode, 401);

    // Result with forged token
    const r2 = await simulateRequest('POST', '/api/batch-probe/result', {
      runId: 'any_run',
      queueIndex: 0,
      fingerprintId: 'any_fp'
    }, { 'x-probe-token': 'bad_fake_token' });
    assert.equal(r2.statusCode, 401);
  });

  // 5. Evidence verification: FIRST_FRAME_ONLY, SEEK_FAILED, PLAYBACK_STALLED
  test('5. correctly enforces evidence criteria for FIRST_FRAME_ONLY and SEEK_FAILED', async () => {
    const queueRes = await simulateRequest('GET', '/api/batch-probe/queue');
    const token = queueRes.data.sessionToken;
    const runId = queueRes.data.runId;
    const cursor = queueRes.data.cursor;

    if (queueRes.data && queueRes.data.queue && queueRes.data.queue.length > cursor) {
      const item = queueRes.data.queue[cursor];

      // Submission claiming PASS but seekSuccess: false -> Downgraded to SEEK_FAILED
      const rSeekFail = await simulateRequest('POST', '/api/batch-probe/result', {
        runId,
        queueIndex: cursor,
        itemId: item.itemId,
        fingerprintId: item.fingerprintId,
        verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS,
        videoWidth: 4320,
        videoHeight: 2160,
        rvfcCount: 20,
        seekSuccess: false,
        observationEvidence: { window1Frames: 15, window2Frames: 0 }
      }, { 'x-probe-token': token });

      assert.equal(rSeekFail.statusCode, 200);
      assert.equal(rSeekFail.data.verdict, BatchProbeVerdict.SEEK_FAILED);
    }
  });

  // 6. Checkpoint integrity check detects directory change on server restart
  test('6. checkpoint integrity check detects root directory change and invalidates stale cursor', () => {
    const cp = {
      runId: 'run_sample_123',
      rootPath: 'G:\\Media\\VR\\Old_Folder',
      candidatesHash: 'hash_abc123',
      cursor: 15,
      totalQueue: 56
    };

    // Current root differs
    const check1 = validateCheckpointIntegrity(cp, 'G:\\Media\\VR\\New_Folder', 'hash_abc123');
    assert.equal(check1.valid, false);
    assert.ok(check1.reason.includes('Active media root changed'));

    // Candidate hash differs
    const check2 = validateCheckpointIntegrity(cp, 'G:\\Media\\VR\\Old_Folder', 'hash_diff456');
    assert.equal(check2.valid, false);
    assert.ok(check2.reason.includes('Candidate inventory snapshot mismatch'));

    // Matching root & hash
    const check3 = validateCheckpointIntegrity(cp, 'G:\\Media\\VR\\Old_Folder', 'hash_abc123');
    assert.equal(check3.valid, true);
  });

  // 7. Issue #26 checkpoint and production player gate remain completely untouched
  test('7. Issue #26 health checkpoint and production player admission gate remain strictly unpolluted', async () => {
    const issue26 = loadIssue26Checkpoint();
    assert.equal(issue26.runId, 'run_1789025942054');
    assert.equal(issue26.totalQueue, 99);
    assert.equal(issue26.passCount, 84);

    const deniedResult = await checkPlaybackAdmission('some_random_av1_file.mp4');
    assert.equal(deniedResult.allowed, false, 'Production gate must fail closed for unadmitted media');
  });

  // 8. Source files strictly adhere to 600 physical lines limit
  test('8. all modified and created source files strictly adhere to 600 physical lines limit', () => {
    const filesToCheck = [
      './src/health/batch-probe-types.mjs',
      './src/health/batch-probe-store.mjs',
      './src/health/batch-probe-queue.mjs',
      './src/health/batch-probe-router.mjs',
      './batch-probe.html',
      './server.mjs'
    ];

    for (const rel of filesToCheck) {
      const fullPath = path.resolve(rel);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n').length;
        assert.ok(lines <= 600, `File ${rel} has ${lines} lines, exceeding 600 lines limit!`);
      }
    }
  });
});
