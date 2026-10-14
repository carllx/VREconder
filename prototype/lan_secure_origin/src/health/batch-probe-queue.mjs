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
import { loadBatchRegistryForRun, loadBatchCheckpoint } from './batch-probe-store.mjs';

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
 * @returns {Promise<object>}
 */
export async function buildBatchCandidateQueue(options = {}) {
  const targetDir = options.targetDir || getActiveMediaRoot();
  const prototypeDir = options.prototypeDir || PROTOTYPE_DIR;

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
  const runRecordsMap = new Map();
  for (const r of currentRunRecords) {
    if (r && r.fingerprintId) {
      runRecordsMap.set(`${r.queueIndex}_${r.fingerprintId}`, r);
      runRecordsMap.set(r.fingerprintId, r);
    }
  }

  const inventory = {
    targetDir,
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
    itemMap: new Map() // itemId -> item
  };

  let queueIndex = 0;
  const candidateFps = [];

  for (const filePath of videoFiles) {
    if (!fs.existsSync(filePath)) {
      inventory.counts.MISSING++;
      inventory.items.push({
        filePath,
        neutralId: path.basename(filePath),
        state: CandidateState.MISSING,
        reason: 'File missing on disk'
      });
      continue;
    }

    const fp = getMediaFingerprint(filePath);
    if (!fp) {
      inventory.counts.UNREADABLE++;
      inventory.items.push({
        filePath,
        neutralId: path.basename(filePath),
        state: CandidateState.UNREADABLE,
        reason: 'Failed to compute file fingerprint'
      });
      continue;
    }

    const neutralId = getProbeNeutralId(filePath, fp.fingerprintId);

    if (isDerivativeFile(filePath)) {
      inventory.counts.DERIVATIVE_EXCLUDED++;
      inventory.items.push({
        filePath,
        neutralId,
        fingerprintId: fp.fingerprintId,
        sizeBytes: fp.sizeBytes,
        state: CandidateState.DERIVATIVE_EXCLUDED,
        reason: 'Matches derivative / test file pattern'
      });
      continue;
    }

    const cachedFacts = factsMap.get(fp.fingerprintId);
    const decision = await preflightIncomingMedia(filePath, {
      facts: cachedFacts,
      provisionalAdmissionStore: provisionalStore
    });

    if (decision.mayPromoteToVrReady) {
      inventory.counts.ALREADY_ADMITTED++;
      inventory.items.push({
        filePath,
        neutralId,
        fingerprintId: fp.fingerprintId,
        sizeBytes: fp.sizeBytes,
        state: CandidateState.ALREADY_ADMITTED,
        classification: decision.classification,
        matchedEnvelopeId: decision.matchedEnvelopeId,
        reason: decision.reason
      });
      continue;
    }

    // Policy denied candidate (e.g. UNSUPPORTED_UNKNOWN_FIX)
    const previousResult = runRecordsMap.get(`${queueIndex}_${fp.fingerprintId}`) || runRecordsMap.get(fp.fingerprintId);
    const isTested = Boolean(previousResult && (!activeRunId || previousResult.runId === activeRunId));
    if (isTested) {
      inventory.counts.DEVICE_TESTED++;
    }

    inventory.counts.POLICY_DENIED_CANDIDATE++;
    candidateFps.push(fp.fingerprintId);

    const itemId = `probe_${queueIndex}_${fp.fingerprintId.substring(0, 8)}`;

    const itemMeta = {
      itemId,
      queueIndex: queueIndex++,
      filePath, // internal server only
      neutralId,
      fingerprintId: fp.fingerprintId,
      sizeBytes: fp.sizeBytes,
      state: CandidateState.POLICY_DENIED_CANDIDATE,
      classification: decision.classification,
      reason: decision.reason,
      codec: cachedFacts?.video?.codec || 'av1',
      tag: cachedFacts?.video?.codecTag || 'av01',
      dimensions: cachedFacts?.video ? `${cachedFacts.video.width}x${cachedFacts.video.height}` : 'unknown',
      rFps: cachedFacts?.video?.rFps || null,
      avgFps: cachedFacts?.video?.avgFps || null,
      isTested,
      recordedVerdict: previousResult ? previousResult.verdict : BatchProbeVerdict.NOT_TESTED,
      lastTestedAt: previousResult ? previousResult.timestamp : null
    };

    inventory.items.push(itemMeta);
    inventory.queue.push(itemMeta);
    inventory.itemMap.set(itemId, itemMeta);
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
    fingerprintId: item.fingerprintId,
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
