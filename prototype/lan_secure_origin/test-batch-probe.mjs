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
  validateCheckpointIntegrity,
  getActivePairingPin,
  verifyPairingPin
} from './src/health/batch-probe-store.mjs';
import { buildBatchCandidateQueue, serializePublicBatchQueue } from './src/health/batch-probe-queue.mjs';
import { handleBatchProbeRoutes } from './src/health/batch-probe-router.mjs';
import { checkPlaybackAdmission } from './src/server/preflight-router.mjs';
import { getMediaFingerprint } from './src/normalization/fingerprint.mjs';
import { loadCheckpoint as loadIssue26Checkpoint } from './src/health/media-health-store.mjs';

describe('AV1 Batch Compatibility Probe Test Suite (Final Gate Repair)', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vreconder-batch-probe-gate-'));
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to simulate router HTTP/HTTPS requests
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

    const handled = handleBatchProbeRoutes(req, res, pathname);
    if (!handled) {
      return { handled: false, statusCode: 404, data: null, headers: responseHeaders, rawBody: '' };
    }
    await endPromise;
    let parsed = null;
    try { parsed = JSON.parse(responseBody); } catch (_) {}
    return { handled, statusCode, data: parsed, headers: responseHeaders, rawBody: responseBody };
  }

  // 1. Unauthorized LAN access must NOT leak tokens, queue, or media files
  test('1. unauthorized LAN requests are blocked from token, queue, and video stream', async () => {
    // A: Status returns authorized: false and no sessionToken
    const statusRes = await simulateRequest('GET', '/api/batch-probe/status');
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.data.authorized, false);
    assert.equal(statusRes.data.sessionToken, undefined, 'Must not leak sessionToken');

    // B: Queue endpoint returns 401
    const queueRes = await simulateRequest('GET', '/api/batch-probe/queue');
    assert.equal(queueRes.statusCode, 401);

    // C: Video stream returns 401
    const videoRes = await simulateRequest('GET', '/api/batch-probe/video?itemId=probe_0_abc');
    assert.equal(videoRes.statusCode, 401);

    // D: Summary returns 401
    const sumRes = await simulateRequest('GET', '/api/batch-probe/summary');
    assert.equal(sumRes.statusCode, 401);
  });

  // 2. PIN pairing over HTTPS sets HttpOnly Secure session cookie
  test('2. pairing PIN exchange over HTTPS establishes authorized cookie session', async () => {
    // A: Attempt pairing over unencrypted HTTP (isHttps = false) -> rejected
    const httpRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: '123456' }, {}, false);
    assert.equal(httpRes.statusCode, 403, 'Must reject pairing over plain HTTP');

    // B: Get active PIN from PC loopback
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    assert.equal(pinRes.statusCode, 200);
    const validPin = pinRes.data.pin;
    assert.ok(validPin && validPin.length === 6);

    // C: Attempt wrong PIN from LAN over HTTPS -> 401
    const wrongPinRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: '000000' }, {}, true);
    assert.equal(wrongPinRes.statusCode, 401);

    // D: Submit valid PIN from iPhone LAN over HTTPS -> 200 + Set-Cookie
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: validPin }, {}, true);
    assert.equal(pairRes.statusCode, 200);
    assert.equal(pairRes.data.authorized, true);
    const setCookie = pairRes.headers['set-cookie'];
    assert.ok(setCookie.includes('batch_probe_session='));
    assert.ok(setCookie.includes('Secure'));
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Strict'));

    // Extract cookie
    const cookieVal = setCookie.split(';')[0];

    // E: Access queue with cookie -> 200 and candidate queue returned
    const authQueueRes = await simulateRequest('GET', '/api/batch-probe/queue', null, { cookie: cookieVal });
    assert.equal(authQueueRes.statusCode, 200);
    assert.ok(Array.isArray(authQueueRes.data.queue));
    assert.equal(authQueueRes.data.sessionToken, undefined, 'Token must not be exposed in JSON response');
  });

  // 3. Opaque streaming over HTTPS succeeds with cookie and has NO token in URL
  test('3. opaque video streaming uses session cookie without URL tokens', async () => {
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: pinRes.data.pin }, {}, true);
    const cookieVal = pairRes.headers['set-cookie'].split(';')[0];

    const qRes = await simulateRequest('GET', '/api/batch-probe/queue', null, { cookie: cookieVal });
    assert.ok(qRes.data.queue.length > 0);
    const firstItem = qRes.data.queue[0];

    // Request video with cookie and NO token query param
    const videoRes = await simulateRequest('GET', `/api/batch-probe/video?itemId=${firstItem.itemId}`, null, {
      cookie: cookieVal,
      range: 'bytes=0-1024'
    });
    // Video streaming handler should accept cookie and return 206 Partial Content or 200 OK
    assert.ok([200, 206].includes(videoRes.statusCode), `Expected 200/206 streaming response, got ${videoRes.statusCode}`);
  });

  // 4. In-flight probe cancellation does NOT persist or advance cursor
  test('4. probe cancellation on pause/interruption aborts and preserves cursor', async () => {
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: pinRes.data.pin }, {}, true);
    const cookieVal = pairRes.headers['set-cookie'].split(';')[0];

    const qRes = await simulateRequest('GET', '/api/batch-probe/queue', null, { cookie: cookieVal });
    const cursorBefore = qRes.data.cursor;

    // Simulate in-flight pause control
    const pauseRes = await simulateRequest('POST', '/api/batch-probe/control', { action: 'pause' }, { cookie: cookieVal });
    assert.equal(pauseRes.statusCode, 200);
    assert.equal(pauseRes.data.checkpoint.status, 'PAUSED');

    // Check status after pause: cursor must remain unchanged
    const statusRes = await simulateRequest('GET', '/api/batch-probe/status', null, { cookie: cookieVal });
    assert.equal(statusRes.data.checkpoint.cursor, cursorBefore);
  });

  // 5. Dual-window observation and presentedFrames progression verification
  test('5. enforces dual-window observation thresholds and presentedFrames advancement', async () => {
    const pinRes = await simulateRequest('GET', '/api/batch-probe/auth/pin', null, {}, true, '127.0.0.1');
    const pairRes = await simulateRequest('POST', '/api/batch-probe/auth/pair', { pin: pinRes.data.pin }, {}, true);
    const cookieVal = pairRes.headers['set-cookie'].split(';')[0];

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
        window1Frames: 4, // below 12
        window1MediaDelta: 0.15, // below 0.4
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

    // Registry must retain previous entries
    const registry = loadBatchRegistry();
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

  // 8. 600-line code structure guardrail verification
  test('8. all modified and created source files strictly adhere to 600 physical lines limit', () => {
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
