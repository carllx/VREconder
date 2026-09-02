import fs from 'node:fs';
import path from 'node:path';
import { runDryRunInventory } from '../normalization/inventory-scanner.mjs';
import { NormalizationEngine } from '../normalization/normalization-engine.mjs';
import { DeviceProbeCache } from '../preflight/device-probe-cache.mjs';

const probeCache = new DeviceProbeCache();
const engine = new NormalizationEngine({ executionEnabled: false });

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
 * @returns {boolean} true if request was handled
 */
export function handlePreflightRoutes(req, res, pathname, __dirname, allowedRoots) {
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
        fs.writeFileSync(resultsFile, JSON.stringify(payload, null, 2), 'utf8');

        // Log formatted report
        console.log(`\n============================================================`);
        console.log(`📋 [Preflight Report Received from ${payload.remoteIp}]`);
        console.log(`   User-Agent: ${payload.userAgent || '--'}`);
        if (payload.pairsTested) {
          for (const [id, data] of Object.entries(payload.pairsTested)) {
            console.log(`   * ${data.pairName}: [Original: ${data.original?.canPlay ? 'OK' : 'ERR'}] [HVC1: ${data.derivative?.canPlay ? 'OK' : 'ERR'}] => Verdict: ${data.verdict}`);
          }
        }
        console.log(`============================================================\n`);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, saved: true }));
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

