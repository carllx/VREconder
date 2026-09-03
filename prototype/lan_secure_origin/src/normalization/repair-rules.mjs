/**
 * Media Repair Rule Registry & Manifest.
 * 
 * Certified rules are officially authorized based on verified physical device A/B test results.
 * Narrowed strictly to exact certified buckets with exact tested envelopes.
 */

export const RuleStatus = {
  CERTIFIED_FOR_TESTED_ENVELOPE: 'CERTIFIED_FOR_TESTED_ENVELOPE',
  NEEDS_BUCKET_CERTIFICATION: 'NEEDS_BUCKET_CERTIFICATION',
  NEEDS_DEVICE_PROBE: 'NEEDS_DEVICE_PROBE',
  DEPRECATED: 'DEPRECATED'
};

/**
 * Verified Physical Test Buckets.
 */
export const EXACT_CERTIFIED_BUCKETS = [
  {
    bucketId: 'BUCKET_A1_4K_59FPS_SIVR033',
    name: '4K 3840x1920 Main Level 153 ~59.94fps (SIVR033)',
    codec: 'hevc',
    codecTag: 'hev1',
    ext: '.mp4',
    profile: 'Main',
    level: 153,
    bitDepth: 8,
    width: 3840,
    height: 1920,
    rFps: '2997/50',
    avgFps: '262749987/4359446',
    provenBy: 'SIVR033 (Mikami Yua_Arata Arina)'
  },
  {
    bucketId: 'BUCKET_A2_4K_60FPS_WAKUI',
    name: '4K 4096x2048 Main Level 153 ~60.00fps (Wakui Mito)',
    codec: 'hevc',
    codecTag: 'hev1',
    ext: '.mp4',
    profile: 'Main',
    level: 153,
    bitDepth: 8,
    width: 4096,
    height: 2048,
    rFps: '60000/1001',
    avgFps: '60000/1001',
    provenBy: 'Wakui Mito (DSVR01546 / VRKM962)'
  },
  {
    bucketId: 'BUCKET_B_8K_60FPS_KAMIKI',
    name: '8K 8192x4096 Main Level 183 ~59.94fps (Kamiki Rei)',
    codec: 'hevc',
    codecTag: 'hev1',
    ext: '.mp4',
    profile: 'Main',
    level: 183,
    bitDepth: 8,
    width: 8192,
    height: 4096,
    rFps: '60000/1001',
    avgFps: '2118587705/34961143',
    provenBy: 'Kamiki Rei (DSVR01433)'
  }
];

export const CERTIFIED_REPAIR_RULES = [
  {
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    name: 'HEVC MP4 hev1 to hvc1 Lossless Stream-Copy Remux',
    policyVersion: 'v1.0.0-safari-certified',
    status: RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE,
    purpose: 'Safari Code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) compatibility for HEVC MP4 assets',
    inputRequirements: {
      containerExtensions: ['.mp4'],
      videoCodec: 'hevc',
      sampleEntryTags: ['hev1'],
      colorDepth: [8],
      profile: ['Main'],
      certifiedBuckets: ['BUCKET_A1_4K_59FPS_SIVR033', 'BUCKET_A2_4K_60FPS_WAKUI', 'BUCKET_B_8K_60FPS_KAMIKI']
    },
    operation: {
      type: 'stream-copy',
      ffmpegArgs: ['-map', '0', '-c', 'copy', '-tag:v', 'hvc1'],
      outputTag: 'hvc1',
      requiresReencoding: false
    },
    provenBy: [
      { id: '8k-kamiki', name: '8K Kamiki (DSVR01433)', res: '8192x4096', original: 'hev1 (Code 4)', certified: 'hvc1 (canplay)' },
      { id: '4k-sivr033', name: '4K SIVR033', res: '3840x1920', original: 'hev1 (Code 4)', certified: 'hvc1 (canplay)' },
      { id: 'wakui-mito', name: 'Legacy Render Wakui Mito (DSVR01546)', res: '4096x2048', original: 'hev1 (Code 4)', certified: 'hvc1 (canplay)' }
    ],
    doesNotClaim: [
      'Universal hev1 failure across all hardware / OS combinations',
      'Sustained Full VR 60fps playback performance guarantee (belongs to Issue #14)',
      'FastStart container rearrangement (belongs to container-faststart-optimization policy)',
      'Fix for WebGL texture upload latency, memory pressure, or network stall'
    ],
    rationale: 'Apple Safari on iOS requires the canonical MP4 container sample entry tag hvc1 to route HEVC video bitstreams to the hardware VideoToolbox decoder. Stream-copy remuxing rewrites container atom sample descriptions from hev1 to hvc1 without mutating or re-encoding media payload packets.'
  }
];

/**
 * Finds if facts match one of the exact certified buckets.
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @returns {object | null}
 */
export function matchExactCertifiedBucket(facts, ext) {
  if (!facts || !facts.video) return null;
  if (facts.videoCount && facts.videoCount > 1) return null;
  const v = facts.video;
  const extLower = (ext || '').toLowerCase();
  if (extLower !== '.mp4') return null;
  if ((v.codec || '').toLowerCase() !== 'hevc') return null;
  if ((v.codecTag || '').toLowerCase() !== 'hev1') return null;
  if (v.bitDepth !== 8) return null; // Unknown or non-8 bit depth fails match
  if (v.profile !== 'Main') return null;

  for (const b of EXACT_CERTIFIED_BUCKETS) {
    if (
      v.width === b.width &&
      v.height === b.height &&
      v.level === b.level &&
      v.profile === b.profile &&
      v.rFps === b.rFps &&
      v.avgFps === b.avgFps
    ) {
      return b;
    }
  }
  return null;
}

export const CANDIDATE_REPAIR_RULES = [
  {
    ruleId: 'hevc-mp4-hev1-to-hvc1-chapters-streamcopy-v1',
    name: 'HEVC MP4 hev1 to hvc1 Lossless Stream-Copy Remux with Chapter Preservation',
    policyVersion: 'v1.0.0-candidate-preflight',
    status: RuleStatus.NEEDS_BUCKET_CERTIFICATION,
    isChapterAware: true,
    purpose: 'Safari Code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) compatibility for HEVC MP4 assets with legacy chapter/text tracks',
    inputRequirements: {
      containerExtensions: ['.mp4'],
      videoCodec: 'hevc',
      sampleEntryTags: ['hev1'],
      colorDepth: [8],
      profile: ['Main'],
      certifiedBuckets: ['BUCKET_A1_4K_59FPS_SIVR033', 'BUCKET_A2_4K_60FPS_WAKUI', 'BUCKET_B_8K_60FPS_KAMIKI'],
      requiresChapters: true,
      allowedTopology: '1 video + 1 audio + 1 legacy chapter/data stream'
    },
    operation: {
      type: 'stream-copy-chapters',
      ffmpegArgs: ['-map', '0:v', '-map', '0:a', '-map_chapters', '0', '-c', 'copy', '-tag:v', 'hvc1'],
      outputTag: 'hvc1',
      requiresReencoding: false
    },
    provenBy: [],
    doesNotClaim: [
      'Universal hev1 failure across all hardware / OS combinations',
      'Production batch authorization without physical device certification',
      'FastStart container rearrangement',
      'Fix for WebGL texture upload latency, memory pressure, or network stall'
    ],
    rationale: 'Extracts video and audio bitstreams while preserving chapter markers via container-level -map_chapters 0, shedding non-standard legacy data/text streams that cause container mismatch on Safari VideoToolbox routing.'
  }
];

/**
 * Matches candidate media against the narrow chapter-aware candidate topology.
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @returns {object | null}
 */
export function matchChapterAwareCandidate(facts, ext) {
  if (!facts || !facts.video) return null;
  const extLower = (ext || '').toLowerCase();
  if (extLower !== '.mp4') return null;

  // Video envelope must match exact certified bucket
  const bucket = matchExactCertifiedBucket(facts, ext);
  if (!bucket) return null;

  // Topology matching: strictly 1 video stream, 1 audio stream, and > 0 chapters
  if ((facts.videoCount ?? 1) !== 1) return null;
  if ((facts.audioCount ?? 1) !== 1) return null;
  if (!facts.chapterCount || facts.chapterCount <= 0) return null;

  // Must have legacy chapter representation: exactly 1 non-video/non-audio stream of data type
  const otherStreams = facts.otherStreams || [];
  if (otherStreams.length !== 1) return null;

  const dataStream = otherStreams[0];
  if (dataStream.codecType !== 'data') return null;
  const cName = (dataStream.codecName || '').toLowerCase();
  const cTag = (dataStream.codecTag || '').toLowerCase();
  if (!['bin_data', 'text', 'unknown'].includes(cName)) return null;
  if (!['text', 'bin_data', ''].includes(cTag)) return null;

  // Subtitle streams strictly forbidden
  if (facts.subtitleCount && facts.subtitleCount > 0) return null;

  return {
    ...CANDIDATE_REPAIR_RULES[0],
    matchedBucket: bucket
  };
}

export const findCandidateRepairRule = matchChapterAwareCandidate;

/**
 * Finds a matching certified repair rule for a given media fact profile.
 * Certified rules apply ONLY to ordinary 2-stream media (1 video + 1 audio, 0 other streams, 0 chapters).
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @returns {object | null}
 */
export function findCertifiedRepairRule(facts, ext) {
  const bucket = matchExactCertifiedBucket(facts, ext);
  if (!bucket) return null;

  // Enforce topology boundary: certified rule requires strictly ordinary topology
  if ((facts.videoCount ?? 1) !== 1) return null;
  if (facts.audioCount !== undefined && facts.audioCount !== 1) return null;
  if (facts.otherStreams && facts.otherStreams.length > 0) return null;
  if (facts.chapterCount && facts.chapterCount > 0) return null;

  return {
    ...CERTIFIED_REPAIR_RULES[0],
    matchedBucket: bucket
  };
}

/**
 * Finds repair candidate with strict certified-by-default safety gate.
 * Uncertified candidates are strictly blocked unless explicit options.allowUncertified: true is passed.
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @param {object} options - { allowUncertified: boolean }
 * @returns {object | null}
 */
export function findRepairCandidate(facts, ext, options = {}) {
  // 1. Try certified rule first
  const certified = findCertifiedRepairRule(facts, ext);
  if (certified) return certified;

  // 2. Uncertified candidates only permitted when explicitly opted in (e.g. isolated staging tests)
  if (options && options.allowUncertified) {
    const candidate = matchChapterAwareCandidate(facts, ext);
    if (candidate) return candidate;
  }

  return null;
}

/**
 * Verifies if probed facts represent a cleanly normalized derivative
 * of an exact certified bucket (i.e. identical envelope, but hvc1 tag).
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @returns {object | null} Matched bucket or null
 */
export function matchNormalizedCertifiedBucket(facts, ext) {
  if (!facts || !facts.video) return null;
  if (facts.videoCount && facts.videoCount > 1) return null;
  const v = facts.video;
  const extLower = (ext || '').toLowerCase();
  if (extLower !== '.mp4') return null;
  if ((v.codec || '').toLowerCase() !== 'hevc') return null;
  if ((v.codecTag || '').toLowerCase() !== 'hvc1') return null;
  if (v.bitDepth !== 8) return null;
  if (v.profile !== 'Main') return null;

  for (const b of EXACT_CERTIFIED_BUCKETS) {
    if (
      v.width === b.width &&
      v.height === b.height &&
      v.level === b.level &&
      v.profile === b.profile &&
      v.rFps === b.rFps &&
      v.avgFps === b.avgFps
    ) {
      return b;
    }
  }
  return null;
}

