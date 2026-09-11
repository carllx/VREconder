import fs from 'node:fs';
import path from 'node:path';
import { classifyMedia, isDerivativeFile, MediaClass } from './src/normalization/classification.mjs';
import { findCertifiedRepairRule, matchExactCertifiedBucket } from './src/normalization/repair-rules.mjs';
import { getDiskFreeSpace, buildBucketCertificationPlan } from './src/normalization/inventory-scanner.mjs';

const raw = JSON.parse(fs.readFileSync('prototype/lan_secure_origin/scanned_raw_library.json', 'utf8'));

let totalPhysicalFiles = raw.length;
let derivativeCount = 0;
let readyCount = 0;
let certifiedCandidateCount = 0;
let needsBucketCertCount = 0;
let needsProbeCount = 0;
let unknownCount = 0;
let invalidCount = 0;

let candidateTotalBytes = 0;
let largestCandidate = null;

const candidates = [];
const needsBucketItems = [];
const needsProbeItems = [];
const unknownItems = [];
const readyItems = [];
const derivativeItems = [];

for (const item of raw) {
  const filePath = item.fullPath;
  let stat = null;
  try { stat = fs.statSync(filePath); } catch (_) {}
  const size = stat ? stat.size : 0;

  if (item.isDerivative || isDerivativeFile(filePath)) {
    derivativeCount++;
    derivativeItems.push({ path: filePath, size, name: path.basename(filePath) });
    continue;
  }

  const facts = item.facts;
  const classification = classifyMedia(filePath, facts);
  const ext = path.extname(filePath);
  const certifiedRule = findCertifiedRepairRule(facts, ext);
  const effectiveClass = classification.classification;
  const v = facts?.video;

  const itemSummary = {
    root: item.root,
    relPath: item.relPath,
    fullPath: filePath,
    name: path.basename(filePath),
    sizeBytes: size,
    sizeGB: (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
    classification: effectiveClass,
    reason: classification.reason,
    ruleId: certifiedRule ? certifiedRule.ruleId : null,
    matchedBucket: certifiedRule ? certifiedRule.matchedBucket.bucketId : null,
    video: v ? {
      codec: v.codec,
      codecTag: v.codecTag,
      profile: v.profile,
      level: v.level,
      bitDepth: v.bitDepth,
      width: v.width,
      height: v.height,
      rFps: v.rFps,
      avgFps: v.avgFps,
      durationSec: Math.round(v.durationSec)
    } : null
  };

  switch (effectiveClass) {
    case MediaClass.READY_DIRECT:
      readyCount++;
      readyItems.push(itemSummary);
      break;
    case MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE:
      certifiedCandidateCount++;
      candidateTotalBytes += size;
      if (!largestCandidate || size > largestCandidate.sizeBytes) {
        largestCandidate = itemSummary;
      }
      candidates.push(itemSummary);
      break;
    case MediaClass.NEEDS_BUCKET_CERTIFICATION:
      needsBucketCertCount++;
      needsBucketItems.push(itemSummary);
      break;
    case MediaClass.NEEDS_DEVICE_PROBE:
      needsProbeCount++;
      needsProbeItems.push(itemSummary);
      break;
    case MediaClass.UNSUPPORTED_UNKNOWN_FIX:
      unknownCount++;
      unknownItems.push(itemSummary);
      break;
    default:
      invalidCount++;
      break;
  }
}

const totalLogicalMedia = totalPhysicalFiles - derivativeCount;
const requiredFreeFloor = largestCandidate ? Math.ceil(largestCandidate.sizeBytes * 1.2) : 0;
const actualFreeSpace = getDiskFreeSpace('G:\\Media\\VR');
const diskSafetyStatus = (actualFreeSpace >= 0 && actualFreeSpace >= requiredFreeFloor) ? 'SAFE_TO_START' : 'BLOCKED_NO_SPACE';

// Breakdown of candidates by certified bucket
const candidateBreakdown = {
  byBucket: {},
  byRoot: {},
  byResolutionBucket: {},
  byFpsBucket: {}
};

for (const c of candidates) {
  const bucketKey = c.matchedBucket || 'UNKNOWN';
  candidateBreakdown.byBucket[bucketKey] = (candidateBreakdown.byBucket[bucketKey] || 0) + 1;

  const rootKey = path.basename(c.root);
  candidateBreakdown.byRoot[rootKey] = (candidateBreakdown.byRoot[rootKey] || 0) + 1;

  const v = c.video;
  if (v) {
    let resBucket = `${v.width}x${v.height}`;
    candidateBreakdown.byResolutionBucket[resBucket] = (candidateBreakdown.byResolutionBucket[resBucket] || 0) + 1;

    let fpsBucket = v.rFps || 'Unknown';
    candidateBreakdown.byFpsBucket[fpsBucket] = (candidateBreakdown.byFpsBucket[fpsBucket] || 0) + 1;
  }
}

const bucketCertificationPlan = buildBucketCertificationPlan(needsBucketItems.map(i => ({
  path: i.fullPath,
  sizeBytes: i.sizeBytes,
  facts: { video: i.video }
})));

const finalReport = {
  inventorySummary: {
    totalPhysicalFiles,
    totalLogicalMedia,
    readyDirectCount: readyCount,
    exactCertifiedCandidateCount: certifiedCandidateCount,
    needsBucketCertificationCount: needsBucketCertCount,
    needsDeviceProbeCount: needsProbeCount,
    unsupportedUnknownCount: unknownCount,
    invalidMediaCount: invalidCount,
    experimentDerivativeCount: derivativeCount
  },
  candidateBreakdown,
  bucketCertificationPlan,
  storageImpact: {
    candidateTotalSourceBytes: candidateTotalBytes,
    candidateTotalSourceGB: (candidateTotalBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
    largestCandidate: largestCandidate ? {
      name: largestCandidate.name,
      path: largestCandidate.fullPath,
      sizeBytes: largestCandidate.sizeBytes,
      sizeGB: largestCandidate.sizeGB
    } : null,
    expectedBytesRewritten: candidateTotalBytes,
    expectedGigabytesRewritten: (candidateTotalBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
    requiredTemporaryFreeSpaceFloorBytes: requiredFreeFloor,
    requiredTemporaryFreeSpaceFloorGB: (requiredFreeFloor / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
    actualDiskFreeSpaceBytes: actualFreeSpace,
    actualDiskFreeSpaceGB: (actualFreeSpace / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
    diskSafetyStatus
  },
  sampleCandidates: candidates.slice(0, 10),
  needsBucketCertificationItems: needsBucketItems,
  needsDeviceProbeItems: needsProbeItems,
  sampleUnknownItems: unknownItems.slice(0, 10),
  sampleDerivatives: derivativeItems.slice(0, 10)
};

fs.writeFileSync('prototype/lan_secure_origin/final_library_dry_run_report.json', JSON.stringify(finalReport, null, 2), 'utf8');
console.log('FINAL_REPORT_SUMMARY:\n' + JSON.stringify({
  inventorySummary: finalReport.inventorySummary,
  candidateBreakdown: finalReport.candidateBreakdown,
  storageImpact: finalReport.storageImpact,
  bucketCertificationPlanSummary: finalReport.bucketCertificationPlan.map(p => ({
    bucketSignature: p.bucketSignature,
    numberOfMedia: p.numberOfMedia,
    totalBytesGB: (p.totalBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
    representativeSample: p.representativeFiles[0] ? path.basename(p.representativeFiles[0].path) : null
  })),
  sampleCandidateCount: finalReport.sampleCandidates.length,
  needsProbeCount: finalReport.needsDeviceProbeItems.length,
  sampleUnknownCount: finalReport.sampleUnknownItems.length
}, null, 2));
