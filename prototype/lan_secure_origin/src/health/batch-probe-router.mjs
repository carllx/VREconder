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
  recordBatchResult
} from './batch-probe-store.mjs';
import { buildBatchCandidateQueue } from './batch-probe-queue.mjs';
import { getMediaFingerprint } from '../normalization/fingerprint.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..');

let cachedCandidateInventory = null;
let scanInProgress = false;

/**
 * Handles batch probe routing.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @returns {boolean}
 */
export function handleBatchProbeRoutes(req, res, pathname) {
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
    const checkpoint = loadBatchCheckpoint(PROTOTYPE_DIR);
    const registry = loadBatchRegistry(PROTOTYPE_DIR);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      policyVersion: BATCH_PROBE_POLICY_VERSION,
      scanInProgress,
      checkpoint,
      testedCount: registry.size,
      hasCachedInventory: Boolean(cachedCandidateInventory),
      totalCandidates: cachedCandidateInventory ? cachedCandidateInventory.queue.length : null
    }));
    return true;
  }

  // 3. Candidate Queue: GET /api/batch-probe/queue
  if (pathname === '/api/batch-probe/queue' && req.method === 'GET') {
    const refresh = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1';

    if (cachedCandidateInventory && !refresh) {
      const checkpoint = loadBatchCheckpoint(PROTOTYPE_DIR);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        cursor: checkpoint.cursor,
        total: cachedCandidateInventory.queue.length,
        counts: cachedCandidateInventory.counts,
        queue: cachedCandidateInventory.queue
      }));
      return true;
    }

    scanInProgress = true;
    buildBatchCandidateQueue({ prototypeDir: PROTOTYPE_DIR }).then(inventory => {
      cachedCandidateInventory = inventory;
      scanInProgress = false;

      const cp = loadBatchCheckpoint(PROTOTYPE_DIR);
      if (!cp.runId) cp.runId = `run_${Date.now()}`;
      cp.totalQueue = inventory.queue.length;
      saveBatchCheckpoint(cp, PROTOTYPE_DIR);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        cursor: cp.cursor,
        total: inventory.queue.length,
        counts: inventory.counts,
        queue: inventory.queue
      }));
    }).catch(err => {
      scanInProgress = false;
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  // 4. Control Checkpoint: POST /api/batch-probe/control
  if (pathname === '/api/batch-probe/control' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const action = payload.action; // 'start', 'pause', 'resume', 'reset'
        const cp = loadBatchCheckpoint(PROTOTYPE_DIR);

        if (action === 'start') {
          cp.status = 'RUNNING';
          if (!cp.runId) cp.runId = `run_${Date.now()}`;
        } else if (action === 'pause') {
          cp.status = 'PAUSED';
        } else if (action === 'resume') {
          cp.status = 'RUNNING';
        } else if (action === 'reset') {
          cp.status = 'IDLE';
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

  // 5. Record Physical Probe Result: POST /api/batch-probe/result
  if (pathname === '/api/batch-probe/result' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.fingerprintId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Missing fingerprintId' }));
          return;
        }

        // Verify fingerprint authenticity against disk file if path provided
        if (payload.filePath && fs.existsSync(payload.filePath)) {
          const liveFp = getMediaFingerprint(payload.filePath);
          if (!liveFp || liveFp.fingerprintId !== payload.fingerprintId) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Fingerprint tamper / mismatch detected' }));
            return;
          }
        }

        // Evidence-to-verdict enforcement
        let verdict = payload.verdict;
        if (verdict === BatchProbeVerdict.NATIVE_SAMPLE_PASS) {
          const hasDimensions = payload.videoWidth > 0 && payload.videoHeight > 0;
          const hasRvfc = (typeof payload.rvfcCount === 'number' && payload.rvfcCount >= 2);
          const hasSeek = Boolean(payload.seekSuccess);

          if (!hasDimensions || !hasRvfc) {
            verdict = BatchProbeVerdict.PLAYBACK_STALLED;
          } else if (!hasSeek) {
            verdict = BatchProbeVerdict.SEEK_FAILED;
          }
        }

        const cp = loadBatchCheckpoint(PROTOTYPE_DIR);
        const runId = cp.runId || `run_${Date.now()}`;

        const record = {
          runId,
          queueIndex: payload.queueIndex,
          generation: payload.generation,
          neutralId: payload.neutralId || getProbeNeutralId(payload.filePath, payload.fingerprintId),
          fingerprintId: payload.fingerprintId,
          filePath: payload.filePath,
          candidateState: payload.candidateState || CandidateState.POLICY_DENIED_CANDIDATE,
          verdict,
          videoWidth: payload.videoWidth || 0,
          videoHeight: payload.videoHeight || 0,
          rvfcCount: payload.rvfcCount || 0,
          sampleDurationSec: payload.sampleDurationSec || 0,
          seekCount: payload.seekCount || 0,
          seekSuccess: !!payload.seekSuccess,
          seekDetails: payload.seekDetails || null,
          stallCount: payload.stallCount || 0,
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

        // Advance checkpoint
        if (typeof payload.queueIndex === 'number') {
          cp.cursor = payload.queueIndex + 1;
        }
        cp.completedCount = (cp.completedCount || 0) + 1;

        if (verdict === BatchProbeVerdict.NATIVE_SAMPLE_PASS) {
          cp.passCount = (cp.passCount || 0) + 1;
        } else if (verdict === BatchProbeVerdict.TIMEOUT_INCONCLUSIVE) {
          cp.inconclusiveCount = (cp.inconclusiveCount || 0) + 1;
        } else {
          cp.failCount = (cp.failCount || 0) + 1;
        }

        cp.lastTestedItem = {
          fingerprintId: payload.fingerprintId,
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

  // 6. Public Sanitized Summary: GET /api/batch-probe/summary
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
