/**
 * Runtime Observatory Incident Clustering & Correlation Module (Issue #28)
 * 
 * Implements:
 * - Correlating paired server admission denial + client policy block events
 * - Clustering repeated incidents by stable signatures
 * - Separating OBSERVATION, HYPOTHESIS, VERIFIED_CAUSE, and KNOWN_POLICY
 * - Preserving raw JSONL evidence and tracking occurrence counts + first/last seen
 */

export const IncidentStatus = {
  KNOWN_POLICY: 'KNOWN_POLICY',
  VERIFIED_CAUSE: 'VERIFIED_CAUSE',
  HYPOTHESIS: 'HYPOTHESIS',
  OBSERVATION: 'OBSERVATION'
};

/**
 * Sanitizes reason strings to remove absolute paths and filenames for safe triage reporting.
 */
export function sanitizeReason(reason) {
  if (!reason || typeof reason !== 'string') return '';
  let sanitized = reason.replace(/[a-zA-Z]:\\[^ \n\r\t,"]+/g, '[path]');
  sanitized = sanitized.replace(/\/[^ \n\r\t,"]+\.(mp4|m4v|mkv|mov|webm)/gi, '[path]');
  return sanitized;
}

/**
 * Maps an incident to its target GitHub issue and topic.
 */
export function routeIncident(incident) {
  const c = incident.classification || '';
  const r = incident.reason || '';
  const e = incident.eventType || '';

  // Actual runtime playback failures -> Issue #23
  if (
    c === 'MEDIA_ERR_SRC_NOT_SUPPORTED' ||
    c === 'MEDIA_ERR_DECODE' ||
    c === 'MEDIA_ERR_NETWORK' ||
    c === 'MEDIA_ERR_ABORTED' ||
    r.includes('MEDIA_ERR_SRC_NOT_SUPPORTED') ||
    e === 'MEDIA_PLAYBACK_ERROR'
  ) {
    return { targetIssue: 23, topic: 'Runtime Playback Recovery' };
  }

  // Media-health / compatibility findings -> Issue #21
  if (
    c === 'NORMALIZATION_CANDIDATE_CERTIFIED' ||
    c === 'EXACT_CERTIFIED_NORMALIZATION_CANDIDATE' ||
    c === 'EXPERIMENT_DERIVATIVE' ||
    c === 'NEEDS_BUCKET_CERTIFICATION' ||
    c === 'NEEDS_DEVICE_PROBE' ||
    c === 'UNSUPPORTED_UNKNOWN_FIX' ||
    c === 'UNREADABLE_MEDIA' ||
    c === 'INVALID_MEDIA' ||
    e === 'PLAYBACK_ADMISSION_DENIED'
  ) {
    return { targetIssue: 21, topic: 'Media Normalization / Policy Compatibility' };
  }

  // Incident pipeline lifecycle / unclassified defects -> Issue #24
  return { targetIssue: 24, topic: 'Runtime Incident Triage' };
}

/**
 * Determines rigorous evidence discipline status:
 * - KNOWN_POLICY: intentional compatibility policy rule or known exclusion
 * - VERIFIED_CAUSE: empirically proven by certified device evidence or verified envelope
 * - HYPOTHESIS: unverified device/compatibility hypothesis requiring targeted follow-up
 * - OBSERVATION: raw runtime observation without causal verification
 */
export function determineIncidentStatus(incident) {
  const c = incident.classification || '';
  const r = incident.reason || '';
  const e = incident.eventType || '';

  // 1. Verified causes: explicitly verified via exact certified physical repair envelope
  if (
    c === 'EXACT_CERTIFIED_NORMALIZATION_CANDIDATE' ||
    (c === 'NORMALIZATION_CANDIDATE_CERTIFIED' && incident.matchedEnvelopeId)
  ) {
    return IncidentStatus.VERIFIED_CAUSE;
  }

  // 2. Known policy blocks: preflight gate exclusions or known codec/container rules
  if (
    e === 'PLAYBACK_ADMISSION_DENIED' ||
    e === 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY' ||
    c === 'EXPERIMENT_DERIVATIVE' ||
    c === 'UNREADABLE_MEDIA' ||
    c === 'INVALID_MEDIA' ||
    c === 'NORMALIZATION_CANDIDATE_CERTIFIED' ||
    r.includes('has no verified playback or streamcopy repair rule') ||
    r.includes('Matches derivative')
  ) {
    return IncidentStatus.KNOWN_POLICY;
  }

  // 3. Hypothesis / targeted follow-up required:
  // E.g. Safari MEDIA_ERR_SRC_NOT_SUPPORTED on High@L6.0 (BIKMVR039), needs device probe, untested topology
  if (
    c === 'MEDIA_ERR_SRC_NOT_SUPPORTED' ||
    c === 'NEEDS_DEVICE_PROBE' ||
    c === 'NEEDS_BUCKET_CERTIFICATION' ||
    r.includes('Untested or complex stream topology') ||
    r.includes('MEDIA_ERR_SRC_NOT_SUPPORTED') ||
    (e === 'MEDIA_PLAYBACK_ERROR' && (incident.metadata?.code === 4 || incident.metadata?.errorName === 'MEDIA_ERR_SRC_NOT_SUPPORTED'))
  ) {
    return IncidentStatus.HYPOTHESIS;
  }

  // 4. Baseline observation
  return IncidentStatus.OBSERVATION;
}

/**
 * Extracts hypothesis note or targeted follow-up guidance when status is HYPOTHESIS.
 */
export function getHypothesisDetails(incident) {
  const name = incident.localMediaName || '';
  const r = incident.reason || '';
  const c = incident.classification || '';

  if (name.includes('BIKMVR039') || (r.includes('Level 6') && r.includes('High'))) {
    return 'Observed static facts: H.264 High@L6.0 4320x2160 ~59.94fps. Cause remains a hypothesis pending authoritative/device A/B evidence.';
  }
  if (c === 'NEEDS_DEVICE_PROBE' || r.includes('requires device probe')) {
    return 'Media topology or container variant requires controlled physical device probe before admission.';
  }
  if (r.includes('Untested or complex stream topology')) {
    return 'Non-standard stream topology (audio/video/data stream counts) requires isolation experiment.';
  }
  if (c === 'MEDIA_ERR_SRC_NOT_SUPPORTED' || incident.metadata?.code === 4) {
    return 'Browser media element returned Code 4; exact device/profile limit is an unverified hypothesis requiring follow-up.';
  }
  return null;
}

/**
 * Derives a stable clustering signature for an incident.
 */
export function getClusterSignature(incident) {
  const route = routeIncident(incident);
  const cleanReason = sanitizeReason(incident.reason);

  if (
    incident.eventType === 'PLAYBACK_ADMISSION_DENIED' ||
    incident.eventType === 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY'
  ) {
    // Policy admission blocks cluster by rule/classification across media
    return `POLICY_BLOCK::#${route.targetIssue}::${incident.classification}::${incident.matchedEnvelopeId || 'NONE'}::${cleanReason}`;
  }

  if (
    incident.eventType === 'MEDIA_PLAYBACK_ERROR' ||
    incident.classification === 'MEDIA_ERR_SRC_NOT_SUPPORTED' ||
    incident.classification === 'MEDIA_ERR_DECODE' ||
    incident.classification === 'MEDIA_ERR_NETWORK' ||
    incident.classification === 'MEDIA_ERR_ABORTED'
  ) {
    // Runtime playback errors cluster by media identity + error classification
    const mediaId = incident.fingerprintId || incident.localMediaName || 'unknown_media';
    return `PLAYBACK_ERROR::#${route.targetIssue}::${incident.classification}::${mediaId}`;
  }

  // Generic pipeline / storage incidents
  return `SYSTEM_EVENT::#${route.targetIssue}::${incident.classification}::${incident.matchedEnvelopeId || 'NONE'}::${cleanReason}`;
}

/**
 * Finds paired server admission and client policy events in a list of incidents.
 * Returns a map of incidentId -> paired incidentId.
 */
export function correlatePairedAdmissionEvents(incidents = []) {
  const pairMap = new Map();
  const serverDenials = [];
  const clientBlocks = [];

  for (const inc of incidents) {
    if (inc.eventType === 'PLAYBACK_ADMISSION_DENIED') {
      serverDenials.push(inc);
    } else if (inc.eventType === 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY') {
      clientBlocks.push(inc);
    }
  }

  // 1. Direct match by admissionId
  for (const s of serverDenials) {
    const admId = s.metadata?.admissionId;
    if (admId) {
      const match = clientBlocks.find(c => !pairMap.has(c.incidentId) && c.metadata?.admissionId === admId);
      if (match) {
        pairMap.set(s.incidentId, match.incidentId);
        pairMap.set(match.incidentId, s.incidentId);
      }
    }
  }

  // 2. Fallback heuristic: matching media name/fingerprint + classification + time proximity
  for (const s of serverDenials) {
    if (pairMap.has(s.incidentId)) continue;
    const sTime = new Date(s.timestamp).getTime();
    const match = clientBlocks.find(c => {
      if (pairMap.has(c.incidentId)) return false;
      if (s.classification !== c.classification) return false;
      const mediaMatches = (s.fingerprintId && c.fingerprintId && s.fingerprintId === c.fingerprintId) ||
                           (s.localMediaName && c.localMediaName && s.localMediaName === c.localMediaName);
      if (!mediaMatches) return false;
      const cTime = new Date(c.timestamp).getTime();
      return Math.abs(sTime - cTime) <= 60000; // within 60s
    });
    if (match) {
      pairMap.set(s.incidentId, match.incidentId);
      pairMap.set(match.incidentId, s.incidentId);
    }
  }

  return pairMap;
}

/**
 * Clusters a list of incidents into structured, correlated logical incident clusters.
 * 
 * @param {object[]} incidents - Raw incidents from JSONL store
 * @returns {{ clusters: object[], totalRawEvents: number, totalLogicalOccurrences: number }}
 */
export function clusterIncidents(incidents = []) {
  if (!Array.isArray(incidents) || incidents.length === 0) {
    return { clusters: [], totalRawEvents: 0, totalLogicalOccurrences: 0 };
  }

  const pairMap = correlatePairedAdmissionEvents(incidents);
  const clusterMap = new Map();
  const countedPairIds = new Set();
  let totalLogicalOccurrences = 0;

  for (const inc of incidents) {
    const signature = getClusterSignature(inc);
    const route = routeIncident(inc);
    const status = determineIncidentStatus(inc);
    const hypothesisDetails = getHypothesisDetails(inc);
    const cleanReason = sanitizeReason(inc.reason);

    if (!clusterMap.has(signature)) {
      clusterMap.set(signature, {
        signature,
        targetIssue: route.targetIssue,
        topic: route.topic,
        status,
        classification: inc.classification,
        matchedEnvelopeId: inc.matchedEnvelopeId || null,
        reason: cleanReason,
        hypothesisDetails,
        occurrenceCount: 0,
        rawEventCount: 0,
        pairedEventsCount: 0,
        firstSeen: inc.timestamp,
        lastSeen: inc.timestamp,
        affectedMedia: new Map(),
        rawIncidentIds: [],
        occurrenceSources: new Set(),
        allowedNextActions: new Set(inc.allowedNextActions || []),
        userAgents: new Set(),
        clientIps: new Set(),
        sampleMetadata: inc.metadata || {}
      });
    }

    const c = clusterMap.get(signature);
    c.rawEventCount++;
    c.rawIncidentIds.push(inc.incidentId);
    if (inc.occurrenceSource) c.occurrenceSources.add(inc.occurrenceSource);
    if (inc.metadata?.userAgent) c.userAgents.add(inc.metadata.userAgent);
    if (inc.metadata?.clientIp) c.clientIps.add(inc.metadata.clientIp);
    if (Array.isArray(inc.allowedNextActions)) {
      for (const act of inc.allowedNextActions) c.allowedNextActions.add(act);
    }

    // Time window update
    if (new Date(inc.timestamp) < new Date(c.firstSeen)) {
      c.firstSeen = inc.timestamp;
    }
    if (new Date(inc.timestamp) > new Date(c.lastSeen)) {
      c.lastSeen = inc.timestamp;
    }

    // Media tracking: correlate by fingerprint or canonical media name
    let foundMedia = null;
    for (const m of c.affectedMedia.values()) {
      if (inc.fingerprintId && m.fingerprintId && inc.fingerprintId === m.fingerprintId) {
        foundMedia = m;
        break;
      }
      if (inc.localMediaName && m.name && inc.localMediaName === m.name) {
        foundMedia = m;
        break;
      }
    }

    if (foundMedia) {
      if (!foundMedia.fingerprintId && inc.fingerprintId) {
        foundMedia.fingerprintId = inc.fingerprintId;
      }
      if (!foundMedia.mediaFacts && inc.metadata?.mediaFacts) {
        foundMedia.mediaFacts = inc.metadata.mediaFacts;
      }
    } else {
      const mediaKey = inc.fingerprintId || inc.localMediaName || `unknown_${c.affectedMedia.size}`;
      c.affectedMedia.set(mediaKey, {
        name: inc.localMediaName || '',
        path: inc.localMediaPath || '',
        fingerprintId: inc.fingerprintId || null,
        mediaFacts: inc.metadata?.mediaFacts || null
      });
    }

    // Logical occurrence counting: paired events count as 1 selection
    const partnerId = pairMap.get(inc.incidentId);
    if (partnerId) {
      if (!countedPairIds.has(partnerId)) {
        countedPairIds.add(inc.incidentId);
        c.occurrenceCount++;
        c.pairedEventsCount++;
        totalLogicalOccurrences++;
      }
    } else {
      c.occurrenceCount++;
      totalLogicalOccurrences++;
    }
  }

  const clusters = Array.from(clusterMap.values()).map(c => ({
    ...c,
    mediaCount: c.affectedMedia.size,
    affectedMedia: Array.from(c.affectedMedia.values()),
    occurrenceSources: Array.from(c.occurrenceSources),
    allowedNextActions: Array.from(c.allowedNextActions),
    userAgents: Array.from(c.userAgents),
    clientIps: Array.from(c.clientIps)
  }));

  return {
    clusters,
    totalRawEvents: incidents.length,
    totalLogicalOccurrences
  };
}
