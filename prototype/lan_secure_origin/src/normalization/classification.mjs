import path from 'node:path';
import { matchExactCertifiedBucket, matchChapterAwareCandidate, RuleStatus } from './repair-rules.mjs';

export const MediaClass = {
  READY_DIRECT: 'READY_DIRECT',
  EXACT_CERTIFIED_NORMALIZATION_CANDIDATE: 'EXACT_CERTIFIED_NORMALIZATION_CANDIDATE',
  NEEDS_BUCKET_CERTIFICATION: 'NEEDS_BUCKET_CERTIFICATION',
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
 * Classifies a media file given its probed facts into exact certification categories.
 * 
 * @param {string} filePath 
 * @param {object | null} facts 
 * @returns {{ classification: string, reason: string, repairCandidate: string | null, matchedBucket?: string }}
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

  if (facts.videoCount && facts.videoCount > 1) {
    return {
      classification: MediaClass.UNSUPPORTED_UNKNOWN_FIX,
      reason: `Multi-video stream container (${facts.videoCount} video streams) not certified for destructive normalization`,
      repairCandidate: null
    };
  }

  const v = facts.video;
  const ext = path.extname(filePath).toLowerCase();
  const codec = (v.codec || '').toLowerCase();
  const tag = (v.codecTag || '').toLowerCase();
  const bitDepth = (typeof v.bitDepth === 'number') ? v.bitDepth : null;

  // Unknown bit depth must NOT default to 8
  if (bitDepth === null) {
    return {
      classification: MediaClass.NEEDS_DEVICE_PROBE,
      reason: 'Bit depth unknown from probe; requires physical device probe',
      repairCandidate: null
    };
  }

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
    // 10-bit HEVC requires device probe
    if (bitDepth > 8) {
      return {
        classification: MediaClass.NEEDS_DEVICE_PROBE,
        reason: `${bitDepth}-bit HEVC (${tag || 'none'}) requires device probe to evaluate container & decoding capability`,
        repairCandidate: null
      };
    }

    // 8-bit HEVC with hvc1 tag
    if (tag === 'hvc1') {
      return {
        classification: MediaClass.READY_DIRECT,
        reason: 'HEVC with canonical hvc1 tag is directly compatible with Safari',
        repairCandidate: null
      };
    }

    // 8-bit HEVC with hev1 tag in .mp4
    if (tag === 'hev1') {
      if (ext === '.mp4') {
        const exactBucket = matchExactCertifiedBucket(facts, ext);
        if (exactBucket) {
          // Topology boundary check: explicit evidence required
          const isOrdinaryTopology =
            facts.videoCount === 1 &&
            facts.audioCount === 1 &&
            Array.isArray(facts.otherStreams) &&
            facts.otherStreams.length === 0 &&
            Number.isInteger(facts.chapterCount) &&
            facts.chapterCount === 0;

          // 1. Ordinary known topology (video + audio, no extra streams, no chapters)
          if (isOrdinaryTopology) {
            return {
              classification: MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE,
              reason: `Matches exact certified envelope (${exactBucket.name}) with standard A/V topology`,
              repairCandidate: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
              matchedBucket: exactBucket.bucketId
            };
          }

          // 2. Recognized certified chapter topology (video + audio + legacy data/text chapter representation + chapters)
          const chapterCandidate = matchChapterAwareCandidate(facts, ext);
          if (chapterCandidate && chapterCandidate.status === RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE) {
            return {
              classification: MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE,
              reason: `Matches certified video envelope with certified chapter-aware topology (${facts.chapterCount} chapters)`,
              repairCandidate: chapterCandidate.ruleId,
              matchedBucket: exactBucket.bucketId
            };
          }

          // 3. Unexpected or incomplete topology on exact video envelope (subtitles, multi-audio, missing topology facts, unknown data streams, etc.)
          return {
            classification: MediaClass.UNSUPPORTED_UNKNOWN_FIX,
            reason: `Untested or missing stream topology evidence on certified video envelope (videoCount: ${facts.videoCount}, audioCount: ${facts.audioCount}, otherStreams: ${facts.otherStreams?.length ?? 'none'}, chapterCount: ${facts.chapterCount ?? 'none'})`,
            repairCandidate: null
          };
        } else {
          return {
            classification: MediaClass.NEEDS_BUCKET_CERTIFICATION,
            reason: `HEVC hev1 8-bit MP4 with untested envelope (${v.width}x${v.height}, Level ${v.level}, Profile ${v.profile}, rFps ${v.rFps}, avgFps ${v.avgFps})`,
            repairCandidate: null
          };
        }
      } else {
        return {
          classification: MediaClass.NEEDS_DEVICE_PROBE,
          reason: `Non-.mp4 container extension (${ext}) with HEVC hev1 requires container compatibility probe`,
          repairCandidate: null
        };
      }
    }

    // Non-canonical tags (e.g. '', 'hevc')
    return {
      classification: MediaClass.NEEDS_DEVICE_PROBE,
      reason: `HEVC with non-canonical sample tag (${tag || 'empty'}) requires device probe`,
      repairCandidate: null
    };
  }

  // 3. Fallback for unrecognized formats
  return {
    classification: MediaClass.UNSUPPORTED_UNKNOWN_FIX,
    reason: `Codec ${codec} (tag: ${tag}) has no verified streamcopy repair rule`,
    repairCandidate: null
  };
}

