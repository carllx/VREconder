import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordIncident,
  readPendingIncidents,
  readProcessedIncidents,
  acknowledgeIncidents,
  getIncidentFilePaths
} from './src/telemetry/incident-store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DIR = path.join(__dirname, 'test_incident_sandbox');

console.log('=== RUNNING ISSUE #24 INCIDENT STORE TEST SUITE ===\n');

// Clean sandbox
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

try {
  // 1. Initial state
  console.log('Test 1: Initial empty state');
  const initialPending = readPendingIncidents(TEST_DIR);
  assert.strictEqual(initialPending.length, 0, 'Initial pending incidents should be empty');
  const initialProcessed = readProcessedIncidents(TEST_DIR);
  assert.strictEqual(initialProcessed.length, 0, 'Initial processed incidents should be empty');
  console.log('  ✅ [PASS] Empty state verified');

  // 2. Recording incidents
  console.log('\nTest 2: Record incidents');
  const inc1 = recordIncident({
    eventType: 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY',
    severity: 'WARN',
    fingerprintId: 'fp_test_123',
    localMediaName: 'test_blocked.mp4',
    localMediaPath: '/mock/path/test_blocked.mp4',
    classification: 'NORMALIZATION_CANDIDATE_CERTIFIED',
    reason: 'HEVC mp4 requires hvc1 repacking',
    matchedEnvelopeId: 'ENV_HEVC_REPACK',
    allowedNextActions: ['REPACK_HVC1'],
    occurrenceSource: 'test_runner'
  }, TEST_DIR);

  assert.ok(inc1.incidentId.startsWith('inc_'), 'incidentId should have prefix inc_');
  assert.strictEqual(inc1.classification, 'NORMALIZATION_CANDIDATE_CERTIFIED');

  const inc2 = recordIncident({
    eventType: 'MEDIA_PLAYBACK_ERROR',
    severity: 'ERROR',
    fingerprintId: 'fp_test_456',
    localMediaName: 'test_error.mp4',
    localMediaPath: '/mock/path/test_error.mp4',
    classification: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
    reason: 'Format not supported',
    matchedEnvelopeId: null,
    allowedNextActions: [],
    occurrenceSource: 'client_telemetry'
  }, TEST_DIR);

  const pendingAfterRecord = readPendingIncidents(TEST_DIR);
  assert.strictEqual(pendingAfterRecord.length, 2, 'Should have 2 pending incidents');
  assert.strictEqual(pendingAfterRecord[0].incidentId, inc1.incidentId);
  assert.strictEqual(pendingAfterRecord[1].incidentId, inc2.incidentId);
  console.log('  ✅ [PASS] 2 incidents recorded and read accurately');

  // 3. Acknowledge single incident
  console.log('\nTest 3: Acknowledge incident');
  const ackRes1 = acknowledgeIncidents([inc1.incidentId], { triagedBy: 'unit_test' }, TEST_DIR);
  assert.strictEqual(ackRes1.acknowledgedCount, 1, 'Should acknowledge 1 item');
  assert.strictEqual(ackRes1.remainingCount, 1, 'Should have 1 remaining item');

  const pendingAfterAck = readPendingIncidents(TEST_DIR);
  assert.strictEqual(pendingAfterAck.length, 1, 'Only 1 item should remain pending');
  assert.strictEqual(pendingAfterAck[0].incidentId, inc2.incidentId);

  const processedAfterAck = readProcessedIncidents(TEST_DIR);
  assert.strictEqual(processedAfterAck.length, 1, 'Processed should have 1 item');
  assert.strictEqual(processedAfterAck[0].incidentId, inc1.incidentId);
  assert.strictEqual(processedAfterAck[0].triageMeta.triagedBy, 'unit_test');
  assert.ok(processedAfterAck[0].triagedAt, 'triagedAt timestamp should exist');
  console.log('  ✅ [PASS] Acknowledging correctly transitions incident to processed');

  // 4. Acknowledge remaining
  console.log('\nTest 4: Acknowledge remaining incidents');
  const ackRes2 = acknowledgeIncidents([inc2.incidentId], {}, TEST_DIR);
  assert.strictEqual(ackRes2.acknowledgedCount, 1);
  assert.strictEqual(ackRes2.remainingCount, 0);

  assert.strictEqual(readPendingIncidents(TEST_DIR).length, 0);
  assert.strictEqual(readProcessedIncidents(TEST_DIR).length, 2);
  console.log('  ✅ [PASS] All incidents moved to processed');

  console.log('\n------------------------------------------------------------');
  console.log('OVERALL INCIDENT STORE TEST SUITE: ✅ ALL PASSED\n');
} finally {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
