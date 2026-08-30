import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  getLocalIPs,
  ensureCertificates,
  renderHevcDiagnosticPage,
  isLoopbackIp,
  getActiveMediaRoot,
  setActiveMediaRoot,
  scanRealVRVideos,
  getCachedVideos
} from './src/server/cert-helper.mjs';
import { streamVideo } from './src/media/video-streamer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const CERTS_DIR = path.join(__dirname, 'certs');

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

function handleRequest(req, res, isHttps) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  if (pathname !== '/api/calibration/events') {
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

  // Real-time Calibration Events SSE stream (PC <-> iPhone live bridge)
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

  // Real-time Calibration Control endpoint (broadcasts actions to connected clients)
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

  // Client Diagnostic Logger (Captures phone & PC browser actions & errors in real-time)
  if (pathname === '/api/log' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        const line = `[${new Date().toISOString()}] [${req.socket.remoteAddress}] [${item.level || 'INFO'}] ${item.message} ${item.data ? JSON.stringify(item.data) : ''}\n`;
        fs.appendFileSync(path.join(__dirname, 'live_client.log'), line);
        console.log(`[Client Log] ${item.level}: ${item.message}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Telemetry endpoint
  if (pathname === '/api/telemetry' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        payload.serverTimestamp = new Date().toISOString();
        payload.clientIp = req.socket.remoteAddress;
        
        latestTelemetry = payload;

        // If it's a UX interaction event or metric summary
        if (payload.type === 'ux_event') {
          console.log(`[UX Event] Pattern ${payload.pattern} | ${payload.event} | target: ${payload.target || 'none'} | dwell: ${payload.dwellMs || 0}ms | timeToCmd: ${payload.timeToCmdMs || 0}ms | travel: ${payload.travelDeg ? payload.travelDeg.toFixed(1) : 0}°`);
        } else if (payload.type === 'ux_summary') {
          console.log(`[UX Summary] Pattern ${payload.pattern} | Activations: ${payload.activations} | Cancels: ${payload.cancels} | AvgDwell: ${payload.avgDwellMs}ms | AvgTimeToCmd: ${payload.avgTimeToCmdMs}ms | Travel: ${payload.travelDeg.toFixed(1)}°`);
          // Save to local prototype evidence JSON
          const summaryFile = path.join(__dirname, 'prototype_ux_telemetry.json');
          fs.writeFileSync(summaryFile, JSON.stringify(payload, null, 2), 'utf8');
        } else if (payload.type === 'telemetry_sync') {
          if (payload.perf && typeof payload.perf.windowSeq === 'number') {
            if (payload.perf.windowSeq !== lastLoggedPerfWindowSeq) {
              lastLoggedPerfWindowSeq = payload.perf.windowSeq;
              const perfLog = path.join(__dirname, 'prototype_perf_telemetry.log');
              const p = payload.perf;
              const cad = p.cadence || {};
              const ft = p.frameTimeMs || {};
              const pb = p.playback || {};
              const line = `[${payload.serverTimestamp}] Win:#${p.windowSeq} Mode:${p.performanceMode} Scale:${p.renderScale}x | rAF:${cad.rafPerSec} rVFC:${cad.rvfcPerSec} VidUp:${cad.videoUploadsPerSec} UIUp:${cad.uiUploadsPerSec} | avgFT:${ft.avg}ms p95FT:${ft.p95}ms maxFT:${ft.max}ms | Dropped:${pb.quality?.droppedVideoFrames} BufAhead:${pb.bufferAheadSec}s | Ready:${pb.readyState}\n`;
              fs.appendFileSync(perfLog, line, 'utf8');
            }
          }
        } else {
          const s = payload.state || {};
          const reason = payload.reason || 'update';
          const fwd = s.cameraForward ? `fwd:(${s.cameraForward.map(n=>n.toFixed(2)).join(',')})` : '';
          const up = s.cameraUp ? `up:(${s.cameraUp.map(n=>n.toFixed(2)).join(',')})` : '';
          const sa = `stand:${s.standalone ? 'YES' : 'no'}`;
          const vp = s.viewport ? `${s.viewport.w}x${s.viewport.h}` : '';
          console.log(`[Telemetry (${reason})] inVR:${s.inVR} | ${sa} | ang:${s.screenAngle}° | FPS:${s.fps} | ${fwd} ${up} | mode:${s.stereoMode} | time:${s.currentTime}s | vp:${vp}`);
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

  // Profiles storage endpoints
  const VIDEO_PROFILES_FILE = path.join(__dirname, 'prototype_video_profiles.json');
  const VIEWER_PROFILE_FILE = path.join(__dirname, 'prototype_viewer_profile.json');

  function normalizeServerVideoProfile(raw, defaultMediaId = '') {
    if (!raw) return null;
    const mediaId = raw.mediaId || defaultMediaId;
    let projection = raw.projection || 'unknown';
    let horizontalCoverageDeg = (typeof raw.horizontalCoverageDeg === 'number')
      ? raw.horizontalCoverageDeg
      : ((typeof raw.fovHorizontalDeg === 'number') ? raw.fovHorizontalDeg : 180);
    let verticalCoverageDeg = (typeof raw.verticalCoverageDeg === 'number')
      ? raw.verticalCoverageDeg
      : ((typeof raw.fovVerticalDeg === 'number') ? raw.fovVerticalDeg : 180);

    if (projection === 'equirectangular-180') {
      projection = 'equirectangular';
      horizontalCoverageDeg = 180;
      verticalCoverageDeg = 180;
    } else if (projection === 'equirectangular-360') {
      projection = 'equirectangular';
      horizontalCoverageDeg = 360;
      verticalCoverageDeg = 180;
    } else if (projection !== 'equirectangular' && projection !== 'flat') {
      projection = 'unknown';
    }

    let stereoMode = raw.stereoMode || 'unknown';
    if (!['left-right', 'top-bottom', 'mono', 'unknown'].includes(stereoMode)) stereoMode = 'unknown';

    let eyeOrder = raw.eyeOrder || 'unknown';
    if (eyeOrder === 'left-first') eyeOrder = 'left-right';
    else if (eyeOrder === 'right-first') eyeOrder = 'right-left';
    if (!['left-right', 'right-left', 'unknown'].includes(eyeOrder)) eyeOrder = 'unknown';

    return {
      mediaId,
      name: raw.name || '',
      projection,
      horizontalCoverageDeg,
      verticalCoverageDeg,
      stereoMode,
      eyeOrder,
      crop: raw.crop || { top: 0, bottom: 0, left: 0, right: 0 },
      pose: raw.pose || { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      confidence: raw.confidence || 'unverified',
      notes: raw.notes || 'Awaiting Stage A calibration in Flat Diagnostic View',
      updatedAt: raw.updatedAt || new Date().toISOString()
    };
  }

  if ((pathname === '/api/profiles' || pathname === '/api/profiles/videos') && req.method === 'GET') {
    let videoProfiles = {};
    let viewerProfile = null;
    try {
      if (fs.existsSync(VIDEO_PROFILES_FILE)) {
        const rawMap = JSON.parse(fs.readFileSync(VIDEO_PROFILES_FILE, 'utf8'));
        for (const [k, v] of Object.entries(rawMap)) {
          videoProfiles[k] = normalizeServerVideoProfile(v, k);
        }
      }
      if (fs.existsSync(VIEWER_PROFILE_FILE)) {
        viewerProfile = JSON.parse(fs.readFileSync(VIEWER_PROFILE_FILE, 'utf8'));
        if (viewerProfile && (viewerProfile.confidence === 'working-user-tuned' || viewerProfile.viewerProfileId === 'viewer:my_profile')) {
          viewerProfile.isCalibrated = false;
          viewerProfile.source = 'User-tuned Working Profile (Unvalidated)';
        }
      }
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ videoProfiles, viewerProfile }));
    return;
  }

  if ((pathname === '/api/profiles/video' || pathname === '/api/profiles/videos') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const profile = JSON.parse(body);
        let existing = {};
        if (fs.existsSync(VIDEO_PROFILES_FILE)) {
          try {
            const rawMap = JSON.parse(fs.readFileSync(VIDEO_PROFILES_FILE, 'utf8'));
            for (const [k, v] of Object.entries(rawMap)) {
              existing[k] = normalizeServerVideoProfile(v, k);
            }
          } catch (e) {}
        }
        if (profile && profile.mediaId) {
          const canonical = normalizeServerVideoProfile(profile, profile.mediaId);
          existing[profile.mediaId] = canonical;
          fs.writeFileSync(VIDEO_PROFILES_FILE, JSON.stringify(existing, null, 2), 'utf8');
          console.log(`[Profile] Saved Projection Profile for ${profile.mediaId} (${canonical.projection})`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', saved: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/profiles/viewer' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const profile = JSON.parse(body);
        if (profile && (profile.confidence === 'working-user-tuned' || profile.viewerProfileId === 'viewer:my_profile')) {
          profile.confidence = 'working-user-tuned';
          profile.isCalibrated = false;
          profile.source = 'User-tuned Working Profile (Unvalidated)';
        }
        fs.writeFileSync(VIEWER_PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf8');
        console.log(`[Profile] Saved Viewer Profile: ${profile.viewerProfileId} (Lens: ${profile.lensCorrectionEnabled ? 'ON' : 'OFF'})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', saved: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/profiles/viewer' && req.method === 'GET') {
    let viewerProfile = null;
    try {
      if (fs.existsSync(VIEWER_PROFILE_FILE)) viewerProfile = JSON.parse(fs.readFileSync(VIEWER_PROFILE_FILE, 'utf8'));
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(viewerProfile));
    return;
  }

  // Telemetry status and summary
  if (pathname === '/api/telemetry' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ latestTelemetry }, null, 2));
    return;
  }

  // Media Root endpoints (Issue #19 SSOT Media Root Selector)
  if (pathname === '/api/media-root' && req.method === 'GET') {
    const currentRoot = getActiveMediaRoot();
    const videos = getCachedVideos();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      root: currentRoot,
      videoCount: videos.length
    }));
    return;
  }

  if (pathname === '/api/media-root' && req.method === 'POST') {
    if (!isLoopbackIp(req.socket.remoteAddress)) {
      console.warn(`[Security] Rejected /api/media-root mutation from non-loopback IP: ${req.socket.remoteAddress}`);
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Media root mutation is only allowed from loopback PC interface (127.0.0.1)' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const newRoot = payload.root;
        const result = setActiveMediaRoot(newRoot);
        console.log(`[Media] Media root successfully switched to: ${result.root} (${result.videoCount} videos found)`);
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
    if (videos.length === 0) {
      videos = scanRealVRVideos();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ mediaRoot: activeRoot, count: videos.length, videos: videos }));
    return;
  }

  // Video streaming endpoint (supports ?path=... or default /sample.mp4)
  if (pathname === '/video' || pathname === '/sample.mp4') {
    const activeRoot = getActiveMediaRoot();
    const relParam = urlObj.searchParams.get('path');
    let targetPath = '';

    if (relParam) {
      const resolved = path.resolve(activeRoot, relParam);
      // Hard security check: ensure targetPath is within activeRoot to prevent directory traversal
      const relToRoot = path.relative(activeRoot, resolved);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        console.warn(`[Security] Path traversal attempt blocked: ${relParam} (resolved: ${resolved})`);
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Access denied: path outside media root');
        return;
      }
      targetPath = resolved;
    } else {
      let videos = getCachedVideos();
      if (videos.length === 0) videos = scanRealVRVideos();
      if (videos.length > 0) {
        targetPath = videos[0].fullPath;
      }
    }

    if (targetPath && fs.existsSync(targetPath)) {
      streamVideo(req, res, targetPath);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Video not found in ${activeRoot}`);
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
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
  }

  // Static assets (.html, .js, .mjs, .css, .json, .png, .svg)
  let safePath = path.normalize(path.join(__dirname, pathname));
  if (pathname === '/controller') safePath = path.join(__dirname, 'controller.html');
  if (pathname === '/hevc-diag' || pathname === '/hevc-diag.html') {
    renderHevcDiagnosticPage(res);
    return;
  }
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
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] });
      fs.createReadStream(safePath).pipe(res);
      return;
    }
  }

function renderOnboardingPage(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const localIps = getLocalIPs();
  const primaryIp = localIps.find(ip => ip.startsWith('192.168.')) || localIps[0] || '127.0.0.1';
  res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VREconder CA Onboarding</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; line-height: 1.6; background: #0f172a; color: #f8fafc; margin: 0; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 20px; border: 1px solid #334155; }
    .btn { display: inline-block; background: #2563eb; color: white; padding: 14px 20px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 10px 0; text-align: center; }
    .btn-green { background: #16a34a; }
    code { background: #334155; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; color: #38bdf8; }
    ol { padding-left: 20px; }
    li { margin-bottom: 12px; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold; background: #0284c7; }
  </style>
</head>
<body>
  <h2>🔒 VREconder Local HTTPS CA Setup</h2>
  <div class="card">
    <span class="badge">Step 1</span>
    <h3>Download & Install Root CA Profile</h3>
    <p>Tap below in iPhone Safari to download the root certificate:</p>
    <a class="btn" href="/ca.crt">📥 Download Root CA Profile</a>
    <ol>
      <li>Tap <b>Allow</b> when Safari asks to download profile.</li>
      <li>Open iPhone <b>Settings</b> &rarr; tap <b>Profile Downloaded</b> &rarr; tap <b>Install</b>.</li>
    </ol>
  </div>
  <div class="card">
    <span class="badge">Step 2</span>
    <h3>Enable Full Trust for Root CA</h3>
    <ol>
      <li>In iPhone <b>Settings</b>, go to: <code>General &gt; About &gt; Certificate Trust Settings</code>.</li>
      <li>Turn ON <b>VREconder LAN Root CA</b> &rarr; tap <b>Continue</b>.</li>
    </ol>
  </div>
  <div class="card">
    <span class="badge">Step 3</span>
    <h3>Open Secure VR Player</h3>
    <a class="btn btn-green" href="https://${primaryIp}:${HTTPS_PORT}/">🚀 Open HTTPS VR Player (https://${primaryIp}:${HTTPS_PORT})</a>
  </div>
</body>
</html>`);
}

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
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
  console.log(`[Media Root]   Directly streaming real VR videos from: ${getActiveMediaRoot()}`);
  console.log(`\n============================================================`);
  console.log(`💻 [PC Controller / 电脑控制台]:`);
  console.log(`   👉 https://127.0.0.1:${HTTPS_PORT}/controller.html`);
  console.log(`   👉 https://${primaryIp}:${HTTPS_PORT}/controller.html`);
  console.log(`\n📱 [iPhone VR Headset / 手机VR头显]:`);
  console.log(`   👉 https://${primaryIp}:${HTTPS_PORT}/`);
  console.log(`\n📥 [CA Certificate Onboarding / 首次证书安装]:`);
  console.log(`   👉 http://${primaryIp}:${HTTP_PORT}/`);
  console.log(`============================================================\n`);
});

// Periodic SSE keepalive heartbeat
setInterval(() => {
  broadcastCalibrationEvent({ type: 'heartbeat', timestamp: Date.now() });
}, 3000);
