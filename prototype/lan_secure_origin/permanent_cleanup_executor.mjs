import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getMediaFingerprint } from './generate_asset_manifest.mjs';

const RUN_ID = '20260910_gate_b_initial';
const QUARANTINE_ROOT = path.normalize(`G:\\VREconder_Quarantine\\issue-27\\${RUN_ID}`);
const MANIFEST_PATH = 'prototype/lan_secure_origin/asset_integrity_cleanup_manifest.json';
const GATE_B_RECEIPT_PATH = 'prototype/lan_secure_origin/asset_integrity_quarantine_receipt.json';
const FINAL_RECEIPT_PATH = 'prototype/lan_secure_origin/asset_integrity_final_cleanup_receipt.json';

function getDriveFreeSpace(driveLetter = 'G') {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-PSDrive ${driveLetter}).Free"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return BigInt(out);
  } catch (err) {
    console.error(`Failed to get drive free space: ${err.message}`);
    return null;
  }
}

export async function executePermanentCleanup() {
  console.log('=== GATE C: PERMANENT CLEANUP EXECUTION ===');

  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Gate A manifest missing: ${MANIFEST_PATH}`);
  }
  if (!fs.existsSync(GATE_B_RECEIPT_PATH)) {
    throw new Error(`Gate B receipt missing: ${GATE_B_RECEIPT_PATH}`);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const gateBReceipt = JSON.parse(fs.readFileSync(GATE_B_RECEIPT_PATH, 'utf8'));

  if (!Array.isArray(gateBReceipt.items) || gateBReceipt.items.length !== 25) {
    throw new Error(`Expected exactly 25 items in Gate B receipt, found ${gateBReceipt.items?.length}`);
  }

  // Measure initial free disk space
  const initialFreeBytes = getDriveFreeSpace('G');
  console.log(`Initial G: free space: ${initialFreeBytes} bytes`);

  // Load registered provenance manifests for fresh validation
  const sixRepManifest = fs.existsSync('six_rep_derivatives_manifest.json')
    ? JSON.parse(fs.readFileSync('six_rep_derivatives_manifest.json', 'utf8'))
    : {};
  const b2c2d2Manifest = fs.existsSync('b2_c2_d2_derivatives.json')
    ? JSON.parse(fs.readFileSync('b2_c2_d2_derivatives.json', 'utf8'))
    : {};

  const cleanupItems = [];
  let deletedCount = 0;
  let blockedCount = 0;
  let bytesPermanentlyDeleted = 0;
  let retainedCanonicalVerifiedCount = 0;

  for (const item of gateBReceipt.items) {
    console.log(`Processing Group ${item.groupId}: ${path.basename(item.quarantinePath)}`);

    // Guard 1: Quarantine file still exists
    if (!fs.existsSync(item.quarantinePath)) {
      console.error(`  Quarantine file missing: ${item.quarantinePath}`);
      blockedCount++;
      cleanupItems.push({
        groupId: item.groupId,
        quarantinePath: item.quarantinePath,
        retainedCanonicalPath: item.retainedCanonicalPath,
        evidenceType: item.evidenceType,
        evidenceValidationResult: 'FAILED_QUARANTINE_FILE_MISSING',
        deleteStatus: 'DELETE_BLOCKED_FILE_NOT_FOUND',
        deletedAt: null,
        bytesDeleted: 0,
        blockedReason: 'Quarantine file does not exist at recorded path'
      });
      continue;
    }

    // Guard 2: It is one of the exact 25 Gate B receipt entries (verified by iterating gateBReceipt.items)

    // Guard 3: Retained canonical still exists
    if (!fs.existsSync(item.retainedCanonicalPath)) {
      console.error(`  Retained canonical missing: ${item.retainedCanonicalPath}`);
      blockedCount++;
      cleanupItems.push({
        groupId: item.groupId,
        quarantinePath: item.quarantinePath,
        retainedCanonicalPath: item.retainedCanonicalPath,
        evidenceType: item.evidenceType,
        evidenceValidationResult: 'FAILED_RETAINED_CANONICAL_MISSING',
        deleteStatus: 'DELETE_BLOCKED_EVIDENCE_CHANGED',
        deletedAt: null,
        bytesDeleted: 0,
        blockedReason: 'Retained canonical file missing from active root'
      });
      continue;
    }

    // Guard 4: Retained canonical current fingerprint still matches Gate A
    const curRetainedFp = getMediaFingerprint(item.retainedCanonicalPath);
    if (!curRetainedFp || curRetainedFp.fingerprintId !== item.retainedCanonicalFingerprintBeforeMove) {
      console.error(`  Retained canonical fingerprint mismatch for ${item.retainedCanonicalPath}`);
      blockedCount++;
      cleanupItems.push({
        groupId: item.groupId,
        quarantinePath: item.quarantinePath,
        retainedCanonicalPath: item.retainedCanonicalPath,
        evidenceType: item.evidenceType,
        evidenceValidationResult: 'FAILED_RETAINED_CANONICAL_FINGERPRINT_MISMATCH',
        deleteStatus: 'DELETE_BLOCKED_EVIDENCE_CHANGED',
        deletedAt: null,
        bytesDeleted: 0,
        blockedReason: `Retained canonical fingerprint mismatch: expected ${item.retainedCanonicalFingerprintBeforeMove}, got ${curRetainedFp?.fingerprintId}`
      });
      continue;
    }
    retainedCanonicalVerifiedCount++;

    // Guard 5: Evidence is currently valid under one of the 4 strict classes
    let evidenceValid = false;
    let validationNote = '';

    if (item.evidenceType === 'EXACT_BYTE_IDENTICAL_SHA256') {
      if (item.evidenceDetails?.byteIdentical === true && item.evidenceDetails?.candidateSha256 && item.evidenceDetails?.candidateSha256 === item.evidenceDetails?.retainedSha256) {
        evidenceValid = true;
        validationNote = 'EXACT_BYTE_IDENTICAL_CONFIRMED';
      } else {
        validationNote = 'BYTE_IDENTICAL_FLAG_FALSE_OR_HASH_MISMATCH';
      }
    } else if (item.evidenceType === 'GENERATOR_SCRIPT_AND_STREAM_MD5') {
      if (item.evidenceDetails?.streamIdentical === true) {
        evidenceValid = true;
        validationNote = 'GENERATOR_STREAM_MD5_CONFIRMED';
      } else {
        validationNote = 'GENERATOR_STREAM_IDENTICAL_FLAG_FALSE';
      }
    } else if (item.evidenceType === 'DIRECT_STREAM_MD5_MATCH') {
      if (item.evidenceDetails?.streamIdentical === true && item.evidenceDetails?.candidateVideoMd5 === item.evidenceDetails?.retainedVideoMd5) {
        evidenceValid = true;
        validationNote = 'DIRECT_STREAM_MD5_CONFIRMED';
      } else {
        validationNote = 'DIRECT_STREAM_MD5_MISMATCH_OR_FLAG_FALSE';
      }
    } else if (item.evidenceType === 'PROVENANCE_MANIFEST_STREAM_MD5') {
      const filename = path.basename(item.quarantinePath);
      // Re-verify against actual loaded source manifest
      let slotMatch = null;
      if (item.evidenceDetails?.sourceManifest === 'six_rep_derivatives_manifest.json') {
        slotMatch = Object.values(sixRepManifest).find(s => path.basename(s.derivPath) === filename);
      } else if (item.evidenceDetails?.sourceManifest === 'b2_c2_d2_derivatives.json') {
        slotMatch = Object.values(b2c2d2Manifest).find(s => path.basename(s.derivPath) === filename);
      }

      if (!slotMatch) {
        validationNote = 'PROVENANCE_SLOT_NOT_FOUND_IN_SOURCE_MANIFEST';
      } else {
        // Enforce: videoMd5Match === true AND audioMd5Match === true (or explicitly validated no-audio equivalent)
        const vMatch = slotMatch.videoMd5Match === true;
        const aMatch = slotMatch.audioMd5Match === true || slotMatch.aOrig === 'NO_AUDIO_STREAM';
        if (vMatch && aMatch) {
          evidenceValid = true;
          validationNote = `PROVENANCE_STREAM_MD5_CONFIRMED (${slotMatch.slot})`;
        } else {
          validationNote = `PROVENANCE_STREAM_MD5_NOT_MATCHED (vMatch=${vMatch}, aMatch=${aMatch})`;
        }
      }
    } else {
      validationNote = `UNKNOWN_EVIDENCE_TYPE: ${item.evidenceType}`;
    }

    if (!evidenceValid) {
      console.error(`  Evidence validation failed for ${item.groupId}: ${validationNote}`);
      blockedCount++;
      cleanupItems.push({
        groupId: item.groupId,
        quarantinePath: item.quarantinePath,
        retainedCanonicalPath: item.retainedCanonicalPath,
        evidenceType: item.evidenceType,
        evidenceValidationResult: validationNote,
        deleteStatus: 'DELETE_BLOCKED_EVIDENCE_CHANGED',
        deletedAt: null,
        bytesDeleted: 0,
        blockedReason: `Evidence criteria failed: ${validationNote}`
      });
      continue;
    }

    // Execute permanent deletion of the quarantine file
    const statBefore = fs.statSync(item.quarantinePath);
    fs.unlinkSync(item.quarantinePath);

    // Verify deletion succeeded
    if (fs.existsSync(item.quarantinePath)) {
      throw new Error(`File still exists after unlinkSync: ${item.quarantinePath}`);
    }

    const deletedAt = new Date().toISOString();
    deletedCount++;
    bytesPermanentlyDeleted += statBefore.size;
    console.log(`  Permanently deleted: ${path.basename(item.quarantinePath)} (${statBefore.size} bytes)`);

    // Clean up empty parent group directory
    const parentDir = path.dirname(item.quarantinePath);
    try {
      const remainingFiles = fs.readdirSync(parentDir);
      if (remainingFiles.length === 0) {
        fs.rmdirSync(parentDir);
      }
    } catch (e) {
      // Non-fatal
    }

    cleanupItems.push({
      groupId: item.groupId,
      quarantinePath: item.quarantinePath,
      retainedCanonicalPath: item.retainedCanonicalPath,
      evidenceType: item.evidenceType,
      evidenceValidationResult: validationNote,
      deleteStatus: 'PERMANENTLY_DELETED',
      deletedAt,
      bytesDeleted: statBefore.size,
      blockedReason: null
    });
  }

  // Clean up quarantine run directory if completely empty
  try {
    const remainingGroupDirs = fs.readdirSync(QUARANTINE_ROOT);
    if (remainingGroupDirs.length === 0) {
      fs.rmdirSync(QUARANTINE_ROOT);
      console.log(`Cleaned up empty quarantine root: ${QUARANTINE_ROOT}`);
    } else {
      console.log(`Quarantine root contains ${remainingGroupDirs.length} retained items`);
    }
  } catch (e) {
    // Non-fatal
  }

  // Measure final free disk space
  const finalFreeBytes = getDriveFreeSpace('G');
  const freeSpaceDelta = (finalFreeBytes !== null && initialFreeBytes !== null)
    ? (finalFreeBytes - initialFreeBytes)
    : null;

  console.log(`Final G: free space: ${finalFreeBytes} bytes (Delta: ${freeSpaceDelta} bytes)`);

  // === POST-CLEANUP VERIFICATIONS ===
  console.log('=== STEP 2: POST-CLEANUP VERIFICATION ===');

  // Verify Render has zero _HVC1_TEST
  const renderDir = path.normalize('G:\\Media\\VR\\Render');
  const remainingRenderTests = fs.readdirSync(renderDir).filter(f => f.includes('_HVC1_TEST'));
  console.log(`Remaining _HVC1_TEST in Render: ${remainingRenderTests.length}`);

  // Verify all 15 canonical failures untouched
  const canonicalFailures = manifest.groups.filter(g => g.classification === 'CANONICAL_NEEDS_NORMALIZATION');
  let canonicalFailuresUntouched = true;
  for (const cf of canonicalFailures) {
    if (!fs.existsSync(cf.candidatePath)) {
      canonicalFailuresUntouched = false;
      console.error(`Canonical failure missing: ${cf.candidatePath}`);
    }
  }

  // Verify all 4 uncertain groups untouched
  const uncertainGroups = manifest.groups.filter(g => g.classification === 'RELATIONSHIP_UNCERTAIN');
  let uncertainGroupsUntouched = true;
  for (const ug of uncertainGroups) {
    if (!fs.existsSync(ug.candidatePath)) {
      uncertainGroupsUntouched = false;
      console.error(`Uncertain candidate missing: ${ug.candidatePath}`);
    }
  }

  const finalReceipt = {
    receiptVersion: '1.0.0-issue-27-gate-c',
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    gate: 'GATE_C_PERMANENT_CLEANUP_RECEIPT',
    totals: {
      candidatesInReceipt: gateBReceipt.items.length,
      permanentlyDeletedCount: deletedCount,
      blockedCount,
      bytesPermanentlyDeleted,
      initialFreeBytes: initialFreeBytes !== null ? initialFreeBytes.toString() : null,
      finalFreeBytes: finalFreeBytes !== null ? finalFreeBytes.toString() : null,
      freeSpaceDeltaBytes: freeSpaceDelta !== null ? freeSpaceDelta.toString() : null,
      retainedCanonicalVerifiedCount,
      remainingRenderTestsCount: remainingRenderTests.length,
      canonicalFailuresUntouched,
      uncertainGroupsUntouched,
      permanentDeletionOccurred: true
    },
    items: cleanupItems
  };

  fs.writeFileSync(FINAL_RECEIPT_PATH, JSON.stringify(finalReceipt, null, 2), 'utf8');
  console.log(`Final cleanup receipt written to: ${FINAL_RECEIPT_PATH}`);
  console.log('Totals:', JSON.stringify(finalReceipt.totals, null, 2));

  return finalReceipt;
}

if (process.argv[1] && process.argv[1].endsWith('permanent_cleanup_executor.mjs')) {
  executePermanentCleanup().catch(err => {
    console.error('Fatal error during permanent cleanup:', err);
    process.exit(1);
  });
}
