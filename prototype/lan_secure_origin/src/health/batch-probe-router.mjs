import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BATCH_PROBE_POLICY_VERSION,
  BatchProbeVerdict,
  CandidateState,
  sanitizeBatchProbeRecord,
  getProbeNeutralId
} from './batch-probe-types.mjs';
import {
  loadBatchCheckpoint,
  saveBatchCheckpoint,
  loadBatchRegistry,
  recordBatchResult,
  generateSessionToken,
  validateCheckpointIntegrity,
  getActivePairingPin,
  verifyPairingPin,
  syncActiveCohortToCheckpoint,
  switchBatchCohort
} from './batch-probe-store.mjs';
import {
  buildBatchCandidateQueue,
  serializePublicBatchQueue,
  build90FileReconciliationMatrix
} from './batch-probe-queue.mjs';
import { getMediaFingerprint } from '../normalization/fingerprint.mjs';
import { streamVideo } from '../media/video-streamer.mjs';
import { resolveHealthMediaPath } from './media-health-router.mjs';
import { isLoopbackIp, getActiveMediaRoot } from '../server/cert-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..');

const inventoryCacheByDir = new Map();
let scanInProgress = false;

function getSessionCookie(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)batch_probe_session=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isSessionAuthorized(req, cp) {
  if (isLoopbackIp(req.socket.remoteAddress)) return true;
  const cookie = getSessionCookie(req);
  if (cookie && cp.sessionToken && cookie === cp.sessionToken) return true;
  return false;
}

function ensureActiveSession(cp) {
  if (!cp.runId) cp.runId = `run_${Date.now()}`;
  if (!cp.sessionToken) cp.sessionToken = generateSessionToken();
  return cp;
}

function getCachedInventory(baseDir, activeRoot) {
  const inv = inventoryCacheByDir.get(baseDir);
  return (inv && inv.targetDir === activeRoot) ? inv : null;
}

function setCachedInventory(baseDir, inv) {
  inventoryCacheByDir.set(baseDir, inv);
}

/**
 * Handles batch probe routing.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {object} [options]
 * @returns {boolean}
 */
export function handleBatchProbeRoutes(req, res, pathname, options = {}) {
  const urlObj = new URL(req.url, 'http://localhost');
  const baseDir = options.prototypeDir || PROTOTYPE_DIR;

  // 1. Diagnostic Page: /batch-probe
  if (pathname === '/batch-probe' || pathname === '/batch-probe.html') {
    const htmlPath = path.join(baseDir, 'batch-probe.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
      return true;
    }
  }

  // 2. Pairing PIN retrieval (Loopback only): GET /api/batch-probe/auth/pin
  if (pathname === '/api/batch-probe/auth/pin' && req.method === 'GET') {
    if (!isLoopbackIp(req.socket.remoteAddress)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Pairing PIN is only viewable from PC local console' }));
      return true;
    }
    const pinData = getActivePairingPin();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, pin: pinData.pin, expiresAt: pinData.expiresAt }));
    return true;
  }

  // 3. Pairing PIN exchange: POST /api/batch-probe/auth/pair
  if (pathname === '/api/batch-probe/auth/pair' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const isLoopback = isLoopbackIp(req.socket.remoteAddress);
        const isHttps = Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https');
        if (!isHttps && !isLoopback) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Pairing credentials forbidden over plain HTTP. Connect via HTTPS.' }));
          return;
        }

        const payload = body ? JSON.parse(body) : {};
        const clientIp = req.socket.remoteAddress || 'unknown';
        const verifyResult = verifyPairingPin(payload.pin, clientIp);

        if (!isLoopback && !verifyResult.valid) {
          if (verifyResult.reason === 'RATE_LIMITED') {
            res.writeHead(429, {
              'Content-Type': 'application/json; charset=utf-8',
              'Retry-After': String(verifyResult.retryAfterSec || 60)
            });
            res.end(JSON.stringify({
              error: 'Too many failed pairing attempts. Please wait before retrying.',
              retryAfterSec: verifyResult.retryAfterSec
            }));
            return;
          }
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            error: verifyResult.reason === 'PIN_EXPIRED_OR_ABSENT' ? 'Pairing PIN expired or not generated' : 'Invalid pairing PIN'
          }));
          return;
        }

        let cp = loadBatchCheckpoint(baseDir);
        ensureActiveSession(cp);
        saveBatchCheckpoint(cp, baseDir);

        res.setHeader('Set-Cookie', `batch_probe_session=${cp.sessionToken}; Path=/; Secure; HttpOnly; SameSite=Strict`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, authorized: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 4. Status: GET /api/batch-probe/status
  if (pathname === '/api/batch-probe/status' && req.method === 'GET') {
    let cp = loadBatchCheckpoint(baseDir);
    ensureActiveSession(cp);
    saveBatchCheckpoint(cp, baseDir);

    const authorized = isSessionAuthorized(req, cp);
    const registry = loadBatchRegistry(baseDir);

    if (!authorized) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        policyVersion: BATCH_PROBE_POLICY_VERSION,
        authorized: false,
        status: cp.status,
        runId: cp.runId,
        cursor: cp.cursor,
        totalQueue: cp.totalQueue
      }));
      return true;
    }

    const cachedInv = getCachedInventory(baseDir, getActiveMediaRoot());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      policyVersion: BATCH_PROBE_POLICY_VERSION,
      authorized: true,
      scanInProgress,
      checkpoint: {
        runId: cp.runId,
        status: cp.status,
        cursor: cp.cursor,
        totalQueue: cp.totalQueue,
        completedCount: cp.completedCount,
        passCount: cp.passCount,
        failCount: cp.failCount,
        inconclusiveCount: cp.inconclusiveCount,
        lastUpdated: cp.lastUpdated,
        lastTestedItem: cp.lastTestedItem
      },
      testedCount: registry.size,
      hasCachedInventory: Boolean(cachedInv),
      totalCandidates: cachedInv ? cachedInv.queue.length : null
    }));
    return true;
  }

  // Cohort Selection: POST /api/batch-probe/cohort
  if (pathname === '/api/batch-probe/cohort' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        let cp = loadBatchCheckpoint(baseDir);
        ensureActiveSession(cp);
        if (!isSessionAuthorized(req, cp)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Unauthorized: session pairing required' }));
          return;
        }

        const payload = body ? JSON.parse(body) : {};
        const targetCohort = payload.cohort || 'denied';
        if (!['denied', 'admitted', 'derivatives', 'all'].includes(targetCohort)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Invalid cohort: ${targetCohort}` }));
          return;
        }

        const inv = await buildBatchCandidateQueue({ prototypeDir: baseDir, cohort: targetCohort });
        setCachedInventory(baseDir, inv);

        cp = switchBatchCohort(cp, targetCohort, inv.queue.length, inv.candidatesHash, baseDir);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          activeCohort: cp.activeCohort,
          checkpoint: cp,
          total: inv.queue.length,
          counts: inv.counts,
          queue: serializePublicBatchQueue(inv.queue)
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 5. Candidate Queue: GET /api/batch-probe/queue
  if (pathname === '/api/batch-probe/queue' && req.method === 'GET') {
    let cp = loadBatchCheckpoint(baseDir);
    ensureActiveSession(cp);
    if (!isSessionAuthorized(req, cp)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized: batch probe session pairing required' }));
      return true;
    }

    const refresh = urlObj.searchParams.get('refresh') === '1';
    const reqCohort = urlObj.searchParams.get('cohort') || cp.activeCohort || 'denied';

    const respondWithInventory = (inventory) => {
      const integrity = validateCheckpointIntegrity(cp, inventory.targetDir, inventory.candidatesHash);
      if (!integrity.valid && cp.rootPath) {
        console.warn(`[BatchProbe] Checkpoint integrity mismatch (${integrity.reason}). Re-anchoring run.`);
        cp.runId = `run_${Date.now()}`;
        cp.cursor = 0;
        cp.completedCount = 0;
        cp.passCount = 0;
        cp.failCount = 0;
        cp.inconclusiveCount = 0;
        cp.lastTestedItem = null;
      }

      cp.rootPath = inventory.targetDir;
      cp.candidatesHash = inventory.candidatesHash;
      cp.totalQueue = inventory.queue.length;
      cp.activeCohort = inventory.cohort;
      syncActiveCohortToCheckpoint(cp);
      saveBatchCheckpoint(cp, baseDir);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        runId: cp.runId,
        activeCohort: cp.activeCohort,
        cursor: cp.cursor,
        total: inventory.queue.length,
        counts: inventory.counts,
        queue: serializePublicBatchQueue(inventory.queue)
      }));
    };

    const activeRoot = getActiveMediaRoot();
    const cachedInv = getCachedInventory(baseDir, activeRoot);
    if (cachedInv && !refresh && cachedInv.cohort === reqCohort) {
      respondWithInventory(cachedInv);
      return true;
    }

    scanInProgress = true;
    buildBatchCandidateQueue({ prototypeDir: baseDir, runId: cp.runId, cohort: reqCohort }).then(inventory => {
      setCachedInventory(baseDir, inventory);
      scanInProgress = false;
      respondWithInventory(inventory);
    }).catch(err => {
      scanInProgress = false;
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  // 6. Video Streaming: GET /api/batch-probe/video
  if (pathname === '/api/batch-probe/video' && req.method === 'GET') {
    const cp = loadBatchCheckpoint(baseDir);
    if (!isSessionAuthorized(req, cp)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized: valid HTTPS session cookie required' }));
      return true;
    }

    const itemId = urlObj.searchParams.get('itemId');
    if (!itemId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Missing itemId parameter' }));
      return true;
    }

    const serveVideo = (inv) => {
      const item = inv.itemMap.get(itemId) || inv.allItemMap?.get(itemId);
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Candidate item not found in batch inventory' }));
        return;
      }
      const targetFile = resolveHealthMediaPath(item.filePath);
      if (!targetFile) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Media file missing or outside authoritative roots' }));
        return;
      }
      streamVideo(req, res, targetFile);
    };

    const activeRoot = getActiveMediaRoot();
    const cachedInv = getCachedInventory(baseDir, activeRoot);
    if (cachedInv) {
      serveVideo(cachedInv);
      return true;
    }

    buildBatchCandidateQueue({ prototypeDir: baseDir, cohort: 'all' }).then(inv => {
      setCachedInventory(baseDir, inv);
      serveVideo(inv);
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  // 7. Control: POST /api/batch-probe/control
  if (pathname === '/api/batch-probe/control' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const cp = loadBatchCheckpoint(baseDir);
        if (!isSessionAuthorized(req, cp)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Unauthorized: session pairing required for batch control' }));
          return;
        }

        const payload = body ? JSON.parse(body) : {};
        const action = payload.action;

        if (action === 'start' || action === 'resume') {
          cp.status = 'RUNNING';
          ensureActiveSession(cp);
        } else if (action === 'pause') {
          cp.status = 'PAUSED';
        } else if (action === 'reset') {
          Object.assign(cp, { status: 'IDLE', runId: `run_${Date.now()}`, sessionToken: generateSessionToken(), cursor: 0, completedCount: 0, passCount: 0, failCount: 0, inconclusiveCount: 0, lastTestedItem: null });
          res.setHeader('Set-Cookie', `batch_probe_session=${cp.sessionToken}; Path=/; Secure; HttpOnly; SameSite=Strict`);
        }

        saveBatchCheckpoint(cp, baseDir);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, checkpoint: cp }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 8. Physical Probe Result: POST /api/batch-probe/result
  if (pathname === '/api/batch-probe/result' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const cp = loadBatchCheckpoint(baseDir);
        if (!isSessionAuthorized(req, cp)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Unauthorized: valid HTTPS session cookie required' }));
          return;
        }

        // Batch Status Check: must be RUNNING
        if (cp.status !== 'RUNNING') {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Cannot record result: batch status is ${cp.status}, must be RUNNING` }));
          return;
        }

        const payload = JSON.parse(body);

        const activeRoot = getActiveMediaRoot();
        if (cp.rootPath && activeRoot && path.normalize(activeRoot).toLowerCase() !== path.normalize(cp.rootPath).toLowerCase()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Media root changed: expected ${cp.rootPath}, active is ${activeRoot}` }));
          return;
        }

        if (!payload.runId || payload.runId !== cp.runId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Run ID mismatch: expected ${cp.runId}, got ${payload.runId}` }));
          return;
        }

        if (typeof payload.queueIndex !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Missing queueIndex' }));
          return;
        }
        if (payload.queueIndex < cp.cursor) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Duplicate submission for queueIndex ${payload.queueIndex} (current cursor: ${cp.cursor})` }));
          return;
        }
        if (payload.queueIndex > cp.cursor) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Out-of-order submission: queueIndex ${payload.queueIndex} does not match cursor ${cp.cursor}` }));
          return;
        }

        let cachedInv = getCachedInventory(baseDir, activeRoot);
        if (!cachedInv || cachedInv.cohort !== (cp.activeCohort || 'denied')) {
          cachedInv = await buildBatchCandidateQueue({ prototypeDir: baseDir, runId: cp.runId, cohort: cp.activeCohort || 'denied' });
          setCachedInventory(baseDir, cachedInv);
        }

        const expectedItem = cachedInv.queue[cp.cursor];
        if (!expectedItem) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `No candidate found at queue index ${cp.cursor}` }));
          return;
        }
        if (payload.itemId && payload.itemId !== expectedItem.itemId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Item ID mismatch: expected ${expectedItem.itemId}, got ${payload.itemId}` }));
          return;
        }
        if (!payload.fingerprintId || payload.fingerprintId !== expectedItem.fingerprintId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Fingerprint mismatch: expected ${expectedItem.fingerprintId}, got ${payload.fingerprintId}` }));
          return;
        }

        if (!fs.existsSync(expectedItem.filePath)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Target file missing on disk: ${expectedItem.neutralId}` }));
          return;
        }
        const liveFp = getMediaFingerprint(expectedItem.filePath);
        if (!liveFp || liveFp.fingerprintId !== expectedItem.fingerprintId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Disk fingerprint tamper or mutation detected' }));
          return;
        }

        let verdict = payload.verdict;
        const obs = payload.observationEvidence || {};
        if (verdict === BatchProbeVerdict.NATIVE_SAMPLE_PASS) {
          const hasDimensions = payload.videoWidth > 0 && payload.videoHeight > 0;
          const hasW1 = typeof obs.window1Frames === 'number' && obs.window1Frames >= 12 && typeof obs.window1MediaDelta === 'number' && obs.window1MediaDelta >= 0.4;
          const hasSeek = Boolean(payload.seekSuccess);
          const hasW2 = typeof obs.window2Frames === 'number' && obs.window2Frames >= 8 && typeof obs.window2MediaDelta === 'number' && obs.window2MediaDelta >= 0.3;
          const hasFrameProgression = obs.presentedFramesAdvanced === true;

          if (!hasDimensions || !hasW1 || !hasFrameProgression) {
            verdict = BatchProbeVerdict.PLAYBACK_STALLED;
          } else if (!hasSeek || !hasW2) {
            verdict = BatchProbeVerdict.SEEK_FAILED;
          }
        }

        const record = {
          runId: cp.runId,
          queueIndex: cp.cursor,
          itemId: expectedItem.itemId,
          generation: payload.generation,
          neutralId: expectedItem.neutralId,
          fingerprintId: expectedItem.fingerprintId,
          cohort: payload.cohort || expectedItem.cohort || 'denied',
          candidateState: expectedItem.state,
          verdict,
          productionGateStatus: payload.productionGateStatus || null,
          productionPlayerVerified: payload.productionPlayerVerified ?? null,
          videoWidth: payload.videoWidth || 0,
          videoHeight: payload.videoHeight || 0,
          rvfcCount: payload.rvfcCount || 0,
          sampleDurationSec: payload.sampleDurationSec || 0,
          seekCount: payload.seekCount || 0,
          seekSuccess: !!payload.seekSuccess,
          seekDetails: payload.seekDetails || null,
          stallCount: payload.stallCount || 0,
          observationEvidence: obs,
          readyState: payload.readyState,
          networkState: payload.networkState,
          error: payload.error || null,
          elapsedMs: payload.elapsedMs || 0,
          deviceContext: {
            userAgent: req.headers['user-agent'] || '',
            remoteIp: req.socket.remoteAddress
          },
          testedAt: new Date().toISOString()
        };

        recordBatchResult(record, baseDir);

        cp.cursor = cp.cursor + 1;
        cp.completedCount = (cp.completedCount || 0) + 1;

        if (verdict === BatchProbeVerdict.NATIVE_SAMPLE_PASS) {
          cp.passCount = (cp.passCount || 0) + 1;
        } else if (verdict === BatchProbeVerdict.TIMEOUT_INCONCLUSIVE) {
          cp.inconclusiveCount = (cp.inconclusiveCount || 0) + 1;
        } else {
          cp.failCount = (cp.failCount || 0) + 1;
        }

        cp.lastTestedItem = {
          itemId: expectedItem.itemId,
          fingerprintId: expectedItem.fingerprintId,
          neutralId: record.neutralId,
          verdict
        };

        syncActiveCohortToCheckpoint(cp);
        saveBatchCheckpoint(cp, baseDir);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, verdict, checkpoint: cp }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 9. 90-File Audit Summary: GET /api/batch-probe/summary
  if (pathname === '/api/batch-probe/summary' && req.method === 'GET') {
    const cp = loadBatchCheckpoint(baseDir);
    if (!isSessionAuthorized(req, cp)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized: session pairing required' }));
      return true;
    }

    build90FileReconciliationMatrix(baseDir, cp).then(summary => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(summary, null, 2));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  return false;
}
