/**
 * Intake Preflight Pipeline & Promotion Gate (Issue #21).
 * 
 * Provides deterministic static preflight and compatibility policy gating
 * before any incoming media is promoted to VR Ready.
 * 
 * Precedence:
 * 1. Derivative/test artifact exclusion
 * 2. Unreadable/invalid probe
 * 3. Required-material-facts completeness check
 * 4. Exact certified DIRECT_PLAY envelope
 * 5. Exact certified REPAIR_EVIDENCE envelope
 * 6. Narrow static READY_DIRECT policy
 * 7. Generic existing classifier / fallback routing
 * 8. Fail closed
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeMediaFacts } from '../normalization/ffprobe-facts.mjs';
import { isDerivativeFile } from '../normalization/classification.mjs';
import { DeviceProbeCache } from './device-probe-cache.mjs';
import {
  findCertifiedDirectPlayEnvelope,
  findCertifiedRepairEnvelope
} from './compatibility-certifications.mjs';

export const IntakeClassification = {
  READY_DIRECT: 'READY_DIRECT',
  NORMALIZATION_CANDIDATE_CERTIFIED: 'NORMALIZATION_CANDIDATE_CERTIFIED',
  NEEDS_DEVICE_PROBE: 'NEEDS_DEVICE_PROBE',
  NEEDS_BUCKET_CERTIFICATION: 'NEEDS_BUCKET_CERTIFICATION',
  UNSUPPORTED_UNKNOWN_FIX: 'UNSUPPORTED_UNKNOWN_FIX',
  UNREADABLE_MEDIA: 'UNREADABLE_MEDIA',
  EXPERIMENT_DERIVATIVE: 'EXPERIMENT_DERIVATIVE'
};

export const EvidenceBasis = {
  STATIC_POLICY_ONLY: 'STATIC_POLICY_ONLY',
  CERTIFIED_PHYSICAL_DEVICE: 'CERTIFIED_PHYSICAL_DEVICE',
  FILE_SPECIFIC_DEVICE_PROBE: 'FILE_SPECIFIC_DEVICE_PROBE',
  UNCERTIFIED_HEVC: 'UNCERTIFIED_HEVC',
  UNCERTIFIED_DEVICE_PROBE_REQUIRED: 'UNCERTIFIED_DEVICE_PROBE_REQUIRED',
  UNSUPPORTED_OR_UNKNOWN: 'UNSUPPORTED_OR_UNKNOWN',
  UNREADABLE_OR_INVALID: 'UNREADABLE_OR_INVALID',
  DERIVATIVE_EXCLUDED: 'DERIVATIVE_EXCLUDED'
};

export const UIReadiness = {
  VR_READY: '✓ VR Ready',
  CHECKING: 'Checking',
  NEEDS_NORMALIZATION: 'Needs normalization',
  NEEDS_INVESTIGATION: 'Needs investigation'
};

/**
 * Pure evaluation of probed media facts against compatibility policy.
 * 
 * @param {object | null} facts Probed facts object
 * @param {string} [filePath] Optional file path for container/extension and derivative checks
 * @param {object} [options]
 * @returns {object} Machine-consumable intake decision
 */
export function evaluateMediaFacts(facts, filePath = '', options = {}) {
  // 1. Derivative/test artifact exclusion
  if (filePath && isDerivativeFile(filePath)) {
    return {
      classification: IntakeClassification.EXPERIMENT_DERIVATIVE,
      evidenceBasis: EvidenceBasis.DERIVATIVE_EXCLUDED,
      matchedPolicy: null,
      matchedEnvelopeId: null,
      facts,
      reason: 'Matches derivative / temporary / test file pattern',
      mayPromoteToVrReady: false,
      allowedNextActions: ['EXCLUDE_FROM_INTAKE']
    };
  }

  // 2. Unreadable / invalid probe
  if (!facts || !facts.video) {
    return {
      classification: IntakeClassification.UNREADABLE_MEDIA,
      evidenceBasis: EvidenceBasis.UNREADABLE_OR_INVALID,
      matchedPolicy: null,
      matchedEnvelopeId: null,
      facts: null,
      reason: 'No valid video stream detected or ffprobe failed; media facts unavailable',
      mayPromoteToVrReady: false,
      allowedNextActions: ['CHECK_SOURCE_FILE']
    };
  }

  // Multi-video streams check
  if (facts.videoCount && facts.videoCount > 1) {
    return {
      classification: IntakeClassification.UNSUPPORTED_UNKNOWN_FIX,
      evidenceBasis: EvidenceBasis.UNSUPPORTED_OR_UNKNOWN,
      matchedPolicy: null,
      matchedEnvelopeId: null,
      facts,
      reason: `Multi-video stream container (${facts.videoCount} video streams) not supported for VR Ready playback or normalization`,
      mayPromoteToVrReady: false,
      allowedNextActions: ['MANUAL_REVIEW_REQUIRED']
    };
  }

  const v = facts.video;
  const ext = filePath ? path.extname(filePath).toLowerCase() : (options.ext || '.mp4');
  const codec = (v.codec || '').toLowerCase();
  const tag = (v.codecTag || '').toLowerCase();
  const bitDepth = (typeof v.bitDepth === 'number') ? v.bitDepth : null;

  // 3. Required-material-facts completeness check
  // Missing bitDepth, rFps, or avgFps cannot inherit certified envelopes
  if (bitDepth === null || !v.rFps || !v.avgFps) {
    return {
      classification: IntakeClassification.NEEDS_DEVICE_PROBE,
      evidenceBasis: EvidenceBasis.UNCERTIFIED_DEVICE_PROBE_REQUIRED,
      matchedPolicy: null,
      matchedEnvelopeId: null,
      facts,
      reason: `Missing material fact (bitDepth: ${bitDepth ?? 'unknown'}, rFps: ${v.rFps || 'missing'}, avgFps: ${v.avgFps || 'missing'}); cannot inherit certified envelope without complete facts`,
      mayPromoteToVrReady: false,
      allowedNextActions: ['DEVICE_PROBE_REQUIRED']
    };
  }

  // 4. Exact certified DIRECT_PLAY envelope (e.g. AV1 4K60 physical certification)
  const directEnv = findCertifiedDirectPlayEnvelope(facts, ext);
  if (directEnv) {
    return {
      classification: IntakeClassification.READY_DIRECT,
      evidenceBasis: EvidenceBasis.CERTIFIED_PHYSICAL_DEVICE,
      matchedPolicy: directEnv.policyId || 'safari-certified-direct-av1-4k60',
      matchedEnvelopeId: directEnv.envelopeId,
      facts,
      reason: `Matches physical-device certified direct-play envelope (${directEnv.envelopeId})`,
      mayPromoteToVrReady: true,
      allowedNextActions: ['PROMOTE_TO_VR_READY']
    };
  }

  // 5. Exact certified REPAIR_EVIDENCE envelope (e.g. historical and newly certified HEVC repair envelopes)
  const repairEnv = findCertifiedRepairEnvelope(facts, ext);
  if (repairEnv) {
    const isChapter = !!repairEnv.isChapterAware;
    return {
      classification: IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED,
      evidenceBasis: EvidenceBasis.CERTIFIED_PHYSICAL_DEVICE,
      matchedPolicy: repairEnv.ruleId || (isChapter ? 'hevc-mp4-hev1-to-hvc1-chapters-streamcopy-v1' : 'hevc-mp4-hev1-to-hvc1-streamcopy-v1'),
      matchedEnvelopeId: repairEnv.envelopeId,
      facts,
      reason: `Matches exact certified repair envelope (${repairEnv.envelopeId}) with verified A/V stream-copy compatibility`,
      mayPromoteToVrReady: false,
      requiresUserAuthorization: true,
      proposedOperation: {
        type: isChapter ? 'stream-copy-chapters' : 'stream-copy',
        outputTag: 'hvc1',
        requiresReencoding: false,
        ffmpegArgs: isChapter
          ? ['-map', '0:v', '-map', '0:a', '-map_chapters', '0', '-c', 'copy', '-tag:v', 'hvc1']
          : ['-map', '0', '-c', 'copy', '-tag:v', 'hvc1']
      },
      normalizationPlan: {
        engine: 'NormalizationEngine',
        method: 'processCandidate',
        journalRequired: true,
        fingerprintGate: true,
        diskSpaceGate: true,
        playbackCancellationGate: true,
        concurrencyGate: 1,
        atomicSwapVerification: true,
        recoveryRequiredOnFailure: true,
        destructiveAuthorizationGranted: false
      },
      allowedNextActions: ['REQUEST_USER_AUTHORIZATION', 'STAGED_TRANSACTIONAL_NORMALIZATION']
    };
  }

  // 6. Narrow static READY_DIRECT policy
  // Must fail closed: requires known container (.mp4), known bitDepth, clean explicit topology
  const hasCleanStandardTopology =
    facts.videoCount === 1 &&
    facts.audioCount === 1 &&
    Number.isInteger(facts.chapterCount) && facts.chapterCount === 0 &&
    Array.isArray(facts.chapters) && facts.chapters.length === 0 &&
    Array.isArray(facts.otherStreams) && facts.otherStreams.length === 0 &&
    Number.isInteger(facts.subtitleCount) && facts.subtitleCount === 0;

  // 6a. Static AVC1 (H.264) in MP4: require consistent identity (codec === 'h264' && tag === 'avc1')
  // Permissive OR behavior is strictly forbidden; contradictory codec/tag must fail closed.
  if (codec === 'h264' && tag === 'avc1') {
    if (ext === '.mp4' && hasCleanStandardTopology) {
      return {
        classification: IntakeClassification.READY_DIRECT,
        evidenceBasis: EvidenceBasis.STATIC_POLICY_ONLY,
        matchedPolicy: 'safari-static-direct-h264',
        matchedEnvelopeId: null,
        facts,
        reason: 'Standard AVC1 (H.264) in MP4 container with clean A/V topology is directly compatible with Safari under static policy',
        mayPromoteToVrReady: true,
        allowedNextActions: ['PROMOTE_TO_VR_READY']
      };
    } else {
      // Non-mp4 container or non-standard topology on H.264
      return {
        classification: IntakeClassification.NEEDS_DEVICE_PROBE,
        evidenceBasis: EvidenceBasis.UNCERTIFIED_DEVICE_PROBE_REQUIRED,
        matchedPolicy: null,
        matchedEnvelopeId: null,
        facts,
        reason: `H.264 media with non-standard container (${ext}) or topology requires device probe before promotion`,
        mayPromoteToVrReady: false,
        allowedNextActions: ['DEVICE_PROBE_REQUIRED']
      };
    }
  }

  // 6b. Static HEVC with canonical hvc1 tag and 8-bit depth in MP4
  if (codec === 'hevc' && tag === 'hvc1' && bitDepth === 8) {
    if (ext === '.mp4' && hasCleanStandardTopology) {
      return {
        classification: IntakeClassification.READY_DIRECT,
        evidenceBasis: EvidenceBasis.STATIC_POLICY_ONLY,
        matchedPolicy: 'safari-static-direct-hvc1-8bit',
        matchedEnvelopeId: null,
        facts,
        reason: 'HEVC with canonical hvc1 tag, 8-bit depth, and clean A/V topology in MP4 container is directly compatible with Safari under static policy',
        mayPromoteToVrReady: true,
        allowedNextActions: ['PROMOTE_TO_VR_READY']
      };
    } else {
      return {
        classification: IntakeClassification.NEEDS_DEVICE_PROBE,
        evidenceBasis: EvidenceBasis.UNCERTIFIED_DEVICE_PROBE_REQUIRED,
        matchedPolicy: null,
        matchedEnvelopeId: null,
        facts,
        reason: `HEVC hvc1 media with non-standard container (${ext}) or topology requires device probe`,
        mayPromoteToVrReady: false,
        allowedNextActions: ['DEVICE_PROBE_REQUIRED']
      };
    }
  }

  // 7. Generic existing classifier / fallback routing
  // 7a. HEVC with hev1 tag in MP4
  if (codec === 'hevc' && tag === 'hev1') {
    if (ext !== '.mp4') {
      return {
        classification: IntakeClassification.NEEDS_DEVICE_PROBE,
        evidenceBasis: EvidenceBasis.UNCERTIFIED_DEVICE_PROBE_REQUIRED,
        matchedPolicy: null,
        matchedEnvelopeId: null,
        facts,
        reason: `Non-.mp4 container extension (${ext}) with HEVC hev1 requires container compatibility probe`,
        mayPromoteToVrReady: false,
        allowedNextActions: ['DEVICE_PROBE_REQUIRED']
      };
    }

    if (hasCleanStandardTopology) {
      if (bitDepth === 8) {
        return {
          classification: IntakeClassification.NEEDS_BUCKET_CERTIFICATION,
          evidenceBasis: EvidenceBasis.UNCERTIFIED_HEVC,
          matchedPolicy: null,
          matchedEnvelopeId: null,
          facts,
          reason: `HEVC hev1 8-bit MP4 with uncertified exact envelope (${v.width}x${v.height}, Level ${v.level}, Profile ${v.profile}, rFps ${v.rFps}, avgFps ${v.avgFps}); requires bucket certification`,
          mayPromoteToVrReady: false,
          allowedNextActions: ['BUCKET_CERTIFICATION_REQUIRED']
        };
      } else {
        // > 8-bit uncertified HEVC
        return {
          classification: IntakeClassification.NEEDS_DEVICE_PROBE,
          evidenceBasis: EvidenceBasis.UNCERTIFIED_DEVICE_PROBE_REQUIRED,
          matchedPolicy: null,
          matchedEnvelopeId: null,
          facts,
          reason: `${bitDepth}-bit HEVC (${tag}) with uncertified envelope requires physical device probe`,
          mayPromoteToVrReady: false,
          allowedNextActions: ['DEVICE_PROBE_REQUIRED']
        };
      }
    } else {
      // Non-standard topology on uncertified hev1
      return {
        classification: IntakeClassification.UNSUPPORTED_UNKNOWN_FIX,
        evidenceBasis: EvidenceBasis.UNSUPPORTED_OR_UNKNOWN,
        matchedPolicy: null,
        matchedEnvelopeId: null,
        facts,
        reason: `Untested or complex stream topology on HEVC asset (videoCount: ${facts.videoCount}, audioCount: ${facts.audioCount}, otherStreams: ${facts.otherStreams?.length ?? 0}, chapters: ${facts.chapterCount ?? 0})`,
        mayPromoteToVrReady: false,
        allowedNextActions: ['MANUAL_REVIEW_REQUIRED']
      };
    }
  }

  // 7b. HEVC with non-canonical tags (e.g. '', 'hevc')
  if (codec === 'hevc') {
    return {
      classification: IntakeClassification.NEEDS_DEVICE_PROBE,
      evidenceBasis: EvidenceBasis.UNCERTIFIED_DEVICE_PROBE_REQUIRED,
      matchedPolicy: null,
      matchedEnvelopeId: null,
      facts,
      reason: `HEVC with non-canonical sample tag (${tag || 'empty'}) requires device probe`,
      mayPromoteToVrReady: false,
      allowedNextActions: ['DEVICE_PROBE_REQUIRED']
    };
  }

  // 8. Fail closed / unrecognized codecs
  return {
    classification: IntakeClassification.UNSUPPORTED_UNKNOWN_FIX,
    evidenceBasis: EvidenceBasis.UNSUPPORTED_OR_UNKNOWN,
    matchedPolicy: null,
    matchedEnvelopeId: null,
    facts,
    reason: `Codec ${codec} (tag: ${tag}) has no verified playback or streamcopy repair rule`,
    mayPromoteToVrReady: false,
    allowedNextActions: ['MANUAL_REVIEW_REQUIRED']
  };
}

/**
 * Preflights an incoming media file by probing facts and evaluating compatibility policy.
 * 
 * @param {string} filePath 
 * @param {object} [options] - { facts, probeCache, clientFamily }
 * @returns {Promise<object>} Machine-consumable intake decision
 */
export async function preflightIncomingMedia(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return {
      classification: IntakeClassification.UNREADABLE_MEDIA,
      evidenceBasis: EvidenceBasis.UNREADABLE_OR_INVALID,
      matchedPolicy: null,
      matchedEnvelopeId: null,
      facts: null,
      reason: 'Invalid file path supplied to intake preflight',
      mayPromoteToVrReady: false,
      allowedNextActions: ['CHECK_SOURCE_FILE']
    };
  }

  // Fast-path / synthetic facts injection for test harnesses
  let facts = options.facts || null;
  if (!facts) {
    try {
      facts = await probeMediaFacts(filePath, options);
    } catch (err) {
      return {
        classification: IntakeClassification.UNREADABLE_MEDIA,
        evidenceBasis: EvidenceBasis.UNREADABLE_OR_INVALID,
        matchedPolicy: null,
        matchedEnvelopeId: null,
        facts: null,
        reason: `Probe execution failed: ${err.message}`,
        mayPromoteToVrReady: false,
        allowedNextActions: ['CHECK_SOURCE_FILE']
      };
    }
  }

  // Evaluate static/certified policy
  const decision = evaluateMediaFacts(facts, filePath, options);

  // If already decided as ready or certified repair, return decision
  if (decision.classification === IntakeClassification.READY_DIRECT ||
      decision.classification === IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED ||
      decision.classification === IntakeClassification.EXPERIMENT_DERIVATIVE ||
      decision.classification === IntakeClassification.UNREADABLE_MEDIA) {
    return decision;
  }

  // Check file-specific device probe cache if supplied
  const probeCache = options.probeCache || null;
  if (probeCache && facts && facts.fingerprint?.fingerprintId) {
    const clientFamily = options.clientFamily || 'safari-ios';
    const cached = probeCache.get(facts.fingerprint.fingerprintId, clientFamily);
    if (cached && cached.result) {
      // Must require verified positive video: width > 0, height > 0, rVFC > 0
      const res = cached.result;
      const hasPositiveVideo = (res.videoWidth > 0 && res.videoHeight > 0 && (res.rvfcFrameCount > 0 || res.rVFC > 0));

      if (hasPositiveVideo) {
        return {
          ...decision,
          classification: IntakeClassification.READY_DIRECT,
          evidenceBasis: EvidenceBasis.FILE_SPECIFIC_DEVICE_PROBE,
          matchedPolicy: 'cached-device-probe-positive',
          mayPromoteToVrReady: true,
          reason: `File-specific target device probe verified positive video playback (w=${res.videoWidth}, h=${res.videoHeight}, rVFC=${res.rvfcFrameCount || res.rVFC})`,
          allowedNextActions: ['PROMOTE_TO_VR_READY']
        };
      }
      // Note: canPlay=true alone without verified positive video evidence fails closed
    }
  }

  return decision;
}

/**
 * Backwards-compatible Pipeline class for existing UI / server routes.
 */
export class IntakePreflightPipeline {
  constructor(probeCache = null) {
    this.probeCache = probeCache || new DeviceProbeCache();
  }

  /**
   * Preflights an asset and returns high-level UI readiness.
   * 
   * @param {string} filePath 
   * @param {string} clientFamily 
   * @returns {Promise<{ readiness: string, classification: string, actionRequired: string | null, facts: object | null, decision: object }>}
   */
  async evaluateAsset(filePath, clientFamily = 'safari-ios') {
    const decision = await preflightIncomingMedia(filePath, {
      probeCache: this.probeCache,
      clientFamily
    });

    let readiness = UIReadiness.NEEDS_INVESTIGATION;
    let actionRequired = decision.reason;

    switch (decision.classification) {
      case IntakeClassification.READY_DIRECT:
        readiness = UIReadiness.VR_READY;
        actionRequired = null;
        break;

      case IntakeClassification.NORMALIZATION_CANDIDATE_CERTIFIED:
        readiness = UIReadiness.NEEDS_NORMALIZATION;
        actionRequired = 'Stream-copy packaging required for smooth Safari playback';
        break;

      case IntakeClassification.NEEDS_DEVICE_PROBE:
        readiness = UIReadiness.CHECKING;
        actionRequired = 'Requires target device probe before entering VR';
        break;

      case IntakeClassification.NEEDS_BUCKET_CERTIFICATION:
        readiness = UIReadiness.NEEDS_INVESTIGATION;
        actionRequired = 'Untested media envelope requires bucket certification';
        break;

      case IntakeClassification.UNSUPPORTED_UNKNOWN_FIX:
      case IntakeClassification.UNREADABLE_MEDIA:
      default:
        readiness = UIReadiness.NEEDS_INVESTIGATION;
        actionRequired = decision.reason;
        break;
    }

    return {
      readiness,
      classification: decision.classification,
      actionRequired,
      facts: decision.facts,
      decision
    };
  }
}

// Thin CLI Operator Entry Point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.error(JSON.stringify({
      error: 'Missing required media file path argument',
      usage: 'node intake-preflight.mjs <media-file-path>'
    }, null, 2));
    process.exit(1);
  }

  preflightIncomingMedia(targetPath).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }).catch((err) => {
    console.error(JSON.stringify({
      classification: IntakeClassification.UNREADABLE_MEDIA,
      evidenceBasis: EvidenceBasis.UNREADABLE_OR_INVALID,
      mayPromoteToVrReady: false,
      error: err.message
    }, null, 2));
    process.exit(1);
  });
}
