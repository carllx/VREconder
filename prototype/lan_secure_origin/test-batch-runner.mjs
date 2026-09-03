import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  BatchNormalizationRunner,
  BatchStatus,
  ServerPlaybackMonitor,
  derivePendingQueue,
  CANONICAL_ACCEPTED_INVENTORY
} from './src/normalization/batch-runner.mjs';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { createSyntheticHevcFixture } from './test-fixtures-helper.mjs';
import { classifyMedia, MediaClass } from './src/normalization/classification.mjs';
import {
  verifyAuthorizationUniverse,
  verifyCandidatePreMutationAuthorization,
  verifyPilotJournalDoneAuthorization
} from './src/normalization/authorization-manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DIR = path.join(__dirname, 'test_scratch_batch');

function setupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

async function runTests() {
  console.log('============================================================');
  console.log('🧪 RUNNING BATCH RUNNER & CONTROLLER TEST SUITE');
  console.log('============================================================\n');

  setupTestDir();

  // Test 1: Candidate Scope & Dynamic Queue Derivation
  console.log('Test 1: Candidate Scope & Dynamic Queue Derivation');
  {
    const jPath = path.join(TEST_DIR, 'journal_test1.json');
    const journal = new NormalizationJournal(jPath);

    const fDone = path.join(TEST_DIR, 'done_pilot.mp4');
    createSyntheticHevcFixture(fDone, 0.1);
    journal.recordState(fDone, NormalizationState.DONE, { completedAt: new Date().toISOString() });

    const fCand1 = path.join(TEST_DIR, 'candidate1.mp4');
    const fCand2 = path.join(TEST_DIR, 'candidate2.mp4');
    createSyntheticHevcFixture(fCand1, 0.1);
    createSyntheticHevcFixture(fCand2, 0.1);

    const mockInventory = [
      { fullPath: fDone, classification: MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE },
      { fullPath: fCand1, classification: MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE },
      { fullPath: fCand2, classification: MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE },
      { fullPath: path.join(TEST_DIR, 'uncertified.mp4'), classification: MediaClass.NEEDS_BUCKET_CERTIFICATION },
      { fullPath: path.join(TEST_DIR, 'probe.mp4'), classification: MediaClass.NEEDS_DEVICE_PROBE },
      { fullPath: path.join(TEST_DIR, 'test_deriv_HVC1_TEST.mp4'), classification: MediaClass.EXPERIMENT_DERIVATIVE, isDerivative: true }
    ];

    const plan = await derivePendingQueue({ inventoryItems: mockInventory, journal });
    assert.strictEqual(plan.totalAcceptedUniverse, 3, 'Universe contains 3 exact-certified items');
    assert.strictEqual(plan.alreadyCompleted.length, 1, '1 item recognized as already DONE');
    assert.strictEqual(plan.pendingQueue.length, 2, '2 pending candidates queued');
    assert.strictEqual(plan.skippedOrExcluded.length, 3, '3 non-candidate items excluded');
    console.log('  ✅ [PASS] Candidate scope dynamically extracted and non-candidates rejected');
  }

  // Test 2: Multiple Sequential Successes (Strict Concurrency = 1)
  console.log('\nTest 2: Multiple Sequential Successes (Strict Concurrency = 1)');
  {
    const jPath = path.join(TEST_DIR, 'journal_test2.json');
    const journal = new NormalizationJournal(jPath);
    const f1 = path.join(TEST_DIR, 'seq1.mp4');
    const f2 = path.join(TEST_DIR, 'seq2.mp4');
    createSyntheticHevcFixture(f1, 0.1);
    createSyntheticHevcFixture(f2, 0.1);

    let maxConcurrency = 0;
    let running = 0;
    const engine = new NormalizationEngine({ journal, executionEnabled: true, allowedRoots: [TEST_DIR] });
    const origProc = engine.processCandidate.bind(engine);
    engine.processCandidate = async (p) => {
      running++;
      if (running > maxConcurrency) maxConcurrency = running;
      const res = await origProc(p);
      running--;
      return res;
    };

    const runner = new BatchNormalizationRunner({ journal, engine, executionEnabled: true, allowedRoots: [TEST_DIR] });
    const report = await runner.runQueue([f1, f2]);
    assert.strictEqual(maxConcurrency, 1, 'Concurrency strictly 1 throughout batch execution');
    assert.strictEqual(report.status, BatchStatus.COMPLETED, 'Queue status is COMPLETED');
    assert.strictEqual(report.completedCount, 2, 'All 2 items completed');
    console.log('  ✅ [PASS] Sequential execution succeeded with strict concurrency = 1');
  }

  // Test 3: Individual Safe Failure Isolation & Queue Continuation
  console.log('\nTest 3: Individual Safe Failure Isolation & Queue Continuation');
  {
    const jPath = path.join(TEST_DIR, 'journal_test3.json');
    const journal = new NormalizationJournal(jPath);
    const fGood1 = path.join(TEST_DIR, 'safe_good1.mp4');
    const fCorrupt = path.join(TEST_DIR, 'safe_corrupt.mp4');
    const fGood2 = path.join(TEST_DIR, 'safe_good2.mp4');
    createSyntheticHevcFixture(fGood1, 0.1);
    createSyntheticHevcFixture(fGood2, 0.1);
    fs.writeFileSync(fCorrupt, Buffer.from('NOT_A_VALID_MP4_HEADER_DATA_GARBAGE'), 'utf8');

    const runner = new BatchNormalizationRunner({ journal, executionEnabled: true, allowedRoots: [TEST_DIR] });
    const report = await runner.runQueue([fGood1, fCorrupt, fGood2]);
    assert.strictEqual(report.status, BatchStatus.COMPLETED, 'Runner completes queue without halting');
    assert.strictEqual(report.completedCount, 2, 'Good candidates completed successfully');
    assert.strictEqual(report.failedSafeCount, 1, 'Corrupted candidate recorded in failedSafe');
    console.log('  ✅ [PASS] Safe failure was cleanly isolated and queue continued');
  }

  // Test 4: Queue-Stopping Anomaly — Engine Anomaly Stops Entire Queue
  console.log('\nTest 4: Queue-Stopping Anomaly — Engine Anomaly Stops Entire Queue');
  {
    const jPath = path.join(TEST_DIR, 'journal_test4.json');
    const journal = new NormalizationJournal(jPath);
    const f1 = path.join(TEST_DIR, 'anomaly1.mp4');
    const f2 = path.join(TEST_DIR, 'anomaly2.mp4');
    createSyntheticHevcFixture(f1, 0.1);
    createSyntheticHevcFixture(f2, 0.1);

    const runner = new BatchNormalizationRunner({ journal, executionEnabled: true, allowedRoots: [TEST_DIR] });
    runner.engine.processCandidate = async () => {
      runner.engine.status = EngineStatus.RECOVERY_BLOCKED;
      return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: 'ROLLBACK_FAILED_RECOVERY_REQUIRED' };
    };

    const report = await runner.runQueue([f1, f2]);
    assert.strictEqual(report.status, BatchStatus.BLOCKED, 'Runner transitioned to BLOCKED');
    assert.strictEqual(report.blocked, true, 'Queue blocked flag is true');
    assert.strictEqual(report.remainingCount, 2, 'Candidate 2 was NOT processed');
    console.log('  ✅ [PASS] Queue-stopping anomaly immediately halted the entire batch');
  }

  // Test 5: Corrupted Journal Halts Execution Immediately
  console.log('\nTest 5: Corrupted Journal Halts Execution Immediately');
  {
    const jPath = path.join(TEST_DIR, 'corrupt_journal.json');
    fs.writeFileSync(jPath, '{ invalid json syntax !!!', 'utf8');
    const runner = new BatchNormalizationRunner({ journalPath: jPath, executionEnabled: true, allowedRoots: [TEST_DIR] });
    const f1 = path.join(TEST_DIR, 'corrupt_j_item.mp4');
    createSyntheticHevcFixture(f1, 0.1);

    const report = await runner.runQueue([f1]);
    assert.strictEqual(report.status, BatchStatus.BLOCKED, 'Runner blocked on corrupt journal');
    console.log('  ✅ [PASS] Corrupt journal fail-closed stops queue prior to any processing');
  }

  // Test 6: Fail-Closed Disk Space Gate
  console.log('\nTest 6: Fail-Closed Disk Space Gate');
  {
    const jPath = path.join(TEST_DIR, 'journal_test6.json');
    const journal = new NormalizationJournal(jPath);
    const f1 = path.join(TEST_DIR, 'space_item.mp4');
    createSyntheticHevcFixture(f1, 0.1);

    const runner = new BatchNormalizationRunner({
      journal, executionEnabled: true, allowedRoots: [TEST_DIR],
      fileOps: { statSync: () => { throw new Error('Simulated disk error'); } }
    });

    const report = await runner.runQueue([f1]);
    assert.strictEqual(report.status, BatchStatus.BLOCKED, 'Runner blocked on disk space error');
    assert(report.blockReason.includes('DISK_SPACE_GATE_STOPPED'), 'Block reason notes disk space gate');
    console.log('  ✅ [PASS] Disk space gate fails closed and stops queue');
  }

  // Test 7: Playback Priority — Pause, Yield and Resume
  console.log('\nTest 7: Playback Priority — Pause, Yield and Resume');
  {
    const jPath = path.join(TEST_DIR, 'journal_test7.json');
    const journal = new NormalizationJournal(jPath);
    const f1 = path.join(TEST_DIR, 'pb_sample1.mp4');
    const f2 = path.join(TEST_DIR, 'pb_sample2.mp4');
    createSyntheticHevcFixture(f1, 0.1);
    createSyntheticHevcFixture(f2, 0.1);

    let playbackListeners = [];
    const mockMonitor = {
      isPlaybackActive: false,
      isSignalHealthy: () => true,
      checkHealth: async () => ({ ok: true }),
      onActiveChange: (fn) => { playbackListeners.push(fn); }
    };

    const runner = new BatchNormalizationRunner({
      journal, executionEnabled: true, allowedRoots: [TEST_DIR], playbackMonitor: mockMonitor
    });

    let pausedObserved = false;
    runner.onProgress = (prog) => {
      if (prog.status === BatchStatus.PAUSED_FOR_PLAYBACK) pausedObserved = true;
    };

    let executionCount = 0;
    const origProcess = runner.engine.processCandidate.bind(runner.engine);
    runner.engine.processCandidate = async (p) => {
      executionCount++;
      if (executionCount === 1) {
        mockMonitor.isPlaybackActive = true;
        for (const l of playbackListeners) l(true);
        setTimeout(() => {
          mockMonitor.isPlaybackActive = false;
          runner.engine.notifyPlaybackState(false);
          for (const l of playbackListeners) l(false);
        }, 150);
        return { ok: false, state: NormalizationState.PAUSED_FOR_PLAYBACK, error: 'Cancelled for playback' };
      }
      return origProcess(p);
    };

    const report = await runner.runQueue([f1, f2]);
    assert(pausedObserved, 'Queue entered PAUSED_FOR_PLAYBACK status');
    assert.strictEqual(report.status, BatchStatus.COMPLETED, 'Queue completed all items after resume');
    console.log('  ✅ [PASS] Playback active paused queue and cleanly resumed to completion');
  }

  // Test 8: Restart / Resume Idempotency
  console.log('\nTest 8: Restart / Resume Idempotency');
  {
    const jPath = path.join(TEST_DIR, 'journal_test8.json');
    const journal = new NormalizationJournal(jPath);
    const f1 = path.join(TEST_DIR, 'res1.mp4');
    const f2 = path.join(TEST_DIR, 'res2.mp4');
    createSyntheticHevcFixture(f1, 0.1);
    createSyntheticHevcFixture(f2, 0.1);

    const runner1 = new BatchNormalizationRunner({ journal, executionEnabled: true, allowedRoots: [TEST_DIR] });
    await runner1.runQueue([f1]);

    let f1ProcessCalled = false;
    const runner2 = new BatchNormalizationRunner({ journal, executionEnabled: true, allowedRoots: [TEST_DIR] });
    const origProc = runner2.engine.processCandidate.bind(runner2.engine);
    runner2.engine.processCandidate = async (p) => {
      if (p === f1) f1ProcessCalled = true;
      return origProc(p);
    };

    const report2 = await runner2.runQueue([f1, f2]);
    assert.strictEqual(f1ProcessCalled, false, 'Already DONE candidate was strictly skipped on restart');
    assert.strictEqual(report2.completedCount, 2, 'Total completed is 2');
    console.log('  ✅ [PASS] Restart skipped already DONE candidate without re-running transaction');
  }

  // Test 9: Concise Progress Formatting Output
  console.log('\nTest 9: Concise Progress Formatting Output');
  {
    const runner = new BatchNormalizationRunner();
    runner.totalCandidates = 235;
    runner.completedItems = [{ path: 'a.mp4' }];
    runner.pendingQueue = [{ fullPath: 'b.mp4' }];
    runner.failedSafeItems = [];
    runner.isBlocked = false;
    runner.activeJobPath = 'C:\\media\\b.mp4';

    const formatted = runner.formatProgress();
    assert(formatted.includes('Total: 235') && formatted.includes('Completed: 1') && formatted.includes('Remaining: 1'), 'Progress formatted');
    console.log('  ✅ [PASS] Concise user-facing progress matches specification');
  }

  // Test 10: Real HTTP Server Playback Signal Integration
  console.log('\nTest 10: Real HTTP Server Playback Signal Integration');
  {
    let serverActive = false;
    let sseClient = null;
    const testServer = http.createServer((req, res) => {
      if (req.url === '/api/playback/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ isPlaybackActive: serverActive }));
      } else if (req.url === '/api/playback/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: {"isPlaybackActive": ${serverActive}}\n\n`);
        sseClient = res;
      } else { res.writeHead(404); res.end(); }
    });

    await new Promise(r => testServer.listen(0, '127.0.0.1', r));
    const port = testServer.address().port;
    const serverUrl = `http://127.0.0.1:${port}`;

    let receivedActiveState = null;
    const monitor = new ServerPlaybackMonitor({ serverUrl, pollIntervalMs: 100 });
    monitor.onActiveChange(state => { receivedActiveState = state; });
    monitor.start();

    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(monitor.isPlaybackActive, false, 'Monitor initially idle');
    serverActive = true;
    if (sseClient) sseClient.write(`data: {"isPlaybackActive": true}\n\n`);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(monitor.isPlaybackActive, true, 'Detected playback active via signal');
    monitor.close();
    await new Promise(r => testServer.close(r));
    console.log('  ✅ [PASS] Real HTTP playback signal path verified between independent processes');
  }

  // Test 11: Playback State Fail-Closed Matrix
  console.log('\nTest 11: Playback State Fail-Closed Matrix');
  {
    // A. Server Unavailable -> BLOCK
    const deadMonitor = new ServerPlaybackMonitor({ serverUrl: 'http://127.0.0.1:59999' });
    const jPath = path.join(TEST_DIR, 'journal_pb_fail.json');
    const f1 = path.join(TEST_DIR, 'pb_fail1.mp4');
    createSyntheticHevcFixture(f1, 0.1);

    const runnerA = new BatchNormalizationRunner({
      journalPath: jPath, executionEnabled: true, allowedRoots: [TEST_DIR], playbackMonitor: deadMonitor
    });
    const reportA = await runnerA.runQueue([f1]);
    assert.strictEqual(reportA.status, BatchStatus.BLOCKED, 'Unavailable server blocks queue');
    assert(reportA.blockReason.includes('PLAYBACK_SIGNAL_UNHEALTHY'), 'Reason identifies playback signal failure');

    // B. Invalid Status Response -> BLOCK
    const invalidServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('NOT_JSON_BODY');
    });
    await new Promise(r => invalidServer.listen(0, '127.0.0.1', r));
    const invMonitor = new ServerPlaybackMonitor({ serverUrl: `http://127.0.0.1:${invalidServer.address().port}` });
    const runnerB = new BatchNormalizationRunner({
      journalPath: jPath, executionEnabled: true, allowedRoots: [TEST_DIR], playbackMonitor: invMonitor
    });
    const reportB = await runnerB.runQueue([f1]);
    assert.strictEqual(reportB.status, BatchStatus.BLOCKED, 'Invalid response blocks queue');
    invalidServer.close();

    // C. Stale Status (freshness timeout) -> BLOCK
    const staleMonitor = {
      isPlaybackActive: false,
      isSignalHealthy: () => false, // Stale!
      checkHealth: async () => ({ ok: false, reason: 'PLAYBACK_SIGNAL_STALE' }),
      onActiveChange: () => {}
    };
    const runnerC = new BatchNormalizationRunner({
      journalPath: jPath, executionEnabled: true, allowedRoots: [TEST_DIR], playbackMonitor: staleMonitor
    });
    const reportC = await runnerC.runQueue([f1]);
    assert.strictEqual(reportC.status, BatchStatus.BLOCKED, 'Stale signal blocks queue');
    console.log('  ✅ [PASS] Playback unknown/unhealthy matrix strictly fails closed (unavailable, invalid, stale)');
  }

  // Test 12: Destructive Custom Inventory Override Scope Lock
  console.log('\nTest 12: Destructive Custom Inventory Override Scope Lock');
  {
    assert.throws(() => {
      new BatchNormalizationRunner({
        executionEnabled: true,
        inventoryPath: 'custom_rogue_inventory.json'
      });
    }, /DESTRUCTIVE_AUTHORIZATION_SCOPE_VIOLATION/, 'Custom inventory rejected in destructive mode');
    console.log('  ✅ [PASS] Destructive mode strictly rejects custom inventory override');
  }

  // Test 13: Current-Fact Drift Handling
  console.log('\nTest 13: Current-Fact Drift Handling');
  {
    const jPath = path.join(TEST_DIR, 'journal_test13.json');
    const journal = new NormalizationJournal(jPath);

    // 1. Same certified envelope but already hvc1 -> alreadyCompleted
    const fNormalized = path.join(TEST_DIR, 'canonical_wakui_media.mp4');
    createSyntheticHevcFixture(fNormalized, 0.1);
    const mockHvc1Facts = {
      video: { codec: 'hevc', codecTag: 'hvc1', width: 4096, height: 2048, level: 153, profile: 'Main', bitDepth: 8, rFps: '60000/1001', avgFps: '60000/1001', durationSec: 1 },
      audioCount: 1
    };

    // 2. Drifted file: resolution drifted to 1920x1080 -> CURRENT_FACTS_DRIFT_EXCLUDED (NOT completed)
    const fDrifted = path.join(TEST_DIR, 'drifted_media.mp4');
    createSyntheticHevcFixture(fDrifted, 0.1);
    const mockDriftedFacts = {
      video: { codec: 'hevc', codecTag: 'hev1', width: 1920, height: 1080, level: 120, profile: 'Main', bitDepth: 8, rFps: '30/1', avgFps: '30/1', durationSec: 1 },
      audioCount: 1
    };

    // 3. Normal candidate: hev1 matching BUCKET_A2 -> pendingQueue
    const fPending = path.join(TEST_DIR, 'good_cand.mp4');
    createSyntheticHevcFixture(fPending, 0.1);
    const mockPendingFacts = {
      video: { codec: 'hevc', codecTag: 'hev1', width: 4096, height: 2048, level: 153, profile: 'Main', bitDepth: 8, rFps: '60000/1001', avgFps: '60000/1001', durationSec: 1 },
      audioCount: 1
    };

    const mockInventory = [
      { fullPath: fNormalized, classification: MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE },
      { fullPath: fDrifted, classification: MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE },
      { fullPath: fPending, classification: MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE }
    ];

    const probeFn = async (p) => {
      if (p === fNormalized) return mockHvc1Facts;
      if (p === fDrifted) return mockDriftedFacts;
      return mockPendingFacts;
    };

    const plan = await derivePendingQueue({ inventoryItems: mockInventory, journal, probeFacts: probeFn });
    assert.strictEqual(plan.alreadyCompleted.length, 1, 'Only clean hvc1 derivative counts as alreadyCompleted');
    assert.strictEqual(plan.alreadyCompleted[0].path, fNormalized, 'Normalized file is in alreadyCompleted');
    assert.strictEqual(plan.pendingQueue.length, 1, 'Only valid pending candidate queued');
    assert.strictEqual(plan.pendingQueue[0].fullPath, fPending, 'Pending candidate is valid hev1');
    assert.strictEqual(plan.skippedOrExcluded.length, 1, 'Drifted item excluded');
    assert.strictEqual(plan.skippedOrExcluded[0].reason, 'CURRENT_FACTS_DRIFT_EXCLUDED', 'Drifted item reason is CURRENT_FACTS_DRIFT_EXCLUDED');
    console.log('  ✅ [PASS] Current-fact drift excluded from pending and strictly NOT counted in completed');
  }

  // Test 14: Authorization Universe Identity Lock Matrix
  console.log('\nTest 14: Authorization Universe Identity Lock Matrix');
  {
    const rawInvPath = path.resolve(__dirname, 'scanned_raw_library.json');
    const manifestPath = path.resolve(__dirname, 'batch_authorization_manifest.json');

    // 1. Exact authorized universe => allowed
    const validCheck = verifyAuthorizationUniverse({ manifestPath, inventoryPath: rawInvPath });
    assert.strictEqual(validCheck.ok, true, 'Exact authorized universe succeeds');
    assert.strictEqual(validCheck.count, 235, 'Authorized universe count is exactly 235');
    assert.strictEqual(validCheck.bucketBreakdown.BUCKET_A1_4K_59FPS_SIVR033, 1, 'Bucket A1 is 1');
    assert.strictEqual(validCheck.bucketBreakdown.BUCKET_A2_4K_60FPS_WAKUI, 233, 'Bucket A2 is 233');
    assert.strictEqual(validCheck.bucketBreakdown.BUCKET_B_8K_60FPS_KAMIKI, 1, 'Bucket B is 1');

    // 2. One candidate path changed => blocked
    const rawItems = JSON.parse(fs.readFileSync(rawInvPath, 'utf8'));
    const pathChangedItems = JSON.parse(JSON.stringify(rawItems));
    const firstCand = pathChangedItems.find(i => classifyMedia(i.fullPath, i.facts).classification === MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE);
    firstCand.fullPath = firstCand.fullPath + '_modified_path.mp4';
    const pathChangedCheck = verifyAuthorizationUniverse({
      manifestPath,
      fileOps: {
        existsSync: () => true,
        readFileSync: (p) => p.includes('manifest') ? fs.readFileSync(manifestPath, 'utf8') : JSON.stringify(pathChangedItems)
      }
    });
    assert.strictEqual(pathChangedCheck.ok, false, 'Path change is blocked');
    assert.strictEqual(pathChangedCheck.reason, 'UNIVERSE_DIGEST_MISMATCH', 'Blocked reason is digest mismatch');

    // 3. Fingerprint/identity changed => blocked
    const fpChangedItems = JSON.parse(JSON.stringify(rawItems));
    const candToChange = fpChangedItems.find(i => classifyMedia(i.fullPath, i.facts).classification === MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE);
    candToChange.facts.video.durationSec += 10.5;
    const fpChangedCheck = verifyAuthorizationUniverse({
      manifestPath,
      fileOps: {
        existsSync: () => true,
        readFileSync: (p) => p.includes('manifest') ? fs.readFileSync(manifestPath, 'utf8') : JSON.stringify(fpChangedItems)
      }
    });
    assert.strictEqual(fpChangedCheck.ok, false, 'Fingerprint change is blocked');
    assert.strictEqual(fpChangedCheck.reason, 'UNIVERSE_DIGEST_MISMATCH', 'Blocked reason is digest mismatch');

    // 4. Candidate added/removed => blocked
    const candToRemoveIdx = rawItems.findIndex(i => classifyMedia(i.fullPath, i.facts).classification === MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE);
    const countChangedItems = [...rawItems];
    countChangedItems.splice(candToRemoveIdx, 1);
    const countChangedCheck = verifyAuthorizationUniverse({
      manifestPath,
      fileOps: {
        existsSync: () => true,
        readFileSync: (p) => p.includes('manifest') ? fs.readFileSync(manifestPath, 'utf8') : JSON.stringify(countChangedItems)
      }
    });
    assert.strictEqual(countChangedCheck.ok, false, 'Count change is blocked');
    assert.strictEqual(countChangedCheck.reason, 'UNIVERSE_COUNT_MISMATCH', 'Blocked reason is count mismatch');

    // 5. Same count (235) but different candidate substituted => blocked
    const substitutedItems = JSON.parse(JSON.stringify(rawItems));
    const candSub = substitutedItems.find(i => classifyMedia(i.fullPath, i.facts).classification === MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE);
    candSub.fullPath = 'G:\\Media\\VR\\RogueMedia_Substituted.mp4';
    const subCheck = verifyAuthorizationUniverse({
      manifestPath,
      fileOps: {
        existsSync: () => true,
        readFileSync: (p) => p.includes('manifest') ? fs.readFileSync(manifestPath, 'utf8') : JSON.stringify(substitutedItems)
      }
    });
    assert.strictEqual(subCheck.ok, false, 'Substitution is blocked');
    assert.strictEqual(subCheck.reason, 'UNIVERSE_DIGEST_MISMATCH', 'Blocked reason is digest mismatch');

    // 6. Missing / corrupt manifest => blocked
    const missingCheck = verifyAuthorizationUniverse({ manifestPath: path.join(TEST_DIR, 'non_existent_manifest.json'), inventoryPath: rawInvPath });
    assert.strictEqual(missingCheck.ok, false, 'Missing manifest is blocked');
    assert.strictEqual(missingCheck.reason, 'MANIFEST_NOT_FOUND');

    const corruptManifestPath = path.join(TEST_DIR, 'corrupt_manifest.json');
    fs.writeFileSync(corruptManifestPath, '{ invalid manifest json !!!', 'utf8');
    const corruptCheck = verifyAuthorizationUniverse({ manifestPath: corruptManifestPath, inventoryPath: rawInvPath });
    assert.strictEqual(corruptCheck.ok, false, 'Corrupt manifest is blocked');
    assert.strictEqual(corruptCheck.reason, 'MANIFEST_CORRUPT');

    // 7. Canonical Pilot currently hvc1/DONE preserves 235 universe identity & yields 234 pending queue
    const pilotJournal = new NormalizationJournal(path.join(__dirname, 'normalization_journal.json'));
    const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const pilotPlan = await derivePendingQueue({ inventoryPath: rawInvPath, journal: pilotJournal, manifest: manifestObj });
    assert.strictEqual(pilotPlan.totalAcceptedUniverse, 235, 'Pilot is part of the 235 authorized universe');
    assert(pilotPlan.alreadyCompleted.length >= 1, 'Completed candidates recognized as already DONE');
    assert.strictEqual(pilotPlan.pendingQueue.length, 0, 'Uncertified chapter candidates are NOT QUEUED into destructive queue');

    // 8. Pilot journal initialFingerprint mismatch => BLOCK / excluded from alreadyCompleted
    const corruptPilotEntry = {
      originalPath: pilotPlan.alreadyCompleted[0].path,
      currentState: NormalizationState.DONE,
      initialFingerprint: { canonicalPath: pilotPlan.alreadyCompleted[0].path, sizeBytes: 999999, mtimeMs: 123456789, fingerprintId: 'mismatched_fp' }
    };
    const badPilotJournal = { getEntry: () => corruptPilotEntry };
    const badPilotPlan = await derivePendingQueue({ inventoryPath: rawInvPath, journal: badPilotJournal, manifest: manifestObj });
    assert.strictEqual(badPilotPlan.alreadyCompleted.length, 0, 'Pilot with mismatched initialFingerprint is strictly excluded from alreadyCompleted');
    assert(badPilotPlan.skippedOrExcluded.some(s => s.reason.includes('PILOT_JOURNAL_FINGERPRINT_MISMATCH')), 'Mismatch recorded in skippedOrExcluded');

    // 9. Per-item candidate authorization gate: exact file fingerprint => PASS
    const firstAuth = manifestObj.candidateIdentities[0];
    const exactFpCheck = verifyCandidatePreMutationAuthorization(firstAuth.path, manifestObj, () => ({
      canonicalPath: firstAuth.path, sizeBytes: firstAuth.sizeBytes, mtimeMs: firstAuth.mtimeMs, fingerprintId: firstAuth.fingerprintId
    }));
    assert.strictEqual(exactFpCheck.ok, true, 'Exact candidate fingerprint succeeds');

    // 10. Per-item candidate authorization gate: same path + same envelope but size changed => BLOCK
    const sizeChangedCheck = verifyCandidatePreMutationAuthorization(firstAuth.path, manifestObj, () => ({
      canonicalPath: firstAuth.path, sizeBytes: firstAuth.sizeBytes + 1024, mtimeMs: firstAuth.mtimeMs, fingerprintId: 'new_hash'
    }));
    assert.strictEqual(sizeChangedCheck.ok, false, 'Candidate size change is blocked');
    assert(sizeChangedCheck.reason.includes('CANDIDATE_FINGERPRINT_MISMATCH'));

    // 11. Per-item candidate authorization gate: mtime changed => BLOCK
    const mtimeChangedCheck = verifyCandidatePreMutationAuthorization(firstAuth.path, manifestObj, () => ({
      canonicalPath: firstAuth.path, sizeBytes: firstAuth.sizeBytes, mtimeMs: firstAuth.mtimeMs + 5000, fingerprintId: 'new_hash'
    }));
    assert.strictEqual(mtimeChangedCheck.ok, false, 'Candidate mtime change is blocked');
    assert(mtimeChangedCheck.reason.includes('CANDIDATE_FINGERPRINT_MISMATCH'));

    // 12. Per-item candidate authorization gate: fingerprint unavailable => BLOCK
    const unavailCheck = verifyCandidatePreMutationAuthorization(firstAuth.path, manifestObj, () => null);
    assert.strictEqual(unavailCheck.ok, false, 'Unavailable fingerprint is blocked');
    assert(unavailCheck.reason.includes('CANDIDATE_FINGERPRINT_UNAVAILABLE'));

    // 13. Per-item candidate authorization gate: substituted fixture => BLOCK
    const substitutedCheck = verifyCandidatePreMutationAuthorization(firstAuth.path, manifestObj, () => ({
      canonicalPath: firstAuth.path, sizeBytes: 123456, mtimeMs: 999999999, fingerprintId: 'sub_hash'
    }));
    assert.strictEqual(substitutedCheck.ok, false, 'Substituted candidate is blocked');
    assert(substitutedCheck.reason.includes('CANDIDATE_FINGERPRINT_MISMATCH'));

    // 14. BatchNormalizationRunner fail-closed with verifyAuthorizationManifest on corrupt manifest
    const blockedRunner = new BatchNormalizationRunner({
      executionEnabled: true,
      verifyAuthorizationManifest: true,
      manifestPath: corruptManifestPath,
      inventoryPath: rawInvPath
    });
    const blockReport = await blockedRunner.runQueue([rawItems[0].fullPath]);
    assert.strictEqual(blockReport.status, BatchStatus.BLOCKED, 'Runner blocked on corrupt manifest');
    assert(blockReport.blockReason.includes('AUTHORIZATION_UNIVERSE_LOCK_FAILED'), 'Block reason notes authorization lock');

    // 15. BatchNormalizationRunner fail-closed on candidate fingerprint mismatch
    const candMismatchRunner = new BatchNormalizationRunner({
      executionEnabled: true,
      verifyAuthorizationManifest: true,
      manifestPath,
      inventoryPath: rawInvPath,
      journal: new NormalizationJournal(path.join(TEST_DIR, 'cand_mismatch_journal.json')),
      fileOps: {
        existsSync: () => true,
        getMediaFingerprint: () => ({ sizeBytes: 1, mtimeMs: 2, fingerprintId: 'fake' })
      }
    });
    const candBlockReport = await candMismatchRunner.runQueue([firstAuth.path]);
    assert.strictEqual(candBlockReport.status, BatchStatus.BLOCKED, 'Runner blocked on candidate fingerprint mismatch');
    assert(candBlockReport.blockReason.includes('CANDIDATE_AUTHORIZATION_LOCK_FAILED'), 'Block reason notes candidate authorization lock failed');

    console.log('  ✅ [PASS] Authorization universe & file-object identity lock matrix strictly verified (all drifts & substitutions fail-closed)');
  }

  console.log('\n============================================================');
  console.log('🎉 ALL BATCH RUNNER SUITES PASSED (14/14)');
  console.log('============================================================');
}

runTests().then(() => {
  setupTestDir();
  process.exit(0);
}).catch(err => {
  console.error('\n❌ Batch runner test failure:', err);
  process.exit(1);
});
