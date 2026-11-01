/**
 * Test Suite for Catalog Snapshot Provider & Multi-Root Transformation Adapter
 * Ticket 34.2 / Issue #36
 *
 * Verifies:
 * 1. Timestamp normalization (finite epoch ms vs null)
 * 2. Strict component-boundary path scoping, outside-root rejection & secret redaction
 * 3. Multi-root flat observation transformation (ReadonlyArray<MediaSnapshotItem> for #35)
 * 4. Offline-first / online-second observation ordering and reverse-order stability
 * 5. All-roots-offline preservation without deletion
 * 6. Physical and semantic identity conflict quarantine (fail-closed, not playable)
 * 7. Coherent fail-honest state (unknown history null timestamp, UNRESOLVED default, PLAYED > 0)
 * 8. Stash GraphQL reader contract HOLD state
 * 9. End-to-end integration with #35 PlaybackQueuePolicy (balanced queue, favorites, navigation)
 */

import assert from 'node:assert/strict';
import {
  transformCatalogRecords,
  createSyntheticCatalogSnapshotProvider,
  createStashGraphQLReader,
  normalizeTimestamp,
  sanitizeScopedPath,
  ADAPTER_STATUS,
  QUARANTINE_REASON,
  HISTORY_STATUS,
  IDENTITY_STATUS
} from './src/catalog/catalog-snapshot-provider.mjs';

import {
  buildPlaybackQueue,
  resolveNextQueueItem,
  QUEUE_MODE
} from './src/queue/playback-queue-policy.mjs';

function runTests() {
  console.log('=== Running Catalog Snapshot Provider Test Suite (Issue #36) ===');

  // Test 1: Timestamp Normalization
  {
    console.log('[Test 1] Timestamp Normalization (number | null)');
    assert.equal(normalizeTimestamp(null), null);
    assert.equal(normalizeTimestamp(undefined), null);
    assert.equal(normalizeTimestamp(''), null);
    assert.equal(normalizeTimestamp('  '), null);
    assert.equal(normalizeTimestamp('invalid-date'), null);
    assert.equal(normalizeTimestamp(-100), null);

    const epochMs = 1761912000000;
    assert.equal(normalizeTimestamp(epochMs), epochMs);
    assert.equal(normalizeTimestamp('2025-11-01T12:00:00.000Z'), Date.parse('2025-11-01T12:00:00.000Z'));
  }

  // Test 2: Safe Scoped Path Sanitization, Boundary Containment & Redaction
  {
    console.log('[Test 2] Safe Scoped Path Sanitization, Boundary Containment & Redaction');
    const rootBase = 'G:/Media/VR';

    // 2.1 Normal stripping of root base path with component boundary
    const res1 = sanitizeScopedPath('G:/Media/VR/folder1/video.mp4', rootBase);
    assert.equal(res1.error, null);
    assert.equal(res1.scopedPath, 'folder1/video.mp4');

    // 2.2 Windows backslash normalization in root
    const res2 = sanitizeScopedPath('G:\\Media\\VR\\sub\\test.mp4', 'G:\\Media\\VR');
    assert.equal(res2.error, null);
    assert.equal(res2.scopedPath, 'sub/test.mp4');

    // 2.3 Prefix lookalike must fail closed (G:/Media/VR2 vs G:/Media/VR)
    const resLookalike = sanitizeScopedPath('G:/Media/VR2/private.mp4', rootBase);
    assert.equal(resLookalike.error, QUARANTINE_REASON.OUTSIDE_AUTHORIZED_ROOT);
    assert.equal(resLookalike.scopedPath, null);

    // 2.4 Other-drive absolute path must fail closed
    const resOtherDrive = sanitizeScopedPath('H:/Private/secret.mp4', rootBase);
    assert.equal(resOtherDrive.error, QUARANTINE_REASON.OUTSIDE_AUTHORIZED_ROOT);
    assert.equal(resOtherDrive.scopedPath, null);

    // 2.5 UNC path outside root must fail closed
    const resUnc = sanitizeScopedPath('//nas/share/secret.mp4', rootBase);
    assert.equal(resUnc.error, QUARANTINE_REASON.OUTSIDE_AUTHORIZED_ROOT);
    assert.equal(resUnc.scopedPath, null);

    // 2.6 Valid relative path passes through
    const resRel = sanitizeScopedPath('subfolder/clip.mp4', rootBase);
    assert.equal(resRel.error, null);
    assert.equal(resRel.scopedPath, 'subfolder/clip.mp4');

    // 2.7 Directory traversal in relative path
    const resTrav = sanitizeScopedPath('../../etc/passwd', rootBase);
    assert.equal(resTrav.error, QUARANTINE_REASON.PATH_TRAVERSAL_RISK);
    assert.equal(resTrav.scopedPath, null);

    // 2.8 Directory traversal in root-prefixed path
    const resTravRoot = sanitizeScopedPath('G:/Media/VR/../../secret.mp4', rootBase);
    assert.equal(resTravRoot.error, QUARANTINE_REASON.PATH_TRAVERSAL_RISK);
    assert.equal(resTravRoot.scopedPath, null);

    // 2.9 Redaction of query tokens
    const resQuery = sanitizeScopedPath('G:/Media/VR/clip.mp4?token=secret123&auth=abc', rootBase);
    assert.equal(resQuery.error, null);
    assert.equal(resQuery.scopedPath, 'clip.mp4');

    // 2.10 Diagnostic leakage check: quarantined item details do not expose raw paths
    const records = [{ assetId: 'leak_check', rootId: 'root1', filePath: 'H:/Private/secret.mp4', fileSize: 100, durationSeconds: 10 }];
    const transformRes = transformCatalogRecords(records, { root1: { basePath: 'G:/Media/VR', accessible: true } });
    assert.equal(transformRes.quarantinedItems.length, 1);
    assert(!transformRes.quarantinedItems[0].details.includes('H:/Private/secret.mp4'));
    assert(!transformRes.quarantinedItems[0].details.includes('secret'));
  }

  // Test 3: Multi-Root Flat Observation Transformation
  {
    console.log('[Test 3] Multi-Root Flat Observation Transformation (no nested observations)');
    const rootAvailability = {
      root_online_1: { basePath: 'G:/Media/VR1', accessible: true },
      root_online_2: { basePath: 'H:/Media/VR2', accessible: true }
    };

    const records = [
      {
        assetId: 'asset_multi_1',
        rootId: 'root_online_1',
        filePath: 'video_a.mp4',
        fileSize: 1048576,
        durationSeconds: 120,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 2
      },
      {
        assetId: 'asset_multi_1',
        rootId: 'root_online_2',
        filePath: 'mirrors/video_a.mp4',
        fileSize: 1048576,
        durationSeconds: 120,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 2
      }
    ];

    const result = transformCatalogRecords(records, rootAvailability);
    assert.equal(result.quarantinedItems.length, 0);
    assert.equal(result.items.length, 2);

    assert.equal(result.items[0].assetId, 'asset_multi_1');
    assert.equal(result.items[0].rootId, 'root_online_1');
    assert.equal(result.items[0].accessible, true);
    assert.equal(result.items[0].observations, undefined);

    assert.equal(result.items[1].assetId, 'asset_multi_1');
    assert.equal(result.items[1].rootId, 'root_online_2');
    assert.equal(result.items[1].accessible, true);
    assert.equal(result.items[1].observations, undefined);
  }

  // Test 4: Offline-First vs Online-Second Observation Ordering & Stability
  {
    console.log('[Test 4] Offline-First vs Online-Second & Order Stability with #35');
    const rootAvailability = {
      root_offline: { basePath: 'X:/OfflineDisk', accessible: false },
      root_online: { basePath: 'Y:/OnlineDisk', accessible: true }
    };

    const recordsOfflineFirst = [
      {
        assetId: 'asset_routed_1',
        rootId: 'root_offline',
        filePath: 'clip.mp4',
        fileSize: 5000,
        durationSeconds: 60
      },
      {
        assetId: 'asset_routed_1',
        rootId: 'root_online',
        filePath: 'backup/clip.mp4',
        fileSize: 5000,
        durationSeconds: 60
      }
    ];

    // Order 1: Offline first
    const res1 = transformCatalogRecords(recordsOfflineFirst, rootAvailability);
    assert.equal(res1.items.length, 2);
    assert.equal(res1.items[0].accessible, false);
    assert.equal(res1.items[1].accessible, true);

    const session1 = buildPlaybackQueue(res1.items, { mode: QUEUE_MODE.DEFAULT });
    assert.equal(session1.frozenItems.length, 1);
    assert.equal(session1.frozenItems[0].accessible, true);
    assert.equal(session1.frozenItems[0].rootId, 'root_online');

    // Order 2: Online first (reverse order input)
    const recordsOnlineFirst = [recordsOfflineFirst[1], recordsOfflineFirst[0]];
    const res2 = transformCatalogRecords(recordsOnlineFirst, rootAvailability);
    const session2 = buildPlaybackQueue(res2.items, { mode: QUEUE_MODE.DEFAULT });
    assert.equal(session2.frozenItems.length, 1);
    assert.equal(session2.frozenItems[0].accessible, true);
    assert.equal(session2.frozenItems[0].rootId, 'root_online');
  }

  // Test 5: All Roots Offline Preservation
  {
    console.log('[Test 5] All Roots Offline: Preserved without Deletion');
    const rootAvailability = {
      root_offline_1: { basePath: 'X:/Disk1', accessible: false },
      root_offline_2: { basePath: 'Z:/Disk2', accessible: false }
    };

    const records = [
      {
        assetId: 'asset_all_offline',
        rootId: 'root_offline_1',
        filePath: 'movie.mp4',
        fileSize: 99999,
        durationSeconds: 300,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 5,
        isFavorite: true
      }
    ];

    const result = transformCatalogRecords(records, rootAvailability);
    assert.equal(result.quarantinedItems.length, 0);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].accessible, false);
    assert.equal(result.items[0].isFavorite, true);
    assert.equal(result.items[0].effectivePlayCount, 5);

    const session = buildPlaybackQueue(result.items, { mode: QUEUE_MODE.DEFAULT });
    assert.equal(session.frozenItems.length, 0);
  }

  // Test 6: Physical & Semantic Identity Conflict Quarantine (Fail-Closed)
  {
    console.log('[Test 6] Physical & Semantic Identity Conflict Quarantine (Fail-Closed)');
    const rootAvailability = {
      root_a: { basePath: 'G:/Media/A', accessible: true },
      root_b: { basePath: 'G:/Media/B', accessible: true }
    };

    // 6.1 Physical conflict (fileSize mismatch)
    const recordsPhysical = [
      { assetId: 'asset_conf_phys', rootId: 'root_a', filePath: 'v1.mp4', fileSize: 1000, durationSeconds: 60 },
      { assetId: 'asset_conf_phys', rootId: 'root_b', filePath: 'v2.mp4', fileSize: 2000, durationSeconds: 60 },
      { assetId: 'asset_clean_1', rootId: 'root_a', filePath: 'clean1.mp4', fileSize: 3000, durationSeconds: 90 }
    ];
    const resPhys = transformCatalogRecords(recordsPhysical, rootAvailability);
    assert.equal(resPhys.quarantinedItems.length, 1);
    assert.equal(resPhys.quarantinedItems[0].assetId, 'asset_conf_phys');
    assert.deepEqual(resPhys.quarantinedItems[0].conflictFields, ['fileSize']);
    assert.equal(resPhys.items.length, 1);
    assert.equal(resPhys.items[0].assetId, 'asset_clean_1');

    // 6.2 Semantic conflict (divergent favorite / history status)
    const recordsSemantic = [
      {
        assetId: 'asset_conf_sem',
        rootId: 'root_a',
        filePath: 's1.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 1,
        isFavorite: true
      },
      {
        assetId: 'asset_conf_sem',
        rootId: 'root_b',
        filePath: 's2.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 5, // Mismatched play count!
        isFavorite: false     // Mismatched favorite!
      }
    ];
    const resSem = transformCatalogRecords(recordsSemantic, rootAvailability);
    assert.equal(resSem.quarantinedItems.length, 1);
    assert.equal(resSem.quarantinedItems[0].assetId, 'asset_conf_sem');
    assert(resSem.quarantinedItems[0].conflictFields.includes('effectivePlayCount'));
    assert(resSem.quarantinedItems[0].conflictFields.includes('isFavorite'));
    assert.equal(resSem.items.length, 0);

    // Verify passing quarantined result to #35 never throws PlaybackQueueConflictError!
    assert.doesNotThrow(() => {
      buildPlaybackQueue(resSem.items, { mode: QUEUE_MODE.BALANCED });
    });
  }

  // Test 7: Coherent Fail-Honest State (History & Identity)
  {
    console.log('[Test 7] Coherent Fail-Honest State (History & Identity)');
    const rootAvailability = { root_online: { basePath: 'M:/', accessible: true } };

    const records = [
      // 7.1 Unverified scene-level metrics must not attach fake timestamp, count, or duration
      {
        assetId: 'asset_unverified',
        rootId: 'root_online',
        filePath: 'scene_raw.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        play_count: 8,
        totalWatchSeconds: 9999, // Upstream unverified scene duration
        lastPlayedAt: '2020-01-01T00:00:00.000Z' // Upstream unverified scene timestamp
      },
      // 7.2 Missing logicalMediaKey must force UNRESOLVED
      {
        assetId: 'asset_no_key',
        rootId: 'root_online',
        filePath: 'no_key.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        identityStatus: IDENTITY_STATUS.RESOLVED // Claims resolved but no key!
      },
      // 7.3 Valid key and identityStatus
      {
        assetId: 'asset_valid_resolved',
        rootId: 'root_online',
        filePath: 'valid.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        identityStatus: IDENTITY_STATUS.RESOLVED,
        logicalMediaKey: 'lmk-proven-42'
      },
      // 7.4 PLAYED with count = 0 must fall back to UNKNOWN
      {
        assetId: 'asset_invalid_played_count',
        rootId: 'root_online',
        filePath: 'played_zero.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 0,
        lastPlayedAt: '2026-05-01T00:00:00.000Z'
      },
      // 7.5 PLAYED with valid positive count retains finite timestamp
      {
        assetId: 'asset_valid_played',
        rootId: 'root_online',
        filePath: 'played_valid.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 3,
        lastPlayedAt: '2026-08-01T00:00:00.000Z'
      },
      // 7.6 CONFIRMED_ZERO with valid positive duration must preserve totalWatchSeconds
      {
        assetId: 'asset_cz_with_duration',
        rootId: 'root_online',
        filePath: 'cz_duration.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.CONFIRMED_ZERO,
        effectivePlayCount: 0,
        totalWatchSeconds: 7200
      },
      // 7.7 CONFIRMED_ZERO with negative/invalid duration falls back to 0
      {
        assetId: 'asset_cz_invalid_duration',
        rootId: 'root_online',
        filePath: 'cz_invalid.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.CONFIRMED_ZERO,
        effectivePlayCount: 0,
        totalWatchSeconds: -50
      }
    ];

    const result = transformCatalogRecords(records, rootAvailability);

    // 7.1: UNKNOWN history has null lastPlayedAt and 0 count and 0 duration
    const unverified = result.items.find(i => i.assetId === 'asset_unverified');
    assert.equal(unverified.historyStatus, HISTORY_STATUS.UNKNOWN);
    assert.equal(unverified.effectivePlayCount, 0);
    assert.equal(unverified.totalWatchSeconds, 0);
    assert.equal(unverified.lastPlayedAt, null);

    // 7.2: No logicalMediaKey forces UNRESOLVED with null key
    const noKey = result.items.find(i => i.assetId === 'asset_no_key');
    assert.equal(noKey.identityStatus, IDENTITY_STATUS.UNRESOLVED);
    assert.equal(noKey.logicalMediaKey, null);

    // 7.3: Valid key preserves RESOLVED
    const validResolved = result.items.find(i => i.assetId === 'asset_valid_resolved');
    assert.equal(validResolved.identityStatus, IDENTITY_STATUS.RESOLVED);
    assert.equal(validResolved.logicalMediaKey, 'lmk-proven-42');

    // 7.4: PLAYED with 0 count falls back to UNKNOWN and null lastPlayedAt
    const invalidPlayed = result.items.find(i => i.assetId === 'asset_invalid_played_count');
    assert.equal(invalidPlayed.historyStatus, HISTORY_STATUS.UNKNOWN);
    assert.equal(invalidPlayed.effectivePlayCount, 0);
    assert.equal(invalidPlayed.lastPlayedAt, null);

    // 7.5: PLAYED with positive count preserves count and finite timestamp
    const validPlayed = result.items.find(i => i.assetId === 'asset_valid_played');
    assert.equal(validPlayed.historyStatus, HISTORY_STATUS.PLAYED);
    assert.equal(validPlayed.effectivePlayCount, 3);
    assert.equal(typeof validPlayed.lastPlayedAt, 'number');
    assert.equal(validPlayed.lastPlayedAt, Date.parse('2026-08-01T00:00:00.000Z'));

    // 7.6: CONFIRMED_ZERO preserves verified positive duration
    const czDuration = result.items.find(i => i.assetId === 'asset_cz_with_duration');
    assert.equal(czDuration.historyStatus, HISTORY_STATUS.CONFIRMED_ZERO);
    assert.equal(czDuration.effectivePlayCount, 0);
    assert.equal(czDuration.totalWatchSeconds, 7200);

    // 7.7: CONFIRMED_ZERO with negative duration falls back to 0
    const czInvalid = result.items.find(i => i.assetId === 'asset_cz_invalid_duration');
    assert.equal(czInvalid.historyStatus, HISTORY_STATUS.CONFIRMED_ZERO);
    assert.equal(czInvalid.effectivePlayCount, 0);
    assert.equal(czInvalid.totalWatchSeconds, 0);
  }

  // Test 8: Stash GraphQL Reader Contract Status HOLD
  {
    console.log('[Test 8] Stash GraphQL Reader Contract Status HOLD');
    const reader = createStashGraphQLReader();
    assert.equal(reader.status, ADAPTER_STATUS.HOLD_PENDING_SCHEMA_EVIDENCE);
    assert.rejects(async () => {
      await reader.fetchSnapshot();
    }, /STASH_SCHEMA_READER_ON_HOLD/);
  }

  // Test 9: End-to-End Integration with #35 PlaybackQueuePolicy
  {
    console.log('[Test 9] End-to-End Integration with Issue #35 Queue Policy');
    const rootAvailability = {
      root_fast: { basePath: 'D:/FastStorage', accessible: true },
      root_backup: { basePath: 'E:/BackupStorage', accessible: true }
    };

    const fixtureRecords = [
      // 1. Confirmed zero item
      {
        assetId: 'asset_cz_1',
        rootId: 'root_fast',
        filePath: 'zero1.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.CONFIRMED_ZERO
      },
      // 2. Favorite item (played 1 time)
      {
        assetId: 'asset_fav_1',
        rootId: 'root_fast',
        filePath: 'fav1.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 1,
        isFavorite: true
      },
      // 3. Disliked item (should be filtered out by #35)
      {
        assetId: 'asset_disliked_1',
        rootId: 'root_fast',
        filePath: 'disliked1.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 1,
        isDisliked: true
      },
      // 4. Multi-root replicated item
      {
        assetId: 'asset_replica_1',
        rootId: 'root_fast',
        filePath: 'rep1.mp4',
        fileSize: 2000,
        durationSeconds: 120,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 2
      },
      {
        assetId: 'asset_replica_1',
        rootId: 'root_backup',
        filePath: 'backup_rep1.mp4',
        fileSize: 2000,
        durationSeconds: 120,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.PLAYED,
        effectivePlayCount: 2
      },
      // 5. Conflicting item (should be quarantined by #36 provider)
      {
        assetId: 'asset_bad_conflict',
        rootId: 'root_fast',
        filePath: 'bad1.mp4',
        fileSize: 5000,
        durationSeconds: 100
      },
      {
        assetId: 'asset_bad_conflict',
        rootId: 'root_backup',
        filePath: 'bad2.mp4',
        fileSize: 9999, // Mismatched size!
        durationSeconds: 100
      }
    ];

    const provider = createSyntheticCatalogSnapshotProvider({ records: fixtureRecords });
    const snapshot = provider.getSnapshot(rootAvailability);

    assert.equal(snapshot.quarantinedItems.length, 1);
    assert.equal(snapshot.quarantinedItems[0].assetId, 'asset_bad_conflict');

    // Build #35 queue using provider.items
    const session = buildPlaybackQueue(snapshot.items, {
      mode: QUEUE_MODE.BALANCED,
      seed: 42
    });

    // Disliked item excluded, conflicted item quarantined, replica deduplicated
    // Remaining playable items: asset_cz_1, asset_fav_1, asset_replica_1
    assert.equal(session.frozenItems.length, 3);
    const itemIds = session.frozenItems.map(i => i.assetId);
    assert(itemIds.includes('asset_cz_1'));
    assert(itemIds.includes('asset_fav_1'));
    assert(itemIds.includes('asset_replica_1'));
    assert(!itemIds.includes('asset_disliked_1'));
    assert(!itemIds.includes('asset_bad_conflict'));

    // Test navigation in queue
    const nextResult = resolveNextQueueItem(session, 'SUCCESS');
    assert.equal(nextResult.status, 'ADVANCED');
    assert.equal(nextResult.item.assetId, session.frozenItems[1].assetId);
  }

  console.log('✅ ALL 9 TESTS PASSED IN CATALOG SNAPSHOT PROVIDER TEST SUITE!');
}

runTests();
