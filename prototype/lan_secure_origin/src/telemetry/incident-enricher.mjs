import path from 'node:path';
import fs from 'node:fs';
import { getMediaFingerprint } from '../normalization/fingerprint.mjs';
import { getCachedFacts } from '../normalization/ffprobe-facts.mjs';
import { getCachedAdmission, extractCheapMediaFacts } from '../server/preflight-router.mjs';
import { isPathContained, resolveSecureMediaPath } from '../server/media-path-resolver.mjs';

/**
 * Enriches client telemetry incident data server-side using cheap, existing context.
 * 
 * Performance contract:
 * - CHEAP_INLINE: request UA, client IP, DOM media state, session ID, cached media facts.
 * - STRICTLY NO new ffprobe calls, file hashing, or full-library scans during playback.
 * 
 * Path safety contract:
 * - Fallback fingerprint resolution allowed ONLY if resolved path exists AND is contained in approved roots.
 * - Traversal (../) or outside-root paths remain unresolved without granting canonical local identity.
 * 
 * @param {object} options
 * @param {import('node:http').IncomingMessage} options.req
 * @param {object} options.item - Payload received by POST /api/log
 * @param {string[]} [options.allowedRoots] - Allowed media directories
 * @param {Function} [options.resolveMediaPath] - Optional media path resolver
 * @returns {object} Formatted incident object ready for incident-store recordIncident()
 */
export function enrichIncidentFromRequest({ req, item, allowedRoots = [], resolveMediaPath = null }) {
  const d = item.data || {};
  const message = item.message || '';
  const isError = item.level === 'ERROR';

  const userAgent = (req && req.headers && req.headers['user-agent']) || null;
  const clientIp = (req && req.socket && req.socket.remoteAddress) || null;

  const sessionId = d.sessionId || item.sessionId || null;
  const admissionId = d.admissionId || null;
  const generation = typeof d.generation === 'number' ? d.generation : null;

  const mediaPath = d.mediaPath || '';
  const mediaName = d.mediaName || (mediaPath ? mediaPath.split('/').pop() : '');

  // 1. Resolve fingerprint identity: reuse client-provided or cheap stat-based lookup
  let fingerprintId = d.fingerprintId || null;
  if (!fingerprintId && mediaPath) {
    let resolvedPath = null;
    if (typeof resolveMediaPath === 'function') {
      resolvedPath = resolveMediaPath(mediaPath);
    } else if (allowedRoots && allowedRoots.length > 0) {
      resolvedPath = resolveSecureMediaPath(mediaPath, allowedRoots);
    }

    // Security Gate: Path must exist AND be contained within approved roots
    const rootsToCheck = (allowedRoots && allowedRoots.length > 0) ? allowedRoots : [];
    const isContained = rootsToCheck.length > 0 ? isPathContained(resolvedPath, rootsToCheck) : Boolean(resolvedPath);

    if (resolvedPath && fs.existsSync(resolvedPath) && isContained) {
      // Cheap fs.statSync only (path + size + mtimeMs), NO content hashing
      const fp = getMediaFingerprint(resolvedPath);
      if (fp) {
        fingerprintId = fp.fingerprintId;
      }
    }
  }

  // 2. Cheap cached media facts: strictly from memory/cache, NO ffprobe during ordinary playback
  let mediaFacts = d.mediaFacts || null;
  if (!mediaFacts && fingerprintId) {
    const cachedAdm = getCachedAdmission(fingerprintId);
    if (cachedAdm && cachedAdm.mediaFacts) {
      mediaFacts = cachedAdm.mediaFacts;
    } else {
      const cachedRawFacts = getCachedFacts(fingerprintId);
      if (cachedRawFacts) {
        mediaFacts = extractCheapMediaFacts(cachedRawFacts);
      }
    }
  }

  // 3. Classification and reason derivation
  let classification = d.classification;
  if (!classification) {
    if (message === 'MEDIA_PLAYBACK_ERROR') {
      classification = d.name || 'MEDIA_PLAYBACK_ERROR';
    } else {
      classification = 'UNCLASSIFIED';
    }
  }

  let reason = d.reason;
  if (!reason) {
    if (d.message) {
      reason = `${d.name || 'ERROR'}: ${d.message}`;
    } else {
      reason = d.name || message;
    }
  }

  // 4. Extract HTMLMediaElement DOM state when available
  const readyState = typeof d.readyState === 'number' ? d.readyState : null;
  const networkState = typeof d.networkState === 'number' ? d.networkState : null;
  const code = typeof d.code === 'number' ? d.code : null;
  const currentTime = typeof d.currentTime === 'number' ? d.currentTime : null;
  const bufferAheadSec = typeof d.bufferAheadSec === 'number' ? d.bufferAheadSec : null;
  const videoWidth = typeof d.videoWidth === 'number' ? d.videoWidth : null;
  const videoHeight = typeof d.videoHeight === 'number' ? d.videoHeight : null;

  return {
    eventType: message,
    severity: isError ? 'ERROR' : 'WARN',
    fingerprintId,
    localMediaName: mediaName,
    localMediaPath: mediaPath,
    classification,
    reason,
    matchedEnvelopeId: d.matchedEnvelopeId || null,
    allowedNextActions: Array.isArray(d.allowedNextActions) ? d.allowedNextActions : [],
    occurrenceSource: 'client_telemetry',
    metadata: {
      clientIp,
      userAgent,
      sessionId,
      admissionId,
      generation,
      code,
      errorName: d.name || null,
      errorMessage: d.message || null,
      readyState,
      networkState,
      currentTime,
      bufferAheadSec,
      videoWidth,
      videoHeight,
      mediaFacts: mediaFacts || null
    }
  };
}
