/**
 * Repair Rule Candidates Registry.
 * 
 * Formal repair rules require Browser Review authorization before being registered
 * as active production policies. Currently all repair rules are registered as
 * REPAIR_RULE_CANDIDATE with explicit applicability envelopes.
 */

export const REPAIR_RULE_CANDIDATES = [
  {
    id: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    name: 'HEVC MP4 hev1 to hvc1 Lossless Stream-Copy Remux',
    version: '1.0.0-candidate',
    status: 'CANDIDATE',
    applicability: {
      codec: 'hevc',
      tags: ['hev1', 'hevc', ''],
      containers: ['.mp4', '.m4v', '.mov'],
      colorDepth: [8],
      testedEnvelope: '4K/8K 8-bit HEVC in standard MP4 container with hev1 packaging causing Safari video error Code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED)'
    },
    rationale: 'Safari on iOS requires MP4 container sample entry tag hvc1 for hardware HEVC decoding. Remuxing with -c copy -tag:v hvc1 -movflags +faststart modifies container header atoms without re-encoding video payloads.',
    ffmpegArgs: [
      '-i', '{input}',
      '-c', 'copy',
      '-tag:v', 'hvc1',
      '-movflags', '+faststart',
      '{output}'
    ],
    expectedOutputTag: 'hvc1',
    requiresFullReencode: false
  }
];

/**
 * Finds a repair candidate rule for a given media fact profile.
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @returns {object | null}
 */
export function findRepairCandidate(facts, ext) {
  if (!facts || !facts.video) return null;
  const v = facts.video;
  const codec = (v.codec || '').toLowerCase();
  const tag = (v.codecTag || '').toLowerCase();
  const extLower = ext.toLowerCase();

  for (const rule of REPAIR_RULE_CANDIDATES) {
    const app = rule.applicability;
    if (app.codec === codec && app.tags.includes(tag) && app.containers.includes(extLower)) {
      return rule;
    }
  }
  return null;
}
