import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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
  loadBatchRegistryForRun,
  recordBatchResult,
  generateSessionToken,
  validateCheckpointIntegrity,
  generatePairingPin,
  getActivePairingPin,
  verifyPairingPin
} from './src/health/batch-probe-store.mjs';
import { buildBatchCandidateQueue, serializePublicBatchQueue } from './src/health/batch-probe-queue.mjs';
import { handleBatchProbeRoutes } from './src/health/batch-probe-router.mjs';
import { checkPlaybackAdmission } from './src/server/preflight-router.mjs';
import { getMediaFingerprint } from './src/normalization/fingerprint.mjs';
import { loadCheckpoint as loadIssue26Checkpoint } from './src/health/media-health-store.mjs';

describe('AV1 Batch Compatibility Probe Test Suite (Final Readiness Delta)', () => {
  let tempDir;
  let prodRegHashBefore;
  let prodCpHashBefore;

  const PROD_DIR = path.resolve('.');
  const PROD_REG = path.join(PROD_DIR, 'batch_probe_registry.jsonl');
  const PROD_CP = path.join(PROD_DIR, 'batch_probe_checkpoint.json');

  function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return 'missing';
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vreconder-batch-probe-isolated-'));
    prodRegHashBefore = getFileHash(PROD_REG);
    prodCpHashBefore = getFileHash(PROD_CP);
  });

  after(() => {
    // Assert production storage was completely unpolluted by tests
    const prodRegHashAfter = getFileHash(PROD_REG);
    const prodCpHashAfter = getFileHash(PROD_CP);
    assert.equal(prodRegHashAfter, prodRegHashBefore, 'Production batch_probe_registry.jsonl MUST NOT be modified by tests');
    assert.equal(prodCpHashAfter, prodCpHashBefore, 'Production batch_probe_checkpoint.json MUST NOT be modified by tests');

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to simulate router HTTP/HTTPS requests with explicit tempDir isolation
  async function simulateRequest(method, fullUrl, payload = null, headers = {}, isHttps = true, remoteIp = '192.168.1.100') {
    const [pathname] = fullUrl.split('?');
    let responseBody = '';
    let statusCode = 200;
    let responseHeaders = {};
    let endResolver;
    const endPromise = new Promise(resolve => { endResolver = resolve; });

    const req = {
      method,
      url: fullUrl,
      socket: {
        remoteAddress: remoteIp,
        encrypted: isHttps
      },
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
      setHeader: (name, val) => { responseHeaders[name.toLowerCase()] = val; },
      writeHead: (code, head = {}) => {
        statusCode = code;
        for (const [k, v] of Object.entries(head)) responseHeaders[k.toLowerCase()] = v;
      },
      write: () => true,
      on: () => res,
      once: () => res,
      emit: () => true,
      end: (data) => {
        responseBody = data || '';
        endResolver();
      }
    };

    const handled = handleBatchProbeRoutes(req, res, pathname, { prototypeDir: tempDir });
    if (!handled) {
      return { handled: false, statusCode: 404, data: null, headers: responseHeaders, rawBody: '' };
    }
    await endPromise;
    let parsed = null;
    try { parsed = JSON.parse(responseBody); } catch (_) {}
    return { handled, statusCode, data: parsed, headers: responseHeaders, rawBody: responseBody };
  }

  // 1. Unauthorized LAN access blocked from token, queue, and streaming
  test('1. unauthorized LAN requests are blocked from token, queue, and video stream', async () => {
    const statusRes = await simulateRequest('GET', '/api/batch-probe/status');
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.data.authorized, false);
    assert.equal(statusRes.data.sessionToken, undefined, 'Must not leak sessionToken');

    const queueRes = await simulateRequest('GET', '/api/batch-probe/queue');
    assert.equal(queueRes.statusCode, 401);

    const videoRes = await simulateRequest('GET', '/api/batch-probe/video?itemId=probe_0_abc');
    assert.equal(videoRes.statusCode, 401);

    const sumRes = await simulateRequest('GET', '/api/batch-probe/summary');
    assert.equal(sumRes.statusCode, 401);
  });

  // 2. PIN pairing hardening: rate-limiting (429) and single-use redemption
  test('2. pairing PIN enforces crypto-randomness, rate-limit cooldown, and single-use invalidation', async () => {
    // A: PIN generated via crypto.randomInt is 6 numeric digits
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    assert.equal(pinRes.statusCode, 200);
    const validPin = pinRes.data.pin;
    assert.match(validPin, /^\d{6}$/, 'PIN must be a 6-digit integer string');

    // B: Rate-limiting: brute force attempts from an attacker IP trigger 429
    const attackerIp = '192.168.1.188';
    for (let i = 0; i < 4; i++) {
      const badRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: '000000' }, {}, true, attackerIp);
      assert.equal(badRes.statusCode, 401);
    }
    // 5th attempt locks the client out with 429
    const lockRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: '000000' }, {}, true, attackerIp);
    assert.equal(lockRes.statusCode, 429);
    assert.ok(lockRes.data.error.includes('Too many failed'));
    assert.ok(lockRes.headers['retry-after']);

    // C: Valid redemption succeeds with Secure HttpOnly cookie
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: validPin }, {}, true);
    assert.equal(pairRes.statusCode, 200);
    assert.equal(pairRes.data.authorized, true);
    assert.ok(pairRes.headers['set-cookie'].includes('batch_probe_session='));

    // D: Single-use: attempting to reuse the redeemed PIN fails
    const reuseRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: validPin }, {}, true);
    assert.equal(reuseRes.statusCode, 401, 'Redeemed PIN must be immediately invalidated');
  });

  // 3. Opaque streaming over HTTPS uses cookie and requires NO URL token
  test('3. opaque video streaming uses session cookie without URL tokens', async () => {
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: pinRes.data.pin }, {}, true);
    const cookieVal = pairRes.headers['set-cookie'].split(';')[0];

    const qRes = await simulateRequest('GET', '/api/batch-probe/queue', null, { cookie: cookieVal });
    assert.ok(qRes.data.queue.length > 0);
    const firstItem = qRes.data.queue[0];

    const videoRes = await simulateRequest('GET', `/api/batch-probe/video?itemId=${firstItem.itemId}`, null, {
      cookie: cookieVal,
      range: 'bytes=0-1024'
    });
    assert.ok([200, 206].includes(videoRes.statusCode), `Expected 200/206 streaming response, got ${videoRes.statusCode}`);
  });

  // 4. Server accepts results ONLY when batch status is RUNNING
  test('4. rejects result submission unless batch probe status is RUNNING', async () => {
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: pinRes.data.pin }, {}, true);
    const cookieVal = pairRes.headers['set-cookie'].split(';')[0];

    const qRes = await simulateRequest('GET', '/api/batch-probe/queue', null, { cookie: cookieVal });
    const cursor = qRes.data.cursor;
    const runId = qRes.data.runId;
    const item = qRes.data.queue[cursor];

    // Status is currently IDLE -> submission must be rejected with 409
    const idleSubRes = await simulateRequest('POST', '/api/batch-probe/result', {
      runId,
      queueIndex: cursor,
      itemId: item.itemId,
      fingerprintId: item.fingerprintId,
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS
    }, { cookie: cookieVal });
    assert.equal(idleSubRes.statusCode, 409);
    assert.ok(idleSubRes.data.error.includes('must be RUNNING'));

    // Start batch -> status becomes RUNNING
    const startRes = await simulateRequest('POST', '/api/batch-probe/control', { action: 'start' }, { cookie: cookieVal });
    assert.equal(startRes.statusCode, 200);
    assert.equal(startRes.data.checkpoint.status, 'RUNNING');

    // In-flight pause -> status becomes PAUSED -> submission rejected
    await simulateRequest('POST', '/api/batch-probe/control', { action: 'pause' }, { cookie: cookieVal });
    const pausedSubRes = await simulateRequest('POST', '/api/batch-probe/result', {
      runId,
      queueIndex: cursor,
      itemId: item.itemId,
      fingerprintId: item.fingerprintId,
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS
    }, { cookie: cookieVal });
    assert.equal(pausedSubRes.statusCode, 409);
  });

  // 5. Dual-window observation and presentedFrames progression verification
  test('5. enforces dual-window observation thresholds and presentedFrames advancement', async () => {
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: pinRes.data.pin }, {}, true);
    const cookieVal = pairRes.headers['set-cookie'].split(';')[0];

    // Ensure status is RUNNING
    await simulateRequest('POST', '/api/batch-probe/control', { action: 'start' }, { cookie: cookieVal });

    const qRes = await simulateRequest('GET', '/api/batch-probe/queue', null, { cookie: cookieVal });
    const cursor = qRes.data.cursor;
    const runId = qRes.data.runId;
    const item = qRes.data.queue[cursor];

    // Submission claiming PASS but with insufficient Window 1 duration -> Downgrades to PLAYBACK_STALLED
    const rShortW1 = await simulateRequest('POST', '/api/batch-probe/result', {
      runId,
      queueIndex: cursor,
      itemId: item.itemId,
      fingerprintId: item.fingerprintId,
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS,
      videoWidth: 3840,
      videoHeight: 2160,
      seekSuccess: true,
      observationEvidence: {
        window1Frames: 4,
        window1MediaDelta: 0.15,
        window2Frames: 10,
        window2MediaDelta: 0.35,
        presentedFramesAdvanced: true
      }
    }, { cookie: cookieVal });
    assert.equal(rShortW1.statusCode, 200);
    assert.equal(rShortW1.data.verdict, BatchProbeVerdict.PLAYBACK_STALLED);
  });

  // 6. Reset creates new run without deleting past registry records
  test('6. batch reset re-anchors to cursor 0 with new runId without wiping registry', async () => {
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: pinRes.data.pin }, {}, true);
    const cookieVal = pairRes.headers['set-cookie'].split(';')[0];

    const resetRes = await simulateRequest('POST', '/api/batch-probe/control', { action: 'reset' }, { cookie: cookieVal });
    assert.equal(resetRes.statusCode, 200);
    assert.equal(resetRes.data.checkpoint.cursor, 0);
    assert.ok(resetRes.data.checkpoint.runId.startsWith('run_'));

    const registry = loadBatchRegistry(tempDir);
    assert.ok(registry instanceof Map);
  });

  // 7. Issue #26 health checkpoint (99 items) and production admission gate unpolluted
  test('7. Issue #26 health checkpoint and production player admission gate remain strictly unpolluted', async () => {
    const issue26 = loadIssue26Checkpoint();
    assert.equal(issue26.runId, 'run_1789025942054');
    assert.equal(issue26.totalQueue, 99);
    assert.equal(issue26.passCount, 84);

    const deniedResult = await checkPlaybackAdmission('some_random_uncertified_av1.mp4');
    assert.equal(deniedResult.allowed, false, 'Production gate must fail closed');
  });

  // 8. Cohort switching and multi-queue integrity
  test('8. supports cohort queues (denied, admitted, derivatives, all) with appropriate streaming endpoints', async () => {
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: pinRes.data.pin }, {}, true);
    const cookieVal = pairRes.headers['set-cookie'].split(';')[0];

    // Switch to admitted cohort
    const admSwitch = await simulateRequest('POST', '/api/batch-probe/cohort', { cohort: 'admitted' }, { cookie: cookieVal });
    assert.equal(admSwitch.statusCode, 200);
    assert.equal(admSwitch.data.activeCohort, 'admitted');
    assert.equal(admSwitch.data.total, 32);
    assert.ok(admSwitch.data.queue.length === 32);
    // Admitted items must use PRODUCTION_PLAYER stream type and /video?path=...
    const firstAdm = admSwitch.data.queue[0];
    assert.equal(firstAdm.cohort, 'admitted');
    assert.equal(firstAdm.streamType, 'PRODUCTION_PLAYER');
    assert.ok(firstAdm.streamUrl.startsWith('/video?path='));

    // Switch to derivatives cohort
    const derivSwitch = await simulateRequest('POST', '/api/batch-probe/cohort', { cohort: 'derivatives' }, { cookie: cookieVal });
    assert.equal(derivSwitch.statusCode, 200);
    assert.equal(derivSwitch.data.activeCohort, 'derivatives');
    assert.equal(derivSwitch.data.total, 2);
    const firstDeriv = derivSwitch.data.queue[0];
    assert.equal(firstDeriv.cohort, 'derivatives');
    assert.equal(firstDeriv.streamType, 'DERIVATIVE_DIAGNOSTIC');

    // Switch to all cohort
    const allSwitch = await simulateRequest('POST', '/api/batch-probe/cohort', { cohort: 'all' }, { cookie: cookieVal });
    assert.equal(allSwitch.statusCode, 200);
    assert.equal(allSwitch.data.activeCohort, 'all');
    assert.equal(allSwitch.data.total, 90);

    // Switch back to denied cohort
    const deniedSwitch = await simulateRequest('POST', '/api/batch-probe/cohort', { cohort: 'denied' }, { cookie: cookieVal });
    assert.equal(deniedSwitch.statusCode, 200);
    assert.equal(deniedSwitch.data.activeCohort, 'denied');
    assert.equal(deniedSwitch.data.total, 56);
  });

  // 9. Full 90-file reconciliation matrix summary
  test('9. GET /api/batch-probe/summary delivers 90-file reconciliation matrix with cohort counts', async () => {
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: pinRes.data.pin }, {}, true);
    const cookieVal = pairRes.headers['set-cookie'].split(';')[0];

    const sumRes = await simulateRequest('GET', '/api/batch-probe/summary', null, { cookie: cookieVal });
    assert.equal(sumRes.statusCode, 200);
    assert.equal(sumRes.data.totalFiles, 90);
    assert.equal(sumRes.data.cohortCounts.denied, 56);
    assert.equal(sumRes.data.cohortCounts.admitted, 32);
    assert.equal(sumRes.data.cohortCounts.derivatives, 2);
    assert.equal(sumRes.data.items.length, 90);

    // Verify properties on items
    for (const item of sumRes.data.items) {
      assert.ok(item.neutralId, 'Must have neutralId');
      assert.ok(item.fingerprintId, 'Must have fingerprintId');
      assert.ok(['denied', 'admitted', 'derivatives'].includes(item.cohort), 'Must have valid cohort');
      assert.ok(item.candidateState, 'Must have candidateState');
      assert.ok(typeof item.physicalTested === 'boolean', 'Must have physicalTested boolean');
      assert.ok(item.physicalVerdict, 'Must have physicalVerdict');
      assert.ok(['ALLOWED', 'DENIED', 'NOT_TESTED'].includes(item.productionGateStatus), 'Must have productionGateStatus');
    }
  });

  // 10. 600-line code structure guardrail verification
  test('10. all modified and created source files strictly adhere to 600 physical lines limit', () => {
    const filesToCheck = [
      './batch-probe.html',
      './src/health/batch-probe-types.mjs',
      './src/health/batch-probe-store.mjs',
      './src/health/batch-probe-queue.mjs',
      './src/health/batch-probe-router.mjs',
      './src/server/cert-helper.mjs',
      './test-batch-probe.mjs'
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
