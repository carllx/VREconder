/**
 * Compatibility Certification Registry.
 * 
 * Holds accepted physical-device compatibility certifications separating:
 * - DIRECT_PLAY (device-certified direct playback envelopes)
 * - REPAIR_EVIDENCE (certified repair envelopes with proven stream-copy restoration)
 * 
 * IMPORTANT: Entries here are compatibility evidence for intake classification.
 * They do NOT grant destructive-normalization execution authorization.
 */

import { EXACT_CERTIFIED_BUCKETS } from '../normalization/repair-rules.mjs';

export const CompatibilityIntent = {
  DIRECT_PLAY: 'DIRECT_PLAY',
  REPAIR_EVIDENCE: 'REPAIR_EVIDENCE'
};

/**
 * Certified Direct-Play Envelopes.
 * Proven by target iPhone physical-device tests to play directly in Safari.
 */
export const CERTIFIED_DIRECT_PLAY_ENVELOPES = [
  {
    envelopeId: 'CERTIFIED_DIRECT_AV1_4K_60_MOOV_FIRST',
    name: 'AV1 4320x2160 Main L16 8-bit 60fps moov_first',
    intent: CompatibilityIntent.DIRECT_PLAY,
    policyId: 'safari-certified-direct-av1-4k60',
    codec: 'av1',
    codecTag: 'av01',
    profile: 'Main',
    level: 16,
    bitDepth: 8,
    width: 4320,
    height: 2160,
    rFps: '60/1',
    avgFps: '60/1',
    ext: '.mp4',
    moovLocation: 'moov_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'iPhone 15 Pro Safari hardware decoding (3-member set)'
  },
  {
    envelopeId: 'CERTIFIED_DIRECT_AV1_4K_60_MDAT_FIRST',
    name: 'AV1 4320x2160 Main L16 8-bit 60fps mdat_first',
    intent: CompatibilityIntent.DIRECT_PLAY,
    policyId: 'safari-certified-direct-av1-4k60',
    codec: 'av1',
    codecTag: 'av01',
    profile: 'Main',
    level: 16,
    bitDepth: 8,
    width: 4320,
    height: 2160,
    rFps: '60/1',
    avgFps: '60/1',
    ext: '.mp4',
    moovLocation: 'mdat_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Probe-6A MEDIA-0637 + Probe-6B MEDIA-0728 (39-member set)'
  }
];

/**
 * Base certified repair buckets reused from repair-rules.mjs.
 */
const BASE_REPAIR_BUCKETS = EXACT_CERTIFIED_BUCKETS.map(b => ({
  envelopeId: b.bucketId,
  name: b.name,
  intent: CompatibilityIntent.REPAIR_EVIDENCE,
  ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
  codec: b.codec,
  codecTag: b.codecTag,
  profile: b.profile,
  level: b.level,
  bitDepth: b.bitDepth,
  width: b.width,
  height: b.height,
  rFps: b.rFps,
  avgFps: b.avgFps,
  ext: b.ext || '.mp4',
  videoCount: 1,
  audioCount: 1,
  chapterCount: 0,
  provenBy: b.provenBy
}));

/**
 * Additional accepted physical-device certified repair envelopes.
 */
const EXTENDED_REPAIR_ENVELOPES = [
  // Certified chapter-aware Wakui A2
  {
    envelopeId: 'CHAPTER_A2_4096x2048_60000_1001_MAIN_L153',
    name: '4K 4096x2048 Main Level 153 ~60fps Chapter-Aware (Wakui)',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-chapters-streamcopy-v1',
    isChapterAware: true,
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main',
    level: 153,
    bitDepth: 8,
    width: 4096,
    height: 2048,
    rFps: '60000/1001',
    avgFps: '60000/1001',
    ext: '.mp4',
    videoCount: 1,
    audioCount: 1,
    chapterCount: '>0',
    provenBy: 'Physical iPhone Safari multi-representative chapter repair (Kosaka/Fujita/URVRSP203)'
  },
  // Historical Envelope A (pop 29)
  {
    envelopeId: 'HISTORIC_ENVELOPE_A_4320x2160_60000_1001_MAIN_L180',
    name: '4320x2160 Main L180 8-bit ~59.94fps',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main',
    level: 180,
    bitDepth: 8,
    width: 4320,
    height: 2160,
    rFps: '60000/1001',
    avgFps: '60000/1001',
    ext: '.mp4',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Historical physical matrix Envelope A'
  },
  // Historical Envelope B (pop 75)
  {
    envelopeId: 'HISTORIC_ENVELOPE_B_4096x2048_60000_1001_MAIN10_L153',
    name: '4096x2048 Main 10 L153 10-bit ~59.94fps',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main 10',
    level: 153,
    bitDepth: 10,
    width: 4096,
    height: 2048,
    rFps: '60000/1001',
    avgFps: '60000/1001',
    ext: '.mp4',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Probe-4B physical matrix (MEDIA-0077 / MEDIA-0089)'
  },
  // Historical Envelope C (pop 171)
  {
    envelopeId: 'HISTORIC_ENVELOPE_C_4320x2160_60_1_MAIN10_L180',
    name: '4320x2160 Main 10 L180 10-bit 60fps',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main 10',
    level: 180,
    bitDepth: 10,
    width: 4320,
    height: 2160,
    rFps: '60/1',
    avgFps: '60/1',
    ext: '.mp4',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Probe-5B physical matrix (MEDIA-0065 / MEDIA-0066)'
  },
  // Probe-8B (pop 35)
  {
    envelopeId: 'PROBE8B_4320x2160_60_1_MAIN_L180_MOOV_FIRST',
    name: '4320x2160 Main L180 8-bit 60fps moov_first',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main',
    level: 180,
    bitDepth: 8,
    width: 4320,
    height: 2160,
    rFps: '60/1',
    avgFps: '60/1',
    ext: '.mp4',
    moovLocation: 'moov_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Probe-8B physical matrix (MEDIA-0056 / MEDIA-0057)'
  },
  // Probe-9 (pop 6)
  {
    envelopeId: 'PROBE9_3024x1512_60_1_MAIN10_L153_MOOV_FIRST',
    name: '3024x1512 Main 10 L153 10-bit 60fps moov_first',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main 10',
    level: 153,
    bitDepth: 10,
    width: 3024,
    height: 1512,
    rFps: '60/1',
    avgFps: '60/1',
    ext: '.mp4',
    moovLocation: 'moov_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Probe-9 physical matrix (MEDIA-0277 / MEDIA-0282)'
  },
  // Slot B2 (pop 8)
  {
    envelopeId: 'SLOT_B2_4320x2160_60_1_MAIN_L180_MDAT_FIRST',
    name: '4320x2160 Main L180 8-bit 60fps mdat_first',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main',
    level: 180,
    bitDepth: 8,
    width: 4320,
    height: 2160,
    rFps: '60/1',
    avgFps: '60/1',
    ext: '.mp4',
    moovLocation: 'mdat_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Slot B2 physical matrix (KAVR233 dual-rep)'
  },
  // Slot C2 (pop 6)
  {
    envelopeId: 'SLOT_C2_2880x1440_60_1_MAIN10_L150_MOOV_FIRST',
    name: '2880x1440 Main 10 L150 10-bit 60fps moov_first',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main 10',
    level: 150,
    bitDepth: 10,
    width: 2880,
    height: 1440,
    rFps: '60/1',
    avgFps: '60/1',
    ext: '.mp4',
    moovLocation: 'moov_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Slot C2 physical matrix (KMVR362 dual-rep)'
  },
  // Slot D2 (pop 5)
  {
    envelopeId: 'SLOT_D2_4320x2160_30_1_MAIN10_L180_MOOV_FIRST',
    name: '4320x2160 Main 10 L180 10-bit 30fps moov_first',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main 10',
    level: 180,
    bitDepth: 10,
    width: 4320,
    height: 2160,
    rFps: '30/1',
    avgFps: '30/1',
    ext: '.mp4',
    moovLocation: 'moov_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Slot D2 physical matrix (AA4 dual-rep)'
  },
  // NEW Envelope A (pop 5)
  {
    envelopeId: 'NEW_ENVELOPE_A_4320x2160_2997_50_MAIN_L180_MOOV_FIRST',
    name: '4320x2160 Main L180 8-bit ~59.94fps moov_first',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main',
    level: 180,
    bitDepth: 8,
    width: 4320,
    height: 2160,
    rFps: '2997/50',
    avgFps: '2997/50',
    ext: '.mp4',
    moovLocation: 'moov_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Accepted 6-representative matrix Envelope A (Mihara / Misaki)'
  },
  // NEW Envelope B (pop 3)
  {
    envelopeId: 'NEW_ENVELOPE_B_4320x2160_60000_1001_MAIN10_L180_MOOV_FIRST',
    name: '4320x2160 Main 10 L180 10-bit ~59.94fps moov_first',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main 10',
    level: 180,
    bitDepth: 10,
    width: 4320,
    height: 2160,
    rFps: '60000/1001',
    avgFps: '60000/1001',
    ext: '.mp4',
    moovLocation: 'moov_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Accepted 6-representative matrix Envelope B (Yamagishi / Kurumi)'
  },
  // NEW Envelope C (pop 2)
  {
    envelopeId: 'NEW_ENVELOPE_C_4096x2048_60_1_MAIN_L153_MOOV_FIRST',
    name: '4096x2048 Main L153 8-bit 60fps moov_first',
    intent: CompatibilityIntent.REPAIR_EVIDENCE,
    ruleId: 'hevc-mp4-hev1-to-hvc1-streamcopy-v1',
    codec: 'hevc',
    codecTag: 'hev1',
    profile: 'Main',
    level: 153,
    bitDepth: 8,
    width: 4096,
    height: 2048,
    rFps: '60/1',
    avgFps: '60/1',
    ext: '.mp4',
    moovLocation: 'moov_first',
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0,
    provenBy: 'Accepted 6-representative matrix Envelope C (Ellie Nova dual-rep)'
  }
];

export const CERTIFIED_REPAIR_EVIDENCE_ENVELOPES = [
  ...BASE_REPAIR_BUCKETS,
  ...EXTENDED_REPAIR_ENVELOPES
];

/**
 * Checks exact material equality between probed facts and a certified envelope.
 * Strictly enforces all material dimensions; missing facts or approximate fps fail closed.
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @param {object} env 
 * @returns {boolean}
 */
export function matchExactCompatibilityEnvelope(facts, ext, env) {
  if (!facts || !facts.video) return false;
  if (facts.videoCount !== 1) return false;

  const extLower = (ext || '').toLowerCase();
  if (env.ext && extLower !== env.ext.toLowerCase()) return false;

  const v = facts.video;
  if ((v.codec || '').toLowerCase() !== env.codec.toLowerCase()) return false;
  if ((v.codecTag || '').toLowerCase() !== env.codecTag.toLowerCase()) return false;
  if (v.profile !== env.profile) return false;
  if (v.level !== env.level) return false;
  if (v.bitDepth !== env.bitDepth) return false;
  if (v.width !== env.width) return false;
  if (v.height !== env.height) return false;

  // Exact string fps matching - no floating point approximation!
  if (v.rFps !== env.rFps) return false;
  if (v.avgFps !== env.avgFps) return false;

  // Moov placement constraint when specified by envelope
  if (env.moovLocation) {
    if (facts.moovLocation !== env.moovLocation) return false;
  }

  // Topology verification
  if (env.isChapterAware) {
    if (facts.videoCount !== 1) return false;
    if (facts.audioCount !== 1) return false;
    if (!Number.isInteger(facts.chapterCount) || facts.chapterCount <= 0) return false;
    if (!Array.isArray(facts.chapters) || facts.chapters.length !== facts.chapterCount) return false;
    if (!Array.isArray(facts.otherStreams) || facts.otherStreams.length !== 1) return false;
    if (!Number.isInteger(facts.subtitleCount) || facts.subtitleCount !== 0) return false;
    const dataStream = facts.otherStreams[0];
    if (dataStream.codecType !== 'data') return false;
    const cName = (dataStream.codecName || '').toLowerCase();
    const cTag = (dataStream.codecTag || '').toLowerCase();
    if (!['bin_data', 'text'].includes(cName)) return false;
    if (!['text', 'bin_data', ''].includes(cTag)) return false;
    return true;
  }

  // Clean standard topology requires explicit known facts:
  // videoCount === 1, audioCount === 1, chapterCount === 0, chapters.length === 0,
  // otherStreams.length === 0, subtitleCount === 0
  if (facts.videoCount !== 1) return false;
  if (facts.audioCount !== 1) return false;
  if (!Number.isInteger(facts.chapterCount) || facts.chapterCount !== 0) return false;
  if (!Array.isArray(facts.chapters) || facts.chapters.length !== 0) return false;
  if (!Array.isArray(facts.otherStreams) || facts.otherStreams.length !== 0) return false;
  if (!Number.isInteger(facts.subtitleCount) || facts.subtitleCount !== 0) return false;

  return true;
}

/**
 * Finds matching certified direct play envelope.
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @returns {object | null}
 */
export function findCertifiedDirectPlayEnvelope(facts, ext) {
  for (const env of CERTIFIED_DIRECT_PLAY_ENVELOPES) {
    if (matchExactCompatibilityEnvelope(facts, ext, env)) {
      return env;
    }
  }
  return null;
}

/**
 * Finds matching certified repair evidence envelope.
 * 
 * @param {object} facts 
 * @param {string} ext 
 * @returns {object | null}
 */
export function findCertifiedRepairEnvelope(facts, ext) {
  for (const env of CERTIFIED_REPAIR_EVIDENCE_ENVELOPES) {
    if (matchExactCompatibilityEnvelope(facts, ext, env)) {
      return env;
    }
  }
  return null;
}
