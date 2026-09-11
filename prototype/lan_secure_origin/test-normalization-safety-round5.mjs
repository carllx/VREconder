import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getMediaFingerprint, isFingerprintValid } from './src/normalization/fingerprint.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { createSyntheticHevcFixture } from './test-fixtures-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_SCRATCH_DIR = path.join(__dirname, 'test_scratch_round5');

console.log('============================================================');
console.log('🧪 RUNNING ROUND 5 DESTRUCTIVE SAFETY HARDENING SUITE');
console.log('============================================================\n');

let totalTests = 0;
let passedTests = 0;

function assert(condition, name, details = '') {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${name} ${details ? `(${details})` : ''}`);
  }
}

if (fs.existsSync(TEST_SCRATCH_DIR)) {
  fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_SCRATCH_DIR, { recursive: true });

function getJournal(name) {
  return new NormalizationJournal(path.join(TEST_SCRATCH_DIR, `journal_${name}.json`));
}

async function runRound5Tests() {
  const dummyFile = path.join(TEST_SCRATCH_DIR, 'dummy.mp4');
  fs.writeFileSync(dummyFile, 'DUMMY_CONTENT', 'utf8');

  // Test 1: P0-1 — CLEANUP_PENDING immediately blocks second job without restart
  console.log('Test 1: P0-1 — CLEANUP_PENDING Immediately Blocks Destructive Subsystem');
  const t1Sample = path.join(TEST_SCRATCH_DIR, 't1_cleanup_block.mp4');
  createSyntheticHevcFixture(t1Sample, 0.2);
  const t1Old = path.join(TEST_SCRATCH_DIR, '.t1_cleanup_block.mp4.vreconder-old');
  let t1OldUnlinkBlocked = true;

  const t1Journal = getJournal('t1');
  const t1Engine = new NormalizationEngine({
    journal: t1Journal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    fileOps: {
      unlinkSync: (p) => {
        if (p === t1Old && t1OldUnlinkBlocked) throw new Error('EBUSY: simulated locked old backup');
        return fs.unlinkSync(p);
      }
    }
  });
  await t1Engine.initialize();
  const t1Result1 = await t1Engine.processCandidate(t1Sample);
  assert(t1Result1.ok === false && t1Result1.state === NormalizationState.CLEANUP_PENDING, 'First job fails into CLEANUP_PENDING');
  assert(t1Engine.status === EngineStatus.CLEANUP_PENDING, 'Engine status is CLEANUP_PENDING (not SAFE_IDLE)');
  assert(fs.existsSync(t1Old) === true, 'Old backup preserved on disk');

  // Attempt second candidate immediately without restart
  const t1SecondSample = path.join(TEST_SCRATCH_DIR, 't1_second.mp4');
  createSyntheticHevcFixture(t1SecondSample, 0.2);
  const t1Result2 = await t1Engine.processCandidate(t1SecondSample);
  assert(t1Result2.ok === false && t1Result2.error.includes('CLEANUP_PENDING'), 'Second job immediately rejected due to CLEANUP_PENDING');

  // Recovery succeeds -> engine returns to SAFE_IDLE
  t1OldUnlinkBlocked = false;
  const t1Recovery = await t1Engine.initialize();
  assert(t1Recovery.ok === true && t1Engine.status === EngineStatus.SAFE_IDLE, 'Engine initialize clears CLEANUP_PENDING and enters SAFE_IDLE');
  assert(!fs.existsSync(t1Old), 'Old backup cleaned after recovery');
  assert(t1Journal.getEntry(t1Sample).currentState === NormalizationState.DONE, 'Journal entry marked DONE');

  // Test 2: P0-2 — Post-FINAL_VERIFIED Playback Cancellation via Single CancellationPromise
  console.log('\nTest 2: P0-2 — Post-FINAL_VERIFIED Single-Owner Cancellation & Lock Preservation');
  const t2Sample = path.join(TEST_SCRATCH_DIR, 't2_final_verified_cancel.mp4');
  createSyntheticHevcFixture(t2Sample, 0.5);
  const origFp2 = getMediaFingerprint(t2Sample);
  const t2Old = path.join(TEST_SCRATCH_DIR, '.t2_final_verified_cancel.mp4.vreconder-old');
  let t2RollbackCount = 0;
  let secondJobRejectedDuringCancel = false;
  let cancelPromise = null;

  const t2Journal = getJournal('t2');
  const t2Engine = new NormalizationEngine({
    journal: t2Journal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    fileOps: {
      onFinalVerified: async (job) => {
        // Trigger playback cancellation precisely after FINAL_VERIFIED is recorded
        cancelPromise = t2Engine.cancelActiveJobForPlayback();

        // Second candidate must be rejected immediately while cancellation is resolving
        const secondAttempt = await t2Engine.processCandidate(dummyFile);
        if (!secondAttempt.ok) secondJobRejectedDuringCancel = true;
      },
      renameSync: (from, to) => {
        if (from === t2Old && to === t2Sample) t2RollbackCount++;
        return fs.renameSync(from, to);
      }
    }
  });
  await t2Engine.initialize();

  const t2JobResult = await t2Engine.processCandidate(t2Sample);
  if (cancelPromise) await cancelPromise;

  assert(t2JobResult.ok === false && t2JobResult.state === NormalizationState.PAUSED_FOR_PLAYBACK, 'processCandidate returns PAUSED_FOR_PLAYBACK after cancellation');
  assert(secondJobRejectedDuringCancel === true, 'Second job strictly rejected while post-FINAL_VERIFIED cancellation is resolving');
  assert(t2RollbackCount === 1, 'Rollback executed exactly once by single owner');
  assert(t2Engine.status === EngineStatus.PAUSED_FOR_PLAYBACK, 'Engine status is consistently PAUSED_FOR_PLAYBACK');
  assert(isFingerprintValid(t2Sample, origFp2), 'Canonical media restored to original proven state');
  t2Engine.notifyPlaybackState(false);

  // Test 3: P0-3 — Repeated CLEANUP_PENDING Recovery Preserves Replacement and Remains CLEANUP_PENDING
  console.log('\nTest 3: P0-3 — Repeated CLEANUP_PENDING Recovery Retains Verified Replacement Without Rollback');
  const t3Sample = path.join(TEST_SCRATCH_DIR, 't3_repeated_cleanup.mp4');
  const t3Old = path.join(TEST_SCRATCH_DIR, '.t3_repeated_cleanup.mp4.vreconder-old');
  fs.writeFileSync(t3Old, 'ORIGINAL_PROVEN_MEDIA_BYTES', 'utf8');
  fs.writeFileSync(t3Sample, 'FINAL_VERIFIED_REPLACEMENT_BYTES', 'utf8');
  const t3OrigFp = getMediaFingerprint(t3Old);
  const t3RepFp = getMediaFingerprint(t3Sample);

  const t3Journal = getJournal('t3');
  t3Journal.recordState(t3Sample, NormalizationState.CLEANUP_PENDING, {
    initialFingerprint: t3OrigFp,
    replacementFingerprint: t3RepFp
  });

  let t3FailUnlink = true;
  let t3RenameAttempted = false;
  const t3FileOps = {
    unlinkSync: (p) => {
      if (p === t3Old && t3FailUnlink) throw new Error('EACCES: permission denied unlinking old backup');
      return fs.unlinkSync(p);
    },
    renameSync: (from, to) => {
      if (from === t3Old) t3RenameAttempted = true;
      return fs.renameSync(from, to);
    }
  };

  // Recovery #1
  const rec1 = t3Journal.recoverOnStartup(t3FileOps);
  assert(rec1.ok === false && rec1.status === 'RECOVERY_BLOCKED', 'Recovery #1 fails closed');
  assert(t3Journal.getEntry(t3Sample).currentState === NormalizationState.CLEANUP_PENDING, 'Journal entry #1 remains CLEANUP_PENDING (not RECOVERY_REQUIRED)');
  assert(t3RenameAttempted === false, 'Recovery #1 did NOT attempt rename / rollback');
  assert(isFingerprintValid(t3Sample, t3RepFp), 'Canonical replacement fingerprint unchanged after recovery #1');

  // Recovery #2
  const rec2 = t3Journal.recoverOnStartup(t3FileOps);
  assert(rec2.ok === false && rec2.status === 'RECOVERY_BLOCKED', 'Recovery #2 fails closed');
  assert(t3Journal.getEntry(t3Sample).currentState === NormalizationState.CLEANUP_PENDING, 'Journal entry #2 still remains CLEANUP_PENDING');
  assert(t3RenameAttempted === false, 'Recovery #2 did NOT attempt rollback');
  assert(isFingerprintValid(t3Sample, t3RepFp), 'Canonical replacement fingerprint unchanged after recovery #2');
  assert(fs.existsSync(t3Old) === true, 'Old backup preserved after recovery #2');

  // Recovery #3: Unlink succeeds
  t3FailUnlink = false;
  const rec3 = t3Journal.recoverOnStartup(t3FileOps);
  assert(rec3.ok === true && rec3.status === 'RECOVERED_SAFE', 'Recovery #3 succeeds when unlink allowed');
  assert(t3Journal.getEntry(t3Sample).currentState === NormalizationState.DONE, 'Journal entry #3 transitions to terminal DONE');
  assert(!fs.existsSync(t3Old), 'Old backup cleanly removed');
  assert(isFingerprintValid(t3Sample, t3RepFp), 'Canonical replacement verified intact');

  // Test 4: P0-4 — Startup Recovery Partial Unlink Failure Remains Blocked
  console.log('\nTest 4: P0-4 — Startup Recovery Partial Unlink Failure Fails Closed');
  // Scenario A: Rollback restores canonical, but partial unlink fails
  const t4aSample = path.join(TEST_SCRATCH_DIR, 't4a_rollback_partial_fail.mp4');
  const t4aOld = path.join(TEST_SCRATCH_DIR, '.t4a_rollback_partial_fail.mp4.vreconder-old');
  const t4aPartial = path.join(TEST_SCRATCH_DIR, '.t4a_rollback_partial_fail.mp4.vreconder.partial');
  fs.writeFileSync(t4aOld, 'T4A_ORIGINAL_PROVEN_BYTES', 'utf8');
  fs.writeFileSync(t4aSample, 'T4A_CORRUPTED_REPLACEMENT', 'utf8');
  fs.writeFileSync(t4aPartial, 'T4A_PARTIAL_BYTES', 'utf8');
  const t4aOrigFp = getMediaFingerprint(t4aOld);

  const t4aJournal = getJournal('t4a');
  t4aJournal.recordState(t4aSample, NormalizationState.RECOVERY_REQUIRED, { initialFingerprint: t4aOrigFp });

  const t4aFileOps = {
    unlinkSync: (p) => {
      if (p === t4aPartial) throw new Error('EPERM: simulated partial unlink failure');
      return fs.unlinkSync(p);
    }
  };

  const rec4a = t4aJournal.recoverOnStartup(t4aFileOps);
  assert(rec4a.ok === false && rec4a.status === 'RECOVERY_BLOCKED', 'Rollback with partial unlink failure is RECOVERY_BLOCKED');
  assert(t4aJournal.getEntry(t4aSample).currentState === NormalizationState.RECOVERY_REQUIRED, 'Journal remains in RECOVERY_REQUIRED (never FAILED_SAFE)');
  assert(fs.existsSync(t4aPartial) === true, 'Partial file remains visible for subsequent recovery');

  // Scenario B: Pre-swap recovery with partial unlink failure
  const t4bSample = path.join(TEST_SCRATCH_DIR, 't4b_preswap_partial_fail.mp4');
  const t4bPartial = path.join(TEST_SCRATCH_DIR, '.t4b_preswap_partial_fail.mp4.vreconder.partial');
  fs.writeFileSync(t4bSample, 'T4B_ORIGINAL_INTACT_BYTES', 'utf8');
  fs.writeFileSync(t4bPartial, 'T4B_PARTIAL_BYTES', 'utf8');
  const t4bOrigFp = getMediaFingerprint(t4bSample);

  const t4bJournal = getJournal('t4b');
  t4bJournal.recordState(t4bSample, NormalizationState.STRUCTURE_VERIFYING, { initialFingerprint: t4bOrigFp });

  const t4bFileOps = {
    unlinkSync: (p) => {
      if (p === t4bPartial) throw new Error('EBUSY: partial locked during pre-swap recovery');
      return fs.unlinkSync(p);
    }
  };

  const rec4b = t4bJournal.recoverOnStartup(t4bFileOps);
  assert(rec4b.ok === false && rec4b.status === 'RECOVERY_BLOCKED', 'Pre-swap recovery with partial unlink failure is RECOVERY_BLOCKED');
  assert(t4bJournal.getEntry(t4bSample).currentState === NormalizationState.RECOVERY_REQUIRED, 'Pre-swap failure records RECOVERY_REQUIRED (not FAILED_SAFE)');

  // Test 5: P1 — Pre-swap Runtime Cleanup Failure Transitions to RECOVERY_BLOCKED
  console.log('\nTest 5: P1 — Pre-swap Runtime Cleanup Failure Transitions to RECOVERY_BLOCKED');
  // Sub-case 5.0: Pre-existing artifact gate test
  const t50Sample = path.join(TEST_SCRATCH_DIR, 't50_artifact_gate.mp4');
  createSyntheticHevcFixture(t50Sample, 0.2);
  const t50Partial = path.join(TEST_SCRATCH_DIR, '.t50_artifact_gate.mp4.vreconder.partial');
  const t50Journal = getJournal('t50');
  const t50Engine = new NormalizationEngine({
    journal: t50Journal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR]
  });
  await t50Engine.initialize();
  fs.writeFileSync(t50Partial, 'PRE_EXISTING_PARTIAL_BYTES', 'utf8');
  const t50Result = await t50Engine.processCandidate(t50Sample);
  assert(t50Result.ok === false && t50Result.state === NormalizationState.RECOVERY_REQUIRED, 'Pre-existing artifact without journal state transitions to RECOVERY_REQUIRED');
  assert(t50Engine.status === EngineStatus.RECOVERY_BLOCKED, 'Engine status is RECOVERY_BLOCKED on pre-existing artifact gate');

  // Sub-case 5.1: True production-path remux failure + partial unlink failure
  const t51Sample = path.join(TEST_SCRATCH_DIR, 't51_remux_fail.mp4');
  createSyntheticHevcFixture(t51Sample, 0.2);
  const t51Partial = path.join(TEST_SCRATCH_DIR, '.t51_remux_fail.mp4.vreconder.partial');
  const t51Journal = getJournal('t51');

  const t51Engine = new NormalizationEngine({
    journal: t51Journal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    spawn: (cmd, args, opts) => {
      if (cmd === 'ffmpeg') {
        const emitter = new EventEmitter();
        emitter.stderr = new EventEmitter();
        // Write simulated partial file during remuxing
        fs.writeFileSync(t51Partial, 'PARTIAL_BYTES_FROM_FAILED_REMUX', 'utf8');
        setTimeout(() => {
          emitter.stderr.emit('data', Buffer.from('Simulated encoder failure in ffmpeg\n'));
          emitter.emit('close', 1);
        }, 20);
        return emitter;
      }
      return spawn(cmd, args, opts);
    },
    fileOps: {
      unlinkSync: (p) => {
        if (p === t51Partial) throw new Error('EPERM: simulated partial unlink fail');
        return fs.unlinkSync(p);
      }
    }
  });
  await t51Engine.initialize();
  const t51Result = await t51Engine.processCandidate(t51Sample);
  assert(t51Result.ok === false && t51Result.state === NormalizationState.RECOVERY_REQUIRED, 'True production-path remux failure with partial unlink fault transitions to RECOVERY_REQUIRED');
  assert(t51Engine.status === EngineStatus.RECOVERY_BLOCKED, 'Engine status is RECOVERY_BLOCKED (not SAFE_IDLE)');
  assert(fs.existsSync(t51Partial) === true, 'Partial file preserved on disk for recovery');

  // Sub-case 5.2: Structure verify failure + partial unlink failure
  const t52Sample = path.join(TEST_SCRATCH_DIR, 't52_struct_fail.mp4');
  createSyntheticHevcFixture(t52Sample, 0.2);
  const t52Partial = path.join(TEST_SCRATCH_DIR, '.t52_struct_fail.mp4.vreconder.partial');
  const t52Journal = getJournal('t52');

  const t52Engine = new NormalizationEngine({
    journal: t52Journal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    fileOps: {
      unlinkSync: (p) => {
        if (p === t52Partial) throw new Error('EBUSY: struct verify partial unlink fail');
        return fs.unlinkSync(p);
      }
    }
  });
  await t52Engine.initialize();

  // Create a corrupt partial so structure verify fails
  let t52Sabotaged = false;
  const t52Promise = t52Engine.processCandidate(t52Sample);
  while (t52Engine.isProcessing && !t52Sabotaged) {
    const entry = t52Journal.getEntry(t52Sample);
    if (entry && entry.currentState === NormalizationState.STRUCTURE_VERIFYING) {
      fs.writeFileSync(t52Partial, 'CORRUPTED_PARTIAL_PAYLOAD', 'utf8');
      t52Sabotaged = true;
      break;
    }
    await new Promise(r => setTimeout(r, 5));
  }
  const t52Result = await t52Promise;
  assert(t52Result.ok === false && t52Result.state === NormalizationState.RECOVERY_REQUIRED, 'Structure verify fail with broken unlink transitions to RECOVERY_REQUIRED');
  assert(t52Engine.status === EngineStatus.RECOVERY_BLOCKED, 'Engine status is RECOVERY_BLOCKED on broken partial unlink');

  // Sub-case 5.3: Swap step 1 failure + partial unlink failure
  const t53Sample = path.join(TEST_SCRATCH_DIR, 't53_swap1_fail.mp4');
  createSyntheticHevcFixture(t53Sample, 0.2);
  const t53Old = path.join(TEST_SCRATCH_DIR, '.t53_swap1_fail.mp4.vreconder-old');
  const t53Partial = path.join(TEST_SCRATCH_DIR, '.t53_swap1_fail.mp4.vreconder.partial');
  const t53Journal = getJournal('t53');

  const t53Engine = new NormalizationEngine({
    journal: t53Journal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    fileOps: {
      renameSync: (from, to) => {
        if (from === t53Sample && to === t53Old) throw new Error('EXDEV: simulated swap step 1 rename fail');
        return fs.renameSync(from, to);
      },
      unlinkSync: (p) => {
        if (p === t53Partial) throw new Error('EPERM: swap step 1 partial unlink fail');
        return fs.unlinkSync(p);
      }
    }
  });
  await t53Engine.initialize();
  const t53Result = await t53Engine.processCandidate(t53Sample);
  assert(t53Result.ok === false && t53Result.state === NormalizationState.RECOVERY_REQUIRED, 'Swap step 1 failure with broken partial unlink is RECOVERY_REQUIRED');
  assert(t53Engine.status === EngineStatus.RECOVERY_BLOCKED, 'Engine status is RECOVERY_BLOCKED');

  // Clean scratch
  try { fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true }); } catch (_) {}

  console.log('\n============================================================');
  console.log(`📊 ROUND 5 TEST SUITE RESULTS: ${passedTests} / ${totalTests} PASSED`);
  console.log('============================================================\n');

  if (passedTests === totalTests) process.exit(0);
  else process.exit(1);
}

runRound5Tests().catch(err => {
  console.error('Round 5 test runner fatal error:', err);
  process.exit(1);
});
