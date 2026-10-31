/**
 * Test Suite: Playback Queue Policy & Synthetic Catalog Snapshot
 * Ticket 34.1 / Issue #35
 *
 * Verifies Acceptance Gates G1–G8 and Browser Review Refinements (comments 6548337055 & 6548549330).
 */

import assert from 'node:assert';
import {
  buildPlaybackQueue,
  resolveNextQueueItem,
  resolvePreviousQueueItem,
  HISTORY_STATUS,
  IDENTITY_STATUS,
  QUEUE_MODE,
  QUEUE_NAVIGATION_STATUS,
  PlaybackQueueConflictError
} from './src/queue/playback-queue-policy.mjs';

import {
  createSyntheticItem,
  MULTI_ROOT_OVERLAPPING_FIXTURE,
  CROSS_ROOT_CONFLICTING_FIXTURE,
  CROSS_ROOT_DURATION_CONFLICT_FIXTURE,
  SAME_NAME_DIFFERENT_ASSETS_FIXTURE,
  UNRESOLVED_IDENTITY_FIXTURE,
  FAVORITES_ORDERING_FIXTURE,
  DISLIKE_COEXISTENCE_FIXTURE,
  BALANCED_DISCOVERY_FIXTURE,
  LONG_UNWATCHED_FIXTURE
} from './src/queue/synthetic-catalog-snapshot.mjs';

console.log('============================================================');
console.log('🧪 RUNNING ISSUE #35 (TICKET 34.1) PLAYBACK QUEUE POLICY SUITE');
console.log('============================================================\n');

// -------------------------------------------------------------
// Gate G1: Physical Cross-Root Deduplication
// -------------------------------------------------------------
console.log('Test G1: Physical Cross-Root Deduplication');
{
  const session = buildPlaybackQueue(MULTI_ROOT_OVERLAPPING_FIXTURE, { mode: QUEUE_MODE.DEFAULT });
  assert.strictEqual(session.frozenItems.length, 2, 'Must deduplicate 3 multi-root observations into 2 assets');
  const assetIds = session.frozenItems.map(i => i.assetId);
  assert.deepStrictEqual(assetIds, ['ast-distinct-102', 'ast-shared-101'], 'Asset IDs must be sorted and deduplicated');
  console.log('  ✅ [PASS] Gate G1: Shared physical assetId across roots is deduplicated to exactly 1 entry');
}

// -------------------------------------------------------------
// Gate G2: Distinct Assets with Identical Filename/Size/Duration Never Merged
// -------------------------------------------------------------
console.log('\nTest G2: Prohibit Heuristic Merging on Name / Size / Duration');
{
  const session = buildPlaybackQueue(SAME_NAME_DIFFERENT_ASSETS_FIXTURE, { mode: QUEUE_MODE.DEFAULT });
  assert.strictEqual(session.frozenItems.length, 2, 'Distinct assets with same name/size must NOT be merged');
  const [alpha, beta] = session.frozenItems;
  assert.strictEqual(alpha.assetId, 'ast-variant-alpha');
  assert.strictEqual(alpha.isFavorite, true);
  assert.strictEqual(alpha.effectivePlayCount, 4);

  assert.strictEqual(beta.assetId, 'ast-variant-beta');
  assert.strictEqual(beta.isFavorite, false);
  assert.strictEqual(beta.effectivePlayCount, 0);
  console.log('  ✅ [PASS] Gate G2: Same-name/same-size files remain independent entries with intact state');
}

// -------------------------------------------------------------
// Gate G3 & Refinement 1: Unresolved Identity & No State Borrowing
// -------------------------------------------------------------
console.log('\nTest G3: Unresolved Identity & No State Borrowing');
{
  const session = buildPlaybackQueue(UNRESOLVED_IDENTITY_FIXTURE, { mode: QUEUE_MODE.DEFAULT });
  assert.strictEqual(session.frozenItems.length, 2);

  const resolved = session.frozenItems.find(i => i.assetId === 'ast-resolved-301');
  const unresolved = session.frozenItems.find(i => i.assetId === 'ast-unresolved-302');

  assert.strictEqual(resolved.identityStatus, IDENTITY_STATUS.RESOLVED);
  assert.strictEqual(resolved.logicalMediaKey, 'log-canonical-301');
  assert.strictEqual(resolved.isFavorite, true);
  assert.strictEqual(resolved.effectivePlayCount, 3);

  assert.strictEqual(unresolved.identityStatus, IDENTITY_STATUS.UNRESOLVED);
  assert.strictEqual(unresolved.logicalMediaKey, null, 'Unresolved must have null logicalMediaKey');
  assert.strictEqual(unresolved.isFavorite, false, 'Unresolved item must NEVER borrow favorite from neighbor');
  assert.strictEqual(unresolved.historyStatus, HISTORY_STATUS.UNKNOWN, 'History must stay UNKNOWN');
  assert.strictEqual(unresolved.effectivePlayCount, 0);
  console.log('  ✅ [PASS] Gate G3: UNRESOLVED items maintain strictly isolated state without borrowing');
}

// -------------------------------------------------------------
// Gate G4 & Gate G5: Favorites Sorted by Play Count ASC & Watch Duration Decoupling
// -------------------------------------------------------------
console.log('\nTest G4 & G5: Favorites Play Count ASC & Watch Duration Decoupling');
{
  const session = buildPlaybackQueue(FAVORITES_ORDERING_FIXTURE, { mode: QUEUE_MODE.FAVORITES });
  const ids = session.frozenItems.map(i => i.assetId);

  // Expected order:
  // 1. fav-count-0 (confirmed 0 plays, despite 7200s watch time!)
  // 2. fav-count-1 (1 play)
  // 3. fav-count-2 (2 plays)
  // 4. fav-count-8 (8 plays, despite 45s watch time!)
  // 5. fav-unknown-history (UNKNOWN history, cannot masquerade as 0)
  assert.deepStrictEqual(ids, [
    'fav-count-0',
    'fav-count-1',
    'fav-count-2',
    'fav-count-8',
    'fav-unknown-history'
  ], 'Favorites must sort by confirmed play count ASC, with UNKNOWN after confirmed, watch duration ignored');

  console.log('  ✅ [PASS] Gate G4: CONFIRMED_ZERO (0) precedes played counts; UNKNOWN does not masquerade as 0');
  console.log('  ✅ [PASS] Gate G5: Watch duration changes do not affect favorite order (0 -> 1 -> 2 -> 8)');
}

// -------------------------------------------------------------
// Gate G6: Dislike Automatic Exclusion & Favorite Coexistence
// -------------------------------------------------------------
console.log('\nTest G6: Dislike Exclusion & Favorite Coexistence');
{
  // 1. Auto queue excludes disliked items
  const autoSession = buildPlaybackQueue(DISLIKE_COEXISTENCE_FIXTURE, { mode: QUEUE_MODE.FAVORITES });
  const autoIds = autoSession.frozenItems.map(i => i.assetId);
  assert.ok(!autoIds.includes('item-fav-and-disliked'), 'Disliked item must be excluded from auto-queue');
  assert.deepStrictEqual(autoIds, ['item-normal-fav']);

  // 2. Underlying item still retains favorite property (no silent deletion)
  const dislikedItem = DISLIKE_COEXISTENCE_FIXTURE.find(i => i.assetId === 'item-fav-and-disliked');
  assert.strictEqual(dislikedItem.isFavorite, true, 'Favorite flag must remain intact on disliked item');
  assert.strictEqual(dislikedItem.isDisliked, true);

  // 3. When dislike is actively removed, it reappears in favorites queue
  const restoredItem = createSyntheticItem({
    ...dislikedItem,
    isDisliked: false
  });
  const restoredFixture = [DISLIKE_COEXISTENCE_FIXTURE[0], restoredItem, DISLIKE_COEXISTENCE_FIXTURE[2]];
  const restoredSession = buildPlaybackQueue(restoredFixture, { mode: QUEUE_MODE.FAVORITES });
  const restoredIds = restoredSession.frozenItems.map(i => i.assetId);
  assert.ok(restoredIds.includes('item-fav-and-disliked'), 'Restored item must regain favorite queue eligibility');
  console.log('  ✅ [PASS] Gate G6: Dislike excludes from auto-queue without erasing favorite flag; restores cleanly');
}

// -------------------------------------------------------------
// Gate G7: In-Session Queue Freeze (Anti-Shuffle Invariant)
// -------------------------------------------------------------
console.log('\nTest G7: In-Session Queue Freeze (Anti-Shuffle Invariant)');
{
  const initialItems = [
    createSyntheticItem({ assetId: 'item-1', historyStatus: HISTORY_STATUS.CONFIRMED_ZERO }),
    createSyntheticItem({ assetId: 'item-2', historyStatus: HISTORY_STATUS.CONFIRMED_ZERO }),
    createSyntheticItem({ assetId: 'item-3', historyStatus: HISTORY_STATUS.CONFIRMED_ZERO })
  ];

  const session = buildPlaybackQueue(initialItems, { mode: QUEUE_MODE.DEFAULT });
  assert.strictEqual(session.currentIndex, 0);
  assert.strictEqual(session.frozenItems[0].assetId, 'item-1');

  // Advance session: session.frozenItems must NOT reorder or reshuffle
  const step1 = resolveNextQueueItem(session, 'SUCCESS');
  assert.strictEqual(step1.status, QUEUE_NAVIGATION_STATUS.ADVANCED);
  assert.strictEqual(step1.item.assetId, 'item-2');
  assert.strictEqual(step1.session.currentIndex, 1);
  assert.deepStrictEqual(
    step1.session.frozenItems.map(i => i.assetId),
    ['item-1', 'item-2', 'item-3'],
    'Frozen items array must remain identical across playback progression'
  );

  // Previous navigation
  const prevStep = resolvePreviousQueueItem(step1.session);
  assert.strictEqual(prevStep.item.assetId, 'item-1');
  assert.strictEqual(prevStep.session.currentIndex, 0);

  console.log('  ✅ [PASS] Gate G7: Active session frozen snapshot does not reshuffle during playback navigation');
}

// -------------------------------------------------------------
// Gate G8: Consecutive Failure Circuit Breaker & Post-Trip Invariance
// -------------------------------------------------------------
console.log('\nTest G8: Consecutive Failure Circuit Breaker & Post-Trip Invariance');
{
  const items = [
    createSyntheticItem({ assetId: 'fail-1' }),
    createSyntheticItem({ assetId: 'fail-2' }),
    createSyntheticItem({ assetId: 'fail-3' }),
    createSyntheticItem({ assetId: 'fail-4' }),
    createSyntheticItem({ assetId: 'fail-5' })
  ];

  let current = buildPlaybackQueue(items, { mode: QUEUE_MODE.DEFAULT });

  // Failure 1 (advances to index 1)
  let step = resolveNextQueueItem(current, 'FAILURE');
  assert.strictEqual(step.status, QUEUE_NAVIGATION_STATUS.ADVANCED);
  assert.strictEqual(step.session.consecutiveFailures, 1);
  assert.strictEqual(step.session.currentIndex, 1);
  current = step.session;

  // Failure 2 (advances to index 2)
  step = resolveNextQueueItem(current, 'FAILURE');
  assert.strictEqual(step.status, QUEUE_NAVIGATION_STATUS.ADVANCED);
  assert.strictEqual(step.session.consecutiveFailures, 2);
  assert.strictEqual(step.session.currentIndex, 2);
  current = step.session;

  // Failure 3 (advances to index 3)
  step = resolveNextQueueItem(current, 'FAILURE');
  assert.strictEqual(step.status, QUEUE_NAVIGATION_STATUS.ADVANCED);
  assert.strictEqual(step.session.consecutiveFailures, 3);
  assert.strictEqual(step.session.currentIndex, 3);
  current = step.session;

  // Failure 4: consecutiveFailures > 3 -> CIRCUIT_BREAKER_TRIPPED
  step = resolveNextQueueItem(current, 'FAILURE');
  assert.strictEqual(step.status, QUEUE_NAVIGATION_STATUS.CIRCUIT_BREAKER_TRIPPED);
  assert.strictEqual(step.item, null);
  assert.strictEqual(step.session.consecutiveFailures, 4);

  // POST-TRIP INVARIANCE: A tripped session must remain stopped, even if SUCCESS is sent
  const postTripSuccess = resolveNextQueueItem(step.session, 'SUCCESS');
  assert.strictEqual(postTripSuccess.status, QUEUE_NAVIGATION_STATUS.CIRCUIT_BREAKER_TRIPPED);
  assert.strictEqual(postTripSuccess.item, null);

  const postTripFailure = resolveNextQueueItem(step.session, 'FAILURE');
  assert.strictEqual(postTripFailure.status, QUEUE_NAVIGATION_STATUS.CIRCUIT_BREAKER_TRIPPED);
  assert.strictEqual(postTripFailure.item, null);

  const postTripPrevious = resolvePreviousQueueItem(step.session);
  assert.strictEqual(postTripPrevious.status, QUEUE_NAVIGATION_STATUS.CIRCUIT_BREAKER_TRIPPED);
  assert.strictEqual(postTripPrevious.item, null);

  // Recovery before trip threshold
  let recoverSession = buildPlaybackQueue(items, { mode: QUEUE_MODE.DEFAULT });
  let failStep = resolveNextQueueItem(recoverSession, 'FAILURE');
  assert.strictEqual(failStep.session.consecutiveFailures, 1);
  let successStep = resolveNextQueueItem(failStep.session, 'SUCCESS');
  assert.strictEqual(successStep.session.consecutiveFailures, 0, 'Success must reset consecutiveFailures to 0');

  // Verify clean QUEUE_END when playlist exhausted
  let endSession = buildPlaybackQueue([items[0]], { mode: QUEUE_MODE.DEFAULT });
  let endStep = resolveNextQueueItem(endSession, 'SUCCESS');
  assert.strictEqual(endStep.status, QUEUE_NAVIGATION_STATUS.QUEUE_END);
  assert.strictEqual(endStep.item, null);

  // Verify empty previous returns QUEUE_END
  let emptySession = buildPlaybackQueue([], { mode: QUEUE_MODE.DEFAULT });
  let emptyPrevStep = resolvePreviousQueueItem(emptySession);
  assert.strictEqual(emptyPrevStep.status, QUEUE_NAVIGATION_STATUS.QUEUE_END);
  assert.strictEqual(emptyPrevStep.item, null);

  console.log('  ✅ [PASS] Gate G8: Exactly 3 failures advance; 4th trips breaker; post-trip session remains stopped');
}

// -------------------------------------------------------------
// Refinement 2: Conflicting Cross-Root Observations (Duration & Metadata)
// -------------------------------------------------------------
console.log('\nTest Refinement 2: Conflicting Cross-Root Observations (Duration & Metadata)');
{
  // 1. Conflict on history & favorite throws
  assert.throws(
    () => buildPlaybackQueue(CROSS_ROOT_CONFLICTING_FIXTURE, { onConflict: 'throw' }),
    PlaybackQueueConflictError,
    'Conflicting metadata across roots must throw PlaybackQueueConflictError'
  );

  // 2. Conflict on durationSeconds throws (fail-closed)
  assert.throws(
    () => buildPlaybackQueue(CROSS_ROOT_DURATION_CONFLICT_FIXTURE, { onConflict: 'throw' }),
    PlaybackQueueConflictError,
    'Conflicting durationSeconds across roots must throw PlaybackQueueConflictError'
  );

  // 3. onConflict === 'exclude' safely removes ambiguous assets
  const session = buildPlaybackQueue(CROSS_ROOT_DURATION_CONFLICT_FIXTURE, { onConflict: 'exclude' });
  assert.strictEqual(session.frozenItems.length, 0);
  assert.deepStrictEqual(session.diagnostics.conflictedAssetIds, ['ast-dur-conflict-202']);
  console.log('  ✅ [PASS] Refinement 2: Duration conflicts & metadata conflicts fail closed without silent merge');
}

// -------------------------------------------------------------
// Refinement 3 & 5: Balanced Queue Default & Deterministic Seed Variance
// -------------------------------------------------------------
console.log('\nTest Refinement 3 & 5: Balanced Default & Deterministic Seed Variance');
{
  // 1. Unspecified mode defaults to Owner-approved BALANCED
  const defaultSession = buildPlaybackQueue(BALANCED_DISCOVERY_FIXTURE);
  assert.strictEqual(defaultSession.mode, QUEUE_MODE.BALANCED, 'Default mode must be BALANCED');

  // 2. Invalid mode explicitly rejected
  assert.throws(
    () => buildPlaybackQueue(BALANCED_DISCOVERY_FIXTURE, { mode: 'UNSUPPORTED_MODE' }),
    /Invalid queue mode/,
    'Invalid queue mode must be rejected explicitly'
  );

  // 3. Seed-driven variance: same seed produces identical order
  const sessionSeed42A = buildPlaybackQueue(BALANCED_DISCOVERY_FIXTURE, { mode: QUEUE_MODE.BALANCED, seed: 42 });
  const sessionSeed42B = buildPlaybackQueue(BALANCED_DISCOVERY_FIXTURE, { mode: QUEUE_MODE.BALANCED, seed: 42 });
  const ids42A = sessionSeed42A.frozenItems.map(i => i.assetId);
  const ids42B = sessionSeed42B.frozenItems.map(i => i.assetId);
  assert.deepStrictEqual(ids42A, ids42B, 'Same seed must yield identical queue sequence');

  // 4. Different seed produces bounded variance in order
  const sessionSeed99 = buildPlaybackQueue(BALANCED_DISCOVERY_FIXTURE, { mode: QUEUE_MODE.BALANCED, seed: 99 });
  const ids99 = sessionSeed99.frozenItems.map(i => i.assetId);
  assert.notDeepStrictEqual(ids42A, ids99, 'Different seeds must produce deterministic variance');

  // 5. Single assignment: zero duplicate assetId in either queue
  assert.strictEqual(new Set(ids42A).size, ids42A.length, 'Every assetId must be unique in seed 42 queue');
  assert.strictEqual(new Set(ids99).size, ids99.length, 'Every assetId must be unique in seed 99 queue');

  // 6. Discovery cohort inclusion and exclusions
  assert.ok(ids42A.includes('bal-unk-1'), 'UNKNOWN items must be included in discovery');
  assert.ok(!ids42A.includes('bal-disliked'), 'Disliked items must be excluded');

  console.log('  ✅ [PASS] Refinement 3 & 5: BALANCED is default; seed variance is active and deterministic');
}

// -------------------------------------------------------------
// Refinement 4: Chronology Distinction in LONG_UNWATCHED_FIRST
// -------------------------------------------------------------
console.log('\nTest Refinement 4: Chronology Distinction in LONG_UNWATCHED_FIRST');
{
  const session = buildPlaybackQueue(LONG_UNWATCHED_FIXTURE, { mode: QUEUE_MODE.LONG_UNWATCHED_FIRST });
  const ids = session.frozenItems.map(i => i.assetId);

  // Expected order:
  // 1. ast-ancient (played at 1500000000 - oldest confirmed played)
  // 2. ast-recent (played at 1700000000 - more recently played)
  // 3. ast-no-history (lastPlayedAt: null - unknown chronology, must NOT masquerade as ancient -1)
  assert.deepStrictEqual(ids, ['ast-ancient', 'ast-recent', 'ast-no-history']);
  console.log('  ✅ [PASS] Refinement 4: Genuinely old timestamps precede unknown chronology (no -1 fake ancient)');
}

// -------------------------------------------------------------
// Refinement 6: Pure Function & Deep Immutability Safety
// -------------------------------------------------------------
console.log('\nTest Refinement 6: Pure Function & Immutability Safety');
{
  const deepFrozenInput = Object.freeze([
    Object.freeze(createSyntheticItem({ assetId: 'imm-1' })),
    Object.freeze(createSyntheticItem({ assetId: 'imm-2' }))
  ]);

  const session = buildPlaybackQueue(deepFrozenInput, { mode: QUEUE_MODE.DEFAULT });
  assert.ok(Object.isFrozen(session), 'PlaybackQueueSession must be frozen');
  assert.ok(Object.isFrozen(session.frozenItems), 'frozenItems must be frozen');
  assert.ok(Object.isFrozen(session.frozenItems[0]), 'Individual frozen items must be frozen');

  assert.throws(() => {
    session.currentIndex = 99;
  }, /Cannot assign to read only property/);

  console.log('  ✅ [PASS] Refinement 6: Policy engine enforces deep immutability on input and session objects');
}

console.log('\n------------------------------------------------------------');
console.log('OVERALL ISSUE #35 (TICKET 34.1) SUITE: ✅ ALL GATES & REFINEMENTS PASSED');
console.log('------------------------------------------------------------\n');
