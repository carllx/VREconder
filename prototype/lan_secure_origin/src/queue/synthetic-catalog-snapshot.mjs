/**
 * Synthetic Catalog Snapshot Fixtures
 * Ticket 34.1 / Issue #35
 *
 * Provides synthetic media snapshot data for pure in-memory queue testing.
 * Strictly decoupled from real user files, actual directories, or external databases.
 */

import { HISTORY_STATUS, IDENTITY_STATUS } from './playback-queue-policy.mjs';

/**
 * Factory function for creating synthetic media snapshot items.
 */
export function createSyntheticItem(overrides = {}) {
  const assetId = overrides.assetId || 'ast-default-001';
  return Object.freeze({
    assetId,
    rootId: overrides.rootId || 'root-primary',
    filePath: overrides.filePath || `synthetic/sample_${assetId}.mp4`,
    accessible: overrides.accessible !== undefined ? overrides.accessible : true,
    fileSize: overrides.fileSize || 1073741824, // 1 GB
    durationSeconds: overrides.durationSeconds !== undefined ? overrides.durationSeconds : 1200, // 20 mins
    identityStatus: overrides.identityStatus || IDENTITY_STATUS.RESOLVED,
    logicalMediaKey: overrides.identityStatus === IDENTITY_STATUS.UNRESOLVED
      ? null
      : (overrides.logicalMediaKey !== undefined ? overrides.logicalMediaKey : `log-${assetId}`),
    historyStatus: overrides.historyStatus || HISTORY_STATUS.CONFIRMED_ZERO,
    effectivePlayCount: overrides.historyStatus === HISTORY_STATUS.PLAYED
      ? (overrides.effectivePlayCount || 1)
      : 0,
    totalWatchSeconds: overrides.totalWatchSeconds || 0,
    lastPlayedAt: overrides.lastPlayedAt !== undefined ? overrides.lastPlayedAt : null,
    isFavorite: overrides.isFavorite === true,
    isDisliked: overrides.isDisliked === true
  });
}

/**
 * Fixture: Multi-root overlapping roots with identical physical assetId.
 * Used for Gate G1 (physical deduplication across roots).
 */
export const MULTI_ROOT_OVERLAPPING_FIXTURE = Object.freeze([
  createSyntheticItem({
    assetId: 'ast-shared-101',
    rootId: 'root-ssd',
    filePath: 'movies/feature_one.mp4',
    fileSize: 2147483648,
    durationSeconds: 3600,
    effectivePlayCount: 0,
    historyStatus: HISTORY_STATUS.CONFIRMED_ZERO
  }),
  createSyntheticItem({
    assetId: 'ast-shared-101', // Identical physical asset seen in nested backup root
    rootId: 'root-backup',
    filePath: 'backup/movies/feature_one.mp4',
    fileSize: 2147483648,
    durationSeconds: 3600,
    effectivePlayCount: 0,
    historyStatus: HISTORY_STATUS.CONFIRMED_ZERO
  }),
  createSyntheticItem({
    assetId: 'ast-distinct-102',
    rootId: 'root-ssd',
    filePath: 'movies/feature_two.mp4',
    fileSize: 1500000000,
    durationSeconds: 2400,
    effectivePlayCount: 0,
    historyStatus: HISTORY_STATUS.CONFIRMED_ZERO
  })
]);

/**
 * Fixture: Multi-root conflicting observations for identical assetId.
 * Used for Refinement 2 (conflict detection without silent overwrite).
 */
export const CROSS_ROOT_CONFLICTING_FIXTURE = Object.freeze([
  createSyntheticItem({
    assetId: 'ast-conflict-201',
    rootId: 'root-drive-d',
    filePath: 'vids/clip_a.mp4',
    isFavorite: false,
    historyStatus: HISTORY_STATUS.CONFIRMED_ZERO,
    effectivePlayCount: 0
  }),
  createSyntheticItem({
    assetId: 'ast-conflict-201', // Same assetId but conflicting preference and play count!
    rootId: 'root-drive-e',
    filePath: 'mirror/clip_a.mp4',
    isFavorite: true, // Conflict!
    historyStatus: HISTORY_STATUS.PLAYED, // Conflict!
    effectivePlayCount: 5
  })
]);

/**
 * Fixture: Multi-root observation with durationSeconds conflict.
 */
export const CROSS_ROOT_DURATION_CONFLICT_FIXTURE = Object.freeze([
  createSyntheticItem({
    assetId: 'ast-dur-conflict-202',
    rootId: 'root-alpha',
    filePath: 'vids/movie.mp4',
    durationSeconds: 1200,
    fileSize: 1000000
  }),
  createSyntheticItem({
    assetId: 'ast-dur-conflict-202',
    rootId: 'root-beta',
    filePath: 'backup/vids/movie.mp4', // Differing root-local path is allowed
    durationSeconds: 1800,              // Conflicting duration!
    fileSize: 1000000
  })
]);

/**
 * Fixture: Distinct assets sharing filename, size, and duration.
 * Used for Gate G2 (prohibition of automatic heuristic merging).
 */
export const SAME_NAME_DIFFERENT_ASSETS_FIXTURE = Object.freeze([
  createSyntheticItem({
    assetId: 'ast-variant-alpha',
    rootId: 'root-a',
    filePath: 'vr180/scene_part1.mp4',
    fileSize: 3221225472,
    durationSeconds: 1800,
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 4,
    isFavorite: true
  }),
  createSyntheticItem({
    assetId: 'ast-variant-beta', // Different physical content with identical file properties!
    rootId: 'root-b',
    filePath: 'vr180/scene_part1.mp4', // Identical filename
    fileSize: 3221225472,              // Identical size
    durationSeconds: 1800,              // Identical duration
    historyStatus: HISTORY_STATUS.CONFIRMED_ZERO,
    effectivePlayCount: 0,
    isFavorite: false
  })
]);

/**
 * Fixture: Unresolved logical identity preservation.
 * Used for Refinement 1 & Gate G3 (no state borrowing for UNRESOLVED items).
 */
export const UNRESOLVED_IDENTITY_FIXTURE = Object.freeze([
  createSyntheticItem({
    assetId: 'ast-resolved-301',
    identityStatus: IDENTITY_STATUS.RESOLVED,
    logicalMediaKey: 'log-canonical-301',
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 3,
    isFavorite: true,
    isDisliked: false
  }),
  createSyntheticItem({
    assetId: 'ast-unresolved-302',
    filePath: 'synthetic/sample_ast-resolved-301.mp4', // Shares name/stem with resolved item!
    identityStatus: IDENTITY_STATUS.UNRESOLVED,
    logicalMediaKey: null,
    historyStatus: HISTORY_STATUS.UNKNOWN,
    effectivePlayCount: 0,
    isFavorite: false,
    isDisliked: false
  })
]);

/**
 * Fixture: Favorites ordering by confirmed play count ASC and watch duration decoupling.
 * Used for Gate G4 & Gate G5.
 */
export const FAVORITES_ORDERING_FIXTURE = Object.freeze([
  createSyntheticItem({
    assetId: 'fav-count-8',
    isFavorite: true,
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 8,
    totalWatchSeconds: 45 // Very short watch time despite 8 plays
  }),
  createSyntheticItem({
    assetId: 'fav-count-1',
    isFavorite: true,
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 1,
    totalWatchSeconds: 900
  }),
  createSyntheticItem({
    assetId: 'fav-count-0',
    isFavorite: true,
    historyStatus: HISTORY_STATUS.CONFIRMED_ZERO,
    effectivePlayCount: 0,
    totalWatchSeconds: 7200 // Huge watch time (e.g. stalled or loop) but 0 valid completed plays
  }),
  createSyntheticItem({
    assetId: 'fav-count-2',
    isFavorite: true,
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 2,
    totalWatchSeconds: 1500
  }),
  createSyntheticItem({
    assetId: 'fav-unknown-history',
    isFavorite: true,
    historyStatus: HISTORY_STATUS.UNKNOWN, // Unknown must NOT masquerade as 0
    effectivePlayCount: 0,
    totalWatchSeconds: 0
  })
]);

/**
 * Fixture: Dislike exclusion and coexistence with favorite.
 * Used for Gate G6.
 */
export const DISLIKE_COEXISTENCE_FIXTURE = Object.freeze([
  createSyntheticItem({
    assetId: 'item-normal-fav',
    isFavorite: true,
    isDisliked: false,
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 1
  }),
  createSyntheticItem({
    assetId: 'item-fav-and-disliked',
    isFavorite: true,
    isDisliked: true, // Coexistence: user marked dislike on favorite item
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 2
  }),
  createSyntheticItem({
    assetId: 'item-normal-nonfav',
    isFavorite: false,
    isDisliked: false,
    historyStatus: HISTORY_STATUS.CONFIRMED_ZERO
  })
]);

/**
 * Fixture: Comprehensive balanced discovery cohorts.
 * Used for Refinement 3 (disjoint cohorts, single-assignment, no duplicate assetId).
 */
export const BALANCED_DISCOVERY_FIXTURE = Object.freeze([
  createSyntheticItem({ assetId: 'bal-c0-1', historyStatus: HISTORY_STATUS.CONFIRMED_ZERO }),
  createSyntheticItem({ assetId: 'bal-c0-2', historyStatus: HISTORY_STATUS.CONFIRMED_ZERO }),
  createSyntheticItem({ assetId: 'bal-low-1', historyStatus: HISTORY_STATUS.PLAYED, effectivePlayCount: 1 }),
  createSyntheticItem({ assetId: 'bal-low-2', historyStatus: HISTORY_STATUS.PLAYED, effectivePlayCount: 2 }),
  createSyntheticItem({ assetId: 'bal-unk-1', historyStatus: HISTORY_STATUS.UNKNOWN }),
  createSyntheticItem({ assetId: 'bal-unk-2', historyStatus: HISTORY_STATUS.UNKNOWN }),
  createSyntheticItem({ assetId: 'bal-fav-1', isFavorite: true, historyStatus: HISTORY_STATUS.PLAYED, effectivePlayCount: 1 }),
  createSyntheticItem({ assetId: 'bal-fav-2', isFavorite: true, historyStatus: HISTORY_STATUS.CONFIRMED_ZERO }),
  createSyntheticItem({ assetId: 'bal-high-1', historyStatus: HISTORY_STATUS.PLAYED, effectivePlayCount: 7 }),
  createSyntheticItem({ assetId: 'bal-high-2', historyStatus: HISTORY_STATUS.PLAYED, effectivePlayCount: 12 }),
  createSyntheticItem({ assetId: 'bal-disliked', isDisliked: true, historyStatus: HISTORY_STATUS.CONFIRMED_ZERO }),
  createSyntheticItem({ assetId: 'bal-inaccessible', accessible: false, historyStatus: HISTORY_STATUS.CONFIRMED_ZERO })
]);

/**
 * Fixture: Long unwatched ordering vs unknown chronology.
 */
export const LONG_UNWATCHED_FIXTURE = Object.freeze([
  createSyntheticItem({
    assetId: 'ast-recent',
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 1,
    lastPlayedAt: 1700000000
  }),
  createSyntheticItem({
    assetId: 'ast-ancient',
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 1,
    lastPlayedAt: 1500000000 // Oldest verified played date
  }),
  createSyntheticItem({
    assetId: 'ast-no-history',
    historyStatus: HISTORY_STATUS.UNKNOWN,
    effectivePlayCount: 0,
    lastPlayedAt: null // Unknown chronology
  })
]);
