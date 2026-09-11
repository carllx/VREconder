import fs from 'node:fs';
import path from 'node:path';
import { runDryRunInventory } from '../normalization/inventory-scanner.mjs';
import { NormalizationEngine } from '../normalization/normalization-engine.mjs';
import { DeviceProbeCache } from '../preflight/device-probe-cache.mjs';
import { preflightIncomingMedia } from '../preflight/intake-preflight.mjs';
import { getMediaFingerprint } from '../normalization/fingerprint.mjs';
import { recordIncident } from '../telemetry/incident-store.mjs';

const probeCache = new DeviceProbeCache();
const engine = new NormalizationEngine({ executionEnabled: false });
const admissionCache = new Map();

export function extractCheapMediaFacts(facts) {
  if (!facts) return null;
  const v = facts.video || (facts.videoStreams && facts.videoStreams[0]) || null;
  return {
    codec: v?.codec || null,
    codecTag: v?.codecTag || null,
    profile: v?.profile || null,
    level: v?.level ?? null,
    pixFmt: v?.pixFmt || null,
    bitDepth: v?.bitDepth ?? null,
    width: v?.width || 0,
    height: v?.height || 0,
    fps: v?.rFps || v?.avgFps || null,
    topology: {
      videoCount: facts.videoCount ?? (facts.videoStreams ? facts.videoStreams.length : 0),
      audioCount: facts.audioCount ?? (facts.audioStreams ? facts.audioStreams.length : 0),
      chapterCount: facts.chapterCount ?? (facts.chapters ? facts.chapters.length : 0),
      otherStreamsCount: facts.otherStreams ? facts.otherStreams.length : 0
    }
  };
}

export function getCachedAdmission(fingerprintId) {
  return admissionCache.get(fingerprintId) || null;
}

/**
 * Check if a file is admitted for Safari playback based on Issue #21 compatibility authority.
 * Keyed in-memory by file fingerprint (canonicalPath, size, mtimeMs).
 *
 * @param {string} filePath
 * @returns {Promise<{ allowed: boolean, classification: string, reason: string, matchedEnvelopeId: string | null, allowedNextActions: string[], fingerprintId?: string, admissionId?: string, mediaFacts?: object | null }>}
 */
export async function checkPlaybackAdmission(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      allowed: false,
      classification: 'UNREADABLE_MEDIA',
      reason: 'File not found or unreadable',
      matchedEnvelopeId: null,
      allowedNextActions: []
    };
  }

  const fp = getMediaFingerprint(filePath);
  if (!fp) {
    return {
      allowed: false,
      classification: 'UNREADABLE_MEDIA',
      reason: 'Could not generate fingerprint for file',
      matchedEnvelopeId: null,
      allowedNextActions: []
    };
  }

  if (admissionCache.has(fp.fingerprintId)) {
    return admissionCache.get(fp.fingerprintId);
  }

  try {
    const decision = await preflightIncomingMedia(fp.canonicalPath, { probeCache });
    const allowed = Boolean(decision && decision.mayPromoteToVrReady);
    const mediaFacts = extractCheapMediaFacts(decision?.facts);
    const admissionId = `adm_${Date.now()}_${fp.fingerprintId.slice(0, 8)}`;
    const result = {
      allowed,
      classification: (decision && decision.classification) || 'UNKNOWN',
      reason: (decision && decision.reason) || 'No policy reason provided',
      matchedEnvelopeId: (decision && decision.matchedEnvelopeId) || null,
      allowedNextActions: (decision && decision.allowedNextActions) || [],
      fingerprintId: fp.fingerprintId,
      admissionId,
      mediaFacts
    };
    admissionCache.set(fp.fingerprintId, result);

    if (!allowed) {
      try {
        recordIncident({
          eventType: 'PLAYBACK_ADMISSION_DENIED',
          severity: 'WARN',
          fingerprintId: fp.fingerprintId,
          localMediaName: path.basename(filePath),
          localMediaPath: filePath,
          classification: result.classification,
          reason: result.reason,
          matchedEnvelopeId: result.matchedEnvelopeId,
          allowedNextActions: result.allowedNextActions,
          occurrenceSource: 'server_admission_gate',
          metadata: {
            admissionId,
            mediaFacts
          }
        });
      } catch (logErr) {
        console.warn('[PreflightRouter] Failed to persist denied admission incident:', logErr.message);
      }
    }

    return result;
  } catch (err) {
    const errResult = {
      allowed: false,
      classification: 'PREFLIGHT_ERROR',
      reason: err.message || 'Error executing preflight check',
      matchedEnvelopeId: null,
      allowedNextActions: []
    };
    try {
      recordIncident({
        eventType: 'PREFLIGHT_ERROR',
        severity: 'ERROR',
        fingerprintId: fp ? fp.fingerprintId : null,
        localMediaName: path.basename(filePath),
        localMediaPath: filePath,
        classification: 'PREFLIGHT_ERROR',
        reason: err.message || 'Error executing preflight check',
        matchedEnvelopeId: null,
        allowedNextActions: [],
        occurrenceSource: 'server_admission_gate'
      });
    } catch (_) {}
    return errResult;
  }
}

export function clearAdmissionCache() {
  admissionCache.clear();
}

// Initialize engine asynchronously on startup
export const engineInitPromise = engine.initialize().then(initResult => {
  console.log(`[NormalizationEngine] Startup initialization complete. Status: ${initResult.status}`);
  return initResult;
}).catch(err => {
  console.error(`[NormalizationEngine] Startup initialization error:`, err);
  return { ok: false, status: 'INITIALIZATION_FAILED', error: err.message };
});

/**
 * Handles Preflight and Normalization API routes.
 * 
 * @param {import('node:http').IncomingMessage} req 
 * @param {import('node:http').ServerResponse} res 
 * @param {string} pathname 
 * @param {string} __dirname 
 * @param {string[]} allowedRoots 
 * @param {Function} [resolveMediaPath]
 * @returns {boolean} true if request was handled
 */
export function handlePreflightRoutes(req, res, pathname, __dirname, allowedRoots, resolveMediaPath) {
  // 1. Static HTML for /compat-preflight
  if (pathname === '/compat-preflight' || pathname === '/compat-preflight.html') {
    const filePath = path.join(__dirname, 'compat-preflight.html');
    if (fs.existsSync(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
      return true;
    }
  }

  // 2. Preflight structured results ingestion endpoint
  if (pathname === '/api/preflight/report' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        payload.receivedAt = new Date().toISOString();
        payload.remoteIp = req.socket.remoteAddress;

        const resultsFile = path.join(__dirname, 'preflight_results.json');
        let records = [];
        if (fs.existsSync(resultsFile)) {
          try {
            const existing = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
            if (Array.isArray(existing)) {
              records = existing;
            } else if (existing && typeof existing === 'object') {
              if (Array.isArray(existing.history)) {
                records = existing.history;
              } else {
                records = [existing];
              }
            }
          } catch (_) {
            records = [];
          }
        }
        records.push(payload);
        const fileOutput = {
          latest: payload,
          count: records.length,
          history: records
        };
        fs.writeFileSync(resultsFile, JSON.stringify(fileOutput, null, 2), 'utf8');

        // Log formatted report
        console.log(`\n============================================================`);
        console.log(`📋 [Preflight Report Received from ${payload.remoteIp}]`);
        console.log(`   runId: ${payload.runId || '--'} | testType: ${payload.testType || '--'}`);
        console.log(`   User-Agent: ${payload.userAgent || '--'}`);
        if (payload.pairsTested) {
          for (const [id, data] of Object.entries(payload.pairsTested)) {
            console.log(`   * ${data.pairName}: [Original: ${data.original?.canPlay ? 'OK' : 'ERR'}] [HVC1: ${data.derivative?.canPlay ? 'OK' : 'ERR'}] => Verdict: ${data.verdict}`);
          }
        } else if (payload.pair) {
          console.log(`   * ${payload.pair.name}: [Original: ${payload.pair.original?.canPlay ? 'OK' : 'ERR'}] [Derivative: ${payload.pair.derivative?.canPlay ? 'OK' : 'ERR'}] => Verdict: ${payload.pair.verdict}`);
        }
        console.log(`============================================================\n`);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, saved: true, runId: payload.runId || null, totalRecords: records.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 3. Retrieve preflight report
  if (pathname === '/api/preflight/results' && req.method === 'GET') {
    const resultsFile = path.join(__dirname, 'preflight_results.json');
    let data = { exists: false, results: null };
    if (fs.existsSync(resultsFile)) {
      try {
        data = { exists: true, results: JSON.parse(fs.readFileSync(resultsFile, 'utf8')) };
      } catch (_) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
    return true;
  }

  // 4. Dry-run inventory scan
  if (pathname === '/api/normalization/dry-run' && req.method === 'GET') {
    runDryRunInventory(allowedRoots).then(report => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(report, null, 2));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  // 5. Normalization engine status
  if (pathname === '/api/normalization/status' && req.method === 'GET') {
    let journalEntries = null;
    let journalError = null;
    try {
      journalEntries = engine.journal.readJournal();
    } catch (e) {
      journalError = e.message;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      engineStatus: engine.status,
      executionEnabled: engine.executionEnabled,
      isProcessing: engine.isProcessing,
      isPlaybackActive: engine.isPlaybackActive,
      concurrency: engine.concurrency,
      journal: journalEntries,
      journalError
    }, null, 2));
    return true;
  }

  // 6. Real-time Playback status endpoint
  if (pathname === '/api/playback/status' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store'
    });
    res.end(JSON.stringify({
      isPlaybackActive: engine.isPlaybackActive,
      serverOnline: true,
      timestamp: new Date().toISOString()
    }));
    return true;
  }

  // 7. Real-time Playback SSE events endpoint
  if (pathname === '/api/playback/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify({ isPlaybackActive: engine.isPlaybackActive, timestamp: new Date().toISOString() })}\n\n`);
    playbackSseClients.add(res);
    req.on('close', () => { playbackSseClients.delete(res); });
    return true;
  }

  // 8. Playback Admission Gate check endpoint (Issue #23)
  if (pathname === '/api/playback-admission' && req.method === 'GET') {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const relParam = parsedUrl.searchParams.get('path');
    if (!relParam) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        allowed: false,
        error: 'Missing path query parameter',
        classification: 'INVALID_REQUEST'
      }));
      return true;
    }

    let resolvedPath = null;
    if (typeof resolveMediaPath === 'function') {
      resolvedPath = resolveMediaPath(relParam);
    } else {
      for (const root of (allowedRoots || [])) {
        const p = path.resolve(root, relParam);
        if (fs.existsSync(p)) {
          resolvedPath = p;
          break;
        }
      }
    }

    if (!resolvedPath) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        allowed: false,
        classification: 'UNREADABLE_MEDIA',
        reason: 'File not found in media roots',
        matchedEnvelopeId: null,
        allowedNextActions: []
      }));
      return true;
    }

    checkPlaybackAdmission(resolvedPath).then(decision => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store'
      });
      res.end(JSON.stringify(decision));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        allowed: false,
        classification: 'INTERNAL_ERROR',
        reason: err.message
      }));
    });
    return true;
  }

  return false;
}

const playbackSseClients = new Set();

export function notifyPlaybackChange(activeStreamCount, isActive) {
  const payload = JSON.stringify({
    isPlaybackActive: !!isActive,
    activeStreamCount: activeStreamCount || 0,
    timestamp: new Date().toISOString()
  });
  const msg = `data: ${payload}\n\n`;
  for (const client of playbackSseClients) {
    try {
      client.write(msg);
    } catch (_) {
      playbackSseClients.delete(client);
    }
  }
}

export function getEngineInstance() {
  return engine;
}

