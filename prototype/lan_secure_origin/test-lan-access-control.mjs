import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleRequest,
  renderOnboardingPage
} from './server.mjs';
import {
  getAllowedRoots,
  resolveSecureMediaPath,
  getActiveDeviceToken,
  trustClientIp,
  revokeTrustedClientIp,
  clearTrustedClientIps,
  isDeviceAuthorized
} from './src/server/lan-security.mjs';
import { getActiveMediaRoot } from './src/server/cert-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== RUNNING LAN SECURITY & ACCESS CONTROL REGRESSION SUITE ===\n');

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

import { EventEmitter } from 'node:events';

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
  clearTrustedClientIps();
  const token = getActiveDeviceToken(__dirname);
  const mediaRoot = getActiveMediaRoot();

  // Test Case 1: Plain HTTP 8080 Blocks Unencrypted Media Access
  console.log('Suite 1: Plain HTTP 8080 Protection (Requirement 4)');
  {
    const reqVideo = mockReq({ url: '/video?path=sample.mp4', remoteAddress: '192.168.110.55' });
    const resVideo = mockRes();
    handleRequest(reqVideo, resVideo, false);
    assert.strictEqual(resVideo.statusCode, 403, 'HTTP 8080 /video must return 403');
    const jsonVideo = JSON.parse(resVideo.body);
    assert.strictEqual(jsonVideo.code, 'HTTPS_REQUIRED', 'HTTP 8080 /video must indicate HTTPS_REQUIRED');
    console.log('  ✅ [PASS] HTTP 8080 /video blocked with 403 HTTPS_REQUIRED');

    const reqApi = mockReq({ url: '/api/videos', remoteAddress: '192.168.110.55' });
    const resApi = mockRes();
    handleRequest(reqApi, resApi, false);
    assert.strictEqual(resApi.statusCode, 403, 'HTTP 8080 /api/videos must return 403');
    const jsonApi = JSON.parse(resApi.body);
    assert.strictEqual(jsonApi.code, 'HTTPS_REQUIRED', 'HTTP 8080 /api/videos must indicate HTTPS_REQUIRED');
    console.log('  ✅ [PASS] HTTP 8080 /api/videos blocked with 403 HTTPS_REQUIRED');

    // Onboarding page on HTTP 8080 must be accessible and contain the secure player token
    const reqHome = mockReq({ url: '/', remoteAddress: '192.168.110.55' });
    const resHome = mockRes();
    handleRequest(reqHome, resHome, false);
    assert.strictEqual(resHome.statusCode, 200, 'HTTP 8080 / must return onboarding page');
    assert(resHome.body.includes('VREconder CA Onboarding'), 'Must contain onboarding title');
    assert(resHome.body.includes(`token=${token}`), 'Onboarding page must contain active device token');
    console.log('  ✅ [PASS] HTTP 8080 / serves onboarding page with secure token');
  }

  // Test Case 2: Secure Media Path Resolution Boundaries (Requirement 2)
  console.log('\nSuite 2: Secure Media Path Resolution Boundaries (Requirement 2)');
  {
    // 2a. Canonical media inside root
    const sampleFiles = fs.readdirSync(mediaRoot).filter(f => f.endsWith('.mp4'));
    assert(sampleFiles.length > 0, 'Active media root must contain mp4 files');
    const validRel = sampleFiles[0];
    const resolvedValid = resolveSecureMediaPath(validRel);
    assert.strictEqual(resolvedValid, path.join(mediaRoot, validRel), 'Valid file in root must resolve');
    console.log(`  ✅ [PASS] Valid relative path resolves inside media root: ${validRel}`);

    // 2b. Parent directory escape (the old dirname(root) vulnerability)
    const escapeAttempt = `../${validRel}`;
    const resolvedEscape = resolveSecureMediaPath(escapeAttempt);
    assert.strictEqual(resolvedEscape, null, 'Relative path with ../ must be rejected');
    console.log('  ✅ [PASS] Parent directory traversal (../) rejected');

    // 2c. Deep path traversal
    const deepEscape = `../../../../../../Windows/System32/cmd.exe`;
    const resolvedDeep = resolveSecureMediaPath(deepEscape);
    assert.strictEqual(resolvedDeep, null, 'Deep path traversal must be rejected');
    console.log('  ✅ [PASS] Deep path traversal (../../cmd.exe) rejected');

    // 2d. Arbitrary outside absolute path
    const outsideAbs = 'C:\\Windows\\system.ini';
    const resolvedOutside = resolveSecureMediaPath(outsideAbs);
    assert.strictEqual(resolvedOutside, null, 'Path outside allowed roots must return null');
    console.log('  ✅ [PASS] Outside absolute path rejected');

    // 2e. Redundant root folder prefix stripping (e.g. "New folder (2)/video.mp4")
    const rootName = path.basename(mediaRoot);
    const prefixedRel = `${rootName}/${validRel}`;
    const resolvedPrefixed = resolveSecureMediaPath(prefixedRel);
    assert.strictEqual(resolvedPrefixed, path.join(mediaRoot, validRel), 'Prefixed path must resolve strictly within root');
    console.log('  ✅ [PASS] Redundant root folder prefix cleanly resolved within root');
  }

  // Test Case 3: Device Authentication: PC Loopback vs Trusted iPhone vs Other LAN Clients (Requirement 3)
  console.log('\nSuite 3: Device Access Control & Differentiation (Requirement 3)');
  {
    clearTrustedClientIps();

    // 3a. PC Loopback client is authorized by default
    const reqLoopback = mockReq({ url: '/api/videos', remoteAddress: '127.0.0.1' });
    assert.strictEqual(isDeviceAuthorized(reqLoopback, __dirname), true, 'Loopback 127.0.0.1 must be authorized');
    const resLoopback = mockRes();
    handleRequest(reqLoopback, resLoopback, true);
    assert.strictEqual(resLoopback.statusCode, 200, 'Loopback must fetch /api/videos with 200');
    console.log('  ✅ [PASS] PC Localhost (127.0.0.1) authorized to access /api/videos');

    // 3b. Unauthorized LAN client is rejected with 403 DEVICE_UNAUTHORIZED
    const reqLanUnauth = mockReq({ url: '/api/videos', remoteAddress: '192.168.110.88' });
    assert.strictEqual(isDeviceAuthorized(reqLanUnauth, __dirname), false, 'Untrusted LAN IP must not be authorized');
    const resLanUnauth = mockRes();
    handleRequest(reqLanUnauth, resLanUnauth, true);
    assert.strictEqual(resLanUnauth.statusCode, 403, 'Untrusted LAN client must get 403');
    const jsonUnauth = JSON.parse(resLanUnauth.body);
    assert.strictEqual(jsonUnauth.code, 'DEVICE_UNAUTHORIZED', 'Error code must be DEVICE_UNAUTHORIZED');
    console.log('  ✅ [PASS] Unauthorized LAN client denied access to /api/videos (403 DEVICE_UNAUTHORIZED)');

    // 3c. Unauthorized LAN client streaming /video is rejected with 403 DEVICE_UNAUTHORIZED
    const reqLanStream = mockReq({ url: '/video?path=sample.mp4', remoteAddress: '192.168.110.88' });
    const resLanStream = mockRes();
    handleRequest(reqLanStream, resLanStream, true);
    assert.strictEqual(resLanStream.statusCode, 403, 'Untrusted LAN client streaming /video must get 403');
    assert.strictEqual(JSON.parse(resLanStream.body).code, 'DEVICE_UNAUTHORIZED', 'Must return DEVICE_UNAUTHORIZED');
    console.log('  ✅ [PASS] Unauthorized LAN client denied /video streaming (403 DEVICE_UNAUTHORIZED)');

    // 3d. Trusted iPhone with batch_probe_session cookie is authorized
    const reqPairedCookie = mockReq({
      url: '/api/videos',
      remoteAddress: '192.168.110.150',
      headers: { host: '192.168.110.19:8443', cookie: `batch_probe_session=${token}` }
    });
    assert.strictEqual(isDeviceAuthorized(reqPairedCookie, __dirname), true, 'Paired session cookie must authorize device');
    const resPairedCookie = mockRes();
    handleRequest(reqPairedCookie, resPairedCookie, true);
    assert.strictEqual(resPairedCookie.statusCode, 200, 'Paired iPhone must fetch /api/videos with 200');
    console.log('  ✅ [PASS] Paired iPhone (batch_probe_session cookie) authorized to access /api/videos');

    // 3e. Trusted iPhone with vreconder_device_session cookie is authorized
    const reqDeviceCookie = mockReq({
      url: '/api/videos',
      remoteAddress: '192.168.110.151',
      headers: { host: '192.168.110.19:8443', cookie: `vreconder_device_session=${token}` }
    });
    assert.strictEqual(isDeviceAuthorized(reqDeviceCookie, __dirname), true, 'Device session cookie must authorize device');
    const resDeviceCookie = mockRes();
    handleRequest(reqDeviceCookie, resDeviceCookie, true);
    assert.strictEqual(resDeviceCookie.statusCode, 200, 'Device session iPhone must fetch /api/videos with 200');
    console.log('  ✅ [PASS] Trusted iPhone (vreconder_device_session cookie) authorized to access /api/videos');

    // 3f. Trusted iPhone onboarding via /?token=... sets session cookie and registers IP
    const reqTokenVisit = mockReq({
      url: `/?token=${token}`,
      remoteAddress: '192.168.110.152'
    });
    const resTokenVisit = mockRes();
    handleRequest(reqTokenVisit, resTokenVisit, true);
    assert.strictEqual(resTokenVisit.statusCode, 200, 'Visiting /?token= must return 200');
    assert(resTokenVisit.headers['set-cookie']?.includes(`vreconder_device_session=${token}`), 'Must issue session cookie');
    // Subsequent request from that IP is now trusted without requiring token in query
    const reqSubsequent = mockReq({
      url: '/api/videos',
      remoteAddress: '192.168.110.152'
    });
    assert.strictEqual(isDeviceAuthorized(reqSubsequent, __dirname), true, 'IP registered from token visit must be trusted');
    console.log('  ✅ [PASS] iPhone visiting /?token= receives secure cookie and trusted IP session');

    // 3g. Loopback device trust endpoint (/api/device/trust)
    const reqTrust = mockReq({
      method: 'POST',
      url: '/api/device/trust',
      remoteAddress: '127.0.0.1',
      body: JSON.stringify({ ip: '192.168.110.200' })
    });
    const resTrust = mockRes();
    handleRequest(reqTrust, resTrust, true);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(resTrust.statusCode, 200, 'Loopback /api/device/trust must return 200');
    const reqTrustedIp = mockReq({ url: '/api/videos', remoteAddress: '192.168.110.200' });
    assert.strictEqual(isDeviceAuthorized(reqTrustedIp, __dirname), true, 'Explicitly trusted IP must be authorized');
    console.log('  ✅ [PASS] PC Controller can explicitly authorize connected iPhone IP via /api/device/trust');
  }

  // Test Case 4: Normal Playback Restoration for Uncertified User Media (Requirement 1)
  console.log('\nSuite 4: Direct Playback for User-Owned Media Without Per-File Approval (Requirement 1)');
  {
    // Pick an uncertified AV1 file
    const sampleFiles = fs.readdirSync(mediaRoot).filter(f => f.endsWith('.mp4'));
    const av1Candidate = sampleFiles.find(f => f.includes('Shishido') || f.includes('Haruna') || f.includes('Agatha') || f.includes('Anna')) || sampleFiles[0];
    
    // Simulate authorized iPhone requesting video stream
    const reqStream = mockReq({
      url: `/video?path=${encodeURIComponent(av1Candidate)}`,
      remoteAddress: '192.168.110.152',
      headers: {
        host: '192.168.110.19:8443',
        range: 'bytes=0-1',
        cookie: `vreconder_device_session=${token}`
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
