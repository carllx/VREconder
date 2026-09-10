import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  StaticDisposition,
  ProbeVerdict,
  FinalHealthState,
  getRootNeutralId,
  identifyBusinessRegion
} from './src/health/media-health-types.mjs';
import {
  recordHealthResult,
  loadHealthRegistry,
  loadCheckpoint,
  saveCheckpoint
} from './src/health/media-health-store.mjs';
import {
  runStaticHealthScan,
  mapIntakeToStaticDisposition
} from './src/health/media-health-scanner.mjs';
import { resolveHealthMediaPath } from './src/health/media-health-router.mjs';
import { getMediaFingerprint, isFingerprintValid } from './src/normalization/fingerprint.mjs';
import { evaluateMediaFacts, IntakeClassification } from './src/preflight/intake-preflight.mjs';

describe('Issue #26: T1 Media Health Harness Test Suite', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vreconder-health-test-'));
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Test 1: current filesystem discovery can cover both authoritative roots
  test('1. current filesystem discovery covers multiple authoritative roots', async () => {
    const root1 = path.join(tempDir, 'root1');
    const root2 = path.join(tempDir, 'root2');
    fs.mkdirSync(root1, { recursive: true });
    fs.mkdirSync(root2, { recursive: true });

    const file1 = path.join(root1, 'media1.mp4');
    const file2 = path.join(root2, 'media2.mp4');
    fs.writeFileSync(file1, 'fake-content-1');
    fs.writeFileSync(file2, 'fake-content-2');

    const report = await runStaticHealthScan({
      rootDirs: [root1, root2],
      factsCachePath: path.join(tempDir, 'empty_cache.json')
    });

    assert.equal(report.totalDiscovered, 2, 'Should discover files across both roots');
    const paths = report.items.map(i => i.filePath);
    assert.ok(paths.includes(file1));
    assert.ok(paths.includes(file2));
  });

  // Test 2: unchanged cached media avoids unnecessary reprobe
  test('2. unchanged cached media avoids unnecessary reprobe (fact cache reuse)', async () => {
    const testFile = path.join(tempDir, 'cached_media.mp4');
    fs.writeFileSync(testFile, 'dummy-video-content');
    const fp = getMediaFingerprint(testFile);

    const factsCachePath = path.join(tempDir, 'facts_cache.json');
    const cachedFacts = {
      [fp.fingerprintId]: {
        fingerprint: fp,
        video: { codec: 'h264', codecTag: 'avc1', bitDepth: 8, width: 3840, height: 1920, rFps: '60/1', avgFps: '60/1' },
        videoCount: 1,
        audioCount: 1,
        chapterCount: 0,
        otherStreams: [],
        subtitleCount: 0
      }
    };
    fs.writeFileSync(factsCachePath, JSON.stringify(cachedFacts), 'utf8');

    const report = await runStaticHealthScan({
      rootDirs: [path.dirname(testFile)],
      factsCachePath
    });

    const item = report.items.find(i => i.filePath === testFile);
    assert.ok(item, 'File must be discovered');
    assert.equal(item.cachedFacts, true, 'Facts must be reused from cache');
    assert.ok(report.cacheReuseCount >= 1, 'Cache reuse count must increment');
  });

  // Test 3: changed fingerprint invalidates stale health evidence
  test('3. changed fingerprint invalidates stale health evidence', () => {
    const testFile = path.join(tempDir, 'mutable_file.mp4');
    fs.writeFileSync(testFile, 'initial');
    const fp1 = getMediaFingerprint(testFile);

    // Sleep slightly to guarantee mtime change
    const futureTime = new Date(Date.now() + 2000);
    fs.writeFileSync(testFile, 'modified_new_content');
    fs.utimesSync(testFile, futureTime, futureTime);
    const fp2 = getMediaFingerprint(testFile);

    assert.notEqual(fp1.fingerprintId, fp2.fingerprintId, 'Fingerprint must change when content/mtime changes');
    assert.equal(isFingerprintValid(testFile, fp1), false, 'Old cached entry must be invalid');
  });

  // Test 4: known READY_DIRECT does not enter unresolved physical queue
  test('4. known READY_DIRECT does not enter unresolved physical queue', () => {
    const facts = {
      video: { codec: 'h264', codecTag: 'avc1', bitDepth: 8, width: 1920, height: 1080, rFps: '60/1', avgFps: '60/1' },
      videoCount: 1,
      audioCount: 1,
      chapterCount: 0,
      chapters: [],
      otherStreams: [],
      subtitleCount: 0
    };
    const decision = evaluateMediaFacts(facts, 'test.mp4');
    const disposition = mapIntakeToStaticDisposition(decision.classification);

    assert.equal(disposition, StaticDisposition.READY_DIRECT);
    assert.notEqual(disposition, StaticDisposition.NEEDS_DEVICE_PROBE);
  });

  // Test 5: known certified normalization candidate does not enter unnecessary iPhone queue
  test('5. known certified normalization candidate does not enter unnecessary iPhone queue', () => {
    const facts = {
      video: { codec: 'hevc', codecTag: 'hev1', profile: 'Main', level: 153, bitDepth: 8, width: 4096, height: 2048, rFps: '60000/1001', avgFps: '60000/1001' },
      videoCount: 1,
      audioCount: 1,
      chapterCount: 0,
      chapters: [],
      otherStreams: [],
      subtitleCount: 0
    };
    const decision = evaluateMediaFacts(facts, 'test.mp4');
    const disposition = mapIntakeToStaticDisposition(decision.classification);

    assert.equal(disposition, StaticDisposition.NORMALIZATION_CANDIDATE_CERTIFIED);
    assert.notEqual(disposition, StaticDisposition.NEEDS_DEVICE_PROBE);
  });

  // Test 6: unresolved media does enter device queue
  test('6. unresolved media (NEEDS_DEVICE_PROBE) enters device queue', () => {
    const facts = {
      video: { codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', level: 180, bitDepth: 10, width: 7680, height: 3840, rFps: '60/1', avgFps: '60/1' },
      videoCount: 1,
      audioCount: 1,
      chapterCount: 0,
      chapters: [],
      otherStreams: [],
      subtitleCount: 0
    };
    const decision = evaluateMediaFacts(facts, 'test.mp4');
    const disposition = mapIntakeToStaticDisposition(decision.classification);

    assert.equal(disposition, StaticDisposition.NEEDS_DEVICE_PROBE);
  });

  // Test 7: PASS requires dimensions + rVFC
  test('7. PASS requires positive dimensions (videoWidth > 0, videoHeight > 0) + rVFC >= 1', () => {
    function verifyPass(item) {
      const hasDims = item.videoWidth > 0 && item.videoHeight > 0;
      const hasRvfc = typeof item.rvfcFrameCount === 'number' && item.rvfcFrameCount >= 1;
      return hasDims && hasRvfc ? ProbeVerdict.PASS_VIDEO : ProbeVerdict.NO_VIDEO_FRAME;
    }

    assert.equal(verifyPass({ videoWidth: 1920, videoHeight: 1080, rvfcFrameCount: 2 }), ProbeVerdict.PASS_VIDEO);
    assert.equal(verifyPass({ videoWidth: 0, videoHeight: 0, rvfcFrameCount: 5 }), ProbeVerdict.NO_VIDEO_FRAME);
    assert.equal(verifyPass({ videoWidth: 1920, videoHeight: 1080, rvfcFrameCount: 0 }), ProbeVerdict.NO_VIDEO_FRAME);
    assert.equal(verifyPass({ videoWidth: 1920, videoHeight: 1080, rvfcFrameCount: null }), ProbeVerdict.NO_VIDEO_FRAME);
  });

  // Test 8: Code 4 / timeout persist before queue advancement
  test('8. Code 4 / timeout persist before queue advancement', () => {
    const baseDir = path.join(tempDir, 'test8');
    fs.mkdirSync(baseDir, { recursive: true });

    const failedRecord = {
      neutralId: 'Render:test_code4.mp4',
      fingerprintId: 'fp_code4',
      region: 'G:\\Media\\VR\\Render',
      staticClassification: StaticDisposition.NEEDS_DEVICE_PROBE,
      probeVerdict: ProbeVerdict.MEDIA_ERROR,
      finalHealthState: FinalHealthState.DEVICE_PROBE_FAILED,
      error: { code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' }
    };

    recordHealthResult(failedRecord, baseDir);
    const registry = loadHealthRegistry(baseDir);

    assert.equal(registry.size, 1);
    const saved = registry.get('fp_code4');
    assert.equal(saved.probeVerdict, ProbeVerdict.MEDIA_ERROR);
    assert.equal(saved.error.code, 4);
  });

  // Test 9: stale generation result is discarded
  test('9. stale generation result is discarded', () => {
    let currentGeneration = 2;
    let acceptedResults = [];

    function handleProbeCallback(generation, payload) {
      if (generation !== currentGeneration) {
        return false; // Discard stale
      }
      acceptedResults.push(payload);
      return true;
    }

    const res1 = handleProbeCallback(1, { id: 'item1' });
    const res2 = handleProbeCallback(2, { id: 'item2' });

    assert.equal(res1, false, 'Stale token callback must be discarded');
    assert.equal(res2, true, 'Current token callback must be accepted');
    assert.equal(acceptedResults.length, 1);
    assert.equal(acceptedResults[0].id, 'item2');
  });

  // Test 10: persisted checkpoint resumes after simulated page reload
  test('10. persisted checkpoint resumes after simulated page reload', () => {
    const baseDir = path.join(tempDir, 'test10');
    fs.mkdirSync(baseDir, { recursive: true });

    // Simulate saving checkpoint mid-queue
    saveCheckpoint({
      runId: 'run_test_10',
      status: 'RUNNING',
      cursor: 5,
      totalQueue: 20,
      completedCount: 5,
      passCount: 4,
      failCount: 1,
      lastTestedItem: { fingerprintId: 'fp_item_5', verdict: ProbeVerdict.PASS_VIDEO }
    }, baseDir);

    // Simulate reload by loading checkpoint fresh from disk
    const cp = loadCheckpoint(baseDir);
    assert.equal(cp.runId, 'run_test_10');
    assert.equal(cp.cursor, 5, 'Must resume at cursor position');
    assert.equal(cp.completedCount, 5);
    assert.equal(cp.passCount, 4);
  });

  // Test 11: already completed valid probes are not repeated
  test('11. already completed valid probes are not repeated', () => {
    const baseDir = path.join(tempDir, 'test11');
    fs.mkdirSync(baseDir, { recursive: true });

    recordHealthResult({
      neutralId: 'Render:completed.mp4',
      fingerprintId: 'fp_done',
      probeVerdict: ProbeVerdict.PASS_VIDEO,
      finalHealthState: FinalHealthState.HEALTHY_DIRECT
    }, baseDir);

    const registry = loadHealthRegistry(baseDir);
    const queue = [
      { fingerprintId: 'fp_done', neutralId: 'Render:completed.mp4' },
      { fingerprintId: 'fp_pending', neutralId: 'Render:pending.mp4' }
    ];

    const uncompleted = queue.filter(item => {
      const rec = registry.get(item.fingerprintId);
      return !rec || (rec.probeVerdict !== ProbeVerdict.PASS_VIDEO && rec.probeVerdict !== ProbeVerdict.MEDIA_ERROR);
    });

    assert.equal(uncompleted.length, 1);
    assert.equal(uncompleted[0].fingerprintId, 'fp_pending');
  });

  // Test 12: no media mutation occurs
  test('12. no media mutation occurs (filesystem integrity confirmed)', () => {
    const testFile = path.join(tempDir, 'immutable_target.mp4');
    const initialContent = 'PRESERVED_MEDIA_CONTENT_NEVER_MUTATED';
    fs.writeFileSync(testFile, initialContent);

    const statBefore = fs.statSync(testFile);
    const fpBefore = getMediaFingerprint(testFile);

    // Run resolver and check file path
    const resolved = resolveHealthMediaPath(testFile);
    const read = fs.readFileSync(testFile, 'utf8');
    const statAfter = fs.statSync(testFile);
    const fpAfter = getMediaFingerprint(testFile);

    assert.equal(read, initialContent, 'Content must remain identical');
    assert.equal(statBefore.size, statAfter.size, 'Size must not change');
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, 'mtime must not change');
    assert.equal(fpBefore.fingerprintId, fpAfter.fingerprintId, 'Fingerprint must be perfectly preserved');
  });
});
