import path from 'node:path';

export const MediaClass = {
  READY_DIRECT: 'READY_DIRECT',
  NORMALIZATION_CANDIDATE: 'NORMALIZATION_CANDIDATE',
  NEEDS_DEVICE_PROBE: 'NEEDS_DEVICE_PROBE',
  UNSUPPORTED_UNKNOWN_FIX: 'UNSUPPORTED_UNKNOWN_FIX',
  INVALID_MEDIA: 'INVALID_MEDIA',
  EXPERIMENT_DERIVATIVE: 'EXPERIMENT_DERIVATIVE'
};

const DERIVATIVE_PATTERNS = [
  /_HVC1_TEST/i,
  /_faststart/i,
  /_HVC1\.mp4$/i,
  /_HVC1_test\.mp4$/i,
  /\.partial$/i,
  /\.vreconder\.partial$/i,
  /\.vreconder-old$/i,
  /\.tmp$/i,
  /\.temp$/i
];

/**
 * Checks if a filename or path matches known experimental derivative patterns.
 * 
 * @param {string} filePath 
 * @returns {boolean}
 */
export function isDerivativeFile(filePath) {
  const baseName = path.basename(filePath);
  return DERIVATIVE_PATTERNS.some(p => p.test(baseName));
}

/**
 * Classifies a media file given its probed facts.
 * 
 * @param {string} filePath 
 * @param {object | null} facts 
 * @returns {{ classification: string, reason: string, repairCandidate: string | null }}
 */
export function classifyMedia(filePath, facts) {
  if (isDerivativeFile(filePath)) {
    return {
      classification: MediaClass.EXPERIMENT_DERIVATIVE,
      reason: 'Matches derivative / temporary / test file pattern',
      repairCandidate: null
    };
  }

  if (!facts || !facts.video) {
    return {
      classification: MediaClass.INVALID_MEDIA,
      reason: 'No valid video stream detected or ffprobe failed',
      repairCandidate: null
    };
  }

  const v = facts.video;
  const ext = path.extname(filePath).toLowerCase();
  const isMp4Family = ['.mp4', '.m4v', '.mov'].includes(ext);
  const codec = (v.codec || '').toLowerCase();
  const tag = (v.codecTag || '').toLowerCase();
  const bitDepth = v.bitDepth || 8;

  // 1. AVC1 / H.264 in MP4 container
  if (codec === 'h264' || tag === 'avc1') {
    return {
      classification: MediaClass.READY_DIRECT,
      reason: 'Standard AVC1 (H.264) in MP4 container is directly compatible with Safari',
      repairCandidate: null
    };
  }

  // 2. HEVC in MP4 container
  if (codec === 'hevc') {
    // 10-bit HEVC requires device probe to confirm hardware decoding capability on target Safari
    if (bitDepth > 8) {
      if (tag === 'hvc1') {
        return {
          classification: MediaClass.NEEDS_DEVICE_PROBE,
          reason: '10-bit HEVC (hvc1) requires device probe to confirm decoding performance',
          repairCandidate: null
        };
      } else {
        return {
          classification: MediaClass.NEEDS_DEVICE_PROBE,
          reason: '10-bit HEVC (hev1) requires device probe to evaluate container & decoding compatibility',
          repairCandidate: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1'
        };
      }
    }

    // 8-bit HEVC with hvc1 tag
    if (tag === 'hvc1') {
      return {
        classification: MediaClass.READY_DIRECT,
        reason: 'HEVC with canonical hvc1 tag is directly compatible with Safari',
        repairCandidate: null
      };
    }

    // 8-bit HEVC with hev1 tag in MP4 container -> Candidate for lossless streamcopy normalization
    if (tag === 'hev1' || tag === '' || tag === 'hevc') {
      if (isMp4Family) {
        return {
          classification: MediaClass.NORMALIZATION_CANDIDATE,
          reason: 'HEVC with hev1 tag in MP4 container requires streamcopy packaging to hvc1 for Safari compatibility',
          repairCandidate: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1'
        };
      }
    }
  }

  // 3. Fallback for unrecognized formats
  return {
    classification: MediaClass.UNSUPPORTED_UNKNOWN_FIX,
    reason: `Codec ${codec} (tag: ${tag}) has no verified streamcopy repair rule`,
    repairCandidate: null
  };
}
