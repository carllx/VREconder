import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const CERTS_DIR = path.join(__dirname, 'certs');
const MEDIA_ROOT = 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed';

// Scan actual VR videos from G drive and cache in memory
let cachedVideos = [];
function scanRealVRVideos() {
  const results = [];
  function scan(dir, relDir = '') {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      const relPath = path.join(relDir, ent.name);
      if (ent.isDirectory()) {
        scan(fullPath, relPath);
      } else if (ent.isFile() && /\.(mp4|mov|m4v)$/i.test(ent.name)) {
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            name: ent.name,
            relPath: relPath.replace(/\\/g, '/'),
            fullPath: fullPath,
            sizeBytes: stat.size,
            sizeGB: (stat.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
          });
        } catch (e) {}
      }
    }
  }
  scan(MEDIA_ROOT);
  cachedVideos = results;
  console.log(`[Media] Scanned and cached ${cachedVideos.length} VR videos from ${MEDIA_ROOT}`);
  return results;
}

// Collect all local IPv4 addresses
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

// Generate Certificates if not present
function ensureCertificates() {
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }

  const caKey = path.join(CERTS_DIR, 'ca.key');
  const caCrt = path.join(CERTS_DIR, 'ca.crt');
  const serverKey = path.join(CERTS_DIR, 'server.key');
  const serverCsr = path.join(CERTS_DIR, 'server.csr');
  const serverCrt = path.join(CERTS_DIR, 'server.crt');
  const extCnf = path.join(CERTS_DIR, 'ext.cnf');

  if (fs.existsSync(caCrt) && fs.existsSync(serverCrt) && fs.existsSync(serverKey)) {
    console.log('[Cert] Using existing certificates in', CERTS_DIR);
    return;
  }

  console.log('[Cert] Generating local Root CA and Server Certificate with OpenSSL...');
  const localIps = getLocalIPs();
  const hostname = os.hostname();

  // 1. Root CA
  if (!fs.existsSync(caKey) || !fs.existsSync(caCrt)) {
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${caKey}" -out "${caCrt}" -days 3650 -subj "/CN=VREconder LAN Root CA/O=VREconder/OU=Dev"`, { stdio: 'inherit' });
  }

  // 2. Server SAN config
  let sanList = ['IP.1 = 127.0.0.1', 'DNS.1 = localhost', `DNS.2 = ${hostname}`, `DNS.3 = ${hostname}.local`];
  localIps.forEach((ip, idx) => {
    sanList.push(`IP.${idx + 2} = ${ip}`);
  });

  const extContent = `
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
${sanList.join('\n')}
`;
  fs.writeFileSync(extCnf, extContent.trim(), 'utf8');

  // 3. Server CSR & Cert
  execSync(`openssl req -newkey rsa:2048 -nodes -keyout "${serverKey}" -out "${serverCsr}" -subj "/CN=VREconder Server/O=VREconder/OU=Dev"`, { stdio: 'inherit' });
  execSync(`openssl x509 -req -in "${serverCsr}" -CA "${caCrt}" -CAkey "${caKey}" -CAcreateserial -out "${serverCrt}" -days 825 -extfile "${extCnf}"`, { stdio: 'inherit' });

  console.log('[Cert] Certificates generated successfully with SAN:\n' + sanList.join('\n'));
}

// Range Request handler for MP4
function streamVideo(req, res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Video file not found: ' + filePath);
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    });
    res.end();
    return;
  }

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Content-Type': 'video/mp4'
      });
      res.end();
      return;
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*'
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
}

let latestTelemetry = null;

function handleRequest(req, res, isHttps) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

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

  // Telemetry endpoint
  if (pathname === '/api/telemetry' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        latestTelemetry = JSON.parse(body);
        latestTelemetry.serverTimestamp = new Date().toISOString();
        latestTelemetry.clientIp = req.socket.remoteAddress;
        
        const s = latestTelemetry.state || {};
        const reason = latestTelemetry.reason || 'update';
        const fwd = s.cameraForward ? `fwd:(${s.cameraForward.map(n=>n.toFixed(2)).join(',')})` : '';
        const up = s.cameraUp ? `up:(${s.cameraUp.map(n=>n.toFixed(2)).join(',')})` : '';
        const sa = `stand:${s.standalone ? 'YES' : 'no'}`;
        const vp = s.viewport ? `${s.viewport.w}x${s.viewport.h}` : '';

        console.log(`[Telemetry (${reason})] inVR:${s.inVR} | ${sa} | ang:${s.screenAngle}° | FPS:${s.fps} | ${fwd} ${up} | mode:${s.stereoMode} | time:${s.currentTime}s | vp:${vp}`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', received: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Telemetry status
  if (pathname === '/api/telemetry' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ latestTelemetry }, null, 2));
    return;
  }

  // Video list from real media folder (instant cached)
  if (pathname === '/api/videos') {
    if (cachedVideos.length === 0) {
      scanRealVRVideos();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ mediaRoot: MEDIA_ROOT, count: cachedVideos.length, videos: cachedVideos }));
    return;
  }

  // Video streaming endpoint (supports ?path=... or default /sample.mp4)
  if (pathname === '/video' || pathname === '/sample.mp4') {
    const relParam = urlObj.searchParams.get('path');
    let targetPath = '';
    if (relParam) {
      targetPath = path.join(MEDIA_ROOT, relParam);
    } else {
      if (cachedVideos.length === 0) scanRealVRVideos();
      if (cachedVideos.length > 0) {
        targetPath = cachedVideos[0].fullPath;
      }
    }

    if (targetPath && fs.existsSync(targetPath)) {
      streamVideo(req, res, targetPath);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Video not found in ${MEDIA_ROOT}`);
    }
    return;
  }

  // Index HTML / Static page
  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
  }

  // Fallback for HTTP Onboarding page
  if (!isHttps) {
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
      <li>Tap <b>Allow</b> when Safari asks <i>"This website is trying to download a configuration profile. Do you want to allow this?"</i>.</li>
      <li>Open iPhone <b>Settings</b> &rarr; tap <b>Profile Downloaded</b> (top of Settings) &rarr; tap <b>Install</b> (enter device PIN) &rarr; tap <b>Install</b> again.</li>
    </ol>
  </div>

  <div class="card">
    <span class="badge">Step 2</span>
    <h3>Enable Full Trust for Root CA</h3>
    <ol>
      <li>In iPhone <b>Settings</b>, navigate to: <br><code>General &gt; About &gt; Certificate Trust Settings</code> (scroll to the very bottom).</li>
      <li>Under <b>ENABLE FULL TRUST FOR ROOT CERTIFICATES</b>, turn ON the switch for <b>VREconder LAN Root CA</b>.</li>
      <li>Tap <b>Continue</b> on the warning modal.</li>
    </ol>
  </div>

  <div class="card">
    <span class="badge">Step 3</span>
    <h3>Open Secure Context Probe</h3>
    <p>After completing Step 1 & 2, open the HTTPS origin probe:</p>
    <a class="btn btn-green" href="https://${primaryIp}:${HTTPS_PORT}/">🚀 Open HTTPS VR Player (https://${primaryIp}:${HTTPS_PORT})</a>
  </div>
</body>
</html>`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
}

// Start Servers
ensureCertificates();
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
  console.log(`[Media Root]   Directly streaming real VR videos from: ${MEDIA_ROOT}`);
  console.log(`\n============================================================`);
  console.log(`👉 1. On iPhone Safari, open:  http://${primaryIp}:${HTTP_PORT}`);
  console.log(`👉 2. Install CA and enable Full Trust in Settings`);
  console.log(`👉 3. Open Secure Probe:       https://${primaryIp}:${HTTPS_PORT}`);
  console.log(`============================================================\n`);
});
