import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getMediaFingerprint } from './src/normalization/fingerprint.mjs';
import { preflightIncomingMedia, IntakeClassification, EvidenceBasis } from './src/preflight/intake-preflight.mjs';
import { checkPlaybackAdmission, clearAdmissionCache, getProvisionalStore, revokeProvisionalAdmission } from './src/server/preflight-router.mjs';
import { ProvisionalAdmissionStore, DEFAULT_PROVISIONAL_ENTRIES } from './src/preflight/provisional-admission-store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== RUNNING PROVISIONAL AV1 PLAYBACK ADMISSION SUITE ===\n');

async function run() {
  const mediaDir = 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed\\New folder (2)';
  
  const targetFiles = [
    {
      name: 'Anna Bella - Gallery Sweet Compensation - virtualtaboo.mp4',
      expectedFp: '48488830469320d3'
    },
    {
      name: 'Agatha Vega - Czech VR - I\'m Here to Serve.mp4',
      expectedFp: 'd7ed4c1a61ee1e83'
    },
    {
      name: 'Agatha Vega & Leya Desantis - SLR Originals - Euro Trip Rainy Day Fantasy.mp4',
      expectedFp: 'bc6ef8f49633fa0e'
    },
    {
      name: 'Hagawa Ruru - DSVR02007.mp4',
      expectedFp: '31ec2ec5204250df'
    },
    {
      name: 'Shirohana Non - EBVR086.mp4',
      expectedFp: 'ce726e729505a008'
    }
  ];

  // 1. Exact Fingerprint Binding Test
  console.log('Suite 1: Exact Fingerprint Verification of Five Provisional Media Files');
  for (const item of targetFiles) {
    const fullPath = path.join(mediaDir, item.name);
    assert(fs.existsSync(fullPath), `Target file must exist: ${item.name}`);
    const fp = getMediaFingerprint(fullPath);
    assert(fp, `Fingerprint must be computable for ${item.name}`);
    assert.strictEqual(fp.fingerprintId, item.expectedFp, `Fingerprint mismatch for ${item.name}: got ${fp.fingerprintId}, expected ${item.expectedFp}`);
    console.log(`  ✅ [PASS] ${item.name} -> fp: ${fp.fingerprintId} matches exact expected signature`);
  }

  // 2. Preflight & Server Admission Gate Evaluation
  console.log('\nSuite 2: Preflight & Server Admission Authority Evaluation');
  for (const item of targetFiles) {
    const fullPath = path.join(mediaDir, item.name);
    const admission = await checkPlaybackAdmission(fullPath);
    assert.strictEqual(admission.allowed, true, `Admission must be allowed for ${item.name}`);
    assert.strictEqual(admission.classification, IntakeClassification.READY_DIRECT, `Classification must be READY_DIRECT for ${item.name}`);
    console.log(`  ✅ [PASS] ${item.name} -> allowed: true (${admission.classification})`);
  }

  // 3. Negative Counter-Example (Uncertified AV1 retains uncertified classification while allowing user playback trial)
  console.log('\nSuite 3: Negative Counter-Examples & General AV1 Envelope Invariance');
  const deniedCandidateName = 'Haruna Noa - SBGVR014-cut-merged-1788079570967.mp4';
  const deniedFullPath = path.join(mediaDir, 'Haruna Noa - SBGVR014-cut-merged-1788061546710.mp4');
  if (fs.existsSync(deniedFullPath)) {
    const unverifiedAdmission = await checkPlaybackAdmission(deniedFullPath);
    assert.strictEqual(unverifiedAdmission.certified, false, 'Uncertified AV1 must NOT be certified');
    assert.strictEqual(unverifiedAdmission.compatibilityStatus, 'UNVERIFIED', 'Uncertified AV1 must be UNVERIFIED');
    assert.strictEqual(unverifiedAdmission.allowed, true, 'User-owned media in media roots is permitted for trial');
    assert.strictEqual(unverifiedAdmission.classification, IntakeClassification.UNSUPPORTED_UNKNOWN_FIX, 'Uncertified AV1 classification must remain UNSUPPORTED_UNKNOWN_FIX');
    console.log(`  ✅ [PASS] Uncertified AV1 ${path.basename(deniedFullPath)} -> certified: false (${unverifiedAdmission.classification}), allowed: true (UNVERIFIED trial)`);
  }

  // 4. Fingerprint Invalidation / Content Change Fallback Test
  console.log('\nSuite 4: Fingerprint Invalidation / Mutation Tamper Safety');
  const tempTestStoreFile = path.join(__dirname, 'test_provisional_temp.json');
  try {
    const tempStore = new ProvisionalAdmissionStore(tempTestStoreFile);
    tempStore.addAdmission({
      fingerprintId: 'fake_deadbeef1234',
      name: 'Tampered AV1 Video.mp4',
      notes: 'Test entry'
    });

    // Check with synthetic facts having a different fingerprint
    const tamperedFacts = {
      fingerprint: {
        canonicalPath: path.join(mediaDir, 'dummy.mp4'),
        sizeBytes: 123456,
        mtimeMs: 999999,
        fingerprintId: 'different_hash_5678'
      },
      containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
      videoCount: 1,
      video: {
        codec: 'av1',
        codecTag: 'av01',
        profile: 'Main',
        level: 16,
        bitDepth: 8,
        width: 4320,
        height: 2160,
        rFps: '60/1',
        avgFps: '798481920/13308509'
      },
      audioCount: 1,
      subtitleCount: 0,
      otherStreams: [],
      chapterCount: 0,
      chapters: [],
      moovLocation: 'moov_first'
    };

    const tamperedDecision = await preflightIncomingMedia(tamperedFacts.fingerprint.canonicalPath, {
      facts: tamperedFacts,
      provisionalAdmissionStore: tempStore
    });

    assert.strictEqual(tamperedDecision.mayPromoteToVrReady, false, 'Tampered or changed fingerprint must NOT be admitted');
    assert.strictEqual(tamperedDecision.classification, IntakeClassification.UNSUPPORTED_UNKNOWN_FIX, 'Classification must fail closed to UNSUPPORTED_UNKNOWN_FIX');
    console.log('  ✅ [PASS] Changed fingerprint automatically fails closed to DENIED');
  } finally {
    if (fs.existsSync(tempTestStoreFile)) fs.unlinkSync(tempTestStoreFile);
    if (fs.existsSync(`${tempTestStoreFile}.tmp`)) fs.unlinkSync(`${tempTestStoreFile}.tmp`);
  }

  // 5. Existing Certified AV1, HEVC, and H.264 Regression
  console.log('\nSuite 5: Existing Certified AV1, HEVC, and H.264 Direct Envelopes Unchanged');
  const ashinaCertifiedPath = path.join(mediaDir, 'Ashina Honoka - KIWVR898.mp4');
  if (fs.existsSync(ashinaCertifiedPath)) {
    const ashinaAdmission = await checkPlaybackAdmission(ashinaCertifiedPath);
    assert.strictEqual(ashinaAdmission.allowed, true, 'Certified Ashina Honoka must be allowed');
    assert.strictEqual(ashinaAdmission.matchedEnvelopeId, 'CERTIFIED_DIRECT_AV1_4K_60_MOOV_FIRST', 'Must match official CERTIFIED_DIRECT_AV1_4K_60_MOOV_FIRST envelope');
    console.log('  ✅ [PASS] Officially certified Ashina Honoka retains CERTIFIED_DIRECT_AV1_4K_60_MOOV_FIRST authority');
  }

  // 6. Controlled Rollback, Cache Invalidation, Restart Immunity, and Persistence Failure
  console.log('\nSuite 6: Controlled Rollback, Cache Invalidation, Restart Immunity & Persistence Failure');
  const rollbackStoreFile = path.join(__dirname, 'test_rollback_store.json');
  try {
    // 6a. Fresh store with 0 items (fail-closed, does not seed defaults)
    const rbStore = new ProvisionalAdmissionStore(rollbackStoreFile);
    assert.strictEqual(rbStore.listAdmissions().length, 0, 'New store on non-existent file must fail closed with 0 entries');

    // 6b. Add provisional candidate
    const testFp = 'test_rb_fp_123456';
    rbStore.addAdmission({
      fingerprintId: testFp,
      name: 'Rollback Candidate Video.mp4',
      notes: 'Canary test entry'
    });
    assert.strictEqual(rbStore.getAdmission(testFp)?.fingerprintId, testFp, 'Added candidate must be present in memory');

    // 6c. Verify persistence on disk
    const diskContent = JSON.parse(fs.readFileSync(rollbackStoreFile, 'utf8'));
    assert(diskContent.admissions.some(a => a.fingerprintId === testFp), 'Added candidate must be persisted to disk');

    // 6d. Revoke candidate
    const revoked = rbStore.revokeAdmission(testFp);
    assert.strictEqual(revoked, true, 'revokeAdmission must return true on existing entry');
    assert.strictEqual(rbStore.getAdmission(testFp), null, 'Revoked candidate must be deleted from memory');

    // 6e. Verify deletion persisted to disk (not relying on file deletion)
    const diskAfterRevoke = JSON.parse(fs.readFileSync(rollbackStoreFile, 'utf8'));
    assert(!diskAfterRevoke.admissions.some(a => a.fingerprintId === testFp), 'Revoked candidate must be deleted from disk');

    // 6f. Restart immunity: instantiate brand new store instance from same file
    const restartedStore = new ProvisionalAdmissionStore(rollbackStoreFile);
    assert.strictEqual(restartedStore.getAdmission(testFp), null, 'Revoked candidate must NOT resurrect after store reload');
    assert.strictEqual(restartedStore.listAdmissions().length, 0, 'Store must remain empty after reload');

    // 6g. Corrupted file fail-closed check
    const corruptStoreFile = path.join(__dirname, 'test_corrupt_store.json');
    fs.writeFileSync(corruptStoreFile, '{ invalid json syntax !!!', 'utf8');
    const corruptStore = new ProvisionalAdmissionStore(corruptStoreFile);
    assert.strictEqual(corruptStore.listAdmissions().length, 0, 'Corrupted JSON must fail closed with 0 entries');
    if (fs.existsSync(corruptStoreFile)) fs.unlinkSync(corruptStoreFile);

    // 6h. Persistence failure atomicity: in-memory rollback on write error
    const unwritableStoreFile = path.join(__dirname, 'non_existent_sub_dir_123', 'store.json');
    const unwritableStore = new ProvisionalAdmissionStore(unwritableStoreFile);
    let addThrew = false;
    try {
      unwritableStore.addAdmission({ fingerprintId: 'fail_fp_111', name: 'Fail.mp4' });
    } catch (_) {
      addThrew = true;
    }
    assert.strictEqual(addThrew, true, 'addAdmission must throw if saveToDisk fails');
    assert.strictEqual(unwritableStore.getAdmission('fail_fp_111'), null, 'Memory must roll back if disk write fails');

    console.log('  ✅ [PASS] Controlled rollback: Add -> Persist -> Revoke -> Restart -> Fail-Closed verified');
  } finally {
    if (fs.existsSync(rollbackStoreFile)) fs.unlinkSync(rollbackStoreFile);
    if (fs.existsSync(`${rollbackStoreFile}.tmp`)) fs.unlinkSync(`${rollbackStoreFile}.tmp`);
  }
  console.log('PROVISIONAL ADMISSION SUITE: ✅ ALL PASSED');
  console.log('============================================================\n');
}

run().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
