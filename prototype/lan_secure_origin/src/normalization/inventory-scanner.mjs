import fs from 'node:fs';
import path from 'node:path';
import { probeMediaFacts } from './ffprobe-facts.mjs';
import { classifyMedia, isDerivativeFile, MediaClass } from './classification.mjs';
import { findRepairCandidate } from './repair-rules.mjs';

/**
 * Retrieves available free disk space for a given path.
 * 
 * @param {string} targetPath 
 * @returns {number} Free space in bytes (or -1 if unable to determine)
 */
export function getDiskFreeSpace(targetPath) {
  try {
    const resolved = path.resolve(targetPath);
    if (fs.statfsSync) {
      const stats = fs.statfsSync(resolved);
      return stats.bsize * stats.bavail;
    }
  } catch (e) {}
  return -1;
}

/**
 * Evaluates free disk space safety for a candidate media path.
 * Reuses the authoritative formula: requiredFree = ceil(fileSizeBytes * 1.2).
 * Fails closed if free space is unknown (< 0) or insufficient.
 * 
 * @param {string} targetPath 
 * @param {object} [options]
 * @returns {{ ok: boolean, reason?: string, available: number, requiredFree: number }}
 */
export function evaluateDiskFreeSpaceSafety(targetPath, options = {}) {
  try {
    const fileOps = options.fileOps || {};
    const statFn = fileOps.statSync || fs.statSync;
    const freeSpaceFn = options.getDiskFreeSpace || getDiskFreeSpace;
    const stat = statFn(targetPath);
    const requiredFree = typeof options.requiredBytes === 'number'
      ? options.requiredBytes
      : Math.ceil(stat.size * 1.2);
    const available = freeSpaceFn(targetPath);

    if (available < 0) {
      return { ok: false, reason: 'BLOCKED_SPACE_UNKNOWN', available, requiredFree };
    }
    if (available < requiredFree) {
      return { ok: false, reason: 'BLOCKED_NO_SPACE', available, requiredFree };
    }
    return { ok: true, available, requiredFree };
  } catch (err) {
    return { ok: false, reason: 'BLOCKED_SPACE_STAT_FAILED', error: err.message, available: -1, requiredFree: -1 };
  }
}

/**
 * Scans directories recursively and collects media files.
 * 
 * @param {string[]} rootDirs 
 * @returns {string[]} List of absolute file paths
 */
export function collectMediaFiles(rootDirs) {
  const filePaths = [];
  const validExts = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']);

  for (const root of rootDirs) {
    if (!fs.existsSync(root)) continue;

    function walk(dir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            walk(full);
          } else if (ent.isFile()) {
            const ext = path.extname(ent.name).toLowerCase();
            if (validExts.has(ext)) {
              filePaths.push(full);
            }
          }
        }
      } catch (e) {}
    }

    walk(root);
  }
  return filePaths;
}

/**
 * Builds an automatic bucket certification plan for uncertified HEVC groups.
 * 
 * @param {Array<object>} uncertifiedItems 
 * @returns {Array<object>}
 */
export function buildBucketCertificationPlan(uncertifiedItems) {
  const buckets = new Map();

  for (const item of uncertifiedItems) {
    const facts = item.facts;
    if (!facts || !facts.video) continue;
    const v = facts.video;
    const bucketKey = `HEVC-hev1-Main-8bit-${v.width}x${v.height}-L${v.level}-rFps:${v.rFps || 'unknown'}-avgFps:${v.avgFps || 'unknown'}`;

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        bucketSignature: bucketKey,
        resolution: `${v.width}x${v.height}`,
        level: v.level,
        profile: v.profile,
        bitDepth: v.bitDepth,
        rFps: v.rFps,
        avgFps: v.avgFps,
        numberOfMedia: 0,
        totalBytes: 0,
        representativeFiles: [],
        proposedProbeOperation: {
          ffmpegCommand: '-map 0 -c copy -tag:v hvc1',
          purpose: 'Probe Safari VideoToolbox playback compatibility for uncertified envelope'
        }
      });
    }

    const b = buckets.get(bucketKey);
    b.numberOfMedia++;
    b.totalBytes += item.sizeBytes;
    if (b.representativeFiles.length < 2) {
      b.representativeFiles.push({
        path: item.path,
        sizeBytes: item.sizeBytes,
        durationSec: v.durationSec
      });
    }
  }

  return Array.from(buckets.values()).sort((a, b) => b.totalBytes - a.totalBytes);
}

/**
 * Performs a read-only inventory scan and produces a Dry Run report.
 * 
 * @param {string[]} rootDirs 
 * @returns {Promise<object>}
 */
export async function runDryRunInventory(rootDirs) {
  const files = collectMediaFiles(rootDirs);
  const items = [];

  let totalFiles = files.length;
  let readyDirectCount = 0;
  let exactCertifiedCandidateCount = 0;
  let needsBucketCertificationCount = 0;
  let needsDeviceProbeCount = 0;
  let unsupportedUnknownCount = 0;
  let invalidMediaCount = 0;
  let derivativeExcludedCount = 0;

  let exactCertifiedBytesRewritten = 0;
  let needsBucketBytes = 0;
  let largestCandidateBytes = 0;
  let largestCandidatePath = null;

  const uncertifiedCandidates = [];

  // Process files with bounded concurrency of 6
  const concurrency = 6;
  const queue = [...files];

  async function worker() {
    while (queue.length > 0) {
      const filePath = queue.shift();
      const isDeriv = isDerivativeFile(filePath);
      let stat = null;
      try { stat = fs.statSync(filePath); } catch (_) {}
      const size = stat ? stat.size : 0;

      if (isDeriv) {
        derivativeExcludedCount++;
        items.push({
          path: filePath,
          sizeBytes: size,
          classification: MediaClass.EXPERIMENT_DERIVATIVE,
          reason: 'Experimental derivative or temporary file (excluded from Logical Media)'
        });
        continue;
      }

      const facts = await probeMediaFacts(filePath);
      const classification = classifyMedia(filePath, facts);
      const ext = path.extname(filePath);
      const repairRule = findRepairCandidate(facts, ext);

      const itemRecord = {
        path: filePath,
        sizeBytes: size,
        facts,
        classification: classification.classification,
        reason: classification.reason,
        repairCandidate: repairRule ? repairRule.ruleId : null,
        matchedBucket: classification.matchedBucket || null
      };

      switch (classification.classification) {
        case MediaClass.READY_DIRECT:
          readyDirectCount++;
          break;
        case MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE:
          exactCertifiedCandidateCount++;
          exactCertifiedBytesRewritten += size;
          if (size > largestCandidateBytes) {
            largestCandidateBytes = size;
            largestCandidatePath = filePath;
          }
          break;
        case MediaClass.NEEDS_BUCKET_CERTIFICATION:
          needsBucketCertificationCount++;
          needsBucketBytes += size;
          uncertifiedCandidates.push(itemRecord);
          break;
        case MediaClass.NEEDS_DEVICE_PROBE:
          needsDeviceProbeCount++;
          break;
        case MediaClass.UNSUPPORTED_UNKNOWN_FIX:
          unsupportedUnknownCount++;
          break;
        default:
          invalidMediaCount++;
          break;
      }

      items.push(itemRecord);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);

  const bucketCertificationPlan = buildBucketCertificationPlan(uncertifiedCandidates);

  // Write bucket_certification_plan.json artifact
  try {
    const planPath = path.join(process.cwd(), 'prototype/lan_secure_origin/bucket_certification_plan.json');
    fs.writeFileSync(planPath, JSON.stringify(bucketCertificationPlan, null, 2), 'utf8');
  } catch (_) {}

  // Estimated free space requirement based on largest candidate
  const estimatedFreeSpaceRequirement = Math.ceil(largestCandidateBytes * 1.2);
  const sampleRoot = rootDirs.find(r => fs.existsSync(r)) || process.cwd();
  const availableFreeSpace = getDiskFreeSpace(sampleRoot);

  return {
    scannedRoots: rootDirs,
    summary: {
      totalFilesScanned: totalFiles,
      totalLogicalMedia: totalFiles - derivativeExcludedCount,
      readyDirectCount,
      exactCertifiedCandidateCount,
      needsBucketCertificationCount,
      needsDeviceProbeCount,
      unsupportedUnknownCount,
      invalidMediaCount,
      derivativeExcludedCount,
      exactCertifiedBytesRewritten,
      exactCertifiedGigabytesRewritten: (exactCertifiedBytesRewritten / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
      needsBucketBytes,
      needsBucketGigabytes: (needsBucketBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
      largestCandidate: largestCandidatePath ? {
        path: largestCandidatePath,
        sizeBytes: largestCandidateBytes,
        sizeGB: (largestCandidateBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
      } : null,
      estimatedTemporaryFreeSpaceRequirementBytes: estimatedFreeSpaceRequirement,
      estimatedTemporaryFreeSpaceRequirementGB: (estimatedFreeSpaceRequirement / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
      availableDiskFreeSpaceBytes: availableFreeSpace,
      availableDiskFreeSpaceGB: availableFreeSpace >= 0 ? (availableFreeSpace / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : 'Unknown',
      isFreeSpaceSufficient: availableFreeSpace >= 0 && availableFreeSpace >= estimatedFreeSpaceRequirement
    },
    bucketCertificationPlan,
    items
  };
}

