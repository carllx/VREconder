import path from 'node:path';
import crypto from 'node:crypto';
import { AUTHORITATIVE_HEALTH_ROOTS } from './media-health-types.mjs';

export const BATCH_PROBE_POLICY_VERSION = 'v1.1.0-av1-batch-probe';

/**
 * Candidate item intake status categories.
 */
export const CandidateState = {
  ALREADY_ADMITTED: 'ALREADY_ADMITTED',
  POLICY_DENIED_CANDIDATE: 'POLICY_DENIED_CANDIDATE',
  DERIVATIVE_EXCLUDED: 'DERIVATIVE_EXCLUDED',
  UNREADABLE: 'UNREADABLE',
  MISSING: 'MISSING',
  DEVICE_TESTED: 'DEVICE_TESTED'
};

/**
 * Granular batch probe verdicts for device execution.
 */
export const BatchProbeVerdict = {
  STATIC_POLICY_DENIED: 'STATIC_POLICY_DENIED',
  NATIVE_SAMPLE_PASS: 'NATIVE_SAMPLE_PASS',
  FIRST_FRAME_ONLY: 'FIRST_FRAME_ONLY',
  SEEK_FAILED: 'SEEK_FAILED',
  PLAYBACK_STALLED: 'PLAYBACK_STALLED',
  MEDIA_ERROR: 'MEDIA_ERROR',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  AUTOPLAY_BLOCKED: 'AUTOPLAY_BLOCKED',
  SERVER_ADMISSION_DENIED: 'SERVER_ADMISSION_DENIED',
  TIMEOUT_INCONCLUSIVE: 'TIMEOUT_INCONCLUSIVE',
  NOT_TESTED: 'NOT_TESTED'
};

/**
 * Computes deterministic candidate list hash from ordered fingerprint IDs.
 *
 * @param {string[]} fingerprintIds
 * @returns {string}
 */
export function computeCandidatesHash(fingerprintIds = []) {
  const hash = crypto.createHash('sha256');
  for (const fp of fingerprintIds) {
    hash.update(String(fp || ''));
  }
  return hash.digest('hex').substring(0, 16);
}

/**
 * Creates a public-safe neutral identity from path and fingerprint without exposing local filesystem layout.
 *
 * @param {string} filePath
 * @param {string} fingerprintId
 * @returns {string}
 */
export function getProbeNeutralId(filePath, fingerprintId) {
  if (!filePath) return `item:${fingerprintId || 'nofp'}`;
  const norm = path.normalize(filePath);
  for (const root of AUTHORITATIVE_HEALTH_ROOTS) {
    if (norm.startsWith(root)) {
      const rel = path.relative(root, norm).replace(/\\/g, '/');
      const rootName = path.basename(root);
      return `${rootName}:${rel}`;
    }
  }
  return `item:${fingerprintId || path.basename(filePath)}`;
}

/**
 * Sanitizes batch probe record for public reporting, stripping local paths.
 *
 * @param {object} record
 * @returns {object}
 */
export function sanitizeBatchProbeRecord(record) {
  if (!record) return null;
  return {
    runId: record.runId,
    itemIndex: record.queueIndex ?? record.itemIndex,
    itemId: record.itemId || `candidate_${record.fingerprintId}`,
    neutralId: `candidate:${record.fingerprintId || 'unknown'}`,
    fingerprintId: record.fingerprintId,
    candidateState: record.candidateState,
    cohort: record.cohort || 'denied',
    productionGateStatus: record.productionGateStatus || null,
    productionPlayerVerified: record.productionPlayerVerified ?? null,
    verdict: record.verdict,
    sampleDurationSec: record.sampleDurationSec || null,
    videoWidth: record.videoWidth || null,
    videoHeight: record.videoHeight || null,
    rvfcCount: record.rvfcCount || 0,
    seekCount: record.seekCount || 0,
    seekSuccess: !!record.seekSuccess,
    stallCount: record.stallCount || 0,
    error: record.error || null,
    observationEvidence: record.observationEvidence || null,
    deviceContext: record.deviceContext ? {
      userAgent: record.deviceContext.userAgent || '',
      screenResolution: record.deviceContext.screenResolution || null
    } : null,
    testedAt: record.testedAt || record.timestamp
  };
}
