import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  handleRequest,
  renderOnboardingPage
} from './server.mjs';
import {
  getAllowedRoots,
  resolveSecureMediaPath,
  getActivePairingPin,
  verifyDevicePin,
  createAuthorizedSession,
  revokeAllDeviceSessions,
  isDeviceAuthorized,
  isAllowedPublicStaticAsset
} from './src/server/lan-security.mjs';
import { getActiveMediaRoot } from './src/server/cert-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== RUNNING COMPREHENSIVE LAN SECURITY & ACCESS CONTROL TEST SUITE ===\n');

function mockReq(options = {}) {
  const method = options.method || 'GET';
  const url = options.url || '/';
  const remoteAddress = options.remoteAddress || '192.168.110.55';
  const headers = options.headers || { host: '192.168.110.19:8443' };

  const listeners = {};
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress },
    on: (evt, cb) => {
      listeners[evt] = cb;
      if (evt === 'data' && options.body) {
        setTimeout(() => cb(options.body), 0);
      }
      if (evt === 'end') {
        setTimeout(() => cb(), 5);
      }
    }
  };
  return req;
}

function mockRes() {
  const emitter = new EventEmitter();
  const headers = {};
  let statusCode = 200;
  let body = '';
  emitter.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
  emitter.writeHead = (code, hdrs = {}) => {
    statusCode = code;
    for (const [k, v] of Object.entries(hdrs)) {
      headers[k.toLowerCase()] = v;
    }
  };
  emitter.write = (chunk) => { body += chunk; };
  emitter.end = (chunk) => {
    if (chunk) body += chunk;
    emitter.emit('finish');
  };
  Object.defineProperty(emitter, 'statusCode', { get: () => statusCode, set: (c) => { statusCode = c; } });
  Object.defineProperty(emitter, 'headers', { get: () => headers });
  Object.defineProperty(emitter, 'body', { get: () => body });
  return emitter;
}

async function run() {
  revokeAllDeviceSessions();
  const mediaRoot = getActiveMediaRoot();

  // Suite 1: Plain HTTP 8080 Protection & Zero Credential Leakage (P0)
  console.log('Suite 1: Plain HTTP 8080 Protection & Zero Credential Leakage (P0)');
  {
    const reqVideo = mockReq({ url: '/video?path=sample.mp4', remoteAddress: '192.168.110.55' });
    const resVideo = mockRes();
    handleRequest(reqVideo, resVideo, false);
    assert.strictEqual(resVideo.statusCode, 403, 'HTTP 8080 /video must return 403');
    assert.strictEqual(JSON.parse(resVideo.body).code, 'HTTPS_REQUIRED');
    console.log('  ✅ [PASS] HTTP 8080 /video blocked with 403 HTTPS_REQUIRED');

    const reqApi = mockReq({ url: '/api/videos', remoteAddress: '192.168.110.55' });
    const resApi = mockRes();
    handleRequest(reqApi, resApi, false);
    assert.strictEqual(resApi.statusCode, 403, 'HTTP 8080 /api/videos must return 403');
    assert.strictEqual(JSON.parse(resApi.body).code, 'HTTPS_REQUIRED');
    console.log('  ✅ [PASS] HTTP 8080 /api/videos blocked with 403 HTTPS_REQUIRED');

    // Onboarding page on HTTP 8080 must NOT leak any secret tokens or credentials
    const reqHome = mockReq({ url: '/', remoteAddress: '192.168.110.55' });
    const resHome = mockRes();
    handleRequest(reqHome, resHome, false);
    assert.strictEqual(resHome.statusCode, 200, 'HTTP 8080 / must return onboarding page');
    assert(resHome.body.includes('VREconder CA Onboarding'), 'Must contain onboarding title');
    assert(!resHome.body.includes('token='), 'HTTP 8080 onboarding page MUST NOT leak token');
    assert(!resHome.body.includes('?token='), 'HTTP 8080 onboarding page MUST NOT contain ?token= parameter');
    console.log('  ✅ [PASS] HTTP 8080 onboarding page contains NO leaked tokens or credentials');

    // Arbitrary routes on HTTP 8080 return 403 HTTPS_REQUIRED
    const reqArbitrary = mockReq({ url: '/batch_probe_checkpoint.json', remoteAddress: '192.168.110.55' });
    const resArbitrary = mockRes();
    handleRequest(reqArbitrary, resArbitrary, false);
    assert.strictEqual(resArbitrary.statusCode, 403, 'Arbitrary files on HTTP 8080 must return 403');
    console.log('  ✅ [PASS] Arbitrary file access on HTTP 8080 rejected with 403');
  }

  // Suite 2: Public Static File Whitelist & Config/Secrets Protection (P0)
  console.log('\nSuite 2: Public Static File Whitelist & Config/Secrets Protection (P0)');
  {
    // Ensure all internal sensitive files are strictly rejected (404)
    const sensitiveFiles = [
      '/batch_probe_checkpoint.json',
      '/provisional_playback_admissions.json',
      '/server.mjs',
      '/src/server/lan-security.mjs',
      '/live_client.log',
      '/certs/server.key',
      '/certs/server.crt'
    ];

    for (const file of sensitiveFiles) {
      assert.strictEqual(isAllowedPublicStaticAsset(file, false), false, `Static whitelist must block ${file}`);
      const req = mockReq({ url: file, remoteAddress: '192.168.110.55' });
      const res = mockRes();
      handleRequest(req, res, true);
      assert.strictEqual(res.statusCode, 404, `Requesting ${file} must return 404`);
    }
    console.log('  ✅ [PASS] All sensitive configs, checkpoints, logs, and server code return 404');

    // Controller UI must be restricted to loopback
    const reqRemoteCtrl = mockReq({ url: '/controller.html', remoteAddress: '192.168.110.55' });
    const resRemoteCtrl = mockRes();
    handleRequest(reqRemoteCtrl, resRemoteCtrl, true);
    assert.strictEqual(resRemoteCtrl.statusCode, 403, 'Remote access to /controller.html must be denied 403');
    console.log('  ✅ [PASS] Remote LAN access to /controller.html rejected with 403');

    // Public allowed assets (HTML, CSS, JS, manifest)
    const allowedAssets = ['/styles.css', '/manifest.json', '/src/main.js'];
    for (const asset of allowedAssets) {
      const req = mockReq({ url: asset, remoteAddress: '192.168.110.55' });
      const res = mockRes();
      handleRequest(req, res, true);
      assert.strictEqual(res.statusCode, 200, `Public asset ${asset} must be served with 200`);
    }
    console.log('  ✅ [PASS] Public assets (styles.css, manifest.json, src/main.js) served with 200');
  }

  // Suite 3: Secure Media Path Resolution Boundaries (P1)
  console.log('\nSuite 3: Secure Media Path Resolution Boundaries (P1)');
  {
    const sampleFiles = fs.readdirSync(mediaRoot).filter(f => f.endsWith('.mp4'));
    assert(sampleFiles.length > 0, 'Active media root must contain mp4 files');
    const validRel = sampleFiles[0];

    const resolvedValid = resolveSecureMediaPath(validRel);
    assert.strictEqual(resolvedValid, path.join(mediaRoot, validRel), 'Valid file in root must resolve');

    assert.strictEqual(resolveSecureMediaPath(`../${validRel}`), null, 'Parent traversal must be rejected');
    assert.strictEqual(resolveSecureMediaPath(`../../../../cmd.exe`), null, 'Deep traversal must be rejected');
    assert.strictEqual(resolveSecureMediaPath('C:\\Windows\\system.ini'), null, 'Outside absolute path rejected');

    const rootName = path.basename(mediaRoot);
    const prefixedRel = `${rootName}/${validRel}`;
    assert.strictEqual(resolveSecureMediaPath(prefixedRel), path.join(mediaRoot, validRel), 'Redundant prefix stripped cleanly');
    console.log('  ✅ [PASS] Path resolution strictly bound to configured media roots without dirname fallback');
  }

  // Suite 4: Unified LAN Permission Boundary (P1)
  console.log('\nSuite 4: Unified LAN Permission Boundary (P1)');
  {
    revokeAllDeviceSessions();

    const protectedUrls = [
      '/api/videos',
      '/video?path=sample.mp4',
      '/api/calibration/events',
      '/api/calibration/control',
      '/api/telemetry',
      '/api/profiles',
      '/api/preflight/results',
      '/api/log',
      '/api/media-root'
    ];

    for (const pUrl of protectedUrls) {
      const req = mockReq({ url: pUrl, remoteAddress: '192.168.110.88' });
      const res = mockRes();
      handleRequest(req, res, true);
      assert.strictEqual(res.statusCode, 403, `Untrusted LAN client requesting ${pUrl} must receive 403`);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.code, 'DEVICE_UNAUTHORIZED', `Response for ${pUrl} must code DEVICE_UNAUTHORIZED`);
    }
    console.log('  ✅ [PASS] All protected media, telemetry, control, and API endpoints reject untrusted LAN clients with 403 DEVICE_UNAUTHORIZED');

    // Loopback-only management routes reject remote LAN clients
    const reqRemotePin = mockReq({ url: '/api/device/pin', remoteAddress: '192.168.110.88' });
    const resRemotePin = mockRes();
    handleRequest(reqRemotePin, resRemotePin, true);
    assert.strictEqual(resRemotePin.statusCode, 403, 'Remote access to /api/device/pin must be rejected 403');

    const reqRemoteRevoke = mockReq({ method: 'POST', url: '/api/device/revoke', remoteAddress: '192.168.110.88' });
    const resRemoteRevoke = mockRes();
    handleRequest(reqRemoteRevoke, resRemoteRevoke, true);
    assert.strictEqual(resRemoteRevoke.statusCode, 403, 'Remote access to /api/device/revoke must be rejected 403');
    console.log('  ✅ [PASS] Management endpoints (/api/device/pin, /api/device/revoke) reject remote clients');
  }

  // Suite 5: Minimal PIN Pairing & Session Cookie Lifecycle (P2)
  console.log('\nSuite 5: Minimal PIN Pairing & Session Cookie Lifecycle (P2)');
  {
    revokeAllDeviceSessions();

    // 5a. PC Loopback fetches active PIN
    const reqPin = mockReq({ url: '/api/device/pin', remoteAddress: '127.0.0.1' });
    const resPin = mockRes();
    handleRequest(reqPin, resPin, true);
    assert.strictEqual(resPin.statusCode, 200, 'Loopback must fetch PIN with 200');
    const pinData = JSON.parse(resPin.body);
    assert(pinData.ok && typeof pinData.pin === 'string' && pinData.pin.length === 6, 'Must return 6-digit PIN');
    const validPin = pinData.pin;
    console.log(`  ✅ [PASS] PC console retrieved 6-digit pairing PIN: ${validPin}`);

    // 5b. Pairing attempt with invalid PIN returns 401
    const reqPairBad = mockReq({
      method: 'POST',
      url: '/api/device/pair',
      remoteAddress: '192.168.110.150',
      body: JSON.stringify({ pin: '000000' })
    });
    const resPairBad = mockRes();
    handleRequest(reqPairBad, resPairBad, true);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(resPairBad.statusCode, 401, 'Invalid PIN must return 401');
    console.log('  ✅ [PASS] Invalid PIN rejected with 401');

    // 5c. Pairing attempt with correct PIN over HTTPS succeeds and returns HttpOnly session cookie
    const reqPairGood = mockReq({
      method: 'POST',
      url: '/api/device/pair',
      remoteAddress: '192.168.110.150',
      body: JSON.stringify({ pin: validPin })
    });
    const resPairGood = mockRes();
    handleRequest(reqPairGood, resPairGood, true);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(resPairGood.statusCode, 200, 'Correct PIN pairing must return 200');
    const cookieHeader = resPairGood.headers['set-cookie'];
    assert(cookieHeader, 'Must set cookie header');
    assert(cookieHeader.includes('vreconder_device_session='), 'Cookie must be vreconder_device_session');
    assert(cookieHeader.includes('HttpOnly'), 'Cookie must be HttpOnly');
    assert(cookieHeader.includes('SameSite=Strict'), 'Cookie must be SameSite=Strict');
    assert(cookieHeader.includes('Max-Age='), 'Cookie must include Max-Age');
    const match = cookieHeader.match(/vreconder_device_session=([^;]+)/);
    const sessionToken = match[1];
    console.log('  ✅ [PASS] Pairing succeeded; issued secure HttpOnly session cookie');

    // 5d. Reuse of single-use PIN must be rejected
    const reqPairReuse = mockReq({
      method: 'POST',
      url: '/api/device/pair',
      remoteAddress: '192.168.110.150',
      body: JSON.stringify({ pin: validPin })
    });
    const resPairReuse = mockRes();
    handleRequest(reqPairReuse, resPairReuse, true);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(resPairReuse.statusCode, 401, 'Reusing single-use PIN must fail');
    console.log('  ✅ [PASS] PIN is single-use; subsequent attempt rejected');

    // 5e. Authenticated request using cookie succeeds
    const reqAuth = mockReq({
      url: '/api/videos',
      remoteAddress: '192.168.110.150',
      headers: { host: '192.168.110.19:8443', cookie: `vreconder_device_session=${sessionToken}` }
    });
    assert.strictEqual(isDeviceAuthorized(reqAuth), true, 'Request with session cookie must be authorized');
    const resAuth = mockRes();
    handleRequest(reqAuth, resAuth, true);
    assert.strictEqual(resAuth.statusCode, 200, 'Paired device must access /api/videos with 200');
    console.log('  ✅ [PASS] Paired iPhone with session cookie granted access to /api/videos');

    // 5f. Revoke all sessions invalidates the cookie immediately
    const reqRevoke = mockReq({ method: 'POST', url: '/api/device/revoke', remoteAddress: '127.0.0.1' });
    const resRevoke = mockRes();
    handleRequest(reqRevoke, resRevoke, true);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(resRevoke.statusCode, 200, 'Revoke must return 200');

    // Device with old cookie is now rejected
    const reqRevokedDevice = mockReq({
      url: '/api/videos',
      remoteAddress: '192.168.110.150',
      headers: { host: '192.168.110.19:8443', cookie: `vreconder_device_session=${sessionToken}` }
    });
    assert.strictEqual(isDeviceAuthorized(reqRevokedDevice), false, 'Revoked cookie must not be authorized');
    const resRevokedDevice = mockRes();
    handleRequest(reqRevokedDevice, resRevokedDevice, true);
    assert.strictEqual(resRevokedDevice.statusCode, 403, 'Revoked device must receive 403 DEVICE_UNAUTHORIZED');
    console.log('  ✅ [PASS] Session revocation immediately invalidates existing device sessions');
  }

  // Suite 6: Normal Playback Restoration of Uncertified User Media (Requirement 1)
  console.log('\nSuite 6: Direct Playback of User-Owned Media Without Per-File Approval (Requirement 1)');
  {
    const sessionToken = createAuthorizedSession('test_runner');
    const sampleFiles = fs.readdirSync(mediaRoot).filter(f => f.endsWith('.mp4'));
    const av1Candidate = sampleFiles.find(f => f.includes('Shishido') || f.includes('Haruna') || f.includes('Agatha') || f.includes('Anna')) || sampleFiles[0];

    const reqStream = mockReq({
      url: `/video?path=${encodeURIComponent(av1Candidate)}`,
      remoteAddress: '192.168.110.150',
      headers: {
        host: '192.168.110.19:8443',
        range: 'bytes=0-1',
        cookie: `vreconder_device_session=${sessionToken}`
      }
    });
    const resStream = mockRes();
    handleRequest(reqStream, resStream, true);

    await new Promise(resolve => {
      resStream.on('finish', resolve);
      setTimeout(resolve, 2000);
    });
    assert.strictEqual(resStream.statusCode, 206, 'Authorized iPhone must stream uncertified media with HTTP 206');
    assert.strictEqual(resStream.headers['content-range'], 'bytes 0-1/' + fs.statSync(path.join(mediaRoot, av1Candidate)).size);
    console.log(`  ✅ [PASS] Direct stream of user video without provisional admission succeeded: ${av1Candidate} (HTTP 206)`);
  }

  console.log('\n============================================================');
  console.log('🎉 ALL LAN ACCESS CONTROL & SECURITY TESTS PASSED DETERMINISTICALLY');
  console.log('============================================================');
}

run().catch(err => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
