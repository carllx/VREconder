import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITATIVE_HEALTH_ROOTS,
  HEALTH_CHECK_POLICY_VERSION,
  COMPATIBILITY_POLICY_VERSION,
  FinalHealthState,
  ProbeVerdict,
  sanitizePublicHealthRecord
} from './media-health-types.mjs';
import {
  recordHealthResult,
  loadHealthRegistry,
  loadCheckpoint,
  saveCheckpoint
} from './media-health-store.mjs';
import { runStaticHealthScan } from './media-health-scanner.mjs';
import { streamVideo } from '../media/video-streamer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..');

let cachedScanReport = null;
let scanInProgress = false;

/**
 * Health-specific secure path resolver.
 * Strictly constrained to AUTHORITATIVE_HEALTH_ROOTS (G:\Media\VR and G:\Download).
 * Does NOT alter the normal player's media root resolution.
 * 
 * @param {string} relParam 
 * @returns {string | null}
 */
export function resolveHealthMediaPath(relParam, allowedRoots = AUTHORITATIVE_HEALTH_ROOTS) {
  if (!relParam || typeof relParam !== 'string') return null;

  // 1. Direct absolute path check within authoritative roots
  if (path.isAbsolute(relParam)) {
    const norm = path.resolve(relParam);
    for (const root of allowedRoots) {
      const rel = path.relative(root, norm);
      // Ensure rel is strictly inside root (not equal to root, not starting with '..' or path.sep, not absolute)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        if (fs.existsSync(norm) && fs.statSync(norm).isFile()) {
          return norm;
        }
      }
    }
    return null;
  }

  // 2. Relative to authoritative roots
  for (const root of allowedRoots) {
    const resolved = path.resolve(root, relParam);
    const rel = path.relative(root, resolved);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    }
  }

  return null;
}

/**
 * Handles Media Health routes.
 * 
 * @param {import('node:http').IncomingMessage} req 
 * @param {import('node:http').ServerResponse} res 
 * @param {string} pathname 
 * @returns {boolean} true if request was handled
 */
export function handleMediaHealthRoutes(req, res, pathname) {
  // 1. Diagnostic Page: /library-health-check
  if (pathname === '/library-health-check' || pathname === '/library-health-check.html') {
    const htmlPath = path.join(PROTOTYPE_DIR, 'library-health-check.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
      return true;
    }
  }

  // 1b. Issue #21 Repair Probe Page: /repair-probe-runner
  if (pathname === '/repair-probe-runner' || pathname === '/repair-probe-runner.html') {
    const htmlPath = path.join(PROTOTYPE_DIR, 'repair-probe-runner.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
      return true;
    }
  }

  // 1c. Repair Probe Queue Endpoint: GET /api/repair/queue
  if (pathname === '/api/repair/queue' && req.method === 'GET') {
    const manifestPath = path.join(PROTOTYPE_DIR, 'canonical_repair_manifest.json');
    if (fs.existsSync(manifestPath)) {
      const rm = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ queue: rm.probeQueue || [] }));
      return true;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'canonical_repair_manifest.json not found' }));
    return true;
  }

  // 1d. Record Repair Probe Result: POST /api/repair/result
  if (pathname === '/api/repair/result' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const resultsFile = path.join(PROTOTYPE_DIR, 'canonical_repair_probe_results.jsonl');
        fs.appendFileSync(resultsFile, JSON.stringify(payload) + '\n', 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 2. Health-specific Video Stream Endpoint: /api/health/video
  if (pathname === '/api/health/video' && req.method === 'GET') {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathParam = parsedUrl.searchParams.get('path');
    const targetFile = resolveHealthMediaPath(pathParam);

    if (!targetFile) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Media file not found within authoritative health roots' }));
      return true;
    }

    streamVideo(req, res, targetFile);
    return true;
  }

  // 3. Status & Checkpoint: GET /api/health/status
  if (pathname === '/api/health/status' && req.method === 'GET') {
    const checkpoint = loadCheckpoint(PROTOTYPE_DIR);
    const registry = loadHealthRegistry(PROTOTYPE_DIR);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      policyVersion: HEALTH_CHECK_POLICY_VERSION,
      compatibilityPolicyVersion: COMPATIBILITY_POLICY_VERSION,
      scanInProgress,
      hasStaticScan: Boolean(cachedScanReport),
      totalDiscovered: cachedScanReport ? cachedScanReport.totalDiscovered : null,
      checkpoint,
      registryCount: registry.size
    }));
    return true;
  }

  // 4. Trigger / Retrieve Static Scan: GET /api/health/scan
  if (pathname === '/api/health/scan' && (req.method === 'GET' || req.method === 'POST')) {
    if (scanInProgress) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Static scan already in progress' }));
      return true;
    }

    if (cachedScanReport && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(cachedScanReport));
      return true;
    }

    scanInProgress = true;
    runStaticHealthScan().then(report => {
      cachedScanReport = report;
      scanInProgress = false;

      // Update checkpoint total queue
      const cp = loadCheckpoint(PROTOTYPE_DIR);
      if (!cp.runId) cp.runId = `run_${Date.now()}`;
      cp.totalQueue = report.unresolvedQueueCount;
      saveCheckpoint(cp, PROTOTYPE_DIR);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(report));
    }).catch(err => {
      scanInProgress = false;
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  // 5. Unresolved Queue: GET /api/health/queue
  if (pathname === '/api/health/queue' && req.method === 'GET') {
    if (!cachedScanReport) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Static scan must be run before fetching queue' }));
      return true;
    }

    const registry = loadHealthRegistry(PROTOTYPE_DIR);
    const checkpoint = loadCheckpoint(PROTOTYPE_DIR);

    // Filter items already having a valid probe verdict
    const queueWithStatus = cachedScanReport.unresolvedQueue.map((item, idx) => {
      const recorded = registry.get(item.fingerprintId);
      const isCompleted = recorded && (recorded.probeVerdict === ProbeVerdict.PASS_VIDEO || recorded.probeVerdict === ProbeVerdict.MEDIA_ERROR);
      return {
        index: idx,
        neutralId: item.neutralId,
        fingerprintId: item.fingerprintId,
        filePath: item.filePath,
        region: item.region,
        staticClassification: item.staticClassification,
        isCompleted: Boolean(isCompleted),
        recordedVerdict: recorded ? recorded.probeVerdict : null
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      cursor: checkpoint.cursor,
      total: queueWithStatus.length,
      queue: queueWithStatus
    }));
    return true;
  }

  // 6. Record Physical Probe Result: POST /api/health/probe-result
  if (pathname === '/api/health/probe-result' && req.method === 'POST') {
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

        // Strict positive video check
        let verdict = payload.verdict;
        if (verdict === ProbeVerdict.PASS_VIDEO) {
          const hasDimensions = payload.videoWidth > 0 && payload.videoHeight > 0;
          const hasRvfc = (typeof payload.rvfcFrameCount === 'number' && payload.rvfcFrameCount >= 1);
          if (!hasDimensions || !hasRvfc) {
            verdict = ProbeVerdict.NO_VIDEO_FRAME;
          }
        }

        const finalHealthState = (verdict === ProbeVerdict.PASS_VIDEO)
          ? FinalHealthState.HEALTHY_DIRECT
          : FinalHealthState.DEVICE_PROBE_FAILED;

        const record = {
          neutralId: payload.neutralId,
          fingerprintId: payload.fingerprintId,
          region: payload.region,
          filePath: payload.filePath,
          staticClassification: payload.staticClassification,
          probeVerdict: verdict,
          finalHealthState,
          recommendedNextAction: (verdict === ProbeVerdict.PASS_VIDEO) ? 'DIRECT_PLAYBACK_OK' : 'INSPECT_DEVICE_ERROR',
          deviceContext: {
            userAgent: req.headers['user-agent'] || '',
            remoteIp: req.socket.remoteAddress,
            videoWidth: payload.videoWidth || 0,
            videoHeight: payload.videoHeight || 0,
            rvfcFrameCount: payload.rvfcFrameCount || 0,
            readyState: payload.readyState,
            networkState: payload.networkState,
            error: payload.error || null,
            elapsedMs: payload.elapsedMs || 0
          },
          generation: payload.generation,
          timestamp: new Date().toISOString()
        };

        // 1. Durable Append to Registry
        recordHealthResult(record, PROTOTYPE_DIR);

        // 2. Advance Checkpoint
        const cp = loadCheckpoint(PROTOTYPE_DIR);
        if (typeof payload.queueIndex === 'number') {
          cp.cursor = payload.queueIndex + 1;
        }
        cp.completedCount = (cp.completedCount || 0) + 1;
        if (verdict === ProbeVerdict.PASS_VIDEO) {
          cp.passCount = (cp.passCount || 0) + 1;
        } else {
          cp.failCount = (cp.failCount || 0) + 1;
        }
        cp.lastTestedItem = {
          fingerprintId: payload.fingerprintId,
          neutralId: payload.neutralId,
          verdict
        };
        saveCheckpoint(cp, PROTOTYPE_DIR);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, verdict, checkpoint: cp }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 7. Checkpoint Control: POST /api/health/checkpoint
  if (pathname === '/api/health/checkpoint' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const action = JSON.parse(body).action; // 'start', 'pause', 'resume', 'reset'
        const cp = loadCheckpoint(PROTOTYPE_DIR);

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
          cp.lastTestedItem = null;
        }

        saveCheckpoint(cp, PROTOTYPE_DIR);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, checkpoint: cp }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  return false;
}
