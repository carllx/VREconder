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
  validateCheckpointIntegrity
} from './batch-probe-store.mjs';
import { buildBatchCandidateQueue, serializePublicBatchQueue } from './batch-probe-queue.mjs';
import { getMediaFingerprint } from '../normalization/fingerprint.mjs';
import { streamVideo } from '../media/video-streamer.mjs';
import { resolveHealthMediaPath } from './media-health-router.mjs';
import { isLoopbackIp } from '../server/cert-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..');

let cachedCandidateInventory = null;
let scanInProgress = false;

function extractToken(req, urlObj, bodyPayload = null) {
  const headerToken = req.headers['x-probe-token'];
  if (headerToken) return headerToken;
  if (bodyPayload && bodyPayload.token) return bodyPayload.token;
  if (urlObj && urlObj.searchParams.get('token')) return urlObj.searchParams.get('token');
  return null;
}

function ensureActiveSession(cp) {
  if (!cp.runId) {
    cp.runId = `run_${Date.now()}`;
  }
  if (!cp.sessionToken) {
    cp.sessionToken = generateSessionToken();
  }
  return cp;
}

/**
 * Handles batch probe routing.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @returns {boolean}
 */
export function handleBatchProbeRoutes(req, res, pathname) {
  const urlObj = new URL(req.url, 'http://localhost');

  // 1. Diagnostic Page: /batch-probe
  if (pathname === '/batch-probe' || pathname === '/batch-probe.html') {
    const htmlPath = path.join(PROTOTYPE_DIR, 'batch-probe.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
      return true;
    }
  }

  // 2. Status & Checkpoint: GET /api/batch-probe/status
  if (pathname === '/api/batch-probe/status' && req.method === 'GET') {
    let cp = loadBatchCheckpoint(PROTOTYPE_DIR);
    ensureActiveSession(cp);
    saveBatchCheckpoint(cp, PROTOTYPE_DIR);

    const registry = loadBatchRegistry(PROTOTYPE_DIR);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      policyVersion: BATCH_PROBE_POLICY_VERSION,
      scanInProgress,
      checkpoint: cp,
      sessionToken: cp.sessionToken,
      testedCount: registry.size,
      hasCachedInventory: Boolean(cachedCandidateInventory),
      totalCandidates: cachedCandidateInventory ? cachedCandidateInventory.queue.length : null
    }));
    return true;
  }

  // 3. Candidate Queue: GET /api/batch-probe/queue
  if (pathname === '/api/batch-probe/queue' && req.method === 'GET') {
    const refresh = urlObj.searchParams.get('refresh') === '1';

    const respondWithInventory = (inventory) => {
      let cp = loadBatchCheckpoint(PROTOTYPE_DIR);
      ensureActiveSession(cp);

      // Validate integrity against active root and candidate inventory
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
      saveBatchCheckpoint(cp, PROTOTYPE_DIR);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        runId: cp.runId,
        cursor: cp.cursor,
        total: inventory.queue.length,
        counts: inventory.counts,
        sessionToken: cp.sessionToken,
        queue: serializePublicBatchQueue(inventory.queue)
      }));
    };

    if (cachedCandidateInventory && !refresh) {
      respondWithInventory(cachedCandidateInventory);
      return true;
    }

    scanInProgress = true;
    buildBatchCandidateQueue({ prototypeDir: PROTOTYPE_DIR }).then(inventory => {
      cachedCandidateInventory = inventory;
      scanInProgress = false;
      respondWithInventory(inventory);
    }).catch(err => {
      scanInProgress = false;
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  // 4. Batch Probe Video Streaming: GET /api/batch-probe/video
  if (pathname === '/api/batch-probe/video' && req.method === 'GET') {
    const itemId = urlObj.searchParams.get('itemId');
    const token = extractToken(req, urlObj);

    const cp = loadBatchCheckpoint(PROTOTYPE_DIR);
    if (!token || token !== cp.sessionToken) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid session token' }));
      return true;
    }

    if (!cachedCandidateInventory || !cachedCandidateInventory.itemMap.has(itemId)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Candidate item not found in active batch queue' }));
      return true;
    }

    const item = cachedCandidateInventory.itemMap.get(itemId);
    const targetFile = resolveHealthMediaPath(item.filePath);
    if (!targetFile) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Media file missing or outside authoritative roots' }));
      return true;
    }

    streamVideo(req, res, targetFile);
    return true;
  }

  // 5. Control Checkpoint: POST /api/batch-probe/control
  if (pathname === '/api/batch-probe/control' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const token = extractToken(req, urlObj, payload);
        const cp = loadBatchCheckpoint(PROTOTYPE_DIR);

        const isLoopback = isLoopbackIp(req.socket.remoteAddress);
        if (!isLoopback && (!token || token !== cp.sessionToken)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Unauthorized: invalid batch probe control token' }));
          return;
        }

        const action = payload.action; // 'start', 'pause', 'resume', 'reset'

        if (action === 'start') {
          cp.status = 'RUNNING';
          ensureActiveSession(cp);
        } else if (action === 'pause') {
          cp.status = 'PAUSED';
        } else if (action === 'resume') {
          cp.status = 'RUNNING';
          ensureActiveSession(cp);
        } else if (action === 'reset') {
          cp.status = 'IDLE';
          cp.runId = `run_${Date.now()}`;
          cp.sessionToken = generateSessionToken();
          cp.cursor = 0;
          cp.completedCount = 0;
          cp.passCount = 0;
          cp.failCount = 0;
          cp.inconclusiveCount = 0;
          cp.lastTestedItem = null;
        }

        saveBatchCheckpoint(cp, PROTOTYPE_DIR);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, checkpoint: cp }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 6. Record Physical Probe Result: POST /api/batch-probe/result
  if (pathname === '/api/batch-probe/result' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const token = extractToken(req, urlObj, payload);
        const cp = loadBatchCheckpoint(PROTOTYPE_DIR);

        // Security Check 1: Authorization
        if (!token || token !== cp.sessionToken) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid session token' }));
          return;
        }

        // Security Check 2: Active Run ID binding
        if (!payload.runId || payload.runId !== cp.runId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Run ID mismatch: expected ${cp.runId}, got ${payload.runId}` }));
          return;
        }

        // Security Check 3: Checkpoint cursor and sequential progression
        if (typeof payload.queueIndex !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Missing queueIndex' }));
          return;
        }
        if (payload.queueIndex < cp.cursor) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Duplicate or obsolete submission for queueIndex ${payload.queueIndex} (current cursor: ${cp.cursor})` }));
          return;
        }
        if (payload.queueIndex > cp.cursor) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Out-of-order submission: queueIndex ${payload.queueIndex} does not match cursor ${cp.cursor}` }));
          return;
        }

        // Ensure inventory is loaded
        if (!cachedCandidateInventory) {
          cachedCandidateInventory = await buildBatchCandidateQueue({ prototypeDir: PROTOTYPE_DIR });
        }

        // Security Check 4: Item identity binding
        const expectedItem = cachedCandidateInventory.queue[cp.cursor];
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

        // Security Check 5: Live disk fingerprint verification
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

        // Evidence-to-verdict enforcement (Delta B)
        let verdict = payload.verdict;
        const obs = payload.observationEvidence || {};
        if (verdict === BatchProbeVerdict.NATIVE_SAMPLE_PASS) {
          const hasDimensions = payload.videoWidth > 0 && payload.videoHeight > 0;
          const hasWindow1 = (typeof obs.window1Frames === 'number' ? obs.window1Frames >= 5 : payload.rvfcCount >= 5);
          const hasSeek = Boolean(payload.seekSuccess);
          const hasWindow2 = (typeof obs.window2Frames === 'number' ? obs.window2Frames >= 5 : true);

          if (!hasDimensions || !hasWindow1) {
            verdict = BatchProbeVerdict.PLAYBACK_STALLED;
          } else if (!hasSeek || !hasWindow2) {
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
          candidateState: expectedItem.state,
          verdict,
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

        // Durable append to batch registry
        recordBatchResult(record, PROTOTYPE_DIR);

        // Advance checkpoint cursor strictly on verified persistence
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

        saveBatchCheckpoint(cp, PROTOTYPE_DIR);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, verdict, checkpoint: cp }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 7. Public Sanitized Summary: GET /api/batch-probe/summary
  if (pathname === '/api/batch-probe/summary' && req.method === 'GET') {
    const cp = loadBatchCheckpoint(PROTOTYPE_DIR);
    const registry = loadBatchRegistry(PROTOTYPE_DIR);

    const sanitizedRecords = [];
    for (const rec of registry.values()) {
      sanitizedRecords.push(sanitizeBatchProbeRecord(rec));
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      policyVersion: BATCH_PROBE_POLICY_VERSION,
      checkpoint: cp,
      totalTested: sanitizedRecords.length,
      records: sanitizedRecords
    }, null, 2));
    return true;
  }

  return false;
}
