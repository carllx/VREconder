/**
 * Catalog Snapshot Provider & Multi-Root Transformation Adapter
 * Ticket 34.2 / Issue #36
 *
 * Implements:
 * 1. Flattened multi-root observations mapping to ReadonlyArray<MediaSnapshotItem> for Issue #35
 * 2. Fail-closed identity and semantic conflict quarantine (quarantinedItems)
 * 3. Root availability injection & offline root resilience (accessible: false without deletion)
 * 4. Strict component-boundary path scoping, outside-root rejection & secret redaction
 * 5. Strict epoch millisecond timestamp normalization (number | null)
 * 6. Coherent fail-honest state: unknown history has null timestamp, RESOLVED requires valid key,
 *    PLAYED requires positive integer play count
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
  OUTSIDE_AUTHORIZED_ROOT: 'OUTSIDE_AUTHORIZED_ROOT',
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
 * Sanitize file path with component-boundary containment:
 * - Reject paths outside the authorized root, wrong drive, or UNC unless root matches
 * - Prevent traversal attacks (..)
 * - Strip query strings / tokens
 * - Produce safe relative scoped path
 */
export function sanitizeScopedPath(rawPath, rootBasePath = '') {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { scopedPath: null, error: 'EMPTY_PATH' };
  }

  let normalized = rawPath.replace(/\\/g, '/').trim();
  const normalizedBase = (typeof rootBasePath === 'string')
    ? rootBasePath.replace(/\\/g, '/').trim().replace(/\/+$/, '')
    : '';

  // Redact URL tokens / passwords if embedded
  if (normalized.includes('?')) {
    normalized = normalized.split('?')[0];
  }

  let subpath = '';

  // Determine if rawPath is an absolute path:
  // Windows drive (e.g. C:/), UNC path (//server/share or //...), or root-slash (/...)
  const isWindowsDrive = /^[a-zA-Z]:\//i.test(normalized);
  const isUncPath = /^\/\//.test(normalized);
  const isRootSlash = /^\/[^\/]/.test(normalized);
  const isAbsolute = isWindowsDrive || isUncPath || isRootSlash;

  if (isAbsolute) {
    if (!normalizedBase) {
      return { scopedPath: null, error: QUARANTINE_REASON.OUTSIDE_AUTHORIZED_ROOT };
    }

    const normLower = normalized.toLowerCase();
    const baseLower = normalizedBase.toLowerCase();

    // Must match rootBasePath with component boundary
    if (normLower.startsWith(baseLower + '/')) {
      subpath = normalized.slice(normalizedBase.length + 1);
    } else {
      // Prefix lookalike (e.g. G:/Media/VR2 vs G:/Media/VR), other drive (H:/...), or unmatching UNC
      return { scopedPath: null, error: QUARANTINE_REASON.OUTSIDE_AUTHORIZED_ROOT };
    }
  } else {
    // Relative path: must not start with drive letter or slash
    if (/^[a-zA-Z]:/i.test(normalized) || normalized.startsWith('/')) {
      return { scopedPath: null, error: QUARANTINE_REASON.OUTSIDE_AUTHORIZED_ROOT };
    }
    // Remove leading ./
    subpath = normalized.replace(/^\.\//, '');
  }

  // Prevent directory traversal attacks
  const segments = subpath.split('/').filter(Boolean);
  if (segments.length === 0) {
    return { scopedPath: null, error: 'EMPTY_PATH' };
  }
  if (segments.some(seg => seg === '..')) {
    return { scopedPath: null, error: QUARANTINE_REASON.PATH_TRAVERSAL_RISK };
  }

  return { scopedPath: segments.join('/'), error: null };
}

/**
 * Validate and group raw catalog records into flattened MediaSnapshotItems or quarantined records.
 */
export function transformCatalogRecords(records, rootAvailability = {}, options = {}) {
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
        reason: pathResult.error,
        details: 'Path failed sanitization and is outside authorized scope',
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
    // Scene-level counts != verified per-file history.
    // Unknown asset history MUST have lastPlayedAt = null.
    // PLAYED requires positive finite integer count (> 0); otherwise fall back to UNKNOWN.
    let historyStatus = HISTORY_STATUS.UNKNOWN;
    let effectivePlayCount = 0;
    let totalWatchSeconds = 0;
    let lastPlayedAt = null;

    if (raw.hasVerifiedAssetHistory === true) {
      if (raw.historyStatus === HISTORY_STATUS.CONFIRMED_ZERO) {
        historyStatus = HISTORY_STATUS.CONFIRMED_ZERO;
        effectivePlayCount = 0;
        totalWatchSeconds = 0;
        lastPlayedAt = null;
      } else if (raw.historyStatus === HISTORY_STATUS.PLAYED) {
        const count = (typeof raw.effectivePlayCount === 'number' && Number.isFinite(raw.effectivePlayCount))
          ? Math.trunc(raw.effectivePlayCount)
          : 0;
        if (count > 0) {
          historyStatus = HISTORY_STATUS.PLAYED;
          effectivePlayCount = count;
          totalWatchSeconds = (typeof raw.totalWatchSeconds === 'number' && Number.isFinite(raw.totalWatchSeconds) && raw.totalWatchSeconds >= 0)
            ? Math.trunc(raw.totalWatchSeconds)
            : 0;
          lastPlayedAt = normalizeTimestamp(raw.lastPlayedAt);
        } else {
          // Non-positive or invalid count for PLAYED: fall back to UNKNOWN with null lastPlayedAt
          historyStatus = HISTORY_STATUS.UNKNOWN;
          effectivePlayCount = 0;
          totalWatchSeconds = 0;
          lastPlayedAt = null;
        }
      } else {
        historyStatus = HISTORY_STATUS.UNKNOWN;
        effectivePlayCount = 0;
        totalWatchSeconds = 0;
        lastPlayedAt = null;
      }
    } else {
      // Unverified scene-level metrics do not populate per-file history
      historyStatus = HISTORY_STATUS.UNKNOWN;
      effectivePlayCount = 0;
      totalWatchSeconds = 0;
      lastPlayedAt = null;
    }

    // Identity status & Logical Media Key:
    // RESOLVED requires explicit valid identity key; otherwise UNRESOLVED with null logicalMediaKey.
    let identityStatus = IDENTITY_STATUS.UNRESOLVED;
    let logicalMediaKey = null;

    if (
      raw.identityStatus === IDENTITY_STATUS.RESOLVED &&
      typeof raw.logicalMediaKey === 'string' &&
      raw.logicalMediaKey.trim() !== ''
    ) {
      identityStatus = IDENTITY_STATUS.RESOLVED;
      logicalMediaKey = raw.logicalMediaKey.trim();
    } else {
      identityStatus = IDENTITY_STATUS.UNRESOLVED;
      logicalMediaKey = null;
    }

    const observation = {
      assetId,
      rootId,
      filePath: pathResult.scopedPath,
      accessible,
      identityStatus,
      logicalMediaKey,
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

  // Process grouped observations for conflict detection across ALL fields checked by Issue #35
  for (const [assetId, observations] of candidateGroups.entries()) {
    if (observations.length === 1) {
      const obs = observations[0];
      if (!obs.accessible) offlineCount++;
      items.push(obs);
      continue;
    }

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
      if (curr.historyStatus !== base.historyStatus && !conflictFields.includes('historyStatus')) {
        conflictFields.push('historyStatus');
      }
      if (curr.effectivePlayCount !== base.effectivePlayCount && !conflictFields.includes('effectivePlayCount')) {
        conflictFields.push('effectivePlayCount');
      }
      if (curr.totalWatchSeconds !== base.totalWatchSeconds && !conflictFields.includes('totalWatchSeconds')) {
        conflictFields.push('totalWatchSeconds');
      }
      if (curr.lastPlayedAt !== base.lastPlayedAt && !conflictFields.includes('lastPlayedAt')) {
        conflictFields.push('lastPlayedAt');
      }
      if (curr.isFavorite !== base.isFavorite && !conflictFields.includes('isFavorite')) {
        conflictFields.push('isFavorite');
      }
      if (curr.isDisliked !== base.isDisliked && !conflictFields.includes('isDisliked')) {
        conflictFields.push('isDisliked');
      }
    }

    if (conflictFields.length > 0) {
      // Conflicting observations must fail closed and be quarantined completely
      quarantinedItems.push({
        assetId,
        reason: QUARANTINE_REASON.METADATA_CONFLICT,
        conflictFields,
        candidateCount: observations.length,
        details: `Metadata conflict on fields: ${conflictFields.join(', ')}`,
        sanitizedObservations: observations.map(o => ({
          rootId: o.rootId,
          filePath: o.filePath,
          fileSize: o.fileSize,
          durationSeconds: o.durationSeconds,
          historyStatus: o.historyStatus,
          effectivePlayCount: o.effectivePlayCount,
          isFavorite: o.isFavorite,
          isDisliked: o.isDisliked
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
