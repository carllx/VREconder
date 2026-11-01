/**
 * Catalog Snapshot Provider & Multi-Root Transformation Adapter
 * Ticket 34.2 / Issue #36
 *
 * Implements:
 * 1. Flattened multi-root observations mapping to ReadonlyArray<MediaSnapshotItem> for Issue #35
 * 2. Fail-closed identity conflict quarantine (quarantinedItems)
 * 3. Root availability injection & offline root resilience (accessible: false without deletion)
 * 4. Safe scoped path sanitization and host secret/token redaction
 * 5. Strict epoch millisecond timestamp normalization (number | null)
 * 6. Scene-level count vs verified per-asset history separation (unknown history保真)
 * 7. Version-specific Stash reader contract marked as HOLD pending schema evidence
 */

export const ADAPTER_STATUS = Object.freeze({
  READY: 'READY',
  HOLD_PENDING_SCHEMA_EVIDENCE: 'HOLD_PENDING_SCHEMA_EVIDENCE'
});

export const QUARANTINE_REASON = Object.freeze({
  METADATA_CONFLICT: 'METADATA_CONFLICT',
  INVALID_ATTRIBUTES: 'INVALID_ATTRIBUTES',
  PATH_TRAVERSAL_RISK: 'PATH_TRAVERSAL_RISK',
  AMBIGUOUS_IDENTITY: 'AMBIGUOUS_IDENTITY'
});

export const HISTORY_STATUS = Object.freeze({
  CONFIRMED_ZERO: 'CONFIRMED_ZERO',
  UNKNOWN: 'UNKNOWN',
  PLAYED: 'PLAYED'
});

export const IDENTITY_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  UNRESOLVED: 'UNRESOLVED'
});

/**
 * Normalize timestamp to finite epoch milliseconds (number | null).
 * Strings are parsed via Date.parse; invalid or missing values return null.
 */
export function normalizeTimestamp(val) {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val === 'number') {
    return (Number.isFinite(val) && val >= 0) ? Math.trunc(val) : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return null;
    const parsed = Date.parse(trimmed);
    return (Number.isFinite(parsed) && parsed >= 0) ? Math.trunc(parsed) : null;
  }
  return null;
}

/**
 * Sanitize file path: strip private host absolute roots, prevent traversal,
 * normalize separators to forward slashes, and produce a safe scoped path.
 */
export function sanitizeScopedPath(rawPath, rootBasePath = '') {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { scopedPath: null, error: 'EMPTY_PATH' };
  }

  let normalized = rawPath.replace(/\\/g, '/').trim();
  let normalizedBase = (typeof rootBasePath === 'string') ? rootBasePath.replace(/\\/g, '/').trim() : '';

  // Redact URL tokens / passwords if embedded
  if (normalized.includes('?')) {
    normalized = normalized.split('?')[0];
  }

  // If path starts with rootBasePath, strip it
  if (normalizedBase && normalized.toLowerCase().startsWith(normalizedBase.toLowerCase())) {
    normalized = normalized.slice(normalizedBase.length);
  }

  // Remove leading slashes or drive letters (e.g. C:/)
  normalized = normalized.replace(/^[a-zA-Z]:/, '');
  normalized = normalized.replace(/^\/+/, '');

  // Prevent directory traversal attacks
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some(seg => seg === '..')) {
    return { scopedPath: null, error: QUARANTINE_REASON.PATH_TRAVERSAL_RISK };
  }

  const safePath = segments.join('/');
  if (!safePath) {
    return { scopedPath: null, error: 'EMPTY_PATH' };
  }

  return { scopedPath: safePath, error: null };
}

/**
 * Validate and group raw catalog records into flattened MediaSnapshotItems or quarantined records.
 */
export function transformCatalogRecords(records, rootAvailability = {}, options = {}) {
  const requireVerifiedAssetHistory = options.requireVerifiedAssetHistory === true;
  const items = [];
  const quarantinedItems = [];

  if (!Array.isArray(records)) {
    return {
      items: Object.freeze([]),
      quarantinedItems: Object.freeze([]),
      metrics: { totalInputRecords: 0, emittedItems: 0, quarantinedCount: 0, offlineCount: 0 }
    };
  }

  // Group raw observations by assetId
  const candidateGroups = new Map();

  for (let idx = 0; idx < records.length; idx++) {
    const raw = records[idx];
    if (!raw || typeof raw !== 'object') {
      quarantinedItems.push({
        assetId: `invalid-record-${idx}`,
        reason: QUARANTINE_REASON.INVALID_ATTRIBUTES,
        details: 'Record is null or not an object',
        candidateCount: 1
      });
      continue;
    }

    const assetId = typeof raw.assetId === 'string' ? raw.assetId.trim() : '';
    if (!assetId) {
      quarantinedItems.push({
        assetId: `missing-asset-id-${idx}`,
        reason: QUARANTINE_REASON.AMBIGUOUS_IDENTITY,
        details: 'Missing or empty assetId',
        candidateCount: 1
      });
      continue;
    }

    const rootId = typeof raw.rootId === 'string' ? raw.rootId.trim() : 'default_root';
    const rootInfo = rootAvailability[rootId] || null;
    const rootBasePath = rootInfo && typeof rootInfo.basePath === 'string' ? rootInfo.basePath : '';

    const pathResult = sanitizeScopedPath(raw.filePath || raw.path || '', rootBasePath);
    if (pathResult.error) {
      quarantinedItems.push({
        assetId,
        reason: pathResult.error === QUARANTINE_REASON.PATH_TRAVERSAL_RISK
          ? QUARANTINE_REASON.PATH_TRAVERSAL_RISK
          : QUARANTINE_REASON.INVALID_ATTRIBUTES,
        details: `Path sanitization failed: ${pathResult.error}`,
        candidateCount: 1
      });
      continue;
    }

    // Determine accessibility from rootAvailability (default false if root offline or unlisted)
    let accessible = false;
    if (rootInfo && rootInfo.accessible === true) {
      accessible = raw.accessible !== false;
    }

    // Validate physical metrics
    const fileSize = typeof raw.fileSize === 'number' && Number.isFinite(raw.fileSize) && raw.fileSize >= 0
      ? raw.fileSize
      : null;
    const durationSeconds = typeof raw.durationSeconds === 'number' && Number.isFinite(raw.durationSeconds) && raw.durationSeconds >= 0
      ? raw.durationSeconds
      : null;

    if (fileSize === null || durationSeconds === null) {
      quarantinedItems.push({
        assetId,
        reason: QUARANTINE_REASON.INVALID_ATTRIBUTES,
        details: 'Missing or negative fileSize / durationSeconds',
        candidateCount: 1
      });
      continue;
    }

    // History and count attribution:
    // Scene-level counts != verified per-file history. Unless explicitly marked as verified asset history,
    // default to UNKNOWN with 0 effectivePlayCount.
    let historyStatus = HISTORY_STATUS.UNKNOWN;
    let effectivePlayCount = 0;
    let totalWatchSeconds = 0;
    let lastPlayedAt = normalizeTimestamp(raw.lastPlayedAt);

    if (raw.hasVerifiedAssetHistory === true) {
      if (raw.historyStatus === HISTORY_STATUS.CONFIRMED_ZERO) {
        historyStatus = HISTORY_STATUS.CONFIRMED_ZERO;
        effectivePlayCount = 0;
      } else if (raw.historyStatus === HISTORY_STATUS.PLAYED) {
        historyStatus = HISTORY_STATUS.PLAYED;
        effectivePlayCount = typeof raw.effectivePlayCount === 'number' && raw.effectivePlayCount >= 0
          ? Math.trunc(raw.effectivePlayCount)
          : 0;
        totalWatchSeconds = typeof raw.totalWatchSeconds === 'number' && raw.totalWatchSeconds >= 0
          ? Math.trunc(raw.totalWatchSeconds)
          : 0;
      } else {
        historyStatus = HISTORY_STATUS.UNKNOWN;
      }
    } else if (requireVerifiedAssetHistory) {
      historyStatus = HISTORY_STATUS.UNKNOWN;
      effectivePlayCount = 0;
    }

    const observation = {
      assetId,
      rootId,
      filePath: pathResult.scopedPath,
      accessible,
      identityStatus: raw.identityStatus === IDENTITY_STATUS.UNRESOLVED
        ? IDENTITY_STATUS.UNRESOLVED
        : IDENTITY_STATUS.RESOLVED,
      logicalMediaKey: typeof raw.logicalMediaKey === 'string' ? raw.logicalMediaKey.trim() : null,
      historyStatus,
      effectivePlayCount,
      totalWatchSeconds,
      lastPlayedAt,
      isFavorite: raw.isFavorite === true,
      isDisliked: raw.isDisliked === true,
      fileSize,
      durationSeconds
    };

    if (!candidateGroups.has(assetId)) {
      candidateGroups.set(assetId, []);
    }
    candidateGroups.get(assetId).push(observation);
  }

  let offlineCount = 0;

  // Process grouped observations for conflict detection
  for (const [assetId, observations] of candidateGroups.entries()) {
    if (observations.length === 1) {
      const obs = observations[0];
      if (!obs.accessible) offlineCount++;
      items.push(obs);
      continue;
    }

    // Check for physical metadata conflicts among multi-root observations of the same assetId
    const base = observations[0];
    const conflictFields = [];

    for (let i = 1; i < observations.length; i++) {
      const curr = observations[i];
      if (curr.fileSize !== base.fileSize && !conflictFields.includes('fileSize')) {
        conflictFields.push('fileSize');
      }
      if (curr.durationSeconds !== base.durationSeconds && !conflictFields.includes('durationSeconds')) {
        conflictFields.push('durationSeconds');
      }
      if (curr.logicalMediaKey !== base.logicalMediaKey && !conflictFields.includes('logicalMediaKey')) {
        conflictFields.push('logicalMediaKey');
      }
      if (curr.identityStatus !== base.identityStatus && !conflictFields.includes('identityStatus')) {
        conflictFields.push('identityStatus');
      }
    }

    if (conflictFields.length > 0) {
      // Conflicting observations must fail closed and be quarantined completely
      quarantinedItems.push({
        assetId,
        reason: QUARANTINE_REASON.METADATA_CONFLICT,
        conflictFields,
        candidateCount: observations.length,
        details: `Physical metadata conflict on fields: ${conflictFields.join(', ')}`,
        sanitizedObservations: observations.map(o => ({
          rootId: o.rootId,
          filePath: o.filePath,
          fileSize: o.fileSize,
          durationSeconds: o.durationSeconds
        }))
      });
      continue; // Exclude from items array!
    }

    // All observations are consistent: emit each observation as a flat record
    for (const obs of observations) {
      if (!obs.accessible) offlineCount++;
      items.push(obs);
    }
  }

  return {
    items: Object.freeze(items),
    quarantinedItems: Object.freeze(quarantinedItems),
    metrics: {
      totalInputRecords: records.length,
      emittedItems: items.length,
      quarantinedCount: quarantinedItems.length,
      offlineCount
    }
  };
}

/**
 * Synthetic Catalog Snapshot Provider for unit tests and reproducible transformations.
 */
export function createSyntheticCatalogSnapshotProvider(fixtures = {}) {
  const storedRecords = Array.isArray(fixtures.records) ? fixtures.records.slice() : [];

  return {
    status: ADAPTER_STATUS.READY,
    getSnapshot(rootAvailability = {}, options = {}) {
      return transformCatalogRecords(storedRecords, rootAvailability, options);
    }
  };
}

/**
 * Stash GraphQL Reader Contract.
 * Marked as HOLD_PENDING_SCHEMA_EVIDENCE per Browser review until exact pinned schema is proven.
 */
export function createStashGraphQLReader(config = {}) {
  return {
    status: ADAPTER_STATUS.HOLD_PENDING_SCHEMA_EVIDENCE,
    reason: 'Stash version-specific GraphQL reader is on HOLD per Browser review until exact pinned Stash schema evidence from #32 is established.',
    fetchSnapshot: async () => {
      throw new Error('STASH_SCHEMA_READER_ON_HOLD: Version-specific reader is held pending pinned schema evidence.');
    }
  };
}
