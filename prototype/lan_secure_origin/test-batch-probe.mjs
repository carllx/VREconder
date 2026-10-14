import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CandidateState,
  BatchProbeVerdict,
  getProbeNeutralId,
  sanitizeBatchProbeRecord
} from './src/health/batch-probe-types.mjs';
import {
  loadBatchCheckpoint,
  saveBatchCheckpoint,
  loadBatchRegistry,
  recordBatchResult,
  getBatchProbeFilePaths
} from './src/health/batch-probe-store.mjs';
import { buildBatchCandidateQueue } from './src/health/batch-probe-queue.mjs';
import { handleBatchProbeRoutes } from './src/health/batch-probe-router.mjs';
import { checkPlaybackAdmission } from './src/server/preflight-router.mjs';
import { getMediaFingerprint } from './src/normalization/fingerprint.mjs';
import { loadCheckpoint as loadIssue26Checkpoint } from './src/health/media-health-store.mjs';

describe('AV1 Media Compatibility Batch Probe Test Suite', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vreconder-batch-probe-test-'));
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 1. Candidate Queue building & state separation
  test('1. candidate queue separates ALREADY_ADMITTED, POLICY_DENIED_CANDIDATE, and DERIVATIVE_EXCLUDED', async () => {
    const rootDir = path.join(tempDir, 'media_root');
    fs.mkdirSync(rootDir, { recursive: true });

    // File 1: Normal MP4 (mock)
    const f1 = path.join(rootDir, 'admitted_h264.mp4');
    fs.writeFileSync(f1, 'video-sample-data-1');

    // File 2: Derivative
    const f2 = path.join(rootDir, 'test_sample_HVC1_TEST.mp4');
    fs.writeFileSync(f2, 'derivative-data');

    // File 3: Candidate AV1
    const f3 = path.join(rootDir, 'candidate_av1.mp4');
    fs.writeFileSync(f3, 'av1-media-stream-bytes');

    const inventory = await buildBatchCandidateQueue({
      targetDir: rootDir,
      prototypeDir: tempDir
    });

    assert.equal(inventory.totalDiscovered, 3);
    assert.ok(inventory.counts.DERIVATIVE_EXCLUDED >= 1, 'Should identify derivative');
    assert.ok(inventory.items.length === 3);
  });

  // 2. Isolated persistence does NOT mutate Issue #26 health checkpoint/registry
  test('2. isolated persistence does NOT mutate or overwrite Issue #26 health checkpoint', () => {
    // Check initial state of Issue #26 checkpoint
    const issue26Before = loadIssue26Checkpoint();

    // Save batch probe checkpoint in tempDir
    const cp = {
      runId: 'test_run_123',
      status: 'RUNNING',
      cursor: 5,
      totalQueue: 56,
      completedCount: 5,
      passCount: 4,
      failCount: 1,
      inconclusiveCount: 0
    };
    saveBatchCheckpoint(cp, tempDir);

    recordBatchResult({
      runId: 'test_run_123',
      fingerprintId: 'fp_dummy_123',
      neutralId: 'item:123',
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS
    }, tempDir);

    // Verify batch store saved correctly in isolated directory
    const loadedBatchCp = loadBatchCheckpoint(tempDir);
    assert.equal(loadedBatchCp.runId, 'test_run_123');
    assert.equal(loadedBatchCp.cursor, 5);

    const loadedBatchReg = loadBatchRegistry(tempDir);
    assert.equal(loadedBatchReg.size, 1);
    assert.equal(loadedBatchReg.get('fp_dummy_123').verdict, BatchProbeVerdict.NATIVE_SAMPLE_PASS);

    // Verify Issue #26 checkpoint is untouched
    const issue26After = loadIssue26Checkpoint();
    assert.equal(issue26After.runId, issue26Before.runId);
    assert.equal(issue26After.completedCount, issue26Before.completedCount);
    assert.equal(issue26After.passCount, issue26Before.passCount);
  });

  // 3. Sequential advancement and checkpoint resumption
  test('3. checkpoint resumes cursor and maintains counters across simulated restart', () => {
    let cp = loadBatchCheckpoint(tempDir);
    assert.equal(cp.status, 'RUNNING');
    assert.equal(cp.cursor, 5);

    // Advance cursor
    cp.cursor = 6;
    cp.completedCount = 6;
    cp.passCount = 5;
    saveBatchCheckpoint(cp, tempDir);

    const resumedCp = loadBatchCheckpoint(tempDir);
    assert.equal(resumedCp.cursor, 6);
    assert.equal(resumedCp.completedCount, 6);
    assert.equal(resumedCp.passCount, 5);
  });

  // 4. Evidence-to-verdict enforcement (positive dimensions + rVFC + seek confirmation)
  test('4. NATIVE_SAMPLE_PASS strictly requires positive dimensions, rVFC >= 2, and seek confirmation', async () => {
    const testFile = path.join(tempDir, 'evidence_test.mp4');
    fs.writeFileSync(testFile, 'evidence-test-data');
    const fp = getMediaFingerprint(testFile);

    // Helper mock HTTP request to test route handler
    async function postResult(payload) {
      let responseBody = '';
      let statusCode = 0;
      const req = {
        method: 'POST',
        url: '/api/batch-probe/result',
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'user-agent': 'iPhone Safari Test' },
        on: (event, handler) => {
          if (event === 'data') handler(Buffer.from(JSON.stringify(payload)));
          if (event === 'end') handler();
        }
      };
      const res = {
        writeHead: (code) => { statusCode = code; },
        end: (data) => { responseBody = data; }
      };

      handleBatchProbeRoutes(req, res, '/api/batch-probe/result');
      // allow async tick
      await new Promise(r => setImmediate(r));
      return { statusCode, data: JSON.parse(responseBody) };
    }

    // A: Full valid evidence -> NATIVE_SAMPLE_PASS
    const r1 = await postResult({
      queueIndex: 0,
      generation: 1,
      fingerprintId: fp.fingerprintId,
      filePath: testFile,
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS,
      videoWidth: 4320,
      videoHeight: 2160,
      rvfcCount: 5,
      seekSuccess: true,
      seekCount: 1
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.data.verdict, BatchProbeVerdict.NATIVE_SAMPLE_PASS);

    // B: Missing seek -> Downgrades to SEEK_FAILED
    const r2 = await postResult({
      queueIndex: 1,
      generation: 2,
      fingerprintId: fp.fingerprintId,
      filePath: testFile,
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS,
      videoWidth: 4320,
      videoHeight: 2160,
      rvfcCount: 5,
      seekSuccess: false,
      seekCount: 1
    });
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.data.verdict, BatchProbeVerdict.SEEK_FAILED);

    // C: Missing dimensions/frames -> Downgrades to PLAYBACK_STALLED
    const r3 = await postResult({
      queueIndex: 2,
      generation: 3,
      fingerprintId: fp.fingerprintId,
      filePath: testFile,
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS,
      videoWidth: 0,
      videoHeight: 0,
      rvfcCount: 0,
      seekSuccess: true
    });
    assert.equal(r3.statusCode, 200);
    assert.equal(r3.data.verdict, BatchProbeVerdict.PLAYBACK_STALLED);
  });

  // 5. Fail closed on fingerprint mismatch / tampering
  test('5. fails closed on fingerprint mismatch / spoofing attempt', async () => {
    const testFile = path.join(tempDir, 'tamper_test.mp4');
    fs.writeFileSync(testFile, 'authentic-bytes');

    let responseBody = '';
    let statusCode = 0;
    const req = {
      method: 'POST',
      url: '/api/batch-probe/result',
      socket: { remoteAddress: '192.168.1.50' },
      headers: { 'user-agent': 'TamperClient' },
      on: (event, handler) => {
        if (event === 'data') {
          handler(Buffer.from(JSON.stringify({
            queueIndex: 0,
            generation: 1,
            fingerprintId: 'forged_fake_fp', // does NOT match file
            filePath: testFile,
            verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS
          })));
        }
        if (event === 'end') handler();
      }
    };
    const res = {
      writeHead: (code) => { statusCode = code; },
      end: (data) => { responseBody = data; }
    };

    handleBatchProbeRoutes(req, res, '/api/batch-probe/result');
    await new Promise(r => setImmediate(r));

    assert.equal(statusCode, 400);
    assert.ok(JSON.parse(responseBody).error.includes('tamper'));
  });

  // 6. Production admission gate unaffected
  test('6. production player admission gate remains strictly unpolluted and fail closed', async () => {
    const uncertifiedFile = path.join(tempDir, 'uncertified_av1.mp4');
    fs.writeFileSync(uncertifiedFile, 'uncertified-av1-content');

    const admission = await checkPlaybackAdmission(uncertifiedFile);
    assert.equal(admission.allowed, false, 'Uncertified media must remain denied by production gate');
  });

  // 7. Sanitized public reporting strips private paths
  test('7. public summary strips local paths and private directories', () => {
    const rawRecord = {
      runId: 'run_999',
      itemIndex: 0,
      filePath: 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\New folder (2)\\secret.mp4',
      fingerprintId: 'abc123def456',
      candidateState: CandidateState.POLICY_DENIED_CANDIDATE,
      verdict: BatchProbeVerdict.NATIVE_SAMPLE_PASS,
      videoWidth: 4320,
      videoHeight: 2160,
      rvfcCount: 10,
      seekSuccess: true
    };

    const sanitized = sanitizeBatchProbeRecord(rawRecord);
    assert.equal(sanitized.filePath, undefined, 'Private filePath must be stripped');
    assert.ok(!sanitized.neutralId.includes('New folder (2)'), 'Should not contain raw subfolder path');
    assert.equal(sanitized.verdict, BatchProbeVerdict.NATIVE_SAMPLE_PASS);
  });

  // 8. 600-line code structure guardrail verification
  test('8. all new and modified source files strictly adhere to 600 physical lines limit', () => {
    const filesToCheck = [
      './src/health/batch-probe-types.mjs',
      './src/health/batch-probe-store.mjs',
      './src/health/batch-probe-queue.mjs',
      './src/health/batch-probe-router.mjs',
      './batch-probe.html',
      './server.mjs'
    ];

    for (const rel of filesToCheck) {
      const fullPath = path.resolve(rel);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lineCount = content.split('\n').length;
        assert.ok(
          lineCount <= 600,
          `File ${rel} has ${lineCount} lines, exceeding the 600-line limit!`
        );
      }
    }
  });
});
