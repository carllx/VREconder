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
 * Performs a read-only inventory scan and produces a Dry Run report.
 * 
 * @param {string[]} rootDirs 
 * @returns {Promise<object>}
 */
export async function runDryRunInventory(rootDirs) {
  const files = collectMediaFiles(rootDirs);
  const items = [];

  let totalFiles = files.length;
  let readyCount = 0;
  let candidateCount = 0;
  let needsProbeCount = 0;
  let unknownCount = 0;
  let invalidCount = 0;
  let derivativeCount = 0;

  let predictedBytesRewritten = 0;
  let largestCandidateBytes = 0;
  let largestCandidatePath = null;

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
        derivativeCount++;
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

      switch (classification.classification) {
        case MediaClass.READY_DIRECT:
          readyCount++;
          break;
        case MediaClass.NORMALIZATION_CANDIDATE:
          candidateCount++;
          predictedBytesRewritten += size;
          if (size > largestCandidateBytes) {
            largestCandidateBytes = size;
            largestCandidatePath = filePath;
          }
          break;
        case MediaClass.NEEDS_DEVICE_PROBE:
          needsProbeCount++;
          break;
        case MediaClass.UNSUPPORTED_UNKNOWN_FIX:
          unknownCount++;
          break;
        default:
          invalidCount++;
          break;
      }

      items.push({
        path: filePath,
        sizeBytes: size,
        facts,
        classification: classification.classification,
        reason: classification.reason,
        repairCandidate: repairRule ? repairRule.id : null
      });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);


  // Margin of 20% on top of the largest candidate
  const estimatedFreeSpaceRequirement = Math.ceil(largestCandidateBytes * 1.2);
  const sampleRoot = rootDirs.find(r => fs.existsSync(r)) || process.cwd();
  const availableFreeSpace = getDiskFreeSpace(sampleRoot);

  return {
    scannedRoots: rootDirs,
    summary: {
      totalFilesScanned: totalFiles,
      readyDirectCount: readyCount,
      normalizationCandidateCount: candidateCount,
      needsDeviceProbeCount: needsProbeCount,
      unsupportedUnknownCount: unknownCount,
      invalidMediaCount: invalidCount,
      derivativeExcludedCount: derivativeCount,
      predictedBytesRewritten,
      predictedGigabytesRewritten: (predictedBytesRewritten / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
      largestCandidate: largestCandidatePath ? {
        path: largestCandidatePath,
        sizeBytes: largestCandidateBytes,
        sizeGB: (largestCandidateBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
      } : null,
      estimatedTemporaryFreeSpaceRequirementBytes: estimatedFreeSpaceRequirement,
      estimatedTemporaryFreeSpaceRequirementGB: (estimatedFreeSpaceRequirement / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
      availableDiskFreeSpaceBytes: availableFreeSpace,
      availableDiskFreeSpaceGB: availableFreeSpace >= 0 ? (availableFreeSpace / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : 'Unknown',
      isFreeSpaceSufficient: availableFreeSpace === -1 || availableFreeSpace >= estimatedFreeSpaceRequirement
    },
    items
  };
}
