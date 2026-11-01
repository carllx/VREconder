/**
 * Test Suite for Catalog Snapshot Provider & Multi-Root Transformation Adapter
 * Ticket 34.2 / Issue #36
 *
 * Verifies:
 * 1. Multi-root flat observation transformation (ReadonlyArray<MediaSnapshotItem> for #35)
 * 2. Offline-first / online-second observation ordering and reverse-order stability
 * 3. All-roots-offline preservation without deletion
 * 4. Physical identity conflict quarantine (fail-closed, not playable)
 * 5. Unknown history preservation vs confirmed zero
 * 6. Timestamp normalization (finite epoch ms vs null)
 * 7. Path sanitization and host secret/token redaction
 * 8. Stash GraphQL reader contract HOLD state
 * 9. Integration with #35 PlaybackQueuePolicy (balanced queue, favorites, navigation)
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

  // Test 2: Safe Scoped Path Sanitization & Redaction
  {
    console.log('[Test 2] Safe Scoped Path Sanitization & Redaction');
    const rootBase = 'G:/Media/VR';

    // Normal stripping of root base path
    const res1 = sanitizeScopedPath('G:/Media/VR/folder1/video.mp4', rootBase);
    assert.equal(res1.error, null);
    assert.equal(res1.scopedPath, 'folder1/video.mp4');

    // Windows backslash normalization
    const res2 = sanitizeScopedPath('G:\\Media\\VR\\sub\\test.mp4', 'G:\\Media\\VR');
    assert.equal(res2.error, null);
    assert.equal(res2.scopedPath, 'sub/test.mp4');

    // Redaction of query tokens
    const res3 = sanitizeScopedPath('G:/Media/VR/clip.mp4?token=secret123&auth=abc', rootBase);
    assert.equal(res3.error, null);
    assert.equal(res3.scopedPath, 'clip.mp4');

    // Path traversal detection
    const res4 = sanitizeScopedPath('G:/Media/VR/../../secret.mp4', rootBase);
    assert.equal(res4.error, QUARANTINE_REASON.PATH_TRAVERSAL_RISK);
    assert.equal(res4.scopedPath, null);
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

    // Verify both items are flat and share assetId
    assert.equal(result.items[0].assetId, 'asset_multi_1');
    assert.equal(result.items[0].rootId, 'root_online_1');
    assert.equal(result.items[0].accessible, true);
    assert.equal(result.items[0].observations, undefined); // No nested observations

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

    // Feed to #35 queue engine
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

    // Feed into #35: excluded from active queue because accessible === false, but not deleted
    const session = buildPlaybackQueue(result.items, { mode: QUEUE_MODE.DEFAULT });
    assert.equal(session.frozenItems.length, 0);
  }

  // Test 6: Physical Identity Conflict Quarantine (Fail-Closed)
  {
    console.log('[Test 6] Physical Identity Conflict Quarantine (Fail-Closed)');
    const rootAvailability = {
      root_a: { basePath: 'G:/Media/A', accessible: true },
      root_b: { basePath: 'G:/Media/B', accessible: true }
    };

    const records = [
      {
        assetId: 'asset_conflicted',
        rootId: 'root_a',
        filePath: 'video.mp4',
        fileSize: 1000,
        durationSeconds: 60
      },
      {
        assetId: 'asset_conflicted',
        rootId: 'root_b',
        filePath: 'video_alt.mp4',
        fileSize: 2000, // Conflict on fileSize!
        durationSeconds: 60
      },
      {
        assetId: 'asset_clean',
        rootId: 'root_a',
        filePath: 'clean.mp4',
        fileSize: 3000,
        durationSeconds: 90
      }
    ];

    const result = transformCatalogRecords(records, rootAvailability);
    assert.equal(result.quarantinedItems.length, 1);
    assert.equal(result.quarantinedItems[0].assetId, 'asset_conflicted');
    assert.equal(result.quarantinedItems[0].reason, QUARANTINE_REASON.METADATA_CONFLICT);
    assert.deepEqual(result.quarantinedItems[0].conflictFields, ['fileSize']);

    // The clean asset is emitted, while the conflicted asset is completely excluded from items!
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].assetId, 'asset_clean');
  }

  // Test 7: Unknown History vs Confirmed Zero
  {
    console.log('[Test 7] Unknown History vs Confirmed Zero');
    const records = [
      {
        assetId: 'asset_unverified_scene',
        rootId: 'root_online',
        filePath: 'scene_raw.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        play_count: 8 // Upstream scene play count without verified asset history
      },
      {
        assetId: 'asset_confirmed_zero',
        rootId: 'root_online',
        filePath: 'confirmed_new.mp4',
        fileSize: 1000,
        durationSeconds: 60,
        hasVerifiedAssetHistory: true,
        historyStatus: HISTORY_STATUS.CONFIRMED_ZERO
      }
    ];

    const rootAvailability = { root_online: { basePath: 'M:/', accessible: true } };
    const result = transformCatalogRecords(records, rootAvailability);

    const unverified = result.items.find(i => i.assetId === 'asset_unverified_scene');
    assert.equal(unverified.historyStatus, HISTORY_STATUS.UNKNOWN);
    assert.equal(unverified.effectivePlayCount, 0); // Not assigned scene count!

    const confirmed = result.items.find(i => i.assetId === 'asset_confirmed_zero');
    assert.equal(confirmed.historyStatus, HISTORY_STATUS.CONFIRMED_ZERO);
    assert.equal(confirmed.effectivePlayCount, 0);
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
      randomSeed: 42
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
