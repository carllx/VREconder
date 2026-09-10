import path from 'node:path';

export const HEALTH_CHECK_POLICY_VERSION = 'v1.0.0-t1-health';
export const COMPATIBILITY_POLICY_VERSION = 'v1.0.0-safari-compat';

/**
 * Authoritative roots for Issue #26.
 */
export const AUTHORITATIVE_HEALTH_ROOTS = [
  path.normalize('G:\\Media\\VR'),
  path.normalize('G:\\Download'),
  path.normalize('G:\\VREconder_Repair_Probe')
];

/**
 * Canonical Stage 1 Static Dispositions.
 */
export const StaticDisposition = {
  READY_DIRECT: 'READY_DIRECT',
  NORMALIZATION_CANDIDATE_CERTIFIED: 'NORMALIZATION_CANDIDATE_CERTIFIED',
  NEEDS_DEVICE_PROBE: 'NEEDS_DEVICE_PROBE',
  NEEDS_BUCKET_CERTIFICATION: 'NEEDS_BUCKET_CERTIFICATION',
  UNSUPPORTED_UNKNOWN_FIX: 'UNSUPPORTED_UNKNOWN_FIX',
  UNREADABLE_MEDIA: 'UNREADABLE_MEDIA',
  EXPERIMENT_DERIVATIVE: 'EXPERIMENT_DERIVATIVE'
};

/**
 * Stage 2 Physical Device Probe Verdicts.
 */
export const ProbeVerdict = {
  PASS_VIDEO: 'PASS_VIDEO',
  MEDIA_ERROR: 'MEDIA_ERROR',
  NO_VIDEO_FRAME: 'NO_VIDEO_FRAME',
  TIMEOUT: 'TIMEOUT',
  PROBE_INTERRUPTED: 'PROBE_INTERRUPTED',
  PAGE_RECOVERY_REQUIRED: 'PAGE_RECOVERY_REQUIRED'
};

/**
 * Final Health States.
 */
export const FinalHealthState = {
  HEALTHY_DIRECT: 'HEALTHY_DIRECT',
  NEEDS_NORMALIZATION: 'NEEDS_NORMALIZATION',
  UNRESOLVED_NEEDS_PROBE: 'UNRESOLVED_NEEDS_PROBE',
  UNRESOLVED_NEEDS_CERTIFICATION: 'UNRESOLVED_NEEDS_CERTIFICATION',
  UNSUPPORTED: 'UNSUPPORTED',
  UNREADABLE: 'UNREADABLE',
  DERIVATIVE_EXCLUDED: 'DERIVATIVE_EXCLUDED',
  DEVICE_PROBE_FAILED: 'DEVICE_PROBE_FAILED'
};

/**
 * Identifies the business region of a file path.
 * 
 * @param {string} filePath 
 * @returns {string}
 */
export function identifyBusinessRegion(filePath) {
  const norm = path.normalize(filePath);
  const pRender = path.normalize('G:\\Media\\VR\\Render');
  const pQueue = path.normalize('G:\\Media\\VR\\VR_Video_Processing\\04_HEVC_Conversion_Queue');
  const pDownloadCompleted = path.normalize('G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed');
  const pDownload = path.normalize('G:\\Download');
  const pVrProcessing = path.normalize('G:\\Media\\VR\\VR_Video_Processing');
  const pVr = path.normalize('G:\\Media\\VR');

  if (norm.startsWith(pRender)) return 'G:\\Media\\VR\\Render';
  if (norm.startsWith(pQueue)) return 'G:\\Media\\VR\\VR_Video_Processing\\04_HEVC_Conversion_Queue';
  if (norm.startsWith(pDownloadCompleted)) return 'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed';
  if (norm.startsWith(pDownload)) return 'G:\\Download';
  if (norm.startsWith(pVrProcessing)) return 'G:\\Media\\VR\\VR_Video_Processing (Other)';
  if (norm.startsWith(pVr)) return 'G:\\Media\\VR (Other)';
  return 'External / Unrecognized';
}

/**
 * Creates a root-neutral identity for reporting without exposing local paths.
 * 
 * @param {string} filePath 
 * @param {string} fingerprintId 
 * @returns {string}
 */
export function getRootNeutralId(filePath, fingerprintId) {
  const norm = path.normalize(filePath);
  for (const root of AUTHORITATIVE_HEALTH_ROOTS) {
    if (norm.startsWith(root)) {
      const rel = path.relative(root, norm).replace(/\\/g, '/');
      const rootName = path.basename(root);
      return `${rootName}:${rel}`;
    }
  }
  return `unknown:${fingerprintId || path.basename(filePath)}`;
}

/**
 * Produces a sanitized, public-safe representation of a media health record.
 * 
 * @param {object} record 
 * @returns {object}
 */
export function sanitizePublicHealthRecord(record) {
  return {
    mediaId: record.neutralId || record.fingerprintId,
    fingerprintId: record.fingerprintId,
    region: record.region,
    staticClassification: record.staticClassification,
    probeVerdict: record.probeVerdict || null,
    finalHealthState: record.finalHealthState,
    recommendedNextAction: record.recommendedNextAction,
    healthCheckPolicyVersion: record.healthCheckPolicyVersion || HEALTH_CHECK_POLICY_VERSION,
    compatibilityPolicyVersion: record.compatibilityPolicyVersion || COMPATIBILITY_POLICY_VERSION,
    timestamp: record.timestamp
  };
}
