// ============================================================
// Deterministic Verification Suite for Issue #23 Playback Admission Gate
// ============================================================
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPlaybackAdmission,
  clearAdmissionCache,
  handlePreflightRoutes
} from './src/server/preflight-router.mjs';
import { MediaController } from './src/media/playback.js';
import { state } from './src/core/state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== RUNNING ISSUE #23 PLAYBACK ADMISSION GATE TEST SUITE ===\n');

let allPassed = true;
function check(name, condition) {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    console.log(`  ❌ [FAIL] ${name}`);
    allPassed = false;
  }
}

// Mock Video Element for client-side controller testing
class MockVideoElement {
  constructor() {
    this.src = '';
    this.currentTime = 0;
    this.paused = true;
    this.readyState = 0;
    this.networkState = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.error = null;
    this.eventListeners = {};
    this.rvfcCallbacks = new Map();
    this.rvfcNextId = 1;
    this.cancelRvfcCalls = [];
    this.loadCalls = 0;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.attributes = {};
  }

  addEventListener(type, listener) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    if (!this.eventListeners[type]) return;
    this.eventListeners[type] = this.eventListeners[type].filter(l => l !== listener);
  }

  dispatchEvent(evt) {
    const list = this.eventListeners[evt.type] || [];
    for (const fn of list) {
      fn(evt);
    }
  }

  removeAttribute(attr) {
    delete this.attributes[attr];
    if (attr === 'src') this.src = '';
  }

  load() {
    this.loadCalls++;
  }

  play() {
    this.playCalls++;
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls++;
    this.paused = true;
  }

  requestVideoFrameCallback(cb) {
    const id = this.rvfcNextId++;
    this.rvfcCallbacks.set(id, cb);
    return id;
  }

  cancelVideoFrameCallback(id) {
    this.cancelRvfcCalls.push(id);
    this.rvfcCallbacks.delete(id);
  }

  triggerRvfc(now, metadata = {}) {
    const entries = Array.from(this.rvfcCallbacks.entries());
    this.rvfcCallbacks.clear();
    for (const [id, cb] of entries) {
      cb(now, {
        mediaTime: this.currentTime,
        presentedFrames: 1,
        width: this.videoWidth,
        height: this.videoHeight,
        ...metadata
      });
    }
  }

  triggerError(code, message = '') {
    this.error = { code, message };
    this.networkState = 3;
    this.dispatchEvent({ type: 'error' });
  }
}

class MockVRRenderer {
  constructor() {
    this.resetCalls = 0;
    this.updateCalls = 0;
  }

  resetVideoTexture() {
    this.resetCalls++;
  }

  updateVideoTexture() {
    this.updateCalls++;
    state.firstFrameTimings.firstTextureUploadAt = performance.now();
  }
}

// ------------------------------------------------------------
// Suite 1: Server Admission Authority on Physical Files
// ------------------------------------------------------------
console.log('Suite 1: Server Admission Authority & Caching');
{
  clearAdmissionCache();
  const hunvr029Path = 'G:\\Media\\VR\\Render\\Mihara Honoka - HUNVR029 - (HEVC_21.0).mp4';
  const wavr224Path = 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\4K\\4096_2048_crf18_avc1-Kururugi Aoi - WAVR224.mp4';

  if (fs.existsSync(hunvr029Path)) {
    const resB = await checkPlaybackAdmission(hunvr029Path);
    check('HUNVR029 Code-4 original denied by policy', resB.allowed === false);
    check('HUNVR029 classified as NORMALIZATION_CANDIDATE_CERTIFIED', resB.classification === 'NORMALIZATION_CANDIDATE_CERTIFIED');
    check('HUNVR029 matches certified Envelope A', resB.matchedEnvelopeId === 'NEW_ENVELOPE_A_4320x2160_2997_50_MAIN_L180_MOOV_FIRST');
  } else {
    console.log('  ⚠️ HUNVR029 not found on local disk, skipping physical file check');
  }

  if (fs.existsSync(wavr224Path)) {
    const resA = await checkPlaybackAdmission(wavr224Path);
    check('WAVR224 Playable A admitted by policy', resA.allowed === true);
    check('WAVR224 classified as READY_DIRECT', resA.classification === 'READY_DIRECT');

    // In-memory cache check
    const t0 = performance.now();
    const resACached = await checkPlaybackAdmission(wavr224Path);
    const elapsedMs = performance.now() - t0;
    check('Second admission query returned from in-memory cache', resACached === resA);
    check('Cached lookup executed in sub-millisecond time (< 5ms)', elapsedMs < 5);
  } else {
    console.log('  ⚠️ WAVR224 not found on local disk, skipping physical file check');
  }

  // Non-existent file fails closed
  const missingRes = await checkPlaybackAdmission('Z:\\Fake\\NonExistent.mp4');
  check('Non-existent file fails closed with allowed=false', missingRes.allowed === false);
  check('Missing file classification is UNREADABLE_MEDIA', missingRes.classification === 'UNREADABLE_MEDIA');
}

// ------------------------------------------------------------
// Suite 2: Client MediaController Playback Admission Gate
// ------------------------------------------------------------
console.log('\nSuite 2: Client MediaController Admission Gate & Lifecycle');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();
  const loggedEvents = [];

  // Mock admission checker for deterministic client tests
  const mockAdmissionDb = {
    '4K/playable_A.mp4': { allowed: true, classification: 'READY_DIRECT', reason: 'Direct AVC1' },
    'unsupported/code4_B.mp4': {
      allowed: false,
      classification: 'NORMALIZATION_CANDIDATE_CERTIFIED',
      reason: 'Matches Envelope A repair candidate',
      matchedEnvelopeId: 'NEW_ENVELOPE_A_4320x2160_2997_50_MAIN_L180_MOOV_FIRST'
    },
    '4K/playable_C.mp4': { allowed: true, classification: 'READY_DIRECT', reason: 'Direct AVC1' }
  };

  const controller = new MediaController(video, null, {
    syncAdmissionBypass: false,
    admissionChecker: async (relPath) => mockAdmissionDb[relPath] || { allowed: false, classification: 'UNKNOWN', reason: 'Unknown' }
  });
  controller.attachRenderer(renderer);
  controller.setRemoteLogHook((level, msg, data) => loggedEvents.push({ level, msg, data }));

  // Case 1: Blocked B media (HUNVR029 equivalent)
  const bRes = await controller.selectVideo('unsupported/code4_B.mp4');
  check('Controller denies un-admitted media', bRes.allowed === false);
  check('Video.src is NEVER assigned for denied media', video.src === '');
  // Exactly 1 load call from step 2 source-teardown, NOT a second load call for a new source
  check('Video only receives teardown load(), never new source load()', video.loadCalls === 1);
  check('Status text reflects repair needed', state.firstFrameTimings.statusText === 'Needs compatibility repair');
  check('Timings ready is false', state.firstFrameTimings.ready === false);
  check('Policy block telemetry event emitted', loggedEvents.some(e => e.msg === 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY'));
}

// ------------------------------------------------------------
// Suite 3: Full Recovery Sequence (Playable A -> Denied B -> Playable C)
// ------------------------------------------------------------
console.log('\nSuite 3: Recovery Sequence (Playable A -> Denied B -> Playable C)');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();
  const loggedEvents = [];

  const mockDb = {
    '4K/playable_A.mp4': { allowed: true, classification: 'READY_DIRECT' },
    'Render/HUNVR029_B.mp4': { allowed: false, classification: 'NORMALIZATION_CANDIDATE_CERTIFIED', reason: 'HEVC hev1 repair needed' },
    '4K/playable_C.mp4': { allowed: true, classification: 'READY_DIRECT' }
  };

  const controller = new MediaController(video, null, {
    syncAdmissionBypass: false,
    admissionChecker: async (relPath) => mockDb[relPath]
  });
  controller.attachRenderer(renderer);
  controller.setRemoteLogHook((level, msg, data) => loggedEvents.push({ level, msg, data }));

  // 1. Playable A
  await controller.selectVideo('4K/playable_A.mp4');
  check('A is admitted', video.src.includes('playable_A.mp4'));
  video.readyState = 4;
  video.videoWidth = 3840;
  video.videoHeight = 1920;
  video.triggerRvfc(100);
  check('A texture upload allowed', controller.shouldUploadTexture());
  renderer.updateVideoTexture();
  check('A rendered frame successfully', renderer.updateCalls === 1);

  // 2. Denied B
  const preResetCalls = renderer.resetCalls;
  await controller.selectVideo('Render/HUNVR029_B.mp4');
  check('B selection advances generation to 2', controller.currentMediaGeneration === 2);
  check('B selection wipes A texture from renderer', renderer.resetCalls > preResetCalls);
  check('B does NOT attach to video.src', video.src === '');
  check('B texture upload disallowed', !controller.shouldUploadTexture());
  check('B neutral status presented', state.firstFrameTimings.statusText === 'Needs compatibility repair');

  // 3. Playable C
  await controller.selectVideo('4K/playable_C.mp4');
  check('C selection advances generation to 3', controller.currentMediaGeneration === 3);
  check('C is admitted and attached to video.src', video.src.includes('playable_C.mp4'));
  video.readyState = 4;
  video.videoWidth = 4096;
  video.videoHeight = 2048;
  video.triggerRvfc(200);
  check('C texture upload allowed', controller.shouldUploadTexture());
  renderer.updateVideoTexture();
  check('C rendered frame successfully without reload', renderer.updateCalls === 2);
  check('C decoded frame confirmed in timings', state.firstFrameTimings.firstFrameDecodedAt > 0);
  check('C status displays decode confirmation', state.firstFrameTimings.statusText === 'Decoded Frame Arrived');
}

// ------------------------------------------------------------
// Suite 4: Concurrent Rapid Switch Race Isolation
// ------------------------------------------------------------
console.log('\nSuite 4: Concurrent Rapid Switch Race Isolation');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();

  let resolveB;
  const slowBPromise = new Promise(r => { resolveB = r; });

  const controller = new MediaController(video, null, {
    syncAdmissionBypass: false,
    admissionChecker: async (relPath) => {
      if (relPath === 'slow_B.mp4') return slowBPromise;
      return { allowed: true, classification: 'READY_DIRECT' };
    }
  });
  controller.attachRenderer(renderer);

  // Rapid selection: B initiated, then C immediately selected
  const pB = controller.selectVideo('slow_B.mp4');
  const genB = controller.currentMediaGeneration;
  const pC = controller.selectVideo('fast_C.mp4');
  const genC = controller.currentMediaGeneration;

  check('C incremented generation past B', genC > genB);

  // Await C completion
  await pC;
  check('C source is active', video.src.includes('fast_C.mp4'));

  // Now settle B's delayed admission
  resolveB({ allowed: false, classification: 'NORMALIZATION_CANDIDATE_CERTIFIED' });
  await pB;

  // Verify B did NOT overwrite C's state or status
  check('Delayed B did NOT overwrite C active src', video.src.includes('fast_C.mp4'));
  check('Delayed B did NOT overwrite C status', state.firstFrameTimings.statusText.includes('fast_C.mp4'));
}

// ------------------------------------------------------------
// Suite 5: HTTP Server Route & Defense-In-Depth Gating
// ------------------------------------------------------------
console.log('\nSuite 5: HTTP Server Route & Defense-In-Depth Gating');
{
  // 1. GET /api/playback-admission route
  const req = { url: '/api/playback-admission?path=nonexistent_file.mp4', method: 'GET' };
  let statusCode = null;
  let headers = {};
  let body = '';
  const res = {
    writeHead: (code, hdrs) => { statusCode = code; headers = hdrs; },
    setHeader: (k, v) => { headers[k] = v; },
    end: (content) => { body = content; }
  };

  const handled = handlePreflightRoutes(req, res, '/api/playback-admission', __dirname, [], () => null);
  check('Preflight router handles /api/playback-admission route', handled === true);
  check('Missing path returns 404', statusCode === 404);
  const parsedBody = JSON.parse(body);
  check('Response returns allowed=false for missing path', parsedBody.allowed === false);
  check('Response classification is UNREADABLE_MEDIA', parsedBody.classification === 'UNREADABLE_MEDIA');

  // 2. Direct physical file resolution via route
  const hunvr029 = 'G:\\Media\\VR\\Render\\Mihara Honoka - HUNVR029 - (HEVC_21.0).mp4';
  if (fs.existsSync(hunvr029)) {
    let hunvrCode = null;
    let hunvrBody = '';
    const resHunvr = {
      writeHead: (code) => { hunvrCode = code; },
      end: (content) => { hunvrBody = content; }
    };
    const reqHunvr = { url: '/api/playback-admission?path=Render/Mihara Honoka - HUNVR029 - (HEVC_21.0).mp4', method: 'GET' };
    handlePreflightRoutes(reqHunvr, resHunvr, '/api/playback-admission', __dirname, [], () => hunvr029);

    // Wait microtask for async checkPlaybackAdmission
    await new Promise(r => setTimeout(r, 20));
    check('HUNVR029 route returns HTTP 200', hunvrCode === 200);
    const hunvrJson = JSON.parse(hunvrBody);
    check('HUNVR029 route reports allowed: false', hunvrJson.allowed === false);
    check('HUNVR029 route reports NORMALIZATION_CANDIDATE_CERTIFIED', hunvrJson.classification === 'NORMALIZATION_CANDIDATE_CERTIFIED');
  }
}

console.log('\n------------------------------------------------------------');
if (allPassed) {
  console.log('OVERALL PLAYBACK ADMISSION GATE SUITE: ✅ ALL PASSED');
} else {
  console.log('OVERALL PLAYBACK ADMISSION GATE SUITE: ❌ SOME TESTS FAILED');
  process.exit(1);
}
