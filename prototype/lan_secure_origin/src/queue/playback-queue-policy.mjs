/**
 * Pure Playback Queue Policy Engine
 * Ticket 34.1 / Issue #35
 *
 * Implements deterministic queue building, qualification filtering,
 * favorites ordering, disjoint balanced recommendation, in-session freezing,
 * and consecutive failure circuit breaking.
 *
 * PURE FUNCTION INVARIANTS:
 * - No filesystem or network I/O
 * - No wall clock (Date.now()) or non-deterministic RNG (Math.random())
 * - Input items and sessions are treated as immutable (frozen)
 */

export const HISTORY_STATUS = Object.freeze({
  CONFIRMED_ZERO: 'CONFIRMED_ZERO',
  UNKNOWN: 'UNKNOWN',
  PLAYED: 'PLAYED'
});

export const IDENTITY_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  UNRESOLVED: 'UNRESOLVED'
});

export const QUEUE_MODE = Object.freeze({
  BALANCED: 'BALANCED',
  FAVORITES: 'FAVORITES',
  UNWATCHED_FIRST: 'UNWATCHED_FIRST',
  LOW_FREQUENCY_FIRST: 'LOW_FREQUENCY_FIRST',
  LONG_UNWATCHED_FIRST: 'LONG_UNWATCHED_FIRST',
  DEFAULT: 'DEFAULT'
});

export const QUEUE_NAVIGATION_STATUS = Object.freeze({
  ADVANCED: 'ADVANCED',
  CIRCUIT_BREAKER_TRIPPED: 'CIRCUIT_BREAKER_TRIPPED',
  QUEUE_END: 'QUEUE_END'
});

export class PlaybackQueueConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PlaybackQueueConflictError';
    this.details = details;
  }
}

/**
 * Deterministic PRNG (Mulberry32) for reproducible balanced recommendations.
 */
function createDeterministicRandom(seed = 0) {
  let s = Math.trunc(seed) >>> 0;
  return function nextFloat() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bounded deterministic Fisher-Yates shuffle using seeded PRNG.
 */
function deterministicShuffle(array, prng) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

/**
 * Deterministic string hash for session ID derivation when not explicitly passed.
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16);
}

/**
 * Deduplicate raw snapshot items across roots with complete conflict detection.
 */
function deduplicateAndValidateSnapshot(items, options = {}) {
  const onConflict = options.onConflict || 'throw'; // 'throw' | 'exclude'
  const grouped = new Map();
  const conflictedIds = new Set();

  for (const item of items) {
    if (!item || typeof item.assetId !== 'string' || item.assetId.trim() === '') {
      throw new Error('Invalid snapshot item: missing or invalid assetId');
    }
    const assetId = item.assetId;
    if (!grouped.has(assetId)) {
      grouped.set(assetId, []);
    }
    grouped.get(assetId).push(item);
  }

  const deduplicated = [];

  for (const [assetId, observations] of grouped.entries()) {
    if (observations.length === 1) {
      deduplicated.push(observations[0]);
      continue;
    }

    // Check for conflicting metadata across multi-root observations
    const base = observations[0];
    let hasConflict = false;
    let conflictDetails = null;

    for (let i = 1; i < observations.length; i++) {
      const current = observations[i];
      if (
        current.historyStatus !== base.historyStatus ||
        current.effectivePlayCount !== base.effectivePlayCount ||
        current.totalWatchSeconds !== base.totalWatchSeconds ||
        current.lastPlayedAt !== base.lastPlayedAt ||
        current.isFavorite !== base.isFavorite ||
        current.isDisliked !== base.isDisliked ||
        current.identityStatus !== base.identityStatus ||
        current.logicalMediaKey !== base.logicalMediaKey ||
        current.fileSize !== base.fileSize ||
        current.durationSeconds !== base.durationSeconds
      ) {
        hasConflict = true;
        conflictDetails = {
          assetId,
          baseObservation: base,
          conflictingObservation: current
        };
        break;
      }
    }

    if (hasConflict) {
      if (onConflict === 'throw') {
        throw new PlaybackQueueConflictError(
          `Conflicting metadata observations for assetId: ${assetId}`,
          conflictDetails
        );
      } else {
        conflictedIds.add(assetId);
        continue; // exclude ambiguous input
      }
    }

    // Select representative observation:
    // Prefer accessible observations; break ties deterministically independent of input order.
    const accessibleObs = observations.filter(obs => obs.accessible === true);
    let representative;

    if (accessibleObs.length > 0) {
      accessibleObs.sort((a, b) => a.rootId.localeCompare(b.rootId) || a.filePath.localeCompare(b.filePath));
      representative = accessibleObs[0];
    } else {
      const sortedOffline = observations.slice().sort(
        (a, b) => a.rootId.localeCompare(b.rootId) || a.filePath.localeCompare(b.filePath)
      );
      representative = sortedOffline[0];
    }

    const merged = { ...representative };
    merged.accessible = accessibleObs.length > 0;
    deduplicated.push(merged);
  }

  return { deduplicated, conflictedIds: Array.from(conflictedIds) };
}

/**
 * Assign an item to exactly one cohort for balanced recommendation.
 */
function assignBalancedCohort(item) {
  if (item.isFavorite) {
    return 'C_FAVORITE';
  }
  if (item.historyStatus === HISTORY_STATUS.CONFIRMED_ZERO) {
    return 'C_CONFIRMED_ZERO';
  }
  if (item.historyStatus === HISTORY_STATUS.PLAYED && item.effectivePlayCount <= 2) {
    return 'C_LOW_FREQUENCY';
  }
  if (item.historyStatus === HISTORY_STATUS.UNKNOWN) {
    return 'C_UNKNOWN_DISCOVERY';
  }
  return 'C_OTHER_PLAYED';
}

/**
 * Build balanced queue using deterministic single-assignment interleaving with seed variance.
 */
function buildBalancedQueue(candidates, seed = 0) {
  const cohorts = {
    C_CONFIRMED_ZERO: [],
    C_LOW_FREQUENCY: [],
    C_UNKNOWN_DISCOVERY: [],
    C_FAVORITE: [],
    C_OTHER_PLAYED: []
  };

  for (const item of candidates) {
    const cohortKey = assignBalancedCohort(item);
    cohorts[cohortKey].push(item);
  }

  // Stable secondary sorting within each cohort by assetId first
  for (const key of Object.keys(cohorts)) {
    cohorts[key].sort((a, b) => a.assetId.localeCompare(b.assetId));
  }

  const prng = createDeterministicRandom(seed);

  // Apply deterministic seed-driven shuffling to cohorts with multiple candidates
  for (const key of Object.keys(cohorts)) {
    if (cohorts[key].length > 1) {
      cohorts[key] = deterministicShuffle(cohorts[key], prng);
    }
  }

  // Interleave cohorts deterministically
  const cohortOrder = [
    'C_CONFIRMED_ZERO',
    'C_LOW_FREQUENCY',
    'C_UNKNOWN_DISCOVERY',
    'C_FAVORITE',
    'C_OTHER_PLAYED'
  ];

  const result = [];
  const visited = new Set();

  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const key of cohortOrder) {
      const list = cohorts[key];
      if (list.length > 0) {
        remaining = true;
        const item = list.shift();
        if (!visited.has(item.assetId)) {
          visited.add(item.assetId);
          result.push(item);
        }
      }
    }
  }

  return result;
}

/**
 * Build favorites queue sorted primarily by confirmed effective play count ASC.
 */
function buildFavoritesQueue(candidates) {
  const favorites = candidates.filter(item => item.isFavorite === true);

  return favorites.sort((a, b) => {
    // Both confirmed zero
    const aIsZero = a.historyStatus === HISTORY_STATUS.CONFIRMED_ZERO;
    const bIsZero = b.historyStatus === HISTORY_STATUS.CONFIRMED_ZERO;
    if (aIsZero && !bIsZero) return -1;
    if (!aIsZero && bIsZero) return 1;
    if (aIsZero && bIsZero) return a.assetId.localeCompare(b.assetId);

    // Both played with confirmed counts
    const aPlayed = a.historyStatus === HISTORY_STATUS.PLAYED;
    const bPlayed = b.historyStatus === HISTORY_STATUS.PLAYED;

    if (aPlayed && bPlayed) {
      if (a.effectivePlayCount !== b.effectivePlayCount) {
        return a.effectivePlayCount - b.effectivePlayCount;
      }
      return a.assetId.localeCompare(b.assetId);
    }

    if (aPlayed && !bPlayed) return -1; // played counts come before UNKNOWN
    if (!aPlayed && bPlayed) return 1;

    // Both UNKNOWN: cannot claim 0, tie-break deterministically
    return a.assetId.localeCompare(b.assetId);
  });
}

/**
 * Pure Function: Build Playback Queue from synthetic catalog snapshot.
 * Default queue mode is Owner-approved BALANCED.
 */
export function buildPlaybackQueue(snapshotItems, options = {}) {
  if (!Array.isArray(snapshotItems)) {
    throw new TypeError('snapshotItems must be an array');
  }

  const validModes = new Set(Object.values(QUEUE_MODE));
  const mode = options.mode !== undefined ? options.mode : QUEUE_MODE.BALANCED;
  if (!validModes.has(mode)) {
    throw new Error(`Invalid queue mode: ${mode}`);
  }

  const seed = typeof options.seed === 'number' ? options.seed : 0;
  const maxItems = typeof options.maxItems === 'number' ? options.maxItems : null;

  // Deduplicate and validate observations across roots
  const { deduplicated, conflictedIds } = deduplicateAndValidateSnapshot(snapshotItems, options);

  // Qualification filtering:
  // Disliked items and inaccessible items are excluded from automated queues
  const eligibleCandidates = deduplicated.filter(item => {
    if (item.accessible !== true) return false;
    if (item.isDisliked === true) return false;
    return true;
  });

  let orderedItems = [];

  switch (mode) {
    case QUEUE_MODE.FAVORITES:
      orderedItems = buildFavoritesQueue(eligibleCandidates);
      break;

    case QUEUE_MODE.BALANCED:
      orderedItems = buildBalancedQueue(eligibleCandidates, seed);
      break;

    case QUEUE_MODE.UNWATCHED_FIRST:
      orderedItems = eligibleCandidates.slice().sort((a, b) => {
        const aZero = a.historyStatus === HISTORY_STATUS.CONFIRMED_ZERO;
        const bZero = b.historyStatus === HISTORY_STATUS.CONFIRMED_ZERO;
        if (aZero && !bZero) return -1;
        if (!aZero && bZero) return 1;

        const aUnk = a.historyStatus === HISTORY_STATUS.UNKNOWN;
        const bUnk = b.historyStatus === HISTORY_STATUS.UNKNOWN;
        if (aUnk && !bUnk) return -1;
        if (!aUnk && bUnk) return 1;

        if (a.effectivePlayCount !== b.effectivePlayCount) {
          return (a.effectivePlayCount || 0) - (b.effectivePlayCount || 0);
        }
        return a.assetId.localeCompare(b.assetId);
      });
      break;

    case QUEUE_MODE.LOW_FREQUENCY_FIRST:
      orderedItems = eligibleCandidates.slice().sort((a, b) => {
        const aCount = a.historyStatus === HISTORY_STATUS.CONFIRMED_ZERO ? 0 : (a.effectivePlayCount || 9999);
        const bCount = b.historyStatus === HISTORY_STATUS.CONFIRMED_ZERO ? 0 : (b.effectivePlayCount || 9999);
        if (aCount !== bCount) return aCount - bCount;
        return a.assetId.localeCompare(b.assetId);
      });
      break;

    case QUEUE_MODE.LONG_UNWATCHED_FIRST:
      orderedItems = eligibleCandidates.slice().sort((a, b) => {
        const aHasTime = typeof a.lastPlayedAt === 'number' && Number.isFinite(a.lastPlayedAt);
        const bHasTime = typeof b.lastPlayedAt === 'number' && Number.isFinite(b.lastPlayedAt);

        if (aHasTime && bHasTime) {
          if (a.lastPlayedAt !== b.lastPlayedAt) {
            return a.lastPlayedAt - b.lastPlayedAt; // Oldest known played first
          }
          return a.assetId.localeCompare(b.assetId);
        }

        // Genuinely played items with known timestamps precede unknown chronology
        if (aHasTime && !bHasTime) return -1;
        if (!aHasTime && bHasTime) return 1;

        // Both lack known timestamp: tie-break deterministically without masquerading as ancient
        return a.assetId.localeCompare(b.assetId);
      });
      break;

    case QUEUE_MODE.DEFAULT:
      orderedItems = eligibleCandidates.slice().sort((a, b) => a.assetId.localeCompare(b.assetId));
      break;
  }

  if (maxItems !== null && maxItems >= 0) {
    orderedItems = orderedItems.slice(0, maxItems);
  }

  // Derive deterministic sessionId if not injected
  const sessionId = options.sessionId ||
    `session-${mode.toLowerCase()}-${hashString(orderedItems.map(i => i.assetId).join(':') + `:${seed}`)}`;

  // Return deeply frozen immutable PlaybackQueueSession
  return Object.freeze({
    sessionId,
    mode,
    seed,
    frozenItems: Object.freeze(orderedItems.map(item => Object.freeze({ ...item }))),
    currentIndex: orderedItems.length > 0 ? 0 : -1,
    consecutiveFailures: 0,
    diagnostics: Object.freeze({
      conflictedAssetIds: Object.freeze([...conflictedIds]),
      totalEligible: eligibleCandidates.length,
      totalQueued: orderedItems.length
    })
  });
}

/**
 * Pure Function: Resolve Next item in playback queue with failure circuit breaking.
 */
export function resolveNextQueueItem(session, outcome = 'SUCCESS') {
  if (!session || typeof session !== 'object') {
    throw new TypeError('session must be a valid PlaybackQueueSession object');
  }

  // If circuit breaker is already tripped, session remains stopped
  if (session.consecutiveFailures > 3) {
    return {
      session,
      item: null,
      status: QUEUE_NAVIGATION_STATUS.CIRCUIT_BREAKER_TRIPPED
    };
  }

  const items = session.frozenItems;
  if (!items || items.length === 0 || session.currentIndex < 0) {
    return {
      session,
      item: null,
      status: QUEUE_NAVIGATION_STATUS.QUEUE_END
    };
  }

  if (outcome === 'SUCCESS') {
    const nextIndex = session.currentIndex + 1;
    if (nextIndex >= items.length) {
      const newSession = Object.freeze({
        ...session,
        currentIndex: items.length,
        consecutiveFailures: 0
      });
      return {
        session: newSession,
        item: null,
        status: QUEUE_NAVIGATION_STATUS.QUEUE_END
      };
    }

    const newSession = Object.freeze({
      ...session,
      currentIndex: nextIndex,
      consecutiveFailures: 0
    });
    return {
      session: newSession,
      item: items[nextIndex],
      status: QUEUE_NAVIGATION_STATUS.ADVANCED
    };
  }

  if (outcome === 'FAILURE') {
    const consecutiveFailures = session.consecutiveFailures + 1;

    // Failure guard: up to 3 consecutive failures advance; 4th consecutive failure trips circuit breaker
    if (consecutiveFailures > 3) {
      const newSession = Object.freeze({
        ...session,
        consecutiveFailures
      });
      return {
        session: newSession,
        item: null,
        status: QUEUE_NAVIGATION_STATUS.CIRCUIT_BREAKER_TRIPPED
      };
    }

    const nextIndex = session.currentIndex + 1;
    if (nextIndex >= items.length) {
      const newSession = Object.freeze({
        ...session,
        currentIndex: items.length,
        consecutiveFailures
      });
      return {
        session: newSession,
        item: null,
        status: QUEUE_NAVIGATION_STATUS.QUEUE_END
      };
    }

    const newSession = Object.freeze({
      ...session,
      currentIndex: nextIndex,
      consecutiveFailures
    });
    return {
      session: newSession,
      item: items[nextIndex],
      status: QUEUE_NAVIGATION_STATUS.ADVANCED
    };
  }

  throw new Error(`Invalid outcome: ${outcome}. Expected 'SUCCESS' or 'FAILURE'`);
}

/**
 * Pure Function: Resolve Previous item in playback queue.
 */
export function resolvePreviousQueueItem(session) {
  if (!session || typeof session !== 'object') {
    throw new TypeError('session must be a valid PlaybackQueueSession object');
  }

  // If circuit breaker is already tripped, session remains stopped
  if (session.consecutiveFailures > 3) {
    return {
      session,
      item: null,
      status: QUEUE_NAVIGATION_STATUS.CIRCUIT_BREAKER_TRIPPED
    };
  }

  const items = session.frozenItems;
  // Empty queue reports QUEUE_END
  if (!items || items.length === 0 || session.currentIndex < 0) {
    return {
      session,
      item: null,
      status: QUEUE_NAVIGATION_STATUS.QUEUE_END
    };
  }

  if (session.currentIndex <= 0) {
    return {
      session,
      item: items[0],
      status: QUEUE_NAVIGATION_STATUS.ADVANCED
    };
  }

  const prevIndex = Math.max(0, session.currentIndex - 1);
  const newSession = Object.freeze({
    ...session,
    currentIndex: prevIndex,
    consecutiveFailures: 0
  });

  return {
    session: newSession,
    item: items[prevIndex],
    status: QUEUE_NAVIGATION_STATUS.ADVANCED
  };
}
