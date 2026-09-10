import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { getMediaFingerprint } from './generate_asset_manifest.mjs';

const RUN_ID = '20260910_gate_b_initial';
const QUARANTINE_ROOT = path.normalize(`G:\\VREconder_Quarantine\\issue-27\\${RUN_ID}`);
const MANIFEST_PATH = 'prototype/lan_secure_origin/asset_integrity_cleanup_manifest.json';
const RECEIPT_PATH = 'prototype/lan_secure_origin/asset_integrity_quarantine_receipt.json';

// Authoritative provenance mappings
const CHAPTER_DERIVATIVES = new Set([
  '3840_1920_crfun_avc1-Mikami Yua - SIVR102 - (HEVC_21)_CHAPTER_HVC1_TEST.mp4',
  '4096_2048_crf18_avc1-Kosaka Himari - KIWVR730 - (HEVC_19)_CHAPTER_HVC1_TEST.mp4',
  '4096_2048_crf21_avc1-Fujita kozue - NHVR220 - (HEVC_21.0)_CHAPTER_HVC1_TEST.mp4',
  '4096_2048_crf21_avc1-URVRSP203(UNVRSP002) - p1 - (HEVC_19)_CHAPTER_HVC1_TEST.mp4'
]);

function computeStreamMd5(filePath) {
  try {
    const vOut = execSync(`ffmpeg -i "${filePath}" -map 0:v:0 -c copy -f md5 -`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    let aOut = null;
    try {
      aOut = execSync(`ffmpeg -i "${filePath}" -map 0:a:0 -c copy -f md5 -`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (e) {
      aOut = 'NO_AUDIO_STREAM';
    }
    return { vMd5: vOut, aMd5: aOut };
  } catch (err) {
    return null;
  }
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function executeQuarantineAndStrengthenEvidence() {
  console.log('=== STEP 1: PRE-MOVE VERIFICATION ===');
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const testGroups = manifest.groups.filter(g => g.classification === 'TEST_ARTIFACT');

  if (testGroups.length !== 25) {
    throw new Error(`Expected exactly 25 test artifacts, got ${testGroups.length}`);
  }

  // Create quarantine root
  fs.mkdirSync(QUARANTINE_ROOT, { recursive: true });

  // Load registered provenance manifests
  const sixRepManifest = fs.existsSync('six_rep_derivatives_manifest.json')
    ? JSON.parse(fs.readFileSync('six_rep_derivatives_manifest.json', 'utf8'))
    : {};
  const b2c2d2Manifest = fs.existsSync('b2_c2_d2_derivatives.json')
    ? JSON.parse(fs.readFileSync('b2_c2_d2_derivatives.json', 'utf8'))
    : {};

  const items = [];
  let movedCount = 0;
  let blockedCount = 0;
  let bytesMoved = 0;

  for (const g of testGroups) {
    console.log(`Processing Group ${g.groupId}: ${path.basename(g.candidatePath)}`);
    // 1. Candidate exists
    const cFp = getMediaFingerprint(g.candidatePath);
    // 2. Candidate fingerprint matches Gate A
    const cMatch = cFp && cFp.fingerprintId === g.candidateFingerprint;
    // 3. Retained canonical exists
    const rFp = getMediaFingerprint(g.retainedCanonicalPath);
    // 4. Retained canonical fingerprint matches Gate A
    const rMatch = rFp && rFp.fingerprintId === g.retainedCanonicalFingerprint;

    if (!cMatch || !rMatch) {
      console.error(`  BLOCKED: evidence changed for ${g.groupId}`);
      blockedCount++;
      items.push({
        groupId: g.groupId,
        originalPath: g.candidatePath,
        quarantinePath: null,
        candidateFingerprintBeforeMove: cFp?.fingerprintId || null,
        sizeBytes: g.candidateSize,
        retainedCanonicalPath: g.retainedCanonicalPath,
        retainedCanonicalFingerprintBeforeMove: rFp?.fingerprintId || null,
        movedAt: null,
        moveStatus: 'MOVE_BLOCKED_EVIDENCE_CHANGED',
        rollbackPath: null,
        evidenceStatus: 'PENDING_INVESTIGATION',
        evidenceType: null,
        permanentDeleteClassification: 'KEEP_QUARANTINED_PENDING_EVIDENCE',
        evidenceDetails: null
      });
      continue;
    }

    // Determine target quarantine path (subfolder per group to avoid name collision, preserving original filename)
    const groupQuarantineDir = path.join(QUARANTINE_ROOT, g.groupId);
    fs.mkdirSync(groupQuarantineDir, { recursive: true });
    const targetQuarantinePath = path.join(groupQuarantineDir, path.basename(g.candidatePath));

    // Perform atomic same-volume move
    fs.renameSync(g.candidatePath, targetQuarantinePath);
    const movedAt = new Date().toISOString();
    movedCount++;
    bytesMoved += g.candidateSize;
    console.log(`  Moved to: ${targetQuarantinePath}`);

    // Verify candidate now absent from original location
    if (fs.existsSync(g.candidatePath)) {
      throw new Error(`Candidate still exists at original path after rename: ${g.candidatePath}`);
    }
    if (!fs.existsSync(targetQuarantinePath)) {
      throw new Error(`Candidate missing in quarantine after rename: ${targetQuarantinePath}`);
    }

    // === STEP 2: EVIDENCE STRENGTHENING IN QUARANTINE ===
    const filename = path.basename(targetQuarantinePath);
    let permClassification = 'KEEP_QUARANTINED_PENDING_EVIDENCE';
    let evidenceType = null;
    let evidenceDetails = null;

    // Check Type A: six_rep_derivatives_manifest
    const sixRepSlot = Object.values(sixRepManifest).find(s => path.basename(s.derivPath) === filename);
    if (sixRepSlot) {
      permClassification = 'PERMANENT_DELETE_READY';
      evidenceType = 'PROVENANCE_MANIFEST_STREAM_MD5';
      evidenceDetails = {
        sourceManifest: 'six_rep_derivatives_manifest.json',
        slot: sixRepSlot.slot,
        videoMd5Orig: sixRepSlot.videoMd5Orig,
        videoMd5Deriv: sixRepSlot.videoMd5Deriv,
        audioMd5Orig: sixRepSlot.audioMd5Orig,
        audioMd5Deriv: sixRepSlot.audioMd5Deriv,
        videoMd5Match: sixRepSlot.videoMd5Match,
        audioMd5Match: sixRepSlot.audioMd5Match
      };
    }

    // Check Type A: b2_c2_d2_derivatives
    if (!evidenceType) {
      const b2c2d2Slot = Object.values(b2c2d2Manifest).find(s => path.basename(s.derivPath) === filename);
      if (b2c2d2Slot) {
        permClassification = 'PERMANENT_DELETE_READY';
        evidenceType = 'PROVENANCE_MANIFEST_STREAM_MD5';
        evidenceDetails = {
          sourceManifest: 'b2_c2_d2_derivatives.json',
          slot: b2c2d2Slot.slot,
          vOrig: b2c2d2Slot.vOrig,
          vDeriv: b2c2d2Slot.vDeriv,
          aOrig: b2c2d2Slot.aOrig,
          aDeriv: b2c2d2Slot.aDeriv,
          videoMd5Match: b2c2d2Slot.videoMd5Match,
          audioMd5Match: b2c2d2Slot.audioMd5Match
        };
      }
    }

    // Check Type A: chapter certification generator
    if (!evidenceType && CHAPTER_DERIVATIVES.has(filename)) {
      // For URVRSP203 p1, compute full SHA-256 byte identity
      if (filename.includes('URVRSP203')) {
        const [h1, h2] = await Promise.all([
          computeFileSha256(targetQuarantinePath),
          computeFileSha256(g.retainedCanonicalPath)
        ]);
        if (h1 === h2) {
          permClassification = 'PERMANENT_DELETE_READY';
          evidenceType = 'EXACT_BYTE_IDENTICAL_SHA256';
          evidenceDetails = {
            generatorScript: 'prototype/lan_secure_origin/generate-chapter-certification-derivatives.mjs',
            candidateSha256: h1,
            retainedSha256: h2,
            byteIdentical: true
          };
        }
      } else {
        // Stream MD5 verification
        const cStream = computeStreamMd5(targetQuarantinePath);
        const rStream = computeStreamMd5(g.retainedCanonicalPath);
        if (cStream && rStream && cStream.vMd5 === rStream.vMd5 && cStream.aMd5 === rStream.aMd5) {
          permClassification = 'PERMANENT_DELETE_READY';
          evidenceType = 'GENERATOR_SCRIPT_AND_STREAM_MD5';
          evidenceDetails = {
            generatorScript: 'prototype/lan_secure_origin/generate-chapter-certification-derivatives.mjs',
            videoMd5: cStream.vMd5,
            audioMd5: cStream.aMd5,
            streamIdentical: true
          };
        }
      }
    }

    // Check Type C: 8K Large Remuxes with equal size
    if (!evidenceType && (filename.includes('DSVR01433') || filename.includes('SIVR033') || filename.includes('DSVR01546'))) {
      const qStat = fs.statSync(targetQuarantinePath);
      const rStat = fs.statSync(g.retainedCanonicalPath);
      if (qStat.size === rStat.size) {
        const [h1, h2] = await Promise.all([
          computeFileSha256(targetQuarantinePath),
          computeFileSha256(g.retainedCanonicalPath)
        ]);
        if (h1 === h2) {
          permClassification = 'PERMANENT_DELETE_READY';
          evidenceType = 'EXACT_BYTE_IDENTICAL_SHA256';
          evidenceDetails = {
            candidateSha256: h1,
            retainedSha256: h2,
            sizeBytes: qStat.size,
            byteIdentical: true
          };
        }
      }
    }

    // Direct Stream MD5 fallback for remaining probe items
    if (!evidenceType) {
      console.log(`  Computing direct stream MD5 for ${filename}...`);
      const cStream = computeStreamMd5(targetQuarantinePath);
      const rStream = computeStreamMd5(g.retainedCanonicalPath);
      if (cStream && rStream && cStream.vMd5 === rStream.vMd5 && cStream.aMd5 === rStream.aMd5) {
        permClassification = 'PERMANENT_DELETE_READY';
        evidenceType = 'DIRECT_STREAM_MD5_MATCH';
        evidenceDetails = {
          candidateVideoMd5: cStream.vMd5,
          retainedVideoMd5: rStream.vMd5,
          candidateAudioMd5: cStream.aMd5,
          retainedAudioMd5: rStream.aMd5,
          streamIdentical: true
        };
      } else {
        console.warn(`  Stream MD5 mismatch or unavailable for ${filename}`);
      }
    }

    items.push({
      groupId: g.groupId,
      originalPath: g.candidatePath,
      quarantinePath: targetQuarantinePath,
      candidateFingerprintBeforeMove: g.candidateFingerprint,
      sizeBytes: g.candidateSize,
      retainedCanonicalPath: g.retainedCanonicalPath,
      retainedCanonicalFingerprintBeforeMove: g.retainedCanonicalFingerprint,
      movedAt,
      moveStatus: 'SUCCESSFULLY_QUARANTINED',
      rollbackPath: g.candidatePath,
      evidenceStatus: permClassification === 'PERMANENT_DELETE_READY' ? 'EVIDENCE_STRENGTHENED' : 'EVIDENCE_UNVERIFIED',
      evidenceType,
      permanentDeleteClassification: permClassification,
      evidenceDetails
    });
  }

  // === STEP 3: POST-MOVE INVENTORY & SAFETY AUDIT ===
  console.log('=== STEP 3: POST-MOVE VERIFICATION ===');
  // Check 1: 21 Render test artifacts no longer in G:\Media\VR\Render
  const renderDir = 'G:\\Media\\VR\\Render';
  const remainingRenderFiles = fs.readdirSync(renderDir);
  const remainingRenderTests = remainingRenderFiles.filter(f => f.includes('_HVC1_TEST'));
  console.log(`Remaining _HVC1_TEST files in Render: ${remainingRenderTests.length}`);

  // Check 2: Retained canonical copies still exist and fingerprints unchanged
  let retainedCanonicalValidCount = 0;
  for (const g of testGroups) {
    const rFp = getMediaFingerprint(g.retainedCanonicalPath);
    if (rFp && rFp.fingerprintId === g.retainedCanonicalFingerprint) {
      retainedCanonicalValidCount++;
    } else {
      console.error(`Retained canonical corrupted or missing: ${g.retainedCanonicalPath}`);
    }
  }

  // Check 3: Canonical failures untouched
  const canonicalFailures = manifest.groups.filter(g => g.classification === 'CANONICAL_NEEDS_NORMALIZATION');
  let canonicalFailuresUntouched = true;
  for (const cf of canonicalFailures) {
    if (!fs.existsSync(cf.candidatePath)) {
      canonicalFailuresUntouched = false;
      console.error(`Canonical failure missing: ${cf.candidatePath}`);
    }
  }

  // Check 4: Uncertain groups untouched
  const uncertainGroups = manifest.groups.filter(g => g.classification === 'RELATIONSHIP_UNCERTAIN');
  let uncertainGroupsUntouched = true;
  for (const ug of uncertainGroups) {
    if (!fs.existsSync(ug.candidatePath)) {
      uncertainGroupsUntouched = false;
      console.error(`Uncertain candidate missing: ${ug.candidatePath}`);
    }
  }

  const receipt = {
    receiptVersion: '1.0.0-issue-27-gate-b',
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    gate: 'GATE_B_QUARANTINE_RECEIPT',
    quarantineRoot: QUARANTINE_ROOT,
    totals: {
      totalCandidates: testGroups.length,
      movedCount,
      blockedCount,
      bytesRemovedFromActiveRoots: bytesMoved,
      renderVisibleMovedCount: items.filter(i => i.originalPath.startsWith(renderDir) && i.moveStatus === 'SUCCESSFULLY_QUARANTINED').length,
      retainedCanonicalVerifiedCount: retainedCanonicalValidCount,
      permanentDeleteReadyCount: items.filter(i => i.permanentDeleteClassification === 'PERMANENT_DELETE_READY').length,
      keepQuarantinedCount: items.filter(i => i.permanentDeleteClassification === 'KEEP_QUARANTINED_PENDING_EVIDENCE').length,
      remainingRenderTestsCount: remainingRenderTests.length,
      canonicalFailuresUntouched,
      uncertainGroupsUntouched,
      permanentDeletionOccurred: false
    },
    items
  };

  fs.writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2), 'utf8');
  console.log(`\nReceipt written successfully to ${RECEIPT_PATH}`);
  console.log('Totals:', JSON.stringify(receipt.totals, null, 2));

  return receipt;
}

if (process.argv[1] && process.argv[1].endsWith('quarantine_manager.mjs')) {
  executeQuarantineAndStrengthenEvidence().catch(err => {
    console.error('Fatal error during quarantine:', err);
    process.exit(1);
  });
}
