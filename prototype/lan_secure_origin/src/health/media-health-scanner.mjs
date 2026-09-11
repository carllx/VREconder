import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMediaFiles } from '../normalization/inventory-scanner.mjs';
import { getMediaFingerprint } from '../normalization/fingerprint.mjs';
import { probeMediaFacts } from '../normalization/ffprobe-facts.mjs';
import { isDerivativeFile } from '../normalization/classification.mjs';
import { preflightIncomingMedia, IntakeClassification } from '../preflight/intake-preflight.mjs';
import { DeviceProbeCache } from '../preflight/device-probe-cache.mjs';
import {
  AUTHORITATIVE_HEALTH_ROOTS,
  StaticDisposition,
  FinalHealthState,
  identifyBusinessRegion,
  getRootNeutralId,
  HEALTH_CHECK_POLICY_VERSION,
  COMPATIBILITY_POLICY_VERSION
} from './media-health-types.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_FACTS_CACHE_PATH = path.resolve(__dirname, '..', '..', 'media_health_facts_cache.json');
const HISTORICAL_FACTS_PATH = path.resolve(__dirname, '..', '..', 'full_library_facts.json');

/**
 * Loads available facts keyed strictly by fingerprintId.
 * Only accepts cache entries where fingerprintId matches.
 * 
 * @param {string} [cachePath] 
 * @returns {Map<string, object>}
 */
export function loadExistingFactsMap(cachePath = DEFAULT_FACTS_CACHE_PATH) {
  const map = new Map();

  function ingestFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          const f = entry.facts;
          if (f && f.fingerprint && f.fingerprint.fingerprintId) {
            map.set(f.fingerprint.fingerprintId, f);
          }
        }
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (v && v.fingerprint && v.fingerprint.fingerprintId) {
            map.set(v.fingerprint.fingerprintId, v);
          }
        }
      }
    } catch (_) {}
  }

  // 1. Read historical facts as read-only base cache if present
  ingestFile(HISTORICAL_FACTS_PATH);
  // 2. Read health-owned dedicated facts cache if present
  ingestFile(cachePath);

  return map;
}

/**
 * Saves facts cache to health-owned dedicated file.
 * 
 * @param {Map<string, object>} factsMap 
 * @param {string} [cachePath] 
 */
export function saveHealthFactsCache(factsMap, cachePath = DEFAULT_FACTS_CACHE_PATH) {
  try {
    const obj = {};
    for (const [k, v] of factsMap.entries()) {
      obj[k] = v;
    }
    const tmp = `${cachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, cachePath);
  } catch (err) {
    console.warn('[MediaHealthScanner] Failed saving health facts cache:', err.message);
  }
}

/**
 * Maps IntakeClassification from #21 to canonical Stage 1 StaticDisposition.
 * 
 * @param {string} intakeClassification 
 * @returns {string}
 */
export function mapIntakeToStaticDisposition(intakeClassification) {
  switch (intakeClassification) {
    case IntakeClassification.READY_DIRECT:
      return StaticDisposition.READY_DIRECT;
    case IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED:
      return StaticDisposition.NORMALIZATION_CANDIDATE_CERTIFIED;
    case IntakeClassification.NEEDS_DEVICE_PROBE:
      return StaticDisposition.NEEDS_DEVICE_PROBE;
    case IntakeClassification.NEEDS_BUCKET_CERTIFICATION:
      return StaticDisposition.NEEDS_BUCKET_CERTIFICATION;
    case IntakeClassification.UNSUPPORTED_UNKNOWN_FIX:
      return StaticDisposition.UNSUPPORTED_UNKNOWN_FIX;
    case IntakeClassification.UNREADABLE_MEDIA:
      return StaticDisposition.UNREADABLE_MEDIA;
    case IntakeClassification.EXPERIMENT_DERIVATIVE:
      return StaticDisposition.EXPERIMENT_DERIVATIVE;
    default:
      return StaticDisposition.UNSUPPORTED_UNKNOWN_FIX;
  }
}

/**
 * Determines recommended next action based on static disposition.
 * 
 * @param {string} disposition 
 * @returns {string}
 */
export function getRecommendedActionForDisposition(disposition) {
  switch (disposition) {
    case StaticDisposition.READY_DIRECT:
      return 'DIRECT_PLAYBACK_OK';
    case StaticDisposition.NORMALIZATION_CANDIDATE_CERTIFIED:
      return 'SCHEDULE_STREAMCOPY_NORMALIZATION';
    case StaticDisposition.NEEDS_DEVICE_PROBE:
      return 'ENQUEUE_IPHONE_PHYSICAL_PROBE';
    case StaticDisposition.NEEDS_BUCKET_CERTIFICATION:
      return 'AWAIT_BUCKET_ACCEPTANCE_OR_PILOT';
    case StaticDisposition.UNSUPPORTED_UNKNOWN_FIX:
      return 'MANUAL_INSPECTION_REQUIRED';
    case StaticDisposition.UNREADABLE_MEDIA:
      return 'CHECK_SOURCE_FILE_INTEGRITY';
    case StaticDisposition.EXPERIMENT_DERIVATIVE:
      return 'EXCLUDE_FROM_PLAYLIST';
    default:
      return 'INVESTIGATE';
  }
}

/**
 * Runs a PC Stage-1 Static Health Scan across authoritative roots.
 * Reconciles: totalDiscovered = cacheReuseCount + freshProbedCount.
 * 
 * @param {object} [options]
 * @returns {Promise<object>} Full static report
 */
export async function runStaticHealthScan(options = {}) {
  const rootDirs = options.rootDirs || AUTHORITATIVE_HEALTH_ROOTS;
  const probeCache = options.probeCache || new DeviceProbeCache();
  const factsCachePath = options.factsCachePath || DEFAULT_FACTS_CACHE_PATH;
  const concurrency = options.concurrency || 6;
  const onProgress = options.onProgress || null;

  const files = collectMediaFiles(rootDirs);
  const factsMap = loadExistingFactsMap(factsCachePath);

  let cacheReuseCount = 0;
  let freshProbedCount = 0;

  const items = [];
  const unresolvedQueue = [];
  const queue = [...files];
  let processed = 0;

  async function worker() {
    while (queue.length > 0) {
      const filePath = queue.shift();
      processed++;
      if (onProgress) onProgress(processed, files.length, filePath);

      const fp = getMediaFingerprint(filePath);
      const isDeriv = isDerivativeFile(filePath);
      const region = identifyBusinessRegion(filePath);
      const neutralId = fp ? getRootNeutralId(filePath, fp.fingerprintId) : `unreadable:${path.basename(filePath)}`;

      // 1. Resolve facts (cache vs fresh ffprobe)
      let facts = null;
      let reusedFromCache = false;

      if (fp && factsMap.has(fp.fingerprintId)) {
        facts = factsMap.get(fp.fingerprintId);
        reusedFromCache = true;
        cacheReuseCount++;
      } else if (!isDeriv) {
        freshProbedCount++;
        facts = await probeMediaFacts(filePath);
        if (facts && fp) {
          factsMap.set(fp.fingerprintId, facts);
        }
      } else {
        // Derivative without cached facts doesn't require ffprobe
        freshProbedCount++;
      }

      // 2. Derivative classification
      if (isDeriv) {
        items.push({
          filePath,
          neutralId,
          fingerprintId: fp ? fp.fingerprintId : null,
          sizeBytes: fp ? fp.sizeBytes : 0,
          region,
          staticClassification: StaticDisposition.EXPERIMENT_DERIVATIVE,
          reason: 'Matches derivative / temporary / test file pattern',
          matchedEnvelopeId: null,
          recommendedNextAction: getRecommendedActionForDisposition(StaticDisposition.EXPERIMENT_DERIVATIVE),
          cachedFacts: reusedFromCache
        });
        continue;
      }

      // 3. Evaluate compatibility policy
      const decision = await preflightIncomingMedia(filePath, { facts, probeCache });
      const disposition = mapIntakeToStaticDisposition(decision.classification);
      const recommendedNextAction = getRecommendedActionForDisposition(disposition);

      const itemRecord = {
        filePath,
        neutralId,
        fingerprintId: fp ? fp.fingerprintId : null,
        sizeBytes: fp ? fp.sizeBytes : 0,
        region,
        staticClassification: disposition,
        reason: decision.reason || '',
        matchedEnvelopeId: decision.matchedEnvelopeId || null,
        recommendedNextAction,
        cachedFacts: reusedFromCache
      };

      items.push(itemRecord);

      // 4. Physical device queue admission: strictly NEEDS_DEVICE_PROBE
      if (disposition === StaticDisposition.NEEDS_DEVICE_PROBE) {
        unresolvedQueue.push(itemRecord);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);

  // Save updated health static facts cache
  saveHealthFactsCache(factsMap, factsCachePath);

  // Aggregations
  const countsByDisposition = {};
  for (const d of Object.values(StaticDisposition)) {
    countsByDisposition[d] = 0;
  }
  const countsByRegion = {};

  for (const item of items) {
    countsByDisposition[item.staticClassification] = (countsByDisposition[item.staticClassification] || 0) + 1;
    countsByRegion[item.region] = (countsByRegion[item.region] || 0) + 1;
  }

  const totalDiscovered = files.length;
  const equationHolds = (totalDiscovered === (cacheReuseCount + freshProbedCount));

  return {
    policyVersion: HEALTH_CHECK_POLICY_VERSION,
    compatibilityPolicyVersion: COMPATIBILITY_POLICY_VERSION,
    totalDiscovered,
    cacheReuseCount,
    freshProbedCount,
    equationHolds,
    unresolvedQueueCount: unresolvedQueue.length,
    countsByDisposition,
    countsByRegion,
    unresolvedQueue,
    items
  };
}
