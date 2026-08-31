import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  StallDetector,
  serializeBufferedRanges,
  calculateBufferAhead,
  serializeMediaError,
  captureVisibilityContext
} from './src/telemetry/stall-detector.js';

import {
  streamVideo,
  getRecentRangeLifecycles,
  resetRangeLifecycles
} from './src/media/video-streamer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== RUNNING STALL DETECTOR & INSTRUMENTATION AUTOMATED TESTS ===\n');

// -------------------------------------------------------------
// 1. Serialization Tests (Buffered Ranges, BufferAhead, Error)
// -------------------------------------------------------------
console.log('--- Test Suite 1: Serialization Helpers ---');

// Mock TimeRanges
function createMockTimeRanges(ranges) {
  return {
    length: ranges.length,
    start: (i) => ranges[i][0],
    end: (i) => ranges[i][1]
  };
}

// 1.1 serializeBufferedRanges
{
  const empty = serializeBufferedRanges(null);
  assert.deepStrictEqual(empty, [], 'Null buffered returns empty array');

  const mock = createMockTimeRanges([[0, 10.5], [20.1234, 30.5678]]);
  const serialized = serializeBufferedRanges(mock);
  assert.strictEqual(serialized.length, 2);
  assert.strictEqual(serialized[0].start, 0);
  assert.strictEqual(serialized[0].end, 10.5);
  assert.strictEqual(serialized[1].start, 20.123);
  assert.strictEqual(serialized[1].end, 30.568);
  console.log('✔ Test 1.1 PASS: serializeBufferedRanges correctly formats ranges');
}

// 1.2 calculateBufferAhead
{
  const mock = createMockTimeRanges([[0, 15], [20, 50]]);
  assert.strictEqual(calculateBufferAhead(null, 5), 0, 'Null returns 0');
  assert.strictEqual(calculateBufferAhead(mock, 5), 10, 'currentTime=5 in [0,15] -> 10s ahead');
  assert.strictEqual(calculateBufferAhead(mock, 25), 25, 'currentTime=25 in [20,50] -> 25s ahead');
  assert.strictEqual(calculateBufferAhead(mock, 16), 0, 'currentTime=16 in gap -> 0s ahead');
  assert.strictEqual(calculateBufferAhead(mock, 50), 0, 'currentTime=50 at end -> 0s ahead');
  console.log('✔ Test 1.2 PASS: calculateBufferAhead correctly computes delta');
}

// 1.3 serializeMediaError
{
  assert.strictEqual(serializeMediaError(null), null);
  const err1 = serializeMediaError({ code: 3, message: 'Decoder stall pipeline' });
  assert.strictEqual(err1.code, 3);
  assert.strictEqual(err1.name, 'MEDIA_ERR_DECODE');
  assert.strictEqual(err1.message, 'Decoder stall pipeline');

  const err2 = serializeMediaError({ code: 2, message: '' });
  assert.strictEqual(err2.code, 2);
  assert.strictEqual(err2.name, 'MEDIA_ERR_NETWORK');

  const err4 = serializeMediaError({ code: 4 });
  assert.strictEqual(err4.code, 4);
  assert.strictEqual(err4.name, 'MEDIA_ERR_SRC_NOT_SUPPORTED');
  console.log('✔ Test 1.3 PASS: serializeMediaError correctly resolves codes and names');
}

// -------------------------------------------------------------
// 2. Stall Detector Lifecycle (2s Begin, Milestones, Recovery)
// -------------------------------------------------------------
console.log('\n--- Test Suite 2: Stall Detector Lifecycle ---');

{
  const detector = new StallDetector();
  const capturedSnapshots = [];
  detector.onSnapshot((snap) => capturedSnapshots.push(snap));

  const mockVideo = {
    currentTime: 12.34,
    duration: 100,
    paused: false,
    seeking: false,
    ended: false,
    playbackRate: 1.0,
    readyState: 4,
    networkState: 2,
    buffered: createMockTimeRanges([[0, 50]]),
    error: null,
    getVideoPlaybackQuality: () => ({
      totalVideoFrames: 1200,
      droppedVideoFrames: 5,
      corruptedVideoFrames: 0
    })
  };

  // Step A: Play starts and initial rVFC arrives at t=1000ms
  detector.recordRvfc(1000, {
    mediaTime: 12.34,
    presentedFrames: 1200,
    processingDuration: 0.005,
    expectedDisplayTime: 1016,
    presentationTime: 1016,
    width: 3840,
    height: 1920
  });

  assert.strictEqual(detector.lastRvfcMediaTime, 12.34);
  assert.strictEqual(detector.lastPresentedFrames, 1200);

  // At t=2500ms (1.5s since rVFC): No stall yet
  let snap = detector.checkStall(2500, mockVideo);
  assert.strictEqual(snap, null, 'No stall at 1.5s');
  assert.strictEqual(capturedSnapshots.length, 0);

  // At t=3000ms (2.0s since rVFC): STALL_BEGIN triggers!
  snap = detector.checkStall(3000, mockVideo);
  assert.notStrictEqual(snap, null, 'STALL_BEGIN triggered at 2s');
  assert.strictEqual(snap.phase, 'STALL_BEGIN');
  assert.strictEqual(snap.elapsedMs, 2000);
  assert.strictEqual(snap.mediaState.bufferAheadSec, 37.66); // 50 - 12.34
  assert.strictEqual(snap.mediaState.readyState, 4);
  assert.strictEqual(snap.mediaState.quality.totalVideoFrames, 1200);
  assert.strictEqual(capturedSnapshots.length, 1);
  console.log('✔ Test 2.1 PASS: STALL_BEGIN fires at exactly 2.0s threshold');

  // Repeated checks within milestone interval (e.g. t=3500ms, t=4000ms) do NOT spam duplicate snapshots
  snap = detector.checkStall(3500, mockVideo);
  assert.strictEqual(snap, null, 'No spam between milestones');
  snap = detector.checkStall(4999, mockVideo);
  assert.strictEqual(snap, null, 'No spam before 5s milestone');
  assert.strictEqual(capturedSnapshots.length, 1);
  console.log('✔ Test 2.2 PASS: Repeated checks between milestones do NOT spam snapshots');

  // Milestone 5s at t=6000ms (5s since rVFC at t=1000)
  snap = detector.checkStall(6000, mockVideo);
  assert.notStrictEqual(snap, null);
  assert.strictEqual(snap.phase, 'STALL_MILESTONE');
  assert.strictEqual(snap.milestoneSec, 5);
  assert.strictEqual(capturedSnapshots.length, 2);

  // Check again at 6100ms: does not re-trigger 5s milestone
  snap = detector.checkStall(6100, mockVideo);
  assert.strictEqual(snap, null);

  // Milestone 10s at t=11000ms (10s since rVFC at t=1000)
  snap = detector.checkStall(11000, mockVideo);
  assert.notStrictEqual(snap, null);
  assert.strictEqual(snap.phase, 'STALL_MILESTONE');
  assert.strictEqual(snap.milestoneSec, 10);
  assert.strictEqual(capturedSnapshots.length, 3);

  // Milestone 20s at t=21000ms (20s since rVFC at t=1000)
  snap = detector.checkStall(21000, mockVideo);
  assert.notStrictEqual(snap, null);
  assert.strictEqual(snap.phase, 'STALL_MILESTONE');
  assert.strictEqual(snap.milestoneSec, 20);
  assert.strictEqual(capturedSnapshots.length, 4);

  // Check at 25000ms: 20s milestone does not re-trigger
  snap = detector.checkStall(25000, mockVideo);
  assert.strictEqual(snap, null);
  assert.strictEqual(capturedSnapshots.length, 4);
  console.log('✔ Test 2.3 PASS: Milestones at 5s, 10s, 20s trigger exactly once');

  // Step B: Stall Recovery at t=26000ms (25s total stall duration since t=1000)
  detector.recordRvfc(26000, {
    mediaTime: 12.35,
    presentedFrames: 1201,
    processingDuration: 0.006,
    expectedDisplayTime: 26016,
    presentationTime: 26016
  });

  assert.strictEqual(capturedSnapshots.length, 5);
  const recoverySnap = capturedSnapshots[4];
  assert.strictEqual(recoverySnap.phase, 'STALL_RECOVERED');
  assert.strictEqual(recoverySnap.stallDurationMs, 25000); // 26000 - 1000
  assert.strictEqual(recoverySnap.rvfc.lastPresentedFrames, 1201);
  assert.strictEqual(detector.inStall, false);
  console.log(`✔ Test 2.4 PASS: STALL_RECOVERED records accurate duration (${recoverySnap.stallDurationMs}ms)`);
}

// -------------------------------------------------------------
// 3. Paused / Ended Suppression Test
// -------------------------------------------------------------
console.log('\n--- Test Suite 3: Paused / Ended State Suppression ---');

{
  const detector = new StallDetector();
  const capturedSnapshots = [];
  detector.onSnapshot((snap) => capturedSnapshots.push(snap));

  const mockPausedVideo = {
    currentTime: 5.0,
    duration: 100,
    paused: true,
    ended: false,
    buffered: createMockTimeRanges([[0, 20]])
  };

  detector.recordRvfc(1000, { mediaTime: 5.0, presentedFrames: 50 });

  // At t=10000ms (9s later), video is paused -> checkStall MUST return null
  const snap = detector.checkStall(10000, mockPausedVideo);
  assert.strictEqual(snap, null);
  assert.strictEqual(capturedSnapshots.length, 0);
  console.log('✔ Test 3.1 PASS: Paused video never triggers stall snapshot');
}

// -------------------------------------------------------------
// 4. Production Range Lifecycle Integration Tests
// -------------------------------------------------------------
console.log('\n--- Test Suite 4: Range Lifecycle Telemetry ---');

{
  resetRangeLifecycles();

  // Create temporary test file for streaming (5MB so partial abort can be tested reliably)
  const testFile = path.join(__dirname, 'test_range_diag_temp.bin');
  const testData = Buffer.alloc(5 * 1024 * 1024, 0x42);
  fs.writeFileSync(testFile, testData);

  const server = http.createServer((req, res) => {
    streamVideo(req, res, testFile);
  });

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;

    // Request 1: Valid range bytes=0-499
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/video`, {
        headers: { Range: 'bytes=0-499' }
      }, (res) => {
        assert.strictEqual(res.statusCode, 206);
        let bytes = 0;
        res.on('data', c => { bytes += c.length; });
        res.on('end', () => {
          assert.strictEqual(bytes, 500);
          resolve();
        });
      });
      req.on('error', reject);
    });

    // Request 2: Unsatisfiable range bytes=10000000-
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/video`, {
        headers: { Range: 'bytes=10000000-' }
      }, (res) => {
        assert.strictEqual(res.statusCode, 416);
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
    });

    // Request 3: Aborted / Closed connection simulation (destroy after 1st chunk)
    await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/video`, {
        headers: { Range: 'bytes=0-4000000' }
      }, (res) => {
        res.once('data', () => {
          // Immediately destroy client connection to simulate iPhone Safari seek cancel / abort
          req.destroy();
          setTimeout(resolve, 100);
        });
      });
    });

    const lifecycles = getRecentRangeLifecycles();
    assert.strictEqual(lifecycles.length, 3, 'Recorded exactly 3 request lifecycles');

    // Verify Request 1 lifecycle
    const req1 = lifecycles[0];
    assert.strictEqual(req1.requestId, 1);
    assert.strictEqual(req1.outcome, 'finish');
    assert.strictEqual(req1.responseStatus, 206);
    assert.strictEqual(req1.contentRange, 'bytes 0-499/5242880');
    assert.strictEqual(req1.contentLength, 500);

    // Verify Request 2 lifecycle (416)
    const req2 = lifecycles[1];
    assert.strictEqual(req2.requestId, 2);
    assert.strictEqual(req2.outcome, 'unsatisfiable');
    assert.strictEqual(req2.responseStatus, 416);

    // Verify Request 3 lifecycle (aborted/closed)
    const req3 = lifecycles[2];
    assert.strictEqual(req3.requestId, 3);
    assert.ok(req3.outcome === 'close' || req3.outcome === 'aborted', `Outcome is close or aborted: ${req3.outcome}`);
    assert.strictEqual(req3.responseStatus, 206);

    console.log('✔ Test 4.1 PASS: Range request lifecycles are paired with unique IDs and correct outcomes (finish/unsatisfiable/close)');

    server.close(() => {
      try { fs.unlinkSync(testFile); } catch (e) {}
      console.log('\n=============================================================');
      console.log('ALL STALL INSTRUMENTATION & RANGE LIFECYCLE TESTS PASSED!');
      console.log('=============================================================\n');
    });
  });
}
