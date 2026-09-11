import assert from 'node:assert/strict';

function formatTelemetryLine(payload) {
  const p = payload.perf || {};
  const cad = p.cadence || {};
  const ft = p.frameTimeMs || {};
  const pb = p.playback || {};
  const q = pb.quality || {};
  const mName = payload.mediaName || (payload.mediaPath ? payload.mediaPath.split('/').pop() : '--');
  const dDrop = (typeof q.windowDeltaDropped !== 'undefined') ? q.windowDeltaDropped : '--';
  const dTot = (typeof q.windowDeltaTotal !== 'undefined') ? q.windowDeltaTotal : '--';
  const dRate = (typeof q.windowDropRate !== 'undefined') ? q.windowDropRate + '%' : '--';
  const uiInfo = payload.uiState ? ` UI[vis:${payload.uiState.isStereoUIVisible?'Y':'N'} menu:${payload.uiState.menuOpen?'Y':'N'} toast:${payload.uiState.toastActive?'Y':'N'}]` : '';
  const curTimeStr = (typeof pb.currentTime !== 'undefined') ? ` CurTime:${pb.currentTime}s` : '';
  const pausedStr = (typeof pb.paused !== 'undefined') ? ` Paused:${pb.paused ? 1 : 0}` : '';
  const up = p.texImage2DCallDuration || {};
  const upInfo = (typeof up.medianMs === 'number' && up.uploadCount > 0)
    ? ` | TexUp[med:${up.medianMs}ms p95:${up.p95Ms}ms max:${up.maxMs}ms >16ms:${up.countGt16_7ms || 0} >33ms:${up.countGt33ums || 0} >100ms:${up.countGt100ms || 0}]` 
    : '';
  return `[${payload.serverTimestamp}] Win:#${p.windowSeq} Mode:${p.performanceMode} Scale:${p.renderScale}x Media:${mName} Net:${pb.networkState}${curTimeStr}${pausedStr}${uiInfo} | rAF:${cad.rafPerSec} rVFC:${cad.rvfcPerSec} VidUp:${cad.videoUploadsPerSec} UIUp:${cad.uiUploadsPerSec}${upInfo} | avgFT:${ft.avg}ms p95FT:${ft.p95}ms maxFT:${ft.max}ms | WinDropRate:${dRate} (dDrop:${dDrop}/dTot:${dTot}) Dropped:${q.droppedVideoFrames} TotalF:${q.totalVideoFrames} BufAhead:${pb.bufferAheadSec}s | Ready:${pb.readyState}\n`;
}

console.log('=== RUNNING TELEMETRY FORMATTING REGRESSION TEST ===\n');
// Test Case 1: Full telemetry with upload duration present
const fullPayload = {
  type: 'telemetry_sync',
  serverTimestamp: '2026-08-31T03:40:00.000Z',
  mediaName: 'test_video.mp4',
  uiState: { isStereoUIVisible: true, menuOpen: false, toastActive: false },
  perf: {
    windowSeq: 12,
    performanceMode: 'strict-rvfc-dirty-ui',
    renderScale: 1.0,
    cadence: { rafPerSec: 60, rvfcPerSec: 60, videoUploadsPerSec: 60, uiUploadsPerSec: 0, orientationPerSec: 60 },
    frameTimeMs: { avg: 16.2, p95: 16.5, max: 17.1, samples: 60 },
    texImage2DCallDuration: { uploadCount: 60, medianMs: 2.1, p95Ms: 2.8, maxMs: 3.5, countGt16_7ms: 0, countGt33ums: 0, countGt100ms: 0 },
    playback: { currentTime: 123.4, duration: 1800, paused: false, readyState: 4, networkState: 2, bufferAheadSec: 15.2, bufferedRanges: [{start: 0, end: 150}], quality: { totalVideoFrames: 100, droppedVideoFrames: 0, dropRate: 0, windowDeltaTotal: 60, windowDeltaDropped: 0, windowDropRate: 0 } }
  }
};

const line1 = formatTelemetryLine(fullPayload);
assert.ok(line1.includes('TexUp[med:2.1ms p95:2.8ms max:3.5ms >16ms:0 >33ms:0 >100ms:0]'), 'Must include TexUp stats');
assert.ok(line1.includes('CurTime:123.4s'), 'Must include CurTime');
assert.ok(line1.includes('Paused:0'), 'Must include Paused state');
assert.ok(line1.includes('UI[vis:Y menu:N toast:N]'), 'Must include UI state');
console.log('✓ Test 1 PASS: Full telemetry with upload metrics format safely without ReferenceError');

// Test Case 2: Minimal telemetry with missing texImage2DCallDuration
const missingUploadPayload = {
  type: 'telemetry_sync',
  serverTimestamp: '2026-08-31T03:40:01.000Z',
  perf: {
    windowSeq: 13,
    performanceMode: 'baseline',
    renderScale: 1.0,
    cadence: { rafPerSec: 30, rvfcPerSec: 0, videoUploadsPerSec: 0, uiUploadsPerSec: 0, orientationPerSec: 0 },
    frameTimeMs: { avg: 33.3, p95: 33.3, max: 33.3, samples: 30 },
    playback: { currentTime: 0, duration: 0, paused: true, readyState: 0, networkState: 0, bufferAheadSec: 0 }
  }
};

const line2 = formatTelemetryLine(missingUploadPayload);
assert.ok(!line2.includes('TexUp'), 'Must not include TexUp when missing');
assert.ok(line2.includes('CurTime:0s'), 'Must include default CurTime');
assert.ok(line2.includes('Paused:1'), 'Must include default Paused');
console.log('✔ Test 2 PASS: Telemetry with missing upload metrics format safely');

// Test Case 3: Empty object payload
const emptyPayload = {
  type: 'telemetry_sync',
  serverTimestamp: '2026-08-31T03:40:02.000Z',
  perf: { windowSeq: 14 }
};

const line3 = formatTelemetryLine(emptyPayload);
assert.ok(typeof line3 === 'string', 'Must produce valid string even for empty perf fields');
console.log('✔ Test 3 PASS: Empty payload formats safely without throwing');

console.log('\nALL 3 TELEMETRY FORMATTING TESTS PASSED DETERMINISTICALLY!');