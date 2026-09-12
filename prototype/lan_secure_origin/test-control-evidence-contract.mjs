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
import { CalibrationUI } from './src/controls/calibration-ui.js';
import { state } from './src/core/state.js';

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

function createTelem({ frameSeq = 10, acks = [], renderEvidence = [] } = {}) {
  return { controlEvidence: { renderFrameSeq: frameSeq, acks, renderEvidence } };
}

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
  const evalResult = client.evaluateTelemetryEvidence(record, createTelem());
  assert.strictEqual(evalResult.verdict, 'SERVER_ACCEPTED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 3: evaluateTelemetryEvidence returns APPLIED when ACK present but no render readback
test('3. Matching ACK alone yields APPLIED, never PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_102', action: 'set_diagnostic_overlay' };
  const telem = createTelem({
    frameSeq: 15,
    acks: [{ commandId: 'cmd_102', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 1000, appliedAt: 1005, appliedState: { key: 'showGrid', value: false } }]
  });
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
  assert.strictEqual(evalResult.iphoneAckReceived, true);
});

// Test 4: Mismatched commandId in render evidence does NOT satisfy Command A
test('4. Command B renderEvidence does NOT satisfy Command A', () => {
  const client = new ControlEvidenceClient();
  const recordA = { commandId: 'cmd_A', action: 'set_diagnostic_overlay' };
  const telem = createTelem({
    frameSeq: 20,
    acks: [{ commandId: 'cmd_A', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 1000, appliedAt: 1005, appliedState: { key: 'showGrid', value: false } }],
    renderEvidence: [{ commandId: 'cmd_B', action: 'set_diagnostic_overlay', frameSeq: 20, readbackAt: 1010, effectiveState: { diagOverlay: { showGrid: false } } }]
  });
  const evalResult = client.evaluateTelemetryEvidence(recordA, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED', 'Must not pass when renderEvidence.commandId !== record.commandId');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 5: Action mismatch in ACK or render evidence does not yield PASS
test('5. Action mismatch in ACK or render evidence does not yield PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_103', action: 'set_diagnostic_overlay' };
  const telemAckMismatch = createTelem({
    frameSeq: 25,
    acks: [{ commandId: 'cmd_103', action: 'set_reference_grid', status: 'applied', phoneReceivedAt: 2000, appliedAt: 2005 }]
  });
  assert.strictEqual(client.evaluateTelemetryEvidence(record, telemAckMismatch).verdict, 'REJECTED');

  const telemRenderMismatch = createTelem({
    frameSeq: 25,
    acks: [{ commandId: 'cmd_103', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 2000, appliedAt: 2005 }],
    renderEvidence: [{ commandId: 'cmd_103', action: 'set_reference_grid', frameSeq: 25, readbackAt: 2010, effectiveState: {} }]
  });
  const evalResult2 = client.evaluateTelemetryEvidence(record, telemRenderMismatch);
  assert.strictEqual(evalResult2.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult2.verdict, 'PASS');
});

// Test 6: Stale / non-monotonic timing is rejected
test('6. Non-monotonic causal timing does not yield PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_104', action: 'set_diagnostic_overlay', issuedAt: 3000, serverAcceptedAt: 3002 };
  const telem = createTelem({
    frameSeq: 25,
    acks: [{ commandId: 'cmd_104', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 3005, appliedAt: 3010 }],
    renderEvidence: [{ commandId: 'cmd_104', action: 'set_diagnostic_overlay', frameSeq: 25, readbackAt: 3008, effectiveState: { diagOverlay: { showGrid: false } } }]
  });
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 7: Fail closed when no supported expectation exists
test('7. Fail closed on unsupported action: never PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_105', action: 'set_viewer_params', payload: { action: 'set_viewer_params', k1: 0.1 }, issuedAt: 4000, serverAcceptedAt: 4002 };
  const telem = createTelem({
    frameSeq: 30,
    acks: [{ commandId: 'cmd_105', action: 'set_viewer_params', status: 'applied', phoneReceivedAt: 4005, appliedAt: 4010 }],
    renderEvidence: [{ commandId: 'cmd_105', action: 'set_viewer_params', frameSeq: 30, readbackAt: 4015, effectiveState: { k1: 0.1 } }]
  });
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'UNPROVEN', 'Must fail closed when expectation is absent');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 8: Effective state mismatch fails
test('8. Effective state mismatch fails validator expectation', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_106', action: 'set_diagnostic_overlay', payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false }, issuedAt: 5000, serverAcceptedAt: 5002 };
  const telem = createTelem({
    frameSeq: 35,
    acks: [{ commandId: 'cmd_106', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 5005, appliedAt: 5010 }],
    renderEvidence: [{ commandId: 'cmd_106', action: 'set_diagnostic_overlay', frameSeq: 35, readbackAt: 5015, effectiveState: { diagOverlay: { showGrid: true } } }]
  });
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 9: Complete causal chain satisfied: PASS
test('9. Complete causal chain (request -> server -> phone -> render readback -> state match) yields PASS', () => {
  const client = new ControlEvidenceClient();
  const record = { commandId: 'cmd_107', action: 'set_diagnostic_overlay', payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false }, issuedAt: 6000, serverAcceptedAt: 6002 };
  const telem = createTelem({
    frameSeq: 40,
    acks: [{ commandId: 'cmd_107', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 6005, appliedAt: 6010, appliedState: { key: 'showGrid', value: false } }],
    renderEvidence: [{ commandId: 'cmd_107', action: 'set_diagnostic_overlay', frameSeq: 40, readbackAt: 6015, effectiveState: { renderMode: 'diagnostic', diagOverlay: { showGrid: false, showPlumbLines: true, showHorizon: true } } }]
  });
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'PASS');
  assert.strictEqual(evalResult.renderConfirmed, true);
  assert.strictEqual(evalResult.iphoneAckReceived, true);
});

// Test 10: Runtime modeling: Command A and Command B received before next render commit
test('10. Runtime condition: Commands A and B arrive before next render commit and both obtain independent PASS', () => {
  const client = new ControlEvidenceClient();
  const recordA = { commandId: 'cmd_rapid_A', action: 'set_diagnostic_overlay', payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false }, issuedAt: 7000, serverAcceptedAt: 7002 };
  const recordB = { commandId: 'cmd_rapid_B', action: 'set_diagnostic_overlay', payload: { action: 'set_diagnostic_overlay', key: 'showHorizon', value: false }, issuedAt: 7003, serverAcceptedAt: 7004 };
  const telemBoth = createTelem({
    frameSeq: 50,
    acks: [
      { commandId: 'cmd_rapid_B', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 7006, appliedAt: 7008, appliedState: { key: 'showHorizon', value: false } },
      { commandId: 'cmd_rapid_A', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 7005, appliedAt: 7007, appliedState: { key: 'showGrid', value: false } }
    ],
    renderEvidence: [
      { commandId: 'cmd_rapid_B', action: 'set_diagnostic_overlay', frameSeq: 50, readbackAt: 7015, effectiveState: { renderMode: 'diagnostic', diagOverlay: { showGrid: false, showHorizon: false } } },
      { commandId: 'cmd_rapid_A', action: 'set_diagnostic_overlay', frameSeq: 50, readbackAt: 7015, effectiveState: { renderMode: 'diagnostic', diagOverlay: { showGrid: false, showHorizon: false } } }
    ]
  });
  assert.strictEqual(client.evaluateTelemetryEvidence(recordA, telemBoth).verdict, 'PASS', 'Command A must PASS independently');
  assert.strictEqual(client.evaluateTelemetryEvidence(recordB, telemBoth).verdict, 'PASS', 'Command B must PASS independently');
});

// Test 11: Conflicting Commands A and B on same property before render: Overwritten A never PASSes
test('11. Conflicting Commands A and B before render: Overwritten A never PASSes', () => {
  const client = new ControlEvidenceClient();
  const recordA = { commandId: 'cmd_conflict_A', action: 'set_diagnostic_overlay', payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false }, issuedAt: 8000, serverAcceptedAt: 8002 };
  const recordB = { commandId: 'cmd_conflict_B', action: 'set_diagnostic_overlay', payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: true }, issuedAt: 8003, serverAcceptedAt: 8004 };
  const telemConflict = createTelem({
    frameSeq: 60,
    acks: [
      { commandId: 'cmd_conflict_B', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 8006, appliedAt: 8008 },
      { commandId: 'cmd_conflict_A', action: 'set_diagnostic_overlay', status: 'applied', phoneReceivedAt: 8005, appliedAt: 8007 }
    ],
    renderEvidence: [
      { commandId: 'cmd_conflict_B', action: 'set_diagnostic_overlay', frameSeq: 60, readbackAt: 8015, effectiveState: { renderMode: 'diagnostic', diagOverlay: { showGrid: true } } },
      { commandId: 'cmd_conflict_A', action: 'set_diagnostic_overlay', frameSeq: 60, readbackAt: 8015, effectiveState: { renderMode: 'diagnostic', diagOverlay: { showGrid: true } } }
    ]
  });
  assert.strictEqual(client.evaluateTelemetryEvidence(recordA, telemConflict).verdict, 'APPLIED', 'Overwritten Command A must NOT PASS because rendered state was true');
  assert.strictEqual(client.evaluateTelemetryEvidence(recordB, telemConflict).verdict, 'PASS', 'Command B matches rendered state and PASSes');
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

// Test 14: Simulated multi-second clock offset between PC and iPhone domain still PASSes
test('14. Simulated cross-device clock offset (iPhone behind or ahead of PC) still PASSes', () => {
  const client = new ControlEvidenceClient();
  
  // Case A: iPhone clock is 10 seconds BEHIND PC clock
  const recordA = {
    commandId: 'cmd_skew_behind',
    action: 'set_diagnostic_overlay',
    payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false },
    issuedAt: 100000,
    serverAcceptedAt: 100005
  };
  const telemBehind = {
    controlEvidence: {
      renderFrameSeq: 70,
      acks: [{
        commandId: 'cmd_skew_behind',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 90000, // 10s behind PC issuedAt!
        appliedAt: 90005,
        appliedState: { key: 'showGrid', value: false }
      }],
      renderEvidence: [{
        commandId: 'cmd_skew_behind',
        action: 'set_diagnostic_overlay',
        frameSeq: 70,
        readbackAt: 90010, // 10s behind PC
        effectiveState: {
          renderMode: 'diagnostic',
          diagOverlay: { showGrid: false }
        }
      }]
    }
  };
  const evalBehind = client.evaluateTelemetryEvidence(recordA, telemBehind);
  assert.strictEqual(evalBehind.verdict, 'PASS', 'Clock behind PC must still PASS with local monotonic domain ordering');

  // Case B: iPhone clock is 10 seconds AHEAD of PC clock
  const recordB = {
    commandId: 'cmd_skew_ahead',
    action: 'set_diagnostic_overlay',
    payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false },
    issuedAt: 100000,
    serverAcceptedAt: 100005
  };
  const telemAhead = {
    controlEvidence: {
      renderFrameSeq: 71,
      acks: [{
        commandId: 'cmd_skew_ahead',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 110000, // 10s ahead of PC
        appliedAt: 110005,
        appliedState: { key: 'showGrid', value: false }
      }],
      renderEvidence: [{
        commandId: 'cmd_skew_ahead',
        action: 'set_diagnostic_overlay',
        frameSeq: 71,
        readbackAt: 110010, // 10s ahead of PC
        effectiveState: {
          renderMode: 'diagnostic',
          diagOverlay: { showGrid: false }
        }
      }]
    }
  };
  const evalAhead = client.evaluateTelemetryEvidence(recordB, telemAhead);
  assert.strictEqual(evalAhead.verdict, 'PASS', 'Clock ahead of PC must still PASS with local monotonic domain ordering');
});

// Test 15: Render-path consumption: diagnostic overlay in VR mode does NOT pass
test('15. Render-path consumption: diagnostic overlay while renderMode === "vr" fails expectation', () => {
  const client = new ControlEvidenceClient();
  const record = {
    commandId: 'cmd_render_mismatch',
    action: 'set_diagnostic_overlay',
    payload: { action: 'set_diagnostic_overlay', key: 'showGrid', value: false },
    issuedAt: 1000,
    serverAcceptedAt: 1002
  };
  const telem = {
    controlEvidence: {
      renderFrameSeq: 80,
      acks: [{
        commandId: 'cmd_render_mismatch',
        action: 'set_diagnostic_overlay',
        status: 'applied',
        phoneReceivedAt: 1005,
        appliedAt: 1008
      }],
      renderEvidence: [{
        commandId: 'cmd_render_mismatch',
        action: 'set_diagnostic_overlay',
        frameSeq: 80,
        readbackAt: 1012,
        // In VR mode, diagnostic overlay is NOT consumed by the render path!
        effectiveState: {
          renderMode: 'vr',
          diagOverlay: { showGrid: false }
        }
      }]
    }
  };
  const evalResult = client.evaluateTelemetryEvidence(record, telem);
  assert.strictEqual(evalResult.verdict, 'APPLIED', 'Must not PASS if renderMode !== diagnostic');
  assert.notStrictEqual(evalResult.verdict, 'PASS');
});

// Test 16: Render-path consumption: reference grid shader activation in VR mode
test('16. Render-path consumption: reference grid requires VR mode and shader activation', () => {
  const client = new ControlEvidenceClient();
  const record = {
    commandId: 'cmd_grid_1',
    action: 'set_reference_grid',
    payload: { action: 'set_reference_grid', enabled: true },
    issuedAt: 2000,
    serverAcceptedAt: 2002
  };

  // Case A: showReferenceGrid is true, but sceneType is 1 (Grid Only, not video grid) so shader inactive
  const telemShaderInactive = {
    controlEvidence: {
      renderFrameSeq: 85,
      acks: [{ commandId: 'cmd_grid_1', action: 'set_reference_grid', status: 'applied', phoneReceivedAt: 2005, appliedAt: 2008 }],
      renderEvidence: [{
        commandId: 'cmd_grid_1',
        action: 'set_reference_grid',
        frameSeq: 85,
        readbackAt: 2012,
        effectiveState: {
          renderMode: 'vr',
          sceneType: 1,
          showReferenceGrid: true,
          referenceGridActiveInShader: false // Inactive!
        }
      }]
    }
  };
  const evalInactive = client.evaluateTelemetryEvidence(record, telemShaderInactive);
  assert.strictEqual(evalInactive.verdict, 'APPLIED', 'Must not PASS if referenceGridActiveInShader is false');

  // Case B: sceneType is 0 and shader condition active -> PASS
  const telemShaderActive = {
    controlEvidence: {
      renderFrameSeq: 86,
      acks: [{ commandId: 'cmd_grid_1', action: 'set_reference_grid', status: 'applied', phoneReceivedAt: 2005, appliedAt: 2008 }],
      renderEvidence: [{
        commandId: 'cmd_grid_1',
        action: 'set_reference_grid',
        frameSeq: 86,
        readbackAt: 2012,
        effectiveState: {
          renderMode: 'vr',
          sceneType: 0,
          showReferenceGrid: true,
          referenceGridActiveInShader: true // Active!
        }
      }]
    }
  };
  const evalActive = client.evaluateTelemetryEvidence(record, telemShaderActive);
  assert.strictEqual(evalActive.verdict, 'PASS', 'Must PASS when active in VR shader');
});

// Test 17: Pre-mutation validation: invalid tracked payloads do NOT mutate state and are rejected
test('17. Pre-mutation validation: invalid payload rejected, no state mutation, no render commit', () => {
  const mockStorage = { activeViewerProfile: { distortion: { k1: 0, k2: 0 } } };
  const mockOverlay = { showGrid: false, showPlumbLines: false, showHorizon: false };
  const ui = new CalibrationUI({
    storage: mockStorage,
    diagnosticOverlay: mockOverlay
  });

  // 1. Invalid eye value (eye: 2)
  ui.handleRemoteControlAction({
    commandId: 'cmd_invalid_eye',
    action: 'set_diagnostic_eye',
    eye: 2
  });
  assert.strictEqual(ui.selectedEye, 0, 'selectedEye must NOT be mutated');
  assert.strictEqual(ui.recentCommandAcks.length, 1);
  assert.strictEqual(ui.recentCommandAcks[0].status, 'rejected');
  assert.strictEqual(ui.pendingRenderCommits.length, 0, 'No render commit armed for rejected command');

  // 2. Invalid overlay key
  ui.handleRemoteControlAction({
    commandId: 'cmd_invalid_overlay_key',
    action: 'set_diagnostic_overlay',
    key: 'invalidKey',
    value: true
  });
  assert.strictEqual(mockOverlay.showGrid, false, 'showGrid must remain false');
  assert.strictEqual(mockOverlay.invalidKey, undefined, 'Invalid key must not be written');
  assert.strictEqual(ui.recentCommandAcks[0].status, 'rejected');
  assert.strictEqual(ui.pendingRenderCommits.length, 0);

  // 3. Invalid overlay value (non-boolean)
  ui.handleRemoteControlAction({
    commandId: 'cmd_invalid_overlay_val',
    action: 'set_diagnostic_overlay',
    key: 'showGrid',
    value: 'yes'
  });
  assert.strictEqual(mockOverlay.showGrid, false, 'showGrid must remain false');
  assert.strictEqual(ui.recentCommandAcks[0].status, 'rejected');
  assert.strictEqual(ui.pendingRenderCommits.length, 0);

  // 4. Invalid reference grid value (non-boolean)
  state.showReferenceGrid = false;
  ui.handleRemoteControlAction({
    commandId: 'cmd_invalid_grid',
    action: 'set_reference_grid',
    enabled: 'true'
  });
  assert.strictEqual(state.showReferenceGrid, false, 'state.showReferenceGrid must remain false');
  assert.strictEqual(ui.recentCommandAcks[0].status, 'rejected');
  assert.strictEqual(ui.pendingRenderCommits.length, 0);

  // 5. Valid tracked command mutates state and arms commit
  ui.handleRemoteControlAction({
    commandId: 'cmd_valid_eye',
    action: 'set_diagnostic_eye',
    eye: 1
  });
  assert.strictEqual(ui.selectedEye, 1, 'selectedEye mutated on valid command');
  assert.strictEqual(ui.recentCommandAcks[0].status, 'applied');
  assert.strictEqual(ui.pendingRenderCommits.length, 1, 'Render commit armed');
  assert.strictEqual(ui.pendingRenderCommits[0].commandId, 'cmd_valid_eye');
});

console.log(`\nAll ${passedTests}/${totalTests} Control Evidence Contract tests PASSED successfully!\n`);
