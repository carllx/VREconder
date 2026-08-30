import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

export function getLocalIPs() {
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

export function ensureCertificates(certsDir) {
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
  }

  const caKey = path.join(certsDir, 'ca.key');
  const caCrt = path.join(certsDir, 'ca.crt');
  const serverKey = path.join(certsDir, 'server.key');
  const serverCsr = path.join(certsDir, 'server.csr');
  const serverCrt = path.join(certsDir, 'server.crt');
  const extCnf = path.join(certsDir, 'ext.cnf');

  if (fs.existsSync(caCrt) && fs.existsSync(serverCrt) && fs.existsSync(serverKey)) {
    return { caCrt, serverCrt, serverKey };
  }

  console.log('[Cert] Generating local Root CA and Server Certificate with OpenSSL...');
  const localIps = getLocalIPs();
  const hostname = os.hostname();

  if (!fs.existsSync(caKey) || !fs.existsSync(caCrt)) {
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${caKey}" -out "${caCrt}" -days 3650 -subj "/CN=VREconder LAN Root CA/O=VREconder/OU=Dev"`, { stdio: 'inherit' });
  }

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

  execSync(`openssl req -newkey rsa:2048 -nodes -keyout "${serverKey}" -out "${serverCsr}" -subj "/CN=VREconder Server/O=VREconder/OU=Dev"`, { stdio: 'inherit' });
  execSync(`openssl x509 -req -in "${serverCsr}" -CA "${caCrt}" -CAkey "${caKey}" -CAcreateserial -out "${serverCrt}" -days 825 -extfile "${extCnf}"`, { stdio: 'inherit' });

  console.log('[Cert] Certificates generated successfully with SAN:\n' + sanList.join('\n'));
  return { caCrt, serverCrt, serverKey };
}

// Media Root & Scanner SSOT State
let activeMediaRoot = path.normalize('G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed');
let cachedVideos = [];

export function isLoopbackIp(remoteAddress) {
  if (!remoteAddress) return false;
  const cleaned = remoteAddress.replace(/^::ffff:/, '');
  if (cleaned === '127.0.0.1' || cleaned === '::1' || cleaned === 'localhost') return true;
  const localIps = getLocalIPs();
  return localIps.includes(cleaned);
}

export function getActiveMediaRoot() {
  return activeMediaRoot;
}

export function getCachedVideos() {
  return cachedVideos;
}

export function scanRealVRVideos(customRoot = null) {
  const root = customRoot || activeMediaRoot;
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
  scan(root);
  cachedVideos = results;
  console.log(`[Media] Scanned and cached ${cachedVideos.length} VR videos from ${root}`);
  return results;
}

export function setActiveMediaRoot(newRoot) {
  if (!newRoot || typeof newRoot !== 'string') {
    throw new Error('Media root path must be a non-empty string');
  }
  const normalized = path.normalize(newRoot.trim());
  if (!path.isAbsolute(normalized)) {
    throw new Error('Media root path must be an absolute path');
  }
  if (!fs.existsSync(normalized)) {
    throw new Error('Media root path does not exist');
  }
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    throw new Error('Media root path must be a directory');
  }
  activeMediaRoot = normalized;
  scanRealVRVideos(normalized);
  return { ok: true, root: activeMediaRoot, videoCount: cachedVideos.length };
}

export function renderHevcDiagnosticPage(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>VREconder - HEVC 3-Way Codec Diagnostic</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #090d16; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; padding: 12px; }
    h1 { font-size: 1.1rem; color: #38bdf8; margin-bottom: 8px; }
    .card { background: #131b2e; border: 1px solid #243048; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
    button { background: #1e293b; color: #fff; border: 1px solid #334155; padding: 8px 12px; border-radius: 6px; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
    button.active { background: #2563eb; border-color: #60a5fa; }
    button.btn-action { background: #059669; }
    select { width: 100%; background: #1e293b; color: #fff; border: 1px solid #334155; padding: 8px; border-radius: 6px; font-size: 0.82rem; margin-top: 4px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    @media (max-width: 768px) { .grid-3 { grid-template-columns: 1fr; } }
    .view-box { background: #000; border: 1px solid #334155; border-radius: 6px; padding: 6px; display: flex; flex-direction: column; align-items: center; }
    .view-title { font-size: 0.78rem; font-weight: bold; margin-bottom: 4px; color: #93c5fd; }
    video, canvas { width: 100%; height: 180px; object-fit: contain; background: #020617; border: 1px solid #1e293b; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.72rem; margin-top: 8px; }
    th, td { border: 1px solid #1e293b; padding: 4px 6px; text-align: left; }
    th { background: #0f172a; color: #94a3b8; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.7rem; }
    .badge-ok { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge-err { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .badge-warn { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
  </style>
</head>
<body>
  <h1>🔬 VREconder HEVC 3-Way Diagnostic (A/B Test)</h1>
  <div class="card">
    <div style="font-size:0.75rem; font-weight:bold; color:#94a3b8; text-transform:uppercase;">Select Sample Candidate:</div>
    <div class="btn-row">
      <button id="btnMeiHev1" onclick="pickPreset('tnb/Mei Matsumoto-TD- Vr Japanese, Mei Matsumoto, Mei Matsumoto Vr Porn - SpankBang-HEVC.mp4')">0. Mei (HEVC hev1)</button>
      <button id="btnMeiHvc1" onclick="pickPreset('tnb/Mei Matsumoto-TD- Vr Japanese, Mei Matsumoto, Mei Matsumoto Vr Porn - SpankBang-HEVC_HVC1.mp4')">0b. Mei (HEVC hvc1 Sibling)</button>
      <button id="btnAmatsukiHev1" class="active" onclick="pickPreset('4096_2048_crf21_avc1-Amatsuki Azu(Hoshi Nako) - VRKM1502.mp4 - (HEVC_23.0).mp4')">1. Amatsuki (HEVC hev1)</button>
      <button id="btnAmatsukiHvc1" onclick="pickPreset('4096_2048_crf21_avc1-Amatsuki Azu(Hoshi Nako) - VRKM1502.mp4 - (HEVC_23.0)_HVC1.mp4')">2. Amatsuki (HEVC hvc1 Sibling)</button>
      <button id="btnHarunaHev1" onclick="pickPreset('4096_2048_crf21_avc1-Haruna Noa - KIWVR739.mp4 - (HEVC_23.0).mp4')">3. Haruna (HEVC hev1)</button>
      <button id="btnHarunaHvc1" onclick="pickPreset('4096_2048_crf21_avc1-Haruna Noa - KIWVR739.mp4 - (HEVC_23.0)_HVC1.mp4')">4. Haruna (HEVC hvc1 Sibling)</button>
      <button id="btnAvc1Ref" onclick="pickPreset('4K/4096_2048_crf18_avc1-Kururugi Aoi - WAVR224.mp4')">5. AVC Control (avc1)</button>
    </div>
    <select id="selAllVideos" onchange="pickPreset(this.value)"></select>
    <div class="btn-row" style="margin-top:8px;">
      <button class="btn-action" onclick="togglePlay()">Play / Pause</button>
      <button onclick="reloadVideo()">Reload Video</button>
      <button onclick="reportTelemetry()">Send Diagnostic Log</button>
    </div>
  </div>
  <div class="card">
    <div class="grid-3">
      <div class="view-box">
        <div class="view-title">A. Native Visible &lt;video&gt;</div>
        <video id="diagVideo" playsinline preload="auto" crossorigin="anonymous" muted controls autoplay></video>
        <div id="statusNative" style="font-size:0.7rem; margin-top:4px;">Pixel State: <span class="badge badge-warn">Probing...</span></div>
      </div>
      <div class="view-box">
        <div class="view-title">B. Canvas2D drawImage(video)</div>
        <canvas id="c2dCanvas"></canvas>
        <div id="statusC2D" style="font-size:0.7rem; margin-top:4px;">Pixel State: <span class="badge badge-warn">Probing...</span></div>
      </div>
      <div class="view-box">
        <div class="view-title">C. WebGL texImage2D(video)</div>
        <canvas id="webglCanvas"></canvas>
        <div id="statusWebGL" style="font-size:0.7rem; margin-top:4px;">Pixel State: <span class="badge badge-warn">Probing...</span></div>
      </div>
    </div>
  </div>
  <div class="card">
    <div style="font-size:0.75rem; font-weight:bold; color:#94a3b8; text-transform:uppercase;">Live Diagnostic Metrics</div>
    <table>
      <thead><tr><th>Parameter</th><th>Value</th><th>Interpretation / Status</th></tr></thead>
      <tbody>
        <tr><td>Active File</td><td id="mFile">--</td><td id="mCodecTag">--</td></tr>
        <tr><td>video.error</td><td id="mError">null</td><td id="mErrorCode">None</td></tr>
        <tr><td>readyState / networkState</td><td id="mStates">0 / 0</td><td id="mStatesDesc">HAVE_NOTHING</td></tr>
        <tr><td>videoWidth &times; videoHeight</td><td id="mDimensions">0 &times; 0</td><td id="mAspect">--</td></tr>
        <tr><td>currentTime / duration</td><td id="mTime">0.0s / 0.0s</td><td id="mPaused">paused: false</td></tr>
        <tr><td>rVFC Frame Count</td><td id="mRvfcCount">0</td><td id="mRvfcMeta">none</td></tr>
        <tr><td>WebGL gl.getError()</td><td id="mGlError">NO_ERROR</td><td id="mGlStatus">OK</td></tr>
        <tr><td>getVideoPlaybackQuality()</td><td id="mQuality">--</td><td id="mDropRate">--</td></tr>
        <tr><td><b>Summary 2&times;3 Verdict</b></td><td colspan="2" id="mVerdict" style="font-weight:bold; color:#38bdf8;">Evaluating...</td></tr>
      </tbody>
    </table>
  </div>
  <script>
    const video = document.getElementById('diagVideo');
    const c2dCanvas = document.getElementById('c2dCanvas');
    const c2dCtx = c2dCanvas.getContext('2d');
    const glCanvas = document.getElementById('webglCanvas');
    const gl = glCanvas.getContext('webgl');
    let currentRelPath = '4096_2048_crf21_avc1-Amatsuki Azu(Hoshi Nako) - VRKM1502.mp4 - (HEVC_23.0).mp4';
    let rvfcCount = 0;
    let lastRvfcMeta = null;
    let glTexture = null;
    let glProgram = null;
    let glPosBuffer = null;
    let lastGlError = 'NO_ERROR';
    function initGL() {
      if (!gl) return;
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, "attribute vec2 aPos; varying vec2 vTexCoord; void main() { vTexCoord = vec2((aPos.x + 1.0)*0.5, (1.0 - aPos.y)*0.5); gl_Position = vec4(aPos, 0.0, 1.0); }");
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, "precision mediump float; uniform sampler2D uTex; varying vec2 vTexCoord; void main() { gl_FragColor = texture2D(uTex, vTexCoord); }");
      gl.compileShader(fs);
      glProgram = gl.createProgram();
      gl.attachShader(glProgram, vs);
      gl.attachShader(glProgram, fs);
      gl.linkProgram(glProgram);
      glPosBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, glPosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
      glTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, glTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    initGL();
    function onRvfc(now, metadata) {
      rvfcCount++;
      lastRvfcMeta = metadata;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onRvfc);
    }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onRvfc);
    function pickPreset(relPath) {
      currentRelPath = relPath;
      document.querySelectorAll('.btn-row button').forEach(b => b.classList.remove('active'));
      if (relPath.includes('Mei') && !relPath.includes('_HVC1')) document.getElementById('btnMeiHev1')?.classList.add('active');
      else if (relPath.includes('Mei') && relPath.includes('_HVC1')) document.getElementById('btnMeiHvc1')?.classList.add('active');
      else if (relPath.includes('VRKM1502') && !relPath.includes('_HVC1')) document.getElementById('btnAmatsukiHev1')?.classList.add('active');
      else if (relPath.includes('VRKM1502') && relPath.includes('_HVC1')) document.getElementById('btnAmatsukiHvc1')?.classList.add('active');
      else if (relPath.includes('KIWVR739') && !relPath.includes('_HVC1')) document.getElementById('btnHarunaHev1')?.classList.add('active');
      else if (relPath.includes('KIWVR739') && relPath.includes('_HVC1')) document.getElementById('btnHarunaHvc1')?.classList.add('active');
      else if (relPath.includes('WAVR224')) document.getElementById('btnAvc1Ref')?.classList.add('active');
      rvfcCount = 0;
      lastRvfcMeta = null;
      video.src = '/video?path=' + encodeURIComponent(relPath);
      video.load();
      video.play().catch(()=>{});
    }
    function togglePlay() { if (video.paused) video.play(); else video.pause(); }
    function reloadVideo() { pickPreset(currentRelPath); }
    function checkCanvasPixels(ctx, w, h) {
      try {
        const imgData = ctx.getImageData(Math.floor(w/4), Math.floor(h/4), Math.floor(w/2), Math.floor(h/2));
        const d = imgData.data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 16) sum += d[i] + d[i+1] + d[i+2];
        return sum > 100 ? 'IMAGE' : 'BLACK';
      } catch (e) { return 'UNKNOWN'; }
    }
    function checkWebGLPixels(w, h) {
      try {
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let sum = 0;
        for (let i = 0; i < pixels.length; i += 16) sum += pixels[i] + pixels[i+1] + pixels[i+2];
        return sum > 100 ? 'IMAGE' : 'BLACK';
      } catch (e) { return 'UNKNOWN'; }
    }
    function renderFrame() {
      const w = 320, h = 160;
      if (c2dCanvas.width !== w) c2dCanvas.width = w;
      if (c2dCanvas.height !== h) c2dCanvas.height = h;
      if (glCanvas.width !== w) glCanvas.width = w;
      if (glCanvas.height !== h) glCanvas.height = h;
      let c2dState = 'BLACK';
      let webglState = 'BLACK';
      if (video.readyState >= 2) {
        try { c2dCtx.drawImage(video, 0, 0, w, h); c2dState = checkCanvasPixels(c2dCtx, w, h); } catch (e) {}
        if (gl && glProgram) {
          try {
            gl.viewport(0, 0, w, h);
            gl.bindTexture(gl.TEXTURE_2D, glTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            const err = gl.getError();
            lastGlError = (err === gl.NO_ERROR) ? 'NO_ERROR (0x0)' : ('0x' + err.toString(16));
            gl.useProgram(glProgram);
            const aPos = gl.getAttribLocation(glProgram, 'aPos');
            gl.enableVertexAttribArray(aPos);
            gl.bindBuffer(gl.ARRAY_BUFFER, glPosBuffer);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            webglState = checkWebGLPixels(w, h);
          } catch (e) { lastGlError = 'EXCEPTION: ' + e.message; }
        }
      }
      const nativeVisual = (video.videoWidth > 0 && !video.paused && !video.error) ? (c2dState === 'IMAGE' ? 'IMAGE' : (video.currentTime > 0 ? 'AUDIO_ONLY / BLACK' : 'PROBING')) : 'BLACK';
      document.getElementById('statusNative').innerHTML = 'Native &lt;video&gt;: <span class="badge ' + (nativeVisual === 'IMAGE' ? 'badge-ok' : 'badge-err') + '">' + nativeVisual + '</span>';
      document.getElementById('statusC2D').innerHTML = 'Canvas2D: <span class="badge ' + (c2dState === 'IMAGE' ? 'badge-ok' : 'badge-err') + '">' + c2dState + '</span>';
      document.getElementById('statusWebGL').innerHTML = 'WebGL: <span class="badge ' + (webglState === 'IMAGE' ? 'badge-ok' : 'badge-err') + '">' + webglState + '</span>';
      document.getElementById('mFile').textContent = currentRelPath.split('/').pop();
      document.getElementById('mCodecTag').textContent = currentRelPath.includes('_HVC1') ? 'tag: hvc1' : (currentRelPath.includes('HEVC') ? 'tag: hev1' : 'tag: avc1');
      const err = video.error;
      document.getElementById('mError').textContent = err ? err.message : 'null';
      document.getElementById('mErrorCode').textContent = err ? ('Code ' + err.code) : 'None';
      const stateNames = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
      document.getElementById('mStates').textContent = 'ready: ' + video.readyState + ', net: ' + video.networkState;
      document.getElementById('mStatesDesc').textContent = stateNames[video.readyState] || 'UNKNOWN';
      document.getElementById('mDimensions').textContent = video.videoWidth + ' × ' + video.videoHeight;
      document.getElementById('mAspect').textContent = video.videoWidth ? ((video.videoWidth / video.videoHeight).toFixed(2) + ':1') : '--';
      document.getElementById('mTime').textContent = video.currentTime.toFixed(2) + 's / ' + (video.duration||0).toFixed(2) + 's';
      document.getElementById('mPaused').textContent = 'paused: ' + video.paused + ', ended: ' + video.ended;
      document.getElementById('mRvfcCount').textContent = rvfcCount + ' callbacks';
      document.getElementById('mRvfcMeta').textContent = lastRvfcMeta ? ('presented: ' + (lastRvfcMeta.presentedFrames || 0)) : 'no metadata';
      document.getElementById('mGlError').textContent = lastGlError;
      document.getElementById('mGlStatus').textContent = (lastGlError === 'NO_ERROR (0x0)') ? 'texImage2D OK' : 'GL Upload Error';
      if (video.getVideoPlaybackQuality) {
        const q = video.getVideoPlaybackQuality();
        document.getElementById('mQuality').textContent = 'total: ' + q.totalVideoFrames + ', dropped: ' + q.droppedVideoFrames;
        document.getElementById('mDropRate').textContent = q.totalVideoFrames ? ((q.droppedVideoFrames / q.totalVideoFrames * 100).toFixed(1) + '% dropped') : '0%';
      } else {
        document.getElementById('mQuality').textContent = 'N/A in Safari';
        document.getElementById('mDropRate').textContent = '--';
      }
      document.getElementById('mVerdict').textContent = '[Native: ' + nativeVisual + '] [Canvas2D: ' + c2dState + '] [WebGL: ' + webglState + ']';
      requestAnimationFrame(renderFrame);
    }
    requestAnimationFrame(renderFrame);
    async function reportTelemetry() {
      const payload = {
        type: 'hevc_diag_report',
        file: currentRelPath,
        tag: currentRelPath.includes('_HVC1') ? 'hvc1' : (currentRelPath.includes('HEVC') ? 'hev1' : 'avc1'),
        error: video.error ? { code: video.error.code, message: video.error.message } : null,
        readyState: video.readyState,
        networkState: video.networkState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        ended: video.ended,
        rvfcCount: rvfcCount,
        glError: lastGlError,
        nativePixel: document.getElementById('statusNative').innerText,
        c2dPixel: document.getElementById('statusC2D').innerText,
        webglPixel: document.getElementById('statusWebGL').innerText,
        userAgent: navigator.userAgent
      };
      await fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'HEVC_DIAG_REPORT', message: 'HEVC 3-Way Diagnostic Matrix Sample', data: payload }) }).catch(()=>{});
      alert('Diagnostic log sent to server!');
    }
    fetch('/api/videos').then(r => r.json()).then(d => {
      const sel = document.getElementById('selAllVideos');
      sel.innerHTML = '<option value="">-- Or Select Any Video From Library --</option>';
      (d.videos || []).forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.relPath;
        opt.textContent = '[' + v.sizeGB + '] ' + v.name;
        sel.appendChild(opt);
      });
    }).catch(()=>{});
    pickPreset(currentRelPath);
  </script>
</body>
</html>`);
}
