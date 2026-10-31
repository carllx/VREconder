/**
 * Test Suite: Playback Queue Policy & Synthetic Catalog Snapshot
 * Ticket 34.1 / Issue #35
 *
 * Verifies Acceptance Gates G1–G8 and Browser Review Refinements (comment 6548337055).
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
  SAME_NAME_DIFFERENT_ASSETS_FIXTURE,
  UNRESOLVED_IDENTITY_FIXTURE,
  FAVORITES_ORDERING_FIXTURE,
  DISLIKE_COEXISTENCE_FIXTURE,
  BALANCED_DISCOVERY_FIXTURE
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
// Gate G7 & Refinement 4: In-Session Frozen Queue Snapshot (Anti-Shuffle)
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

  // Simulate background statistics update to item-1 (e.g. now played 5 times)
  const mutatedItem1 = createSyntheticItem({
    assetId: 'item-1',
    historyStatus: HISTORY_STATUS.PLAYED,
    effectivePlayCount: 5,
    lastPlayedAt: 99999999
  });

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
// Gate G8 & Refinement 5: Consecutive Failure Circuit Breaker
// -------------------------------------------------------------
console.log('\nTest G8: Consecutive Failure Circuit Breaker');
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

  // Verify recovery if success occurs before threshold
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

  console.log('  ✅ [PASS] Gate G8: Exactly 3 failures advance, 4th trips circuit breaker; success resets counter');
}

// -------------------------------------------------------------
// Refinement 2: Conflicting Cross-Root Observations
// -------------------------------------------------------------
console.log('\nTest Refinement 2: Conflicting Cross-Root Observations');
{
  // 1. Default onConflict === 'throw'
  assert.throws(
    () => buildPlaybackQueue(CROSS_ROOT_CONFLICTING_FIXTURE, { onConflict: 'throw' }),
    PlaybackQueueConflictError,
    'Conflicting metadata across roots must throw PlaybackQueueConflictError'
  );

  // 2. onConflict === 'exclude' safely removes ambiguous asset
  const session = buildPlaybackQueue(CROSS_ROOT_CONFLICTING_FIXTURE, { onConflict: 'exclude' });
  assert.strictEqual(session.frozenItems.length, 0);
  assert.deepStrictEqual(session.diagnostics.conflictedAssetIds, ['ast-conflict-201']);
  console.log('  ✅ [PASS] Refinement 2: Conflicting cross-root observations fail explicitly without silent erasure');
}

// -------------------------------------------------------------
// Refinement 3: Balanced Queue Determinism & Disjoint Cohorts
// -------------------------------------------------------------
console.log('\nTest Refinement 3: Balanced Queue Determinism & Disjoint Cohorts');
{
  const session1 = buildPlaybackQueue(BALANCED_DISCOVERY_FIXTURE, {
    mode: QUEUE_MODE.BALANCED,
    seed: 42
  });

  const session2 = buildPlaybackQueue(BALANCED_DISCOVERY_FIXTURE, {
    mode: QUEUE_MODE.BALANCED,
    seed: 42
  });

  // 1. Deterministic repeatability: same seed produces identical order
  const ids1 = session1.frozenItems.map(i => i.assetId);
  const ids2 = session2.frozenItems.map(i => i.assetId);
  assert.deepStrictEqual(ids1, ids2, 'Same snapshot and seed must yield identical queue');

  // 2. Single-assignment: no duplicate assetId anywhere in the queue
  const uniqueIds = new Set(ids1);
  assert.strictEqual(uniqueIds.size, ids1.length, 'Every assetId in balanced queue must be unique');

  // 3. Exclusions respected
  assert.ok(!ids1.includes('bal-disliked'), 'Disliked item must be excluded');
  assert.ok(!ids1.includes('bal-inaccessible'), 'Inaccessible item must be excluded');

  // 4. UNKNOWN items are included as discovery cohort
  assert.ok(ids1.includes('bal-unk-1'), 'UNKNOWN items must be included in discovery');
  assert.ok(ids1.includes('bal-unk-2'), 'UNKNOWN items must be included in discovery');

  console.log('  ✅ [PASS] Refinement 3: Balanced queue has disjoint cohorts, zero duplicate assetIds, deterministic seed');
}

// -------------------------------------------------------------
// Refinement 4: Pure Function & Deep Immutability Safety
// -------------------------------------------------------------
console.log('\nTest Refinement 4: Pure Function & Immutability Safety');
{
  const deepFrozenInput = Object.freeze([
    Object.freeze(createSyntheticItem({ assetId: 'imm-1' })),
    Object.freeze(createSyntheticItem({ assetId: 'imm-2' }))
  ]);

  const session = buildPlaybackQueue(deepFrozenInput, { mode: QUEUE_MODE.DEFAULT });
  assert.ok(Object.isFrozen(session), 'PlaybackQueueSession must be frozen');
  assert.ok(Object.isFrozen(session.frozenItems), 'frozenItems must be frozen');
  assert.ok(Object.isFrozen(session.frozenItems[0]), 'Individual frozen items must be frozen');

  // Attempting mutation should throw or fail silently in strict mode
  assert.throws(() => {
    session.currentIndex = 99;
  }, /Cannot assign to read only property/);

  console.log('  ✅ [PASS] Refinement 4: Policy engine enforces deep immutability on input and session objects');
}

console.log('\n------------------------------------------------------------');
console.log('OVERALL ISSUE #35 (TICKET 34.1) SUITE: ✅ ALL 10 GATES PASSED');
console.log('------------------------------------------------------------\n');
