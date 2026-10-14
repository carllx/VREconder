import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMediaFingerprint } from '../normalization/fingerprint.mjs';
import { isDerivativeFile } from '../normalization/classification.mjs';
import { preflightIncomingMedia, IntakeClassification } from '../preflight/intake-preflight.mjs';
import { getProvisionalAdmissionStore } from '../preflight/provisional-admission-store.mjs';
import { loadExistingFactsMap } from './media-health-scanner.mjs';
import { getActiveMediaRoot } from '../server/cert-helper.mjs';
import {
  CandidateState,
  BatchProbeVerdict,
  getProbeNeutralId,
  computeCandidatesHash,
  BATCH_PROBE_POLICY_VERSION
} from './batch-probe-types.mjs';
import { loadBatchRegistryForRun, loadBatchRegistryRecords, loadBatchCheckpoint } from './batch-probe-store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..');

/**
 * Builds the live candidate inventory and physical test queue for batch probing.
 *
 * @param {object} [options]
 * @param {string} [options.targetDir] Custom directory (defaults to active media root)
 * @param {string} [options.prototypeDir]
 * @param {string} [options.runId]
 * @param {string} [options.cohort] 'denied' | 'admitted' | 'derivatives' | 'all'
 * @returns {Promise<object>}
 */
export async function buildBatchCandidateQueue(options = {}) {
  const targetDir = options.targetDir || getActiveMediaRoot();
  const prototypeDir = options.prototypeDir || PROTOTYPE_DIR;
  const cohort = options.cohort || 'denied';

  if (!targetDir || !fs.existsSync(targetDir)) {
    throw new Error(`Target media directory not found: ${targetDir}`);
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  const videoFiles = entries
    .filter(e => e.isFile() && /\.(mp4|mov|m4v)$/i.test(e.name))
    .map(e => path.join(targetDir, e.name));

  const factsMap = loadExistingFactsMap();
  const storeFile = options.provisionalStorePath || (options.prototypeDir ? path.join(options.prototypeDir, 'provisional_playback_admissions.json') : undefined);
  const provisionalStore = getProvisionalAdmissionStore(storeFile);
  const activeCp = loadBatchCheckpoint(prototypeDir);
  const activeRunId = options.runId || activeCp.runId;
  const currentRunRecords = loadBatchRegistryForRun(activeRunId, prototypeDir);
  const allRegistryRecords = loadBatchRegistryRecords(prototypeDir);

  const runRecordsMap = new Map();
  for (const r of currentRunRecords) {
    if (r && r.fingerprintId) {
      runRecordsMap.set(`${r.queueIndex}_${r.fingerprintId}`, r);
      runRecordsMap.set(r.fingerprintId, r);
    }
  }

  const registryFpsMap = new Map();
  for (const r of allRegistryRecords) {
    if (r && r.fingerprintId) registryFpsMap.set(r.fingerprintId, r);
  }

  const inventory = {
    targetDir,
    cohort,
    candidatesHash: '',
    totalDiscovered: videoFiles.length,
    counts: {
      ALREADY_ADMITTED: 0,
      POLICY_DENIED_CANDIDATE: 0,
      DERIVATIVE_EXCLUDED: 0,
      UNREADABLE: 0,
      MISSING: 0,
      DEVICE_TESTED: 0
    },
    items: [],
    queue: [],
    itemMap: new Map(),
    allItemMap: new Map()
  };

  const discoveredItems = [];

  for (const filePath of videoFiles) {
    if (!fs.existsSync(filePath)) {
      inventory.counts.MISSING++;
      continue;
    }

    const fp = getMediaFingerprint(filePath);
    if (!fp) {
      inventory.counts.UNREADABLE++;
      continue;
    }

    const neutralId = getProbeNeutralId(filePath, fp.fingerprintId);
    const relPath = path.relative(targetDir, filePath).replace(/\\/g, '/');
    const cachedFacts = factsMap.get(fp.fingerprintId);
    const isDeriv = isDerivativeFile(filePath);

    let state = CandidateState.POLICY_DENIED_CANDIDATE;
    let fileCohort = 'denied';
    let streamType = 'DIRECT_DIAGNOSTIC';
    let decision = null;

    if (isDeriv) {
      state = CandidateState.DERIVATIVE_EXCLUDED;
      fileCohort = 'derivatives';
      streamType = 'DERIVATIVE_DIAGNOSTIC';
      inventory.counts.DERIVATIVE_EXCLUDED++;
    } else {
      decision = await preflightIncomingMedia(filePath, {
        facts: cachedFacts,
        provisionalAdmissionStore: provisionalStore
      });
      if (decision.mayPromoteToVrReady) {
        state = CandidateState.ALREADY_ADMITTED;
        fileCohort = 'admitted';
        streamType = 'PRODUCTION_PLAYER';
        inventory.counts.ALREADY_ADMITTED++;
      } else {
        state = CandidateState.POLICY_DENIED_CANDIDATE;
        fileCohort = 'denied';
        streamType = 'DIRECT_DIAGNOSTIC';
        inventory.counts.POLICY_DENIED_CANDIDATE++;
      }
    }

    discoveredItems.push({
      filePath,
      relPath,
      neutralId,
      fingerprintId: fp.fingerprintId,
      sizeBytes: fp.sizeBytes,
      state,
      cohort: fileCohort,
      streamType,
      isDerivative: isDeriv,
      classification: decision ? decision.classification : (isDeriv ? 'DERIVATIVE_EXCLUDED' : 'UNKNOWN'),
      reason: decision ? decision.reason : (isDeriv ? 'Matches derivative / test file pattern' : null),
      codec: cachedFacts?.video?.codec || (fileCohort === 'denied' ? 'av1' : 'unknown'),
      tag: cachedFacts?.video?.codecTag || (fileCohort === 'denied' ? 'av01' : 'unknown'),
      dimensions: cachedFacts?.video ? `${cachedFacts.video.width}x${cachedFacts.video.height}` : 'unknown',
      rFps: cachedFacts?.video?.rFps || null,
      avgFps: cachedFacts?.video?.avgFps || null
    });
  }

  inventory.items = discoveredItems;

  const cohortFilter = cohort === 'all'
    ? () => true
    : (it => it.cohort === cohort);

  const selectedItems = discoveredItems.filter(cohortFilter);
  const candidateFps = [];
  let queueIndex = 0;

  for (const item of selectedItems) {
    candidateFps.push(item.fingerprintId);

    const itemId = cohort === 'denied'
      ? `probe_${queueIndex}_${item.fingerprintId.substring(0, 8)}`
      : `${item.cohort}_${queueIndex}_${item.fingerprintId.substring(0, 8)}`;

    const streamUrl = item.streamType === 'PRODUCTION_PLAYER'
      ? `/video?path=${encodeURIComponent(item.relPath)}`
      : `/api/batch-probe/video?itemId=${encodeURIComponent(itemId)}`;

    const prevRunResult = runRecordsMap.get(`${queueIndex}_${item.fingerprintId}`) || runRecordsMap.get(item.fingerprintId);
    const regResult = registryFpsMap.get(item.fingerprintId);
    const isTested = Boolean(prevRunResult || regResult);
    if (isTested) inventory.counts.DEVICE_TESTED++;

    const itemMeta = {
      ...item,
      itemId,
      queueIndex: queueIndex++,
      streamUrl,
      isTested,
      recordedVerdict: (prevRunResult || regResult)?.verdict || BatchProbeVerdict.NOT_TESTED,
      lastTestedAt: (prevRunResult || regResult)?.timestamp || null
    };

    inventory.queue.push(itemMeta);
    inventory.itemMap.set(itemId, itemMeta);
  }

  let allIdx = 0;
  for (const item of discoveredItems) {
    const probeId = `probe_${allIdx}_${item.fingerprintId.substring(0, 8)}`;
    const cohortId = `${item.cohort}_${allIdx}_${item.fingerprintId.substring(0, 8)}`;
    inventory.allItemMap.set(probeId, item);
    inventory.allItemMap.set(cohortId, item);
    inventory.allItemMap.set(item.fingerprintId, item);
    allIdx++;
  }

  inventory.candidatesHash = computeCandidatesHash(candidateFps);
  return inventory;
}

/**
 * Sanitizes candidate queue for public API response, removing full file paths.
 *
 * @param {Array<object>} queue
 * @returns {Array<object>}
 */
export function serializePublicBatchQueue(queue = []) {
  return queue.map(item => ({
    itemId: item.itemId,
    queueIndex: item.queueIndex,
    neutralId: item.neutralId,
    relPath: item.relPath,
    fingerprintId: item.fingerprintId,
    cohort: item.cohort,
    streamType: item.streamType,
    streamUrl: item.streamUrl,
    isDerivative: !!item.isDerivative,
    sizeBytes: item.sizeBytes,
    state: item.state,
    classification: item.classification,
    reason: item.reason,
    codec: item.codec,
    tag: item.tag,
    dimensions: item.dimensions,
    rFps: item.rFps,
    avgFps: item.avgFps,
    isTested: item.isTested,
    recordedVerdict: item.recordedVerdict,
    lastTestedAt: item.lastTestedAt
  }));
}

/**
 * Builds full 90-file reconciliation matrix comparing static discovery with physical test evidence.
 *
 * @param {string} [prototypeDir]
 * @param {object} [cp]
 * @param {string} [targetDir]
 * @returns {Promise<object>}
 */
export async function build90FileReconciliationMatrix(prototypeDir = PROTOTYPE_DIR, cp = null, targetDir = null) {
  const mediaRoot = targetDir || getActiveMediaRoot();
  const inventory = await buildBatchCandidateQueue({ prototypeDir, targetDir: mediaRoot, cohort: 'all' });
  const allRegistryRecords = loadBatchRegistryRecords(prototypeDir);

  const regByFp = new Map();
  for (const r of allRegistryRecords) {
    if (r && r.fingerprintId) {
      regByFp.set(r.fingerprintId, r);
    }
  }

  const items = [];
  const stats = {
    totalFiles: inventory.items.length,
    nativeTested: 0,
    nativePass: 0,
    nativeFail: 0,
    untested: 0,
    productionAllowed: 0,
    productionDenied: 0,
    productionVerified: 0
  };

  const cohortCounts = {
    denied: 0,
    admitted: 0,
    derivatives: 0
  };

  for (const item of inventory.items) {
    if (item.cohort && cohortCounts[item.cohort] !== undefined) {
      cohortCounts[item.cohort]++;
    }

    const rec = regByFp.get(item.fingerprintId) || null;
    const physicalTested = Boolean(rec);
    const physicalVerdict = rec ? rec.verdict : BatchProbeVerdict.NOT_TESTED;

    let productionGateStatus = 'NOT_TESTED';
    let productionPlayerVerified = null;

    if (item.cohort === 'admitted') {
      productionGateStatus = 'ALLOWED';
      if (rec && rec.productionPlayerVerified !== undefined && rec.productionPlayerVerified !== null) {
        productionPlayerVerified = rec.productionPlayerVerified;
      } else if (rec && rec.verdict === BatchProbeVerdict.NATIVE_SAMPLE_PASS) {
        productionPlayerVerified = true;
      }
    } else {
      productionGateStatus = 'DENIED';
      productionPlayerVerified = false;
    }

    if (rec && rec.productionGateStatus) {
      productionGateStatus = rec.productionGateStatus;
    }

    if (physicalTested) {
      stats.nativeTested++;
      if (physicalVerdict === BatchProbeVerdict.NATIVE_SAMPLE_PASS) stats.nativePass++;
      else stats.nativeFail++;
    } else {
      stats.untested++;
    }

    if (productionGateStatus === 'ALLOWED') stats.productionAllowed++;
    else if (productionGateStatus === 'DENIED') stats.productionDenied++;

    if (productionPlayerVerified === true) stats.productionVerified++;

    items.push({
      neutralId: item.neutralId,
      relPath: item.relPath,
      fingerprintId: item.fingerprintId,
      cohort: item.cohort,
      candidateState: item.state,
      codec: item.codec,
      tag: item.tag,
      dimensions: item.dimensions,
      isDerivative: !!item.isDerivative,
      physicalTested,
      physicalVerdict,
      productionGateStatus,
      productionPlayerVerified,
      seekSuccess: rec ? (rec.seekSuccess ?? null) : null,
      rvfcCount: rec ? (rec.rvfcCount ?? null) : null,
      lastTestedAt: rec ? (rec.timestamp || rec.testedAt || null) : null,
      testedRunId: rec ? (rec.runId || null) : null
    });
  }

  return {
    policyVersion: BATCH_PROBE_POLICY_VERSION,
    activeCohort: cp ? (cp.activeCohort || 'denied') : 'denied',
    checkpoint: cp || loadBatchCheckpoint(prototypeDir),
    stats,
    cohortCounts,
    totalFiles: items.length,
    items
  };
}
