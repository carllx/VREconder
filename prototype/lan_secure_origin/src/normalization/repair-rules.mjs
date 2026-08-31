/**
 * Media Repair Rule Registry & Manifest.
 * 
 * Certified rules are officially authorized based on verified physical device A/B test results.
 */

export const RuleStatus = {
  CERTIFIED_FOR_TESTED_ENVELOPE: 'CERTIFIED_FOR_TESTED_ENVELOPE',
  REPAIR_RULE_CANDIDATE: 'REPAIR_RULE_CANDIDATE',
  DEPRECATED: 'DEPRECATED'
};

export const CERTIFIED_REPAIR_RULES = [
  {
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    name: 'HEVC MP4 hev1 to hvc1 Lossless Stream-Copy Remux',
    policyVersion: 'v1.0.0-safari-certified',
    status: RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE,
    purpose: 'Safari Code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) compatibility for HEVC MP4 assets',
    inputRequirements: {
      containerFamily: ['MP4', 'MOV', 'M4V'],
      containerExtensions: ['.mp4', '.m4v', '.mov'],
      videoCodec: 'hevc',
      sampleEntryTags: ['hev1', 'hevc', ''],
      colorDepth: [8],
      structuralValidity: 'Valid MP4 container with parseable moov/mdat atom hierarchy and undecoded HEVC elementary stream'
    },
    operation: {
      type: 'stream-copy',
      ffmpegCommand: '-c copy -tag:v hvc1 -movflags +faststart',
      outputTag: 'hvc1',
      outputMoovLocation: 'moov_first',
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
      'Fix for WebGL texture upload latency, memory pressure, or network stall'
    ],
    rationale: 'Apple Safari on iOS requires the canonical MP4 container sample entry tag hvc1 to route HEVC video bitstreams to the hardware VideoToolbox decoder. Stream-copy remuxing rewrites container atom sample descriptions from hev1 to hvc1 and places moov at front without mutating or re-encoding media payload packets.'
  }
];

/**
 * Finds a matching certified repair rule for a given media fact profile.
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @returns {object | null}
 */
export function findCertifiedRepairRule(facts, ext) {
  if (!facts || !facts.video) return null;
  const v = facts.video;
  const codec = (v.codec || '').toLowerCase();
  const tag = (v.codecTag || '').toLowerCase();
  const extLower = ext.toLowerCase();
  const bitDepth = v.bitDepth || 8;

  for (const rule of CERTIFIED_REPAIR_RULES) {
    if (rule.status !== RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE) continue;
    const req = rule.inputRequirements;
    if (
      req.videoCodec === codec &&
      req.sampleEntryTags.includes(tag) &&
      req.containerExtensions.includes(extLower) &&
      req.colorDepth.includes(bitDepth)
    ) {
      return rule;
    }
  }
  return null;
}

export const findRepairCandidate = findCertifiedRepairRule;
