// =========================================================================
// Automated Test Suite: Control Evidence Contract
// =========================================================================
// Verifies:
// 1. PC owns experimental commandId and server preserves it unchanged.
// 2. HTTP 200 / serverAccepted alone yields SERVER_ACCEPTED / UNPROVEN, NEVER PASS.
// 3. iPhone ACK without matching renderer readback yields APPLIED, NOT PASS.
// 4. Stale renderer readback (older than apply time) does NOT satisfy PASS.
// 5. Mismatched commandId in renderer readback does NOT satisfy PASS (Command B readback cannot satisfy Command A).
// 6. Generic latest-state snapshot without matching commandId NEVER satisfies PASS.
// 7. Full causal match: request.commandId === ack.commandId === renderEvidence.commandId + matching effective state -> PASS.
// 8. Timeout handling: disconnected / absent telemetry results in TIMEOUT.

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
      lastAck: null,
      lastRenderEvidence: null
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
      lastAck: {
        commandId: 'cmd_102',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 1000,
        appliedAt: 1005,
        appliedState: { key: 'showGrid', value: false }
      },
      lastRenderEvidence: null
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
      lastAck: {
        commandId: 'cmd_A',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 1000,
        appliedAt: 1005,
        appliedState: { key: 'showGrid', value: false }
      },
      // Render evidence is from Command B!
      lastRenderEvidence: {
        commandId: 'cmd_B',
        action: 'set_diagnostic_overlay',
        frameSeq: 20,
        readbackAt: 1010,
        effectiveState: { diagOverlay: { showGrid: false } }
      }
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(recordA, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED', 'Must not pass when renderEvidence.commandId !== record.commandId');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 5: Stale readback timestamp older than appliedAt is rejected
test('5. Readback older than appliedAt does not yield PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_103', action: 'set_diagnostic_overlay' };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 25,
      lastAck: {
        commandId: 'cmd_103',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 2000,
        appliedAt: 2005
      },
      lastRenderEvidence: {
        commandId: 'cmd_103',
        action: 'set_diagnostic_overlay',
        frameSeq: 24,
        readbackAt: 1999, // Stale!
        effectiveState: { diagOverlay: { showGrid: false } }
      }
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 6: Effective state mismatch fails validator predicate
test('6. Effective state mismatch does not yield PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_104', action: 'set_diagnostic_overlay' };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 30,
      lastAck: {
        commandId: 'cmd_104',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 3000,
        appliedAt: 3005
      },
      lastRenderEvidence: {
        commandId: 'cmd_104',
        action: 'set_diagnostic_overlay',
        frameSeq: 30,
        readbackAt: 3010,
        effectiveState: { diagOverlay: { showGrid: true } } // Mismatched! Expected false
      }
    }
  };
  const expectationFn = (t, eff) => eff.diagOverlay && eff.diagOverlay.showGrid === false;
  const evalResult = client.evaluateTelemetryEvidence(record, telem, expectationFn);
  assert.strictEqual(evalResult.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 7: Full causal chain satisfied: PASS
test('7. Complete causal chain (request -> server -> phone -> render readback -> state match) yields PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_105', action: 'set_diagnostic_overlay' };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 35,
      lastAck: {
        commandId: 'cmd_105',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 4000,
        appliedAt: 4005,
        appliedState: { key: 'showGrid', value: false }
      },
      lastRenderEvidence: {
        commandId: 'cmd_105',
        action: 'set_diagnostic_overlay',
        frameSeq: 35,
        readbackAt: 4010,
        effectiveState: { diagOverlay: { showGrid: false, showPlumbLines: true, showHorizon: true } }
      }
    }
  };
  const expectationFn = (t, eff) => eff.diagOverlay && eff.diagOverlay.showGrid === false;
  const evalResult = client.evaluateTelemetryEvidence(record, telem, expectationFn);
  assert.strictEqual(evalResult.verdict, 'PASS');
  assert.strictEqual(evalResult.renderConfirmed, true);
  assert.strictEqual(evalResult.iphoneAckReceived, true);
});

// Test 8: Rejected action on phone yields REJECTED
test('8. iPhone rejection yields REJECTED verdict', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_106', action: 'invalid_action' };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 40,
      lastAck: {
        commandId: 'cmd_106',
        action: 'invalid_action',
        status: 'rejected',
        reason: 'Unrecognized action',
        phoneReceivedAt: 5000,
        appliedAt: 5001
      },
      lastRenderEvidence: null
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'REJECTED');
});

// Test 9: Rapid succession - Command A followed by Command B
test('9. Rapid succession: Command A and Command B maintain distinct causal evidence without crosstalk', () => {
  const client = new ControlEvidenceClient();
  const recordA = { commandId: 'cmd_seq_A', action: 'set_diagnostic_overlay' };
  const recordB = { commandId: 'cmd_seq_B', action: 'set_diagnostic_overlay' };

  // Telemetry when Command A applied and rendered
  const telemA = {
    controlEvidence: {
      renderFrameSeq: 50,
      lastAck: {
        commandId: 'cmd_seq_A',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 6000,
        appliedAt: 6005
      },
      lastRenderEvidence: {
        commandId: 'cmd_seq_A',
        action: 'set_diagnostic_overlay',
        frameSeq: 50,
        readbackAt: 6010,
        effectiveState: { diagOverlay: { showGrid: false } }
      }
    }
  };

  const evalA = client.evaluateTelemetryEvidence(recordA, telemA, (t, eff) => !eff.diagOverlay.showGrid);
  assert.strictEqual(evalA.verdict, 'PASS');

  // Next frame: Command B arrives and is applied and rendered
  const telemB = {
    controlEvidence: {
      renderFrameSeq: 51,
      lastAck: {
        commandId: 'cmd_seq_B',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 6015,
        appliedAt: 6020
      },
      lastRenderEvidence: {
        commandId: 'cmd_seq_B',
        action: 'set_diagnostic_overlay',
        frameSeq: 51,
        readbackAt: 6025,
        effectiveState: { diagOverlay: { showHorizon: false } }
      }
    }
  };

  const evalB = client.evaluateTelemetryEvidence(recordB, telemB, (t, eff) => !eff.diagOverlay.showHorizon);
  assert.strictEqual(evalB.verdict, 'PASS');

  // Verify that evaluating telemB against recordA does NOT falsely satisfy recordA
  const evalA_on_B = client.evaluateTelemetryEvidence(recordA, telemB);
  assert.notStrictEqual(evalA_on_B.verdict, 'PASS');
});

// Test 10: Mock dispatchTrackedCommand network integration with timeout (offline client)
await testAsync('10. Mock dispatchTrackedCommand times out when telemetry never arrives', async () => {
  // Mock fetch: server accepts POST, but GET /api/telemetry returns no evidence
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
