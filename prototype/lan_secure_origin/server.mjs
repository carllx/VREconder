import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLocalIPs,
  ensureCertificates,
  isLoopbackIp,
  getActiveMediaRoot,
  setActiveMediaRoot,
  scanRealVRVideos,
  getCachedVideos
} from './src/server/cert-helper.mjs';
import { streamVideo, getRecentRangeLifecycles, onActiveStreamCountChange } from './src/media/video-streamer.mjs';
import { handlePreflightRoutes, getEngineInstance, notifyPlaybackChange } from './src/server/preflight-router.mjs';
import { handleProfileRoutes } from './src/server/profile-router.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const CERTS_DIR = path.join(__dirname, 'certs');

// Hook normalization engine to active video streams
const engine = getEngineInstance();
onActiveStreamCountChange(count => {
  engine.notifyPlaybackState(count > 0);
  notifyPlaybackChange(count, count > 0);
});

// Calibration SSE live event streaming to connected devices (PC <-> iPhone)
const sseClients = new Set();
function broadcastCalibrationEvent(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

let latestTelemetry = null;
let lastLoggedPerfWindowSeq = -1;
let lastIphoneTelemetryAt = 0;

function getAllowedRoots() {
  const primary = getActiveMediaRoot();
  const roots = [primary];
  const renderRoot = 'G:\\Media\\VR\\Render';
  if (fs.existsSync(renderRoot)) roots.push(renderRoot);
  return roots;
}

function resolveSecureMediaPath(relParam) {
  if (!relParam) return null;
  const roots = getAllowedRoots();

  // Try direct resolution or root relative resolution
  for (const root of roots) {
    const resolved = path.resolve(root, relParam);
    const relToRoot = path.relative(root, resolved);
    if (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot) && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  // Handle case where relParam is prefixed with 'Render/' or folder name
  for (const root of roots) {
    const parentDir = path.dirname(root);
    const resolved = path.resolve(parentDir, relParam);
    const relToParent = path.relative(parentDir, resolved);
    if (!relToParent.startsWith('..') && !path.isAbsolute(relToParent) && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return null;
}

function handleRequest(req, res, isHttps) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  if (pathname !== '/api/calibration/events' && pathname !== '/api/telemetry') {
    console.log(`[REQ] ${req.method} ${pathname} (${req.socket.remoteAddress})`);
  }

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Web App Manifest
  if (pathname === '/manifest.json') {
    const manifestPath = path.join(__dirname, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      fs.createReadStream(manifestPath).pipe(res);
      return;
    }
  }

  // CA certificate download endpoint
  if (pathname === '/ca.crt' || pathname === '/download-ca') {
    const caFile = path.join(CERTS_DIR, 'ca.crt');
    if (fs.existsSync(caFile)) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="vreconder-ca.crt"'
      });
      fs.createReadStream(caFile).pipe(res);
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('CA certificate not generated yet');
      return;
    }
  }

  // Preflight & Normalization modular routes
  if (handlePreflightRoutes(req, res, pathname, __dirname, getAllowedRoots())) {
    return;
  }

  // Profiles modular routes
  if (handleProfileRoutes(req, res, pathname, __dirname)) {
    return;
  }

  // Real-time Calibration Events SSE stream
  if (pathname === '/api/calibration/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': ping\n\n');
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
    return;
  }

  // Calibration Control POST
  if (pathname === '/api/calibration/control' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        broadcastCalibrationEvent(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', broadcasted: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Client Diagnostic Logger
  if (pathname === '/api/log' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        const isStall = (typeof item.message === 'string' && item.message.startsWith('STALL_')) || (item.data && item.data.type === 'STALL_SNAPSHOT');
        if (isStall) {
          const stallData = item.data || {};
          const mediaPath = stallData.mediaPath || (stallData.mediaState ? stallData.mediaState.mediaPath : null);
          const rangeSlice = getRecentRangeLifecycles({ sinceMs: 30000, mediaPath: mediaPath, limit: 10 });
          stallData.serverRangeEvidence = rangeSlice;
          item.data = stallData;
        }
        const line = `[${new Date().toISOString()}] [${req.socket.remoteAddress}] [${item.level || 'INFO'}] ${item.message} ${item.data ? JSON.stringify(item.data) : ''}\n`;
        fs.appendFileSync(path.join(__dirname, 'live_client.log'), line);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Telemetry status and summary
  if (pathname === '/api/telemetry' && req.method === 'GET') {
    const now = Date.now();
    const ageMs = lastIphoneTelemetryAt > 0 ? (now - lastIphoneTelemetryAt) : -1;
    let state = 'offline';
    if (ageMs >= 0 && ageMs <= 3000) state = 'active';
    else if (ageMs > 3000 && ageMs <= 10000) state = 'stale';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      serverOnline: true,
      iphoneStatus: {
        state,
        ageMs: ageMs >= 0 ? ageMs : null,
        lastSeenAt: lastIphoneTelemetryAt > 0 ? new Date(lastIphoneTelemetryAt).toISOString() : null
      },
      latestTelemetry: latestTelemetry || null
    }, null, 2));
    return;
  }

  if (pathname === '/api/telemetry' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        payload.serverTimestamp = new Date().toISOString();
        payload.clientIp = req.socket.remoteAddress;

        if (payload.type === 'telemetry_sync') {
          lastIphoneTelemetryAt = Date.now();
          latestTelemetry = payload;
          if (payload.perf && typeof payload.perf.windowSeq === 'number') {
            if (payload.perf.windowSeq !== lastLoggedPerfWindowSeq) {
              lastLoggedPerfWindowSeq = payload.perf.windowSeq;
              const perfLog = path.join(__dirname, 'prototype_perf_telemetry.log');
              const p = payload.perf;
              const cad = p.cadence || {};
              const ft = p.frameTimeMs || {};
              const pb = p.playback || {};
              const q = pb.quality || {};
              const mName = payload.mediaName || (payload.mediaPath ? payload.mediaPath.split('/').pop() : '--');
              const dDrop = (typeof q.windowDeltaDropped !== 'undefined') ? q.windowDeltaDropped : '--';
              const dTot = (typeof q.windowDeltaTotal !== 'undefined') ? q.windowDeltaTotal : '--';
              const dRate = (typeof q.windowDropRate !== 'undefined') ? q.windowDropRate + '%' : '--';
              const line = `[${payload.serverTimestamp}] Win:#${p.windowSeq} Mode:${p.performanceMode} Scale:${p.renderScale}x Media:${mName} Net:${pb.networkState} | rAF:${cad.rafPerSec} rVFC:${cad.rvfcPerSec} VidUp:${cad.videoUploadsPerSec} | avgFT:${ft.avg}ms p95FT:${ft.p95}ms | WinDropRate:${dRate} (dDrop:${dDrop}/dTot:${dTot})\n`;
              fs.appendFileSync(perfLog, line, 'utf8');
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', received: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Diagnostic session structured telemetry persistence
  if (req.method === 'POST' && pathname === '/api/diagnostic-session') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        payload.serverTimestamp = new Date().toISOString();
        payload.clientIp = req.socket.remoteAddress;
        const logFile = path.join(__dirname, 'diagnostic_sessions.log');
        fs.appendFileSync(logFile, JSON.stringify(payload) + '\n', 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Media Root endpoints
  if (pathname === '/api/media-root' && req.method === 'GET') {
    const currentRoot = getActiveMediaRoot();
    const videos = getCachedVideos();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ root: currentRoot, videoCount: videos.length }));
    return;
  }

  if (pathname === '/api/media-root' && req.method === 'POST') {
    if (!isLoopbackIp(req.socket.remoteAddress)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Media root mutation is only allowed from loopback PC interface (127.0.0.1)' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const result = setActiveMediaRoot(payload.root);
        broadcastCalibrationEvent({ type: 'media_root_updated', root: result.root, videoCount: result.videoCount });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Video list from real media folder (instant cached)
  if (pathname === '/api/videos') {
    const activeRoot = getActiveMediaRoot();
    let videos = getCachedVideos();
    if (videos.length === 0) videos = scanRealVRVideos();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ mediaRoot: activeRoot, count: videos.length, videos: videos }));
    return;
  }

  // Video streaming endpoint (supports ?path=... or default first video)
  if (pathname === '/video' || pathname === '/sample.mp4') {
    const relParam = urlObj.searchParams.get('path');
    let targetPath = null;

    if (relParam) {
      targetPath = resolveSecureMediaPath(relParam);
      if (!targetPath) {
        console.warn(`[Security] Path outside allowed roots or missing: ${relParam}`);
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Access denied or file not found in media roots');
        return;
      }
    } else {
      let videos = getCachedVideos();
      if (videos.length === 0) videos = scanRealVRVideos();
      if (videos.length > 0) targetPath = videos[0].fullPath;
    }

    if (targetPath && fs.existsSync(targetPath)) {
      streamVideo(req, res, targetPath);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Video not found');
    }
    return;
  }

  // Index HTML / Static page
  if (pathname === '/' || pathname === '/index.html') {
    if (!isHttps) {
      renderOnboardingPage(res);
      return;
    }
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
  }

  // Static assets (.html, .js, .mjs, .css, .json, .png, .svg)
  let safePath = path.normalize(path.join(__dirname, pathname));
  if (pathname === '/controller') safePath = path.join(__dirname, 'controller.html');
  if (pathname === '/native-diag' || pathname === '/native-diag.html') safePath = path.join(__dirname, 'native-video-diag.html');
  if (pathname === '/upload-diag' || pathname === '/upload-diag.html') safePath = path.join(__dirname, 'webgl-upload-diag.html');

  if (safePath.startsWith(__dirname) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    const ext = path.extname(safePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };
    if (mimeTypes[ext]) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] });
      fs.createReadStream(safePath).pipe(res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
}

function renderOnboardingPage(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const localIps = getLocalIPs();
  const primaryIp = localIps.find(ip => ip.startsWith('192.168.')) || localIps[0] || '127.0.0.1';
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VREconder CA Onboarding</title><style>body{font-family:-apple-system,sans-serif;padding:20px;line-height:1.6;background:#0f172a;color:#f8fafc;margin:0;}.card{background:#1e293b;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #334155;}.btn{display:inline-block;background:#2563eb;color:white;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold;margin:8px 0;}.btn-green{background:#16a34a;}code{background:#334155;padding:2px 6px;border-radius:4px;font-size:0.9em;color:#38bdf8;}ol{padding-left:20px;}li{margin-bottom:8px;}.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:0.8em;font-weight:bold;background:#0284c7;}</style></head><body><h2>🔒 VREconder Local HTTPS CA Setup</h2><div class="card"><span class="badge">Step 1</span><h3>Download & Install Root CA Profile</h3><p>Tap below in iPhone Safari to download the root certificate:</p><a class="btn" href="/ca.crt">📥 Download Root CA Profile</a><ol><li>Tap <b>Allow</b> when Safari asks to download profile.</li><li>Open iPhone <b>Settings</b> &rarr; tap <b>Profile Downloaded</b> &rarr; tap <b>Install</b>.</li></ol></div><div class="card"><span class="badge">Step 2</span><h3>Enable Full Trust for Root CA</h3><ol><li>In iPhone <b>Settings</b>, go to: <code>General &gt; About &gt; Certificate Trust Settings</code>.</li><li>Turn ON <b>VREconder LAN Root CA</b> &rarr; tap <b>Continue</b>.</li></ol></div><div class="card"><span class="badge">Step 3</span><h3>Open Secure VR Player</h3><a class="btn btn-green" href="https://${primaryIp}:${HTTPS_PORT}/">🚀 Open HTTPS VR Player (https://${primaryIp}:${HTTPS_PORT})</a></div></body></html>`);
}

// Start Servers
ensureCertificates(CERTS_DIR);
scanRealVRVideos();

const localIps = getLocalIPs();
const primaryIp = localIps.find(ip => ip.startsWith('192.168.')) || localIps[0] || '127.0.0.1';

// HTTP Server
const httpServer = http.createServer((req, res) => handleRequest(req, res, false));
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[HTTP Server]  Running on http://${primaryIp}:${HTTP_PORT} (for CA download / onboarding)`);
});

// HTTPS Server
const httpsOptions = {
  key: fs.readFileSync(path.join(CERTS_DIR, 'server.key')),
  cert: fs.readFileSync(path.join(CERTS_DIR, 'server.crt'))
};

const httpsServer = https.createServer(httpsOptions, (req, res) => handleRequest(req, res, true));
httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log(`[HTTPS Server] Running on https://${primaryIp}:${HTTPS_PORT} (Secure VR Player)`);
  console.log(`[Media Root]   Streaming VR videos from: ${getActiveMediaRoot()}`);
  console.log(`\n============================================================`);
  console.log(`⚡ [Automated Safari Preflight / 兼容性因果测试]:`);
  console.log(`   👉 https://${primaryIp}:${HTTPS_PORT}/compat-preflight`);
  console.log(`💻 [PC Controller / 电脑控制台]:`);
  console.log(`   👉 https://127.0.0.1:${HTTPS_PORT}/controller.html`);
  console.log(`📱 [iPhone VR Headset / 手机VR头显]:`);
  console.log(`   👉 https://${primaryIp}:${HTTPS_PORT}/`);
  console.log(`============================================================\n`);
});

// Periodic SSE keepalive heartbeat
setInterval(() => {
  broadcastCalibrationEvent({ type: 'heartbeat', timestamp: Date.now() });
}, 3000);
