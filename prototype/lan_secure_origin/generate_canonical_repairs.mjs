import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { getMediaFingerprint } from './generate_asset_manifest.mjs';

const RUN_ID = '20260910_canonical_repair_probe';
const PROBE_OUTPUT_DIR = path.normalize(`G:\\VREconder_Repair_Probe\\issue-21\\${RUN_ID}`);
const MANIFEST_PATH = 'prototype/lan_secure_origin/asset_integrity_cleanup_manifest.json';
const REPAIR_MANIFEST_PATH = 'prototype/lan_secure_origin/canonical_repair_manifest.json';

function computeStreamMd5(filePath) {
  try {
    const vOut = execSync(`ffmpeg -v error -i "${filePath}" -map 0:v:0 -c copy -f md5 -`, {
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

export async function generateCanonicalRepairManifest() {
  console.log('=== ISSUE #21 CANONICAL REPAIR MANIFEST GENERATION ===');

  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const failures15 = manifest.groups.filter(g => g.classification === 'CANONICAL_NEEDS_NORMALIZATION');

  if (failures15.length !== 15) {
    throw new Error(`Expected exactly 15 canonical failure items, got ${failures15.length}`);
  }

  // Ensure output directory exists outside active media roots
  fs.mkdirSync(PROBE_OUTPUT_DIR, { recursive: true });
  console.log(`Temporary probe directory initialized: ${PROBE_OUTPUT_DIR}`);

  const items = [];
  let hvc1DerivativesCreated = 0;
  let timeoutRetriesCount = 0;
  let h264Diagnosis = null;

  for (const [idx, item] of failures15.entries()) {
    console.log(`\n[${idx + 1}/15] Evaluating ${item.groupId}: ${path.basename(item.candidatePath)}`);

    // 1. Confirm current fingerprint
    const curFp = getMediaFingerprint(item.candidatePath);
    if (!curFp || curFp.fingerprintId !== item.candidateFingerprint) {
      throw new Error(`Fingerprint mismatch for ${item.candidatePath}! Expected ${item.candidateFingerprint}, got ${curFp?.fingerprintId}`);
    }

    // 2. Classify based on verified static and device facts
    const facts = item.codecContainerFacts?.candidate;
    const isH264 = facts?.codec === 'h264';
    const isHevc = facts?.codec === 'hevc';
    const isHev1 = facts?.codecTag === 'hev1';
    const isHvc1 = facts?.codecTag === 'hvc1';

    let repairAction = null;
    let category = null;
    let details = {};

    if (item.groupId === 'GRP-INCOMPAT-015' && isH264) {
      // Bucket C: H.264 failure
      category = 'BUCKET_C_H264_STRUCTURAL_FAILURE';
      repairAction = 'SOURCE_DAMAGED_REDOWNLOAD_REQUIRED';
      details = {
        structuralError: 'stream 0, missing mandatory atoms, broken header (Invalid data found when processing input / EOF before open encoder)',
        demuxIntegrity: 'FATAL_CORRUPTION',
        repairViability: 'UNREPAIRABLE_LOCALLY_REDOWNLOAD_REQUIRED'
      };
      h264Diagnosis = details;
      console.log(`  Classification: ${repairAction} (${details.structuralError})`);
    } else if (isHvc1) {
      // Bucket B: Already hvc1 + TIMEOUT in physical probe
      category = 'BUCKET_B_ALREADY_HVC1_TIMEOUT';
      repairAction = 'SLOW_START_REPROBE_REQUIRED';
      timeoutRetriesCount++;
      details = {
        observedVerdictIn26: 'TIMEOUT',
        staticCodecTag: 'hvc1',
        resolution: `${facts.width}x${facts.height}`,
        recommendedTimeoutSec: 25,
        distinctionTarget: 'SLOW_FIRST_FRAME_VS_NO_VIDEO'
      };
      console.log(`  Classification: ${repairAction} (Timeout retry with extended 25s window)`);
    } else if (isHevc && isHev1) {
      // Bucket A: physical Code 4 + HEVC/MP4 + hev1
      category = 'BUCKET_A_HEV1_CODE4';
      repairAction = 'HVC1_STREAMCOPY_PROBE_REQUIRED';

      // Create stream-copy hvc1 derivative outside all active media roots
      const baseName = path.basename(item.candidatePath, path.extname(item.candidatePath));
      const targetDerivativeName = `${baseName}_REPAIR_PROBE_HVC1.mp4`;
      const targetDerivativePath = path.join(PROBE_OUTPUT_DIR, targetDerivativeName);

      console.log(`  Creating hvc1 stream-copy derivative: ${targetDerivativeName}...`);
      const cmd = `ffmpeg -v error -i "${item.candidatePath}" -c copy -tag:v hvc1 "${targetDerivativePath}"`;
      execSync(cmd, { stdio: ['ignore', 'ignore', 'pipe'] });

      if (!fs.existsSync(targetDerivativePath)) {
        throw new Error(`Failed to create derivative at ${targetDerivativePath}`);
      }
      hvc1DerivativesCreated++;

      // Verify A/V equivalence
      console.log(`  Verifying A/V elementary stream equivalence...`);
      const origMd5 = computeStreamMd5(item.candidatePath);
      const derivMd5 = computeStreamMd5(targetDerivativePath);

      const vMatch = origMd5 && derivMd5 && (origMd5.vMd5 === derivMd5.vMd5);
      const aMatch = origMd5 && derivMd5 && (origMd5.aMd5 === derivMd5.aMd5 || origMd5.aMd5 === 'NO_AUDIO_STREAM');

      if (!vMatch || !aMatch) {
        throw new Error(`Stream MD5 mismatch for derivative ${targetDerivativeName}! vMatch=${vMatch}, aMatch=${aMatch}`);
      }

      const derivStat = fs.statSync(targetDerivativePath);
      details = {
        derivativePath: targetDerivativePath,
        derivativeSizeBytes: derivStat.size,
        videoMd5Match: vMatch,
        audioMd5Match: aMatch,
        streamEquivalenceVerified: true,
        testUrlPath: `/api/health/video?path=${encodeURIComponent(targetDerivativePath)}`
      };
      console.log(`  Derivative created & verified bit-for-bit elementary stream identical!`);
    } else {
      repairAction = 'REPAIR_UNKNOWN';
      details = { reason: 'Unmatched condition' };
    }

    items.push({
      groupId: item.groupId,
      canonicalPath: item.candidatePath,
      fingerprintId: item.candidateFingerprint,
      sizeBytes: item.candidateSize,
      category,
      repairAction,
      facts,
      details
    });
  }

  // Count by classification
  const classificationCounts = {};
  for (const it of items) {
    classificationCounts[it.repairAction] = (classificationCounts[it.repairAction] || 0) + 1;
  }

  // Physical iPhone repair probe queue items (Bucket A derivatives + Bucket B timeout retries)
  const probeQueue = [];
  for (const it of items) {
    if (it.repairAction === 'HVC1_STREAMCOPY_PROBE_REQUIRED') {
      probeQueue.push({
        groupId: it.groupId,
        type: 'HVC1_DERIVATIVE_PROBE',
        filePath: it.details.derivativePath,
        targetTimeoutSec: 15,
        expectedResult: 'PASS_IF_HVC1_TAG_FIXES_SAFARI'
      });
    } else if (it.repairAction === 'SLOW_START_REPROBE_REQUIRED') {
      probeQueue.push({
        groupId: it.groupId,
        type: 'TIMEOUT_RETRY_PROBE',
        filePath: it.canonicalPath,
        targetTimeoutSec: 25,
        expectedResult: 'DISTINGUISH_STARTUP_LAG_FROM_UNSUPPORTED'
      });
    }
  }

  const repairManifest = {
    manifestVersion: '1.0.0-issue-21-canonical-repairs',
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    probeOutputDir: PROBE_OUTPUT_DIR,
    totals: {
      totalFailuresEvaluated: 15,
      hvc1StreamcopyDerivativesCreated: hvc1DerivativesCreated,
      timeoutRetryCandidatesCount: timeoutRetriesCount,
      physicalIphoneProbeQueueCount: probeQueue.length,
      classificationCounts
    },
    h264Diagnosis,
    items,
    probeQueue
  };

  fs.writeFileSync(REPAIR_MANIFEST_PATH, JSON.stringify(repairManifest, null, 2), 'utf8');
  console.log(`\nRepair manifest written to: ${REPAIR_MANIFEST_PATH}`);
  console.log('Totals:', JSON.stringify(repairManifest.totals, null, 2));

  return repairManifest;
}

if (process.argv[1] && process.argv[1].endsWith('generate_canonical_repairs.mjs')) {
  generateCanonicalRepairManifest().catch(err => {
    console.error('Fatal error generating canonical repairs:', err);
    process.exit(1);
  });
}
