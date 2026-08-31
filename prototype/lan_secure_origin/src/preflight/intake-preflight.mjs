import { probeMediaFacts } from '../normalization/ffprobe-facts.mjs';
import { classifyMedia, MediaClass } from '../normalization/classification.mjs';
import { DeviceProbeCache } from './device-probe-cache.mjs';

export const UIReadiness = {
  VR_READY: '✓ VR Ready',
  CHECKING: 'Checking',
  NEEDS_NORMALIZATION: 'Needs normalization',
  NEEDS_INVESTIGATION: 'Needs investigation'
};

export class IntakePreflightPipeline {
  constructor(probeCache = null) {
    this.probeCache = probeCache || new DeviceProbeCache();
  }

  /**
   * Preflights an incoming or library media asset and returns high-level UI readiness.
   * 
   * @param {string} filePath 
   * @param {string} clientFamily 
   * @returns {Promise<{ readiness: string, classification: string, actionRequired: string | null, facts: object | null }>}
   */
  async evaluateAsset(filePath, clientFamily = 'safari-ios') {
    const facts = await probeMediaFacts(filePath);
    if (!facts || !facts.video) {
      return {
        readiness: UIReadiness.NEEDS_INVESTIGATION,
        classification: MediaClass.INVALID_MEDIA,
        actionRequired: 'Corrupt or non-video asset',
        facts: null
      };
    }

    const classification = classifyMedia(filePath, facts);
    const fpId = facts.fingerprint.fingerprintId;

    // Check device probe cache if applicable
    const cachedProbe = this.probeCache.get(fpId, clientFamily);
    if (cachedProbe) {
      if (cachedProbe.result && cachedProbe.result.canPlay) {
        return {
          readiness: UIReadiness.VR_READY,
          classification: classification.classification,
          actionRequired: null,
          facts
        };
      } else {
        return {
          readiness: UIReadiness.NEEDS_INVESTIGATION,
          classification: classification.classification,
          actionRequired: 'Device probe reported playback failure',
          facts
        };
      }
    }

    switch (classification.classification) {
      case MediaClass.READY_DIRECT:
        return {
          readiness: UIReadiness.VR_READY,
          classification: MediaClass.READY_DIRECT,
          actionRequired: null,
          facts
        };

      case MediaClass.NORMALIZATION_CANDIDATE:
        return {
          readiness: UIReadiness.NEEDS_NORMALIZATION,
          classification: MediaClass.NORMALIZATION_CANDIDATE,
          actionRequired: 'Stream-copy packaging required for smooth Safari playback',
          facts
        };

      case MediaClass.NEEDS_DEVICE_PROBE:
        return {
          readiness: UIReadiness.CHECKING,
          classification: MediaClass.NEEDS_DEVICE_PROBE,
          actionRequired: 'Requires lightweight browser probe before entering VR',
          facts
        };

      case MediaClass.UNSUPPORTED_UNKNOWN_FIX:
      default:
        return {
          readiness: UIReadiness.NEEDS_INVESTIGATION,
          classification: classification.classification,
          actionRequired: 'Format is not supported by current playback policy',
          facts
        };
    }
  }
}
