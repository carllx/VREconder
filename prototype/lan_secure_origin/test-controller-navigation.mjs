// ============================================================
// Deterministic Verification Suite for Issue #23 Controller Navigation
// ============================================================
import assert from 'node:assert';
import { MediaController } from './src/media/playback.js';
import { CommandModel } from './src/controls/command-model.js';
import { state } from './src/core/state.js';

console.log('=== RUNNING ISSUE #23 CONTROLLER NAVIGATION RECOVERY TEST SUITE ===\n');

let allPassed = true;
function check(name, condition) {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    console.log(`  ❌ [FAIL] ${name}`);
    allPassed = false;
  }
}

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

// Test 1: Direct select denied B synchronizes playlist cursor
console.log('Test 1: Direct select denied B synchronizes playlist cursor');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();

  state.videoList = [
    { relPath: 'media/A.mp4', name: 'A' },
    { relPath: 'media/B_denied.mp4', name: 'B_denied' },
    { relPath: 'media/C.mp4', name: 'C' }
  ];
  state.currentVideoIndex = 0;

  const mockAdmissionDb = {
    'media/A.mp4': { allowed: true, classification: 'READY_DIRECT' },
    'media/B_denied.mp4': { allowed: false, classification: 'NORMALIZATION_CANDIDATE_CERTIFIED', reason: 'Repair candidate' },
    'media/C.mp4': { allowed: true, classification: 'READY_DIRECT' }
  };

  const controller = new MediaController(video, null, {
    syncAdmissionBypass: false,
    admissionChecker: async (relPath) => mockAdmissionDb[relPath]
  });
  controller.attachRenderer(renderer);

  const res = await controller.selectVideo('media/B_denied.mp4');
  check('Direct selection was denied', res.allowed === false);
  check('state.currentVideoIndex synchronized to index 1', state.currentVideoIndex === 1);
  check('state.videoPath synchronized to B_denied.mp4', state.videoPath === 'media/B_denied.mp4');
  check('Video.src was NOT assigned', video.src === '');
  check('Status text reflects repair needed', state.firstFrameTimings.statusText === 'Needs compatibility repair');
}

// Test 2: Next from denied B finds next playable C
console.log('\nTest 2: Next from denied B finds next playable C');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();

  state.videoList = [
    { relPath: 'media/A.mp4', name: 'A' },
    { relPath: 'media/B_denied.mp4', name: 'B_denied' },
    { relPath: 'media/C.mp4', name: 'C' }
  ];
  state.currentVideoIndex = 1;
  state.videoPath = 'media/B_denied.mp4';

  const mockAdmissionDb = {
    'media/A.mp4': { allowed: true, classification: 'READY_DIRECT' },
    'media/B_denied.mp4': { allowed: false, classification: 'NORMALIZATION_CANDIDATE_CERTIFIED', reason: 'Repair candidate' },
    'media/C.mp4': { allowed: true, classification: 'READY_DIRECT' }
  };

  const controller = new MediaController(video, null, {
    syncAdmissionBypass: false,
    admissionChecker: async (relPath) => mockAdmissionDb[relPath]
  });
  controller.attachRenderer(renderer);
  const cmd = new CommandModel(controller);

  const navRes = await cmd.next();
  check('Next recovered to playable C', navRes && navRes.allowed === true);
  check('state.currentVideoIndex is 2 (C)', state.currentVideoIndex === 2);
  check('video.src attached to C', decodeURIComponent(video.src).includes('media/C.mp4'));
  check('video.load called for C', video.loadCalls >= 1);
}

// Test 3: Consecutive denied B1 and B2 are skipped
console.log('\nTest 3: Consecutive denied B1 and B2 are skipped');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();

  state.videoList = [
    { relPath: 'media/A.mp4', name: 'A' },
    { relPath: 'media/B1_denied.mp4', name: 'B1' },
    { relPath: 'media/B2_denied.mp4', name: 'B2' },
    { relPath: 'media/C.mp4', name: 'C' }
  ];
  state.currentVideoIndex = 0;
  state.videoPath = 'media/A.mp4';

  const mockAdmissionDb = {
    'media/A.mp4': { allowed: true, classification: 'READY_DIRECT' },
    'media/B1_denied.mp4': { allowed: false, classification: 'NORMALIZATION_CANDIDATE_CERTIFIED' },
    'media/B2_denied.mp4': { allowed: false, classification: 'NEEDS_DEVICE_PROBE' },
    'media/C.mp4': { allowed: true, classification: 'READY_DIRECT' }
  };

  const controller = new MediaController(video, null, {
    syncAdmissionBypass: false,
    admissionChecker: async (relPath) => mockAdmissionDb[relPath]
  });
  controller.attachRenderer(renderer);
  const cmd = new CommandModel(controller);

  const navRes = await cmd.next();
  check('Next skipped B1 and B2 and landed on C', navRes && navRes.allowed === true);
  check('state.currentVideoIndex is 3 (C)', state.currentVideoIndex === 3);
  check('video.src is C', decodeURIComponent(video.src).includes('media/C.mp4'));
}

// Test 4: Previous behaves symmetrically
console.log('\nTest 4: Previous behaves symmetrically');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();

  state.videoList = [
    { relPath: 'media/A.mp4', name: 'A' },
    { relPath: 'media/B1_denied.mp4', name: 'B1' },
    { relPath: 'media/B2_denied.mp4', name: 'B2' },
    { relPath: 'media/C.mp4', name: 'C' }
  ];
  state.currentVideoIndex = 3;
  state.videoPath = 'media/C.mp4';

  const mockAdmissionDb = {
    'media/A.mp4': { allowed: true, classification: 'READY_DIRECT' },
    'media/B1_denied.mp4': { allowed: false, classification: 'NORMALIZATION_CANDIDATE_CERTIFIED' },
    'media/B2_denied.mp4': { allowed: false, classification: 'NEEDS_DEVICE_PROBE' },
    'media/C.mp4': { allowed: true, classification: 'READY_DIRECT' }
  };

  const controller = new MediaController(video, null, {
    syncAdmissionBypass: false,
    admissionChecker: async (relPath) => mockAdmissionDb[relPath]
  });
  controller.attachRenderer(renderer);
  const cmd = new CommandModel(controller);

  const navRes = await cmd.previous();
  check('Previous skipped B2 and B1 backward and landed on A', navRes && navRes.allowed === true);
  check('state.currentVideoIndex is 0 (A)', state.currentVideoIndex === 0);
  check('video.src is A', decodeURIComponent(video.src).includes('media/A.mp4'));
}

// Test 5: All-denied list terminates safely
console.log('\nTest 5: All-denied list terminates safely');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();

  state.videoList = [
    { relPath: 'media/B1_denied.mp4', name: 'B1' },
    { relPath: 'media/B2_denied.mp4', name: 'B2' }
  ];
  state.currentVideoIndex = 0;
  state.videoPath = 'media/B1_denied.mp4';

  const mockAdmissionDb = {
    'media/B1_denied.mp4': { allowed: false, classification: 'NORMALIZATION_CANDIDATE_CERTIFIED' },
    'media/B2_denied.mp4': { allowed: false, classification: 'NEEDS_DEVICE_PROBE' }
  };

  const controller = new MediaController(video, null, {
    syncAdmissionBypass: false,
    admissionChecker: async (relPath) => mockAdmissionDb[relPath]
  });
  controller.attachRenderer(renderer);
  const cmd = new CommandModel(controller);

  const navRes = await cmd.next();
  check('All-denied list returns null without looping', navRes === null);
  check('Status text reports No compatible media available', state.firstFrameTimings.statusText === 'No compatible media available');
  check('Video.src remains empty', video.src === '');
}

// Test 6: Async/stale admission result cannot move cursor backward
console.log('\nTest 6: Async/stale admission result cannot move cursor backward');
{
  const video = new MockVideoElement();
  const renderer = new MockVRRenderer();

  state.videoList = [
    { relPath: 'media/A.mp4', name: 'A' },
    { relPath: 'media/B_slow.mp4', name: 'B' },
    { relPath: 'media/C_fast.mp4', name: 'C' }
  ];
  state.currentVideoIndex = 0;

  let resolveB;
  const slowBPromise = new Promise(r => { resolveB = r; });

  const controller = new MediaController(video, null, {
    syncAdmissionBypass: false,
    admissionChecker: async (relPath) => {
      if (relPath === 'media/B_slow.mp4') return slowBPromise;
      return { allowed: true, classification: 'READY_DIRECT' };
    }
  });
  controller.attachRenderer(renderer);

  // Start slow selection of B
  const pB = controller.selectVideo('media/B_slow.mp4');
  check('B selection set currentVideoIndex to 1', state.currentVideoIndex === 1);

  // Immediately user selects C
  const pC = controller.selectVideo('media/C_fast.mp4');
  check('C selection set currentVideoIndex to 2', state.currentVideoIndex === 2);

  await pC;
  check('C is active source', decodeURIComponent(video.src).includes('media/C_fast.mp4'));
  check('state.currentVideoIndex is 2 (C)', state.currentVideoIndex === 2);

  // Settle B later
  resolveB({ allowed: true, classification: 'READY_DIRECT' });
  await pB;

  // Verify B did not overwrite C or move index backward
  check('state.currentVideoIndex is still 2 after late B resolution', state.currentVideoIndex === 2);
  check('video.src is still C_fast.mp4', decodeURIComponent(video.src).includes('media/C_fast.mp4'));
}

console.log('\n------------------------------------------------------------');
if (allPassed) {
  console.log('OVERALL CONTROLLER NAVIGATION SUITE: ✅ ALL PASSED');
} else {
  console.log('OVERALL CONTROLLER NAVIGATION SUITE: ❌ SOME TESTS FAILED');
  process.exit(1);
}
