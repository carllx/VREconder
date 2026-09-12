// =========================================================================
// Automated Test Suite: Control Evidence Contract
// =========================================================================
// Verifies:
// 1. PC owns experimental commandId and server preserves it unchanged.
// 2. HTTP 200 / serverAccepted alone yields SERVER_ACCEPTED / UNPROVEN, NEVER PASS.
// 3. iPhone ACK without matching renderer readback yields APPLIED, NOT PASS.
// 4. Stale/non-monotonic renderer readback does NOT satisfy PASS.
// 5. Mismatched commandId or action in renderer readback does NOT satisfy PASS.
// 6. Generic latest-state snapshot without matching commandId NEVER satisfies PASS.
// 7. Fail closed on effective-state verification: unsupported / absent expectation NEVER yields PASS.
// 8. Unsupported/untracked commands do not start 4s polling and never receive scientific PASS.
// 9. Full causal match: request.commandId === ack.commandId === renderEvidence.commandId + monotonic timing + state match -> PASS.
// 10. Runtime condition modeling: Receive Command A, receive Command B before a render commit, retain independently correlated evidence without cross-talk or lost PASS.
// 11. Conflicting Commands A and B before render commit: Command A's overwritten state never receives PASS.
// 12. Timeout handling: disconnected / absent telemetry results in TIMEOUT.

import assert from 'assert';
import { ControlEvidenceClient } from './src/controls/control-evidence-client.js';

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

async function testAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

console.log('\n--- Running Control Evidence Contract Tests ---');

// Test 1: PC generates unique commandId before dispatch
test('1. PC generates unique commandId with prefix', () => {
  const client = new ControlEvidenceClient();
  const id1 = client.generateCommandId('test');
  const id2 = client.generateCommandId('test');
  assert.ok(id1.startsWith('test_'), 'ID starts with prefix');
  assert.notStrictEqual(id1, id2, 'Successive IDs are strictly unique');
});

// Test 2: evaluateTelemetryEvidence returns SERVER_ACCEPTED when no telemetry or ACK
test('2. Missing ACK remains SERVER_ACCEPTED / UNPROVEN, never PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_101', action: 'set_diagnostic_overlay' };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 10,
      acks: [],
      renderEvidence: []
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'SERVER_ACCEPTED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 3: evaluateTelemetryEvidence returns APPLIED when ACK present but no render readback
test('3. Matching ACK alone yields APPLIED, never PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_102', action: 'set_diagnostic_overlay' };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 15,
      acks: [{
        commandId: 'cmd_102',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 1000,
        appliedAt: 1005,
        appliedState: { key: 'showGrid', value: false }
      }],
      renderEvidence: []
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
  assert.strictEqual(evalResult.iphoneAckReceived, true);
});

// Test 4: Mismatched commandId in render evidence does NOT satisfy Command A
test('4. Command B renderEvidence does NOT satisfy Command A', () => {
  const client = new ControlEvidenceClient();
  const recordA = { commandId: 'cmd_A', action: 'set_diagnostic_overlay' };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 20,
      acks: [{
        commandId: 'cmd_A',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 1000,
        appliedAt: 1005,
        appliedState: { key: 'showGrid', value: false }
      }],
      // Render evidence is from Command B!
      renderEvidence: [{
        commandId: 'cmd_B',
        action: 'set_diagnostic_overlay',
        frameSeq: 20,
        readbackAt: 1010,
        effectiveState: { diagOverlay: { showGrid: false } }
      }]
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(recordA, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED', 'Must not pass when renderEvidence.commandId !== record.commandId');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 5: Action mismatch in ACK or render evidence does not yield PASS
test('5. Action mismatch in ACK or render evidence does not yield PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_103', action: 'set_diagnostic_overlay' };
  const telemAckMismatch = {
    controlEvidence: {
      renderFrameSeq: 25,
      acks: [{
        commandId: 'cmd_103',
        action: 'set_reference_grid', // Mismatch!
        status: 'applied',
        phoneReceivedAt: 2000,
        appliedAt: 2005
      }],
      renderEvidence: []
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telemAckMismatch);
  assert.strictEqual(evalResult.verdict, 'REJECTED');

  const telemRenderMismatch = {
    controlEvidence: {
      renderFrameSeq: 25,
      acks: [{
        commandId: 'cmd_103',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 2000,
        appliedAt: 2005
      }],
      renderEvidence: [{
        commandId: 'cmd_103',
        action: 'set_reference_grid', // Mismatch!
        frameSeq: 25,
        readbackAt: 2010,
        effectiveState: {}
      }]
    }
  };
  const evalResult2 = client.evaluateTelemetryEvidence(record, telemRenderMismatch);
  assert.strictEqual(evalResult2.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult2.verdict, 'PASS');
});

// Test 6: Stale / non-monotonic timing is rejected
test('6. Non-monotonic causal timing does not yield PASS', () => {
  const client = new ControlEvidenceClient();
  const record = {
    commandId: 'cmd_104',
    action: 'set_diagnostic_overlay',
    issuedAt: 3000,
    serverAcceptedAt: 3002
  };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 25,
      acks: [{
        commandId: 'cmd_104',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 3005,
        appliedAt: 3010
      }],
      renderEvidence: [{
        commandId: 'cmd_104',
        action: 'set_diagnostic_overlay',
        frameSeq: 25,
        readbackAt: 3008, // Stale! readbackAt < appliedAt
        effectiveState: { diagOverlay: { showGrid: false } }
      }]
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 7: Fail closed when no supported expectation exists
test('7. Fail closed on unsupported action: never PASS', () => {
  const client = new ControlEvidenceClient();
  const record = {
    commandId: 'cmd_105',
    action: 'set_viewer_params', // Non-allowlisted experimental action
    payload: { action: 'set_viewer_params', k1: 0.1 },
    issuedAt: 4000,
    serverAcceptedAt: 4002
  };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 30,
      acks: [{
        commandId: 'cmd_105',
        action: 'set_viewer_params',
        status: 'applied',
        phoneReceivedAt: 4005,
        appliedAt: 4010
      }],
      renderEvidence: [{
        commandId: 'cmd_105',
        action: 'set_viewer_params',
        frameSeq: 30,
        readbackAt: 4015,
        effectiveState: { k1: 0.1 }
      }]
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'UNPROVEN', 'Must fail closed when expectation is absent');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 8: Effective state mismatch fails
test('8. Effective state mismatch fails validator expectation', () => {
  const client = new ControlEvidenceClient();
  const record = {
    commandId: 'cmd_106',
    action: 'set_diagnostic_overlay',
    payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false },
    issuedAt: 5000,
    serverAcceptedAt: 5002
  };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 35,
      acks: [{
        commandId: 'cmd_106',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 5005,
        appliedAt: 5010
      }],
      renderEvidence: [{
        commandId: 'cmd_106',
        action: 'set_diagnostic_overlay',
        frameSeq: 35,
        readbackAt: 5015,
        effectiveState: { diagOverlay: { showGrid: true } } // Mismatch: expected false
      }]
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 9: Complete causal chain satisfied: PASS
test('9. Complete causal chain (request -> server -> phone -> render readback -> state match) yields PASS', () => {
  const client = new ControlEvidenceClient();
  const record = {
    commandId: 'cmd_107',
    action: 'set_diagnostic_overlay',
    payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false },
    issuedAt: 6000,
    serverAcceptedAt: 6002
  };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 40,
      acks: [{
        commandId: 'cmd_107',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 6005,
        appliedAt: 6010,
        appliedState: { key: 'showGrid', value: false }
      }],
      renderEvidence: [{
        commandId: 'cmd_107',
        action: 'set_diagnostic_overlay',
        frameSeq: 40,
        readbackAt: 6015,
        effectiveState: { diagOverlay: { showGrid: false, showPlumbLines: true, showHorizon: true } }
      }]
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'PASS');
  assert.strictEqual(evalResult.renderConfirmed, true);
  assert.strictEqual(evalResult.iphoneAckReceived, true);
});

// Test 10: Runtime modeling: Command A and Command B received before next render commit
test('10. Runtime condition: Commands A and B arrive before next render commit and both obtain independent PASS', () => {
  const client = new ControlEvidenceClient();
  const recordA = {
    commandId: 'cmd_rapid_A',
    action: 'set_diagnostic_overlay',
    payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false },
    issuedAt: 7000,
    serverAcceptedAt: 7002
  };
  const recordB = {
    commandId: 'cmd_rapid_B',
    action: 'set_diagnostic_overlay',
    payload: { action: 'set_diagnostic_overlay', key: 'showHorizon', value: false },
    issuedAt: 7003,
    serverAcceptedAt: 7004
  };

  // Telemetry representing single subsequent render frame where both pending commits were drained
  const telemBoth = {
    controlEvidence: {
      renderFrameSeq: 50,
      acks: [
        {
          commandId: 'cmd_rapid_B',
          action: 'set_diagnostic_overlay',
          status: 'applied',
          phoneReceivedAt: 7006,
          appliedAt: 7008,
          appliedState: { key: 'showHorizon', value: false }
        },
        {
          commandId: 'cmd_rapid_A',
          action: 'set_diagnostic_overlay',
          status: 'applied',
          phoneReceivedAt: 7005,
          appliedAt: 7007,
          appliedState: { key: 'showGrid', value: false }
        }
      ],
      renderEvidence: [
        {
          commandId: 'cmd_rapid_B',
          action: 'set_diagnostic_overlay',
          frameSeq: 50,
          readbackAt: 7015,
          effectiveState: { diagOverlay: { showGrid: false, showHorizon: false } }
        },
        {
          commandId: 'cmd_rapid_A',
          action: 'set_diagnostic_overlay',
          frameSeq: 50,
          readbackAt: 7015,
          effectiveState: { diagOverlay: { showGrid: false, showHorizon: false } }
        }
      ]
    }
  };

  const evalA = client.evaluateTelemetryEvidence(recordA, telemBoth);
  const evalB = client.evaluateTelemetryEvidence(recordB, telemBoth);

  assert.strictEqual(evalA.verdict, 'PASS', 'Command A must PASS independently');
  assert.strictEqual(evalB.verdict, 'PASS', 'Command B must PASS independently');
});

// Test 11: Conflicting Commands A and B on same property before render: Overwritten A never PASSes
test('11. Conflicting Commands A and B before render: Overwritten A never PASSes', () => {
  const client = new ControlEvidenceClient();
  const recordA = {
    commandId: 'cmd_conflict_A',
    action: 'set_diagnostic_overlay',
    payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false }, // Wanted false
    issuedAt: 8000,
    serverAcceptedAt: 8002
  };
  const recordB = {
    commandId: 'cmd_conflict_B',
    action: 'set_diagnostic_overlay',
    payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: true }, // Overwrote with true before render
    issuedAt: 8003,
    serverAcceptedAt: 8004
  };

  const telemConflict = {
    controlEvidence: {
      renderFrameSeq: 60,
      acks: [
        { commandId: 'cmd_conflict_B', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 8006, appliedAt: 8008 },
        { commandId: 'cmd_conflict_A', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 8005, appliedAt: 8007 }
      ],
      renderEvidence: [
        { commandId: 'cmd_conflict_B', action: 'set_diagnostic_overlay', frameSeq: 60, readbackAt: 8015, effectiveState: { diagOverlay: { showGrid: true } } },
        { commandId: 'cmd_conflict_A', action: 'set_diagnostic_overlay', frameSeq: 60, readbackAt: 8015, effectiveState: { diagOverlay: { showGrid: true } } }
      ]
    }
  };

  const evalA = client.evaluateTelemetryEvidence(recordA, telemConflict);
  const evalB = client.evaluateTelemetryEvidence(recordB, telemConflict);

  assert.strictEqual(evalA.verdict, 'APPLIED', 'Overwritten Command A must NOT PASS because rendered state was true');
  assert.strictEqual(evalB.verdict, 'PASS', 'Command B matches rendered state and PASSes');
});

// Test 12: Unsupported / general controller commands remain untracked and do not poll
await testAsync('12. Unsupported / general controller commands remain untracked and do not poll', async () => {
  let postCount = 0;
  let telemCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/calibration/control') {
      postCount++;
      return { ok: true, json: async () => ({ status: 'ok', broadcasted: true }) };
    }
    if (url === '/api/telemetry') {
      telemCount++;
      return { ok: true, json: async () => ({ latestTelemetry: {} }) };
    }
    return { ok: false, status: 404 };
  };

  try {
    const client = new ControlEvidenceClient();
    const result = await client.dispatchTrackedCommand({ action: 'select_media', relPath: 'test.mp4' });
    assert.strictEqual(result.untracked, true, 'Marked as untracked');
    assert.strictEqual(result.verdict, 'UNPROVEN', 'Verdict is UNPROVEN');
    assert.strictEqual(postCount, 1, 'Sent POST once');
    assert.strictEqual(telemCount, 0, 'Did NOT poll telemetry for unsupported command');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Test 13: Mock dispatchTrackedCommand network integration with timeout (offline client)
await testAsync('13. Mock dispatchTrackedCommand times out when telemetry never arrives', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/calibration/control') {
      const body = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          status: 'ok',
          broadcasted: true,
          commandId: body.commandId,
          serverAcceptedAt: Date.now()
        })
      };
    }
    if (url === '/api/telemetry') {
      return {
        ok: true,
        json: async () => ({ latestTelemetry: null })
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    const client = new ControlEvidenceClient({ timeoutMs: 300, pollIntervalMs: 50 });
    const result = await client.dispatchTrackedCommand({
      action: 'set_diagnostic_overlay',
      key: 'showGrid',
      value: false
    });
    assert.strictEqual(result.serverAccepted, true, 'Server accepted command');
    assert.strictEqual(result.verdict, 'TIMEOUT', 'Verdict is TIMEOUT when telemetry absent');
    assert.notStrictEqual(result.verdict, 'PASS', 'Never PASS without evidence');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`\nAll ${passedTests}/${totalTests} Control Evidence Contract tests PASSED successfully!\n`);
