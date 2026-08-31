import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMediaFingerprint, isFingerprintValid } from './src/normalization/fingerprint.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { executeRollback, RollbackStatus } from './src/normalization/rollback-helper.mjs';
import { createSyntheticHevcFixture } from './test-fixtures-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_SCRATCH_DIR = path.join(__dirname, 'test_scratch_round6');

console.log('============================================================');
console.log('🧪 RUNNING ROUND 6 DESTRUCTIVE SAFETY HARDENING SUITE');
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

async function runRound6Tests() {
  // Test 1: FINAL_VERIFIED + canonical missing + replacementFingerprint missing
  console.log('Test 1: FINAL_VERIFIED with missing canonical and missing replacementFingerprint');
  const t1Sample = path.join(TEST_SCRATCH_DIR, 't1_missing_rep_fp.mp4');
  const t1Old = path.join(TEST_SCRATCH_DIR, '.t1_missing_rep_fp.mp4.vreconder-old');
  fs.writeFileSync(t1Old, 'ORIGINAL_PROVEN_CONTENT_T1', 'utf8');
  // Note: canonical is missing
  if (fs.existsSync(t1Sample)) fs.unlinkSync(t1Sample);

  const t1Journal = getJournal('t1');
  t1Journal.recordState(t1Sample, NormalizationState.FINAL_VERIFIED, {
    // Missing replacementFingerprint!
    initialFingerprint: null,
    replacementFingerprint: null
  });

  let t1UnlinkCount = 0;
  let t1RenameCount = 0;
  const t1FileOps = {
    unlinkSync: (p) => { t1UnlinkCount++; return fs.unlinkSync(p); },
    renameSync: (from, to) => { t1RenameCount++; return fs.renameSync(from, to); }
  };

  const t1Recovery = t1Journal.recoverOnStartup(t1FileOps);
  assert(t1Recovery.ok === false, 'Recovery ok is false');
  assert(t1Recovery.status === 'RECOVERY_BLOCKED', 'Recovery status is RECOVERY_BLOCKED');
  assert(fs.existsSync(t1Old) === true, '.vreconder-old backup is strictly preserved on disk');
  assert(t1UnlinkCount === 0, 'Zero unlink operations executed');
  assert(t1RenameCount === 0, 'Zero rename operations executed');
  assert(t1Journal.getEntry(t1Sample).currentState === NormalizationState.RECOVERY_REQUIRED, 'Journal transitions to non-terminal RECOVERY_REQUIRED');

  // Test 2: CLEANUP_PENDING + missing replacementFingerprint
  console.log('\nTest 2: CLEANUP_PENDING with missing replacementFingerprint');
  const t2Sample = path.join(TEST_SCRATCH_DIR, 't2_cleanup_missing_fp.mp4');
  const t2Old = path.join(TEST_SCRATCH_DIR, '.t2_cleanup_missing_fp.mp4.vreconder-old');
  fs.writeFileSync(t2Old, 'ORIGINAL_BACKUP_T2', 'utf8');
  fs.writeFileSync(t2Sample, 'REPLACEMENT_PAYLOAD_T2', 'utf8');

  const t2Journal = getJournal('t2');
  t2Journal.recordState(t2Sample, NormalizationState.CLEANUP_PENDING, {
    replacementFingerprint: null // Missing!
  });

  let t2UnlinkCount = 0;
  const t2FileOps = {
    unlinkSync: (p) => { t2UnlinkCount++; return fs.unlinkSync(p); }
  };

  const t2Recovery = t2Journal.recoverOnStartup(t2FileOps);
  assert(t2Recovery.ok === false, 'Recovery ok is false');
  assert(t2Recovery.status === 'RECOVERY_BLOCKED', 'Recovery status is RECOVERY_BLOCKED');
  assert(t2UnlinkCount === 0, 'No unlink executed on .old backup');
  assert(fs.existsSync(t2Old) === true, 'Old backup preserved on disk');
  assert(t2Journal.getEntry(t2Sample).currentState === NormalizationState.RECOVERY_REQUIRED, 'Journal marked RECOVERY_REQUIRED');

  // Test 3: RECOVERY_REQUIRED + .old present + missing initialFingerprint
  console.log('\nTest 3: RECOVERY_REQUIRED with .old present and missing initialFingerprint');
  const t3Sample = path.join(TEST_SCRATCH_DIR, 't3_recovery_missing_fp.mp4');
  const t3Old = path.join(TEST_SCRATCH_DIR, '.t3_recovery_missing_fp.mp4.vreconder-old');
  const t3Partial = path.join(TEST_SCRATCH_DIR, '.t3_recovery_missing_fp.mp4.vreconder.partial');
  fs.writeFileSync(t3Old, 'OLD_BACKUP_T3', 'utf8');
  fs.writeFileSync(t3Sample, 'CANONICAL_T3', 'utf8');
  fs.writeFileSync(t3Partial, 'PARTIAL_T3', 'utf8');

  const t3Journal = getJournal('t3');
  t3Journal.recordState(t3Sample, NormalizationState.RECOVERY_REQUIRED, {
    initialFingerprint: null // Missing!
  });

  let t3Unlinks = 0;
  let t3Renames = 0;
  const t3FileOps = {
    unlinkSync: (p) => { t3Unlinks++; return fs.unlinkSync(p); },
    renameSync: (from, to) => { t3Renames++; return fs.renameSync(from, to); }
  };

  const t3Recovery = t3Journal.recoverOnStartup(t3FileOps);
  assert(t3Recovery.ok === false, 'Recovery fails closed');
  assert(t3Recovery.status === 'RECOVERY_BLOCKED', 'Status is RECOVERY_BLOCKED');
  assert(t3Unlinks === 0, 'No canonical or partial unlink executed');
  assert(t3Renames === 0, 'No old backup rename executed');
  assert(fs.existsSync(t3Old) === true, 'Old backup preserved intact');
  assert(fs.existsSync(t3Sample) === true, 'Canonical preserved intact');
  assert(fs.existsSync(t3Partial) === true, 'Partial preserved intact');
  assert(t3Journal.getEntry(t3Sample).currentState === NormalizationState.RECOVERY_REQUIRED, 'Journal remains RECOVERY_REQUIRED');

  // Test 4: Interrupted SWAP states (SWAP_STEP1, SWAP_STEP2, FINAL_VERIFYING) + missing initialFingerprint
  console.log('\nTest 4: Interrupted SWAP states with missing initialFingerprint');
  const swapStates = [
    NormalizationState.SWAP_STEP1_RENAME_ORIGINAL,
    NormalizationState.SWAP_STEP2_RENAME_PARTIAL,
    NormalizationState.FINAL_VERIFYING
  ];

  for (const state of swapStates) {
    const sName = `t4_${state.toLowerCase()}`;
    const sSample = path.join(TEST_SCRATCH_DIR, `${sName}.mp4`);
    const sOld = path.join(TEST_SCRATCH_DIR, `.${sName}.mp4.vreconder-old`);
    const sPartial = path.join(TEST_SCRATCH_DIR, `.${sName}.mp4.vreconder.partial`);
    fs.writeFileSync(sOld, `OLD_${state}`, 'utf8');
    fs.writeFileSync(sSample, `CANONICAL_${state}`, 'utf8');
    fs.writeFileSync(sPartial, `PARTIAL_${state}`, 'utf8');

    const sJournal = getJournal(sName);
    sJournal.recordState(sSample, state, {
      initialFingerprint: null // Missing!
    });

    let sUnlinks = 0;
    let sRenames = 0;
    const sFileOps = {
      unlinkSync: (p) => { sUnlinks++; return fs.unlinkSync(p); },
      renameSync: (from, to) => { sRenames++; return fs.renameSync(from, to); }
    };

    const sRecovery = sJournal.recoverOnStartup(sFileOps);
    assert(sRecovery.ok === false, `${state} recovery fails closed when initialFingerprint is missing`);
    assert(sRecovery.status === 'RECOVERY_BLOCKED', `${state} recovery status is RECOVERY_BLOCKED`);
    assert(sUnlinks === 0, `${state} zero unlink operations performed`);
    assert(sRenames === 0, `${state} zero rename operations performed`);
    assert(fs.existsSync(sOld) === true && fs.existsSync(sSample) === true && fs.existsSync(sPartial) === true, `${state} all files intact on disk`);
  }

  // Pre-swap states (REMUXING, STRUCTURE_VERIFYING, PENDING, VERIFIED) + missing initialFingerprint
  const preSwapStates = [
    NormalizationState.REMUXING,
    NormalizationState.STRUCTURE_VERIFYING,
    NormalizationState.PENDING,
    NormalizationState.VERIFIED
  ];

  for (const state of preSwapStates) {
    const pName = `t4_preswap_${state.toLowerCase()}`;
    const pSample = path.join(TEST_SCRATCH_DIR, `${pName}.mp4`);
    const pPartial = path.join(TEST_SCRATCH_DIR, `.${pName}.mp4.vreconder.partial`);
    fs.writeFileSync(pSample, `CANONICAL_${state}`, 'utf8');
    fs.writeFileSync(pPartial, `PARTIAL_${state}`, 'utf8');

    const pJournal = getJournal(pName);
    pJournal.recordState(pSample, state, {
      initialFingerprint: null // Missing!
    });

    let pUnlinks = 0;
    const pFileOps = {
      unlinkSync: (p) => { pUnlinks++; return fs.unlinkSync(p); }
    };

    const pRecovery = pJournal.recoverOnStartup(pFileOps);
    assert(pRecovery.ok === false, `${state} pre-swap recovery fails closed when initialFingerprint missing`);
    assert(pRecovery.status === 'RECOVERY_BLOCKED', `${state} status is RECOVERY_BLOCKED`);
    assert(pUnlinks === 0, `${state} no unlinks executed on unverified state`);
    assert(fs.existsSync(pPartial) === true, `${state} partial preserved on disk`);
  }

  // Test 5: executeRollback({ isSwapped:true, initialFingerprint:null })
  console.log('\nTest 5: executeRollback without initialFingerprint fails closed with zero mutations');
  const t5Sample = path.join(TEST_SCRATCH_DIR, 't5_rollback.mp4');
  const t5Old = path.join(TEST_SCRATCH_DIR, '.t5_rollback.mp4.vreconder-old');
  const t5Partial = path.join(TEST_SCRATCH_DIR, '.t5_rollback.mp4.vreconder.partial');
  fs.writeFileSync(t5Sample, 'CANONICAL_T5', 'utf8');
  fs.writeFileSync(t5Old, 'OLD_T5', 'utf8');
  fs.writeFileSync(t5Partial, 'PARTIAL_T5', 'utf8');

  let t5Unlinks = 0;
  let t5Renames = 0;
  const t5FileOps = {
    unlinkSync: (p) => { t5Unlinks++; return fs.unlinkSync(p); },
    renameSync: (from, to) => { t5Renames++; return fs.renameSync(from, to); }
  };

  // 5.1 Swapped rollback with missing initialFingerprint
  const rbSwapped = executeRollback({
    canonical: t5Sample,
    oldPath: t5Old,
    partialPath: t5Partial,
    isSwapped: true,
    initialFingerprint: null,
    fileOps: t5FileOps
  });

  assert(rbSwapped.ok === false, 'Swapped rollback ok is false');
  assert(rbSwapped.status === RollbackStatus.ROLLBACK_BLOCKED, 'Swapped rollback status is ROLLBACK_BLOCKED');
  assert(t5Unlinks === 0, 'Swapped rollback executed 0 unlinks');
  assert(t5Renames === 0, 'Swapped rollback executed 0 renames');
  assert(fs.existsSync(t5Old) === true && fs.existsSync(t5Sample) === true, 'Files intact on disk');

  // 5.2 Unswapped rollback with missing initialFingerprint
  const t5bSample = path.join(TEST_SCRATCH_DIR, 't5b_unswapped.mp4');
  const t5bPartial = path.join(TEST_SCRATCH_DIR, '.t5b_unswapped.mp4.vreconder.partial');
  fs.writeFileSync(t5bSample, 'CANONICAL_T5B', 'utf8');
  fs.writeFileSync(t5bPartial, 'PARTIAL_T5B', 'utf8');

  let t5bUnlinks = 0;
  const t5bFileOps = {
    unlinkSync: (p) => { t5bUnlinks++; return fs.unlinkSync(p); }
  };

  const rbUnswapped = executeRollback({
    canonical: t5bSample,
    oldPath: path.join(TEST_SCRATCH_DIR, '.t5b_unswapped.mp4.vreconder-old'),
    partialPath: t5bPartial,
    isSwapped: false,
    initialFingerprint: null,
    fileOps: t5bFileOps
  });

  assert(rbUnswapped.ok === false, 'Unswapped rollback ok is false on missing initialFingerprint');
  assert(rbUnswapped.status === RollbackStatus.ROLLBACK_BLOCKED, 'Unswapped rollback status is ROLLBACK_BLOCKED');
  assert(t5bUnlinks === 0, 'Unswapped rollback executed 0 unlinks');
  assert(fs.existsSync(t5bPartial) === true, 'Partial file preserved');

  // Test 6: Runtime processCandidate fingerprint acquisition failure
  console.log('\nTest 6: Runtime processCandidate fingerprint acquisition failure fails closed');
  const t6Sample = path.join(TEST_SCRATCH_DIR, 't6_candidate.mp4');
  createSyntheticHevcFixture(t6Sample, 0.2);
  const t6Old = path.join(TEST_SCRATCH_DIR, '.t6_candidate.mp4.vreconder-old');
  const t6Partial = path.join(TEST_SCRATCH_DIR, '.t6_candidate.mp4.vreconder.partial');
  const t6CanonicalBytesBefore = fs.readFileSync(t6Sample);

  let t6RemuxSpawned = false;
  const t6Journal = getJournal('t6');
  const t6Engine = new NormalizationEngine({
    journal: t6Journal,
    executionEnabled: true,
    allowedRoots: [TEST_SCRATCH_DIR],
    getMediaFingerprint: (p) => {
      // Simulate fingerprint acquisition failure / unreadable metadata
      return null;
    },
    spawn: (cmd, args, opts) => {
      t6RemuxSpawned = true;
      throw new Error('SPAWN_MUST_NOT_BE_CALLED_ON_ADMISSION_FAILURE');
    }
  });

  await t6Engine.initialize();
  const t6Result = await t6Engine.processCandidate(t6Sample);

  assert(t6Result.ok === false, 'processCandidate returns ok: false');
  assert(t6Result.error === 'INITIAL_FINGERPRINT_UNAVAILABLE', 'Error is INITIAL_FINGERPRINT_UNAVAILABLE');
  assert(t6Result.state === NormalizationState.FAILED_SAFE, 'State is FAILED_SAFE');
  assert(t6RemuxSpawned === false, 'ffmpeg remux was NOT spawned');
  assert(t6Engine.status === EngineStatus.SAFE_IDLE, 'Engine remains in SAFE_IDLE');
  assert(fs.existsSync(t6Old) === false, 'No .old artifact was created');
  assert(fs.existsSync(t6Partial) === false, 'No .partial artifact was created');
  const t6CanonicalBytesAfter = fs.readFileSync(t6Sample);
  assert(Buffer.compare(t6CanonicalBytesBefore, t6CanonicalBytesAfter) === 0, 'Canonical media bytes strictly unmutated');

  // Clean scratch
  try { fs.rmSync(TEST_SCRATCH_DIR, { recursive: true, force: true }); } catch (_) {}

  console.log('\n============================================================');
  console.log(`📊 ROUND 6 TEST SUITE RESULTS: ${passedTests} / ${totalTests} PASSED`);
  console.log('============================================================\n');

  if (passedTests === totalTests) process.exit(0);
  else process.exit(1);
}

runRound6Tests().catch(err => {
  console.error('Round 6 test runner fatal error:', err);
  process.exit(1);
});
