import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  routeIncident,
  generateSanitizedTriage,
  formatMarkdownSummary,
  executeTriage
} from '../../scripts/triage-runtime-incidents.mjs';
import {
  recordIncident,
  readPendingIncidents,
  readProcessedIncidents,
  acknowledgeIncidents
} from './src/telemetry/incident-store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DIR = path.join(__dirname, 'test_triage_routing_sandbox');

console.log('=== RUNNING ISSUE #24 TRIAGE ACK & ROUTING FOCUSED TEST SUITE ===\n');

// Clean sandbox
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

try {
  // Test 1: Media-health compatibility findings route to Issue #21
  console.log('Test 1: Routing verification for media compatibility findings (#21)');
  const c1 = routeIncident({ classification: 'UNSUPPORTED_UNKNOWN_FIX' });
  assert.strictEqual(c1.targetIssue, 21, 'UNSUPPORTED_UNKNOWN_FIX must route to Issue #21');
  console.log('  ✅ [PASS] UNSUPPORTED_UNKNOWN_FIX -> #21');

  const c2 = routeIncident({ classification: 'UNREADABLE_MEDIA' });
  assert.strictEqual(c2.targetIssue, 21, 'UNREADABLE_MEDIA must route to Issue #21');
  console.log('  ✅ [PASS] UNREADABLE_MEDIA -> #21');

  const c3 = routeIncident({ classification: 'NORMALIZATION_CANDIDATE_CERTIFIED' });
  assert.strictEqual(c3.targetIssue, 21, 'NORMALIZATION_CANDIDATE_CERTIFIED must route to #21');
  const c4 = routeIncident({ classification: 'EXPERIMENT_DERIVATIVE' });
  assert.strictEqual(c4.targetIssue, 21, 'EXPERIMENT_DERIVATIVE must route to #21');
  const c5 = routeIncident({ classification: 'NEEDS_BUCKET_CERTIFICATION' });
  assert.strictEqual(c5.targetIssue, 21, 'NEEDS_BUCKET_CERTIFICATION must route to #21');
  const c6 = routeIncident({ classification: 'NEEDS_DEVICE_PROBE' });
  assert.strictEqual(c6.targetIssue, 21, 'NEEDS_DEVICE_PROBE must route to #21');
  console.log('  ✅ [PASS] All media compatibility findings route to #21');

  // Test 2: Actual runtime playback failures route to Issue #23
  console.log('\nTest 2: Routing verification for playback failures (#23)');
  const cPlaybackErr = routeIncident({
    eventType: 'MEDIA_PLAYBACK_ERROR',
    classification: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
    reason: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
  });
  assert.strictEqual(cPlaybackErr.targetIssue, 23, 'MEDIA_PLAYBACK_ERROR must route to #23');
  console.log('  ✅ [PASS] MEDIA_ERR_SRC_NOT_SUPPORTED / MEDIA_PLAYBACK_ERROR -> #23');

  // Test 3: Incident pipeline & unclassified defects route to Issue #24
  console.log('\nTest 3: Routing verification for pipeline / unclassified defects (#24)');
  const cPipeline = routeIncident({
    eventType: 'INCIDENT_PIPELINE_ERROR',
    classification: 'STORAGE_WRITE_FAILURE',
    reason: 'Could not append jsonl'
  });
  assert.strictEqual(cPipeline.targetIssue, 24, 'Incident pipeline errors must route to #24');
  console.log('  ✅ [PASS] Pipeline / unclassified defects -> #24');

  // Test 4: Sanitized report omits private filenames and absolute paths
  console.log('\nTest 4: Leakage prevention in public sanitized report');
  const leakSampleIncidents = [
    {
      incidentId: 'inc_leak_1',
      classification: 'NORMALIZATION_CANDIDATE_CERTIFIED',
      matchedEnvelopeId: 'ENV_A',
      reason: 'Failed on G:\\Media\\VR\\PrivateFolder\\Actor_Secret_Video.mp4',
      fingerprintId: 'fp_abc123',
      localMediaName: 'Actor_Secret_Video.mp4',
      localMediaPath: 'G:\\Media\\VR\\PrivateFolder\\Actor_Secret_Video.mp4'
    }
  ];
  const leakTriage = generateSanitizedTriage(leakSampleIncidents);
  const formattedSummary = formatMarkdownSummary(leakTriage);

  assert.ok(!formattedSummary.includes('Actor_Secret_Video'), 'Summary must NOT contain private media filename');
  assert.ok(!formattedSummary.includes('PrivateFolder'), 'Summary must NOT contain private folder name');
  assert.ok(!formattedSummary.includes('G:\\Media'), 'Summary must NOT contain absolute Windows drive path');
  assert.ok(formattedSummary.includes('[path]'), 'Summary must replace sensitive path with [path]');
  console.log('  ✅ [PASS] Public sanitized summary contains zero private filenames or absolute paths');

  // Test 5: Granular publication and acknowledgement (A succeeds, B fails)
  console.log('\nTest 5: Granular publication and acknowledgement (Issue #21 succeeds, Issue #23 fails)');
  // Seed two pending incidents: one for #21, one for #23
  const inc21 = recordIncident({
    incidentId: 'inc_test_21',
    eventType: 'PLAYBACK_ADMISSION_DENIED',
    severity: 'WARN',
    fingerprintId: 'fp_21',
    localMediaName: 'compat_issue.mp4',
    localMediaPath: '/mock/compat_issue.mp4',
    classification: 'UNSUPPORTED_UNKNOWN_FIX',
    reason: 'Complex topology',
    matchedEnvelopeId: null,
    occurrenceSource: 'preflight'
  }, TEST_DIR);

  const inc23 = recordIncident({
    incidentId: 'inc_test_23',
    eventType: 'MEDIA_PLAYBACK_ERROR',
    severity: 'ERROR',
    fingerprintId: 'fp_23',
    localMediaName: 'runtime_error.mp4',
    localMediaPath: '/mock/runtime_error.mp4',
    classification: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
    reason: 'Format not supported',
    matchedEnvelopeId: null,
    occurrenceSource: 'client'
  }, TEST_DIR);

  const initialPending = readPendingIncidents(TEST_DIR);
  assert.strictEqual(initialPending.length, 2, 'Should start with 2 pending incidents');

  // Mock poster where #21 succeeds but #23 fails
  const mockPoster = (issueNum, body) => {
    if (issueNum === 21) {
      return true; // #21 comment succeeds
    }
    if (issueNum === 23) {
      return false; // #23 comment fails
    }
    return false;
  };

  const logs = [];
  const execResult = executeTriage({
    protoDir: TEST_DIR,
    isPost: true,
    isAck: true,
    poster: mockPoster,
    logger: (msg) => logs.push(msg)
  });

  // Verify published vs failed IDs
  assert.deepStrictEqual(execResult.publishedIncidentIds, ['inc_test_21'], 'Only inc_test_21 should be marked published');
  assert.deepStrictEqual(execResult.failedIncidentIds, ['inc_test_23'], 'inc_test_23 must be marked failed');

  // Verify persistent storage state
  const remainingPending = readPendingIncidents(TEST_DIR);
  const processedItems = readProcessedIncidents(TEST_DIR);

  assert.strictEqual(remainingPending.length, 1, 'Exactly 1 item must remain pending');
  assert.strictEqual(remainingPending[0].incidentId, 'inc_test_23', 'Failed publication inc_test_23 must remain in pending');

  assert.strictEqual(processedItems.length, 1, 'Exactly 1 item must be moved to processed');
  assert.strictEqual(processedItems[0].incidentId, 'inc_test_21', 'Successfully published inc_test_21 must move to processed');
  assert.strictEqual(processedItems[0].triageMeta.publishMode, 'github');
  console.log('  ✅ [PASS] Target #21 succeeded -> inc_test_21 acknowledged to processed');
  console.log('  ✅ [PASS] Target #23 failed -> inc_test_23 remained safely in pending');
  console.log('  ✅ [PASS] No evidence lost during partial publication failure');

  // Test 6: Manual acknowledgement mode without --post-github
  console.log('\nTest 6: Intentional manual acknowledgement mode (--ack without --post-github)');
  const manualAckLogs = [];
  executeTriage({
    protoDir: TEST_DIR,
    isPost: false,
    isAck: true,
    logger: (msg) => manualAckLogs.push(msg)
  });

  const finalPending = readPendingIncidents(TEST_DIR);
  const finalProcessed = readProcessedIncidents(TEST_DIR);
  assert.strictEqual(finalPending.length, 0, 'All items acknowledged in manual mode');
  assert.strictEqual(finalProcessed.length, 2, 'Both items now processed');
  assert.strictEqual(finalProcessed[1].triageMeta.publishMode, 'manual_ack');
  console.log('  ✅ [PASS] Manual ack mode functions as intentional distinct operation');

  console.log('\n------------------------------------------------------------');
  console.log('OVERALL FOCUSED TRIAGE TEST SUITE: ✅ ALL PASSED\n');
} finally {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
