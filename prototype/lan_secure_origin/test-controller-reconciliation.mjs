import assert from 'node:assert/strict';

// Create minimal DOM mock for controller-app module import
const domElements = {};
const mockElement = (id) => {
  if (!domElements[id]) {
    domElements[id] = {
      id,
      textContent: '',
      value: '0',
      style: {},
      options: [],
      disabled: false,
      classList: {
        toggle: (cls, val) => { domElements[id][cls] = val; },
        contains: (cls) => !!domElements[id][cls]
      },
      addEventListener: () => {},
      removeEventListener: () => {}
    };
  }
  return domElements[id];
};

globalThis.document = {
  getElementById: (id) => mockElement(id),
  body: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {}
};
globalThis.window = {};
globalThis.EventSource = class {
  constructor() {}
};
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({})
});

const ctrl = await import('./src/controls/controller-app.js');

console.log('--- RUNNING CONTROLLER RECONCILIATION TEST SUITE ---');

// Test A: Cached telemetry with vertical_alignment while phone is OFFLINE must NOT snap controller back from grid_only
ctrl.currentIphoneStatus.state = 'offline';
ctrl.setViewerVisualMode('grid_only'); // fails closed when offline
assert.equal(ctrl.currentVisualMode, 'grid_only', 'Initial visual mode is grid_only');

const cachedOfflineTelemetry = {
  type: 'telemetry_sync',
  calibrationStage: 'B',
  viewerVisualMode: 'vertical_alignment',
  opticsRuntime: { calibrationDistortionOverrideActive: false }
};
ctrl.updateTelemetryUI(cachedOfflineTelemetry);
assert.equal(ctrl.currentVisualMode, 'grid_only', 'TEST A PASS: Offline cached telemetry must NOT snap back visualMode to vertical_alignment');

// Test B: Cached telemetry while phone is STALE must NOT override controller state
ctrl.currentIphoneStatus.state = 'stale';
ctrl.updateTelemetryUI(cachedOfflineTelemetry);
assert.equal(ctrl.currentVisualMode, 'grid_only', 'TEST B PASS: Stale telemetry must NOT override controller visualMode');

// Test C: When phone is ACTIVE, fresh telemetry with matching or updated visual mode reconciles authoritatively
ctrl.currentIphoneStatus.state = 'active';
ctrl.setViewerVisualMode('grid_only');
assert.equal(ctrl.currentVisualMode, 'grid_only');

// Echo arrives confirming grid_only
const activeGridTelemetry = {
  type: 'telemetry_sync',
  calibrationStage: 'B',
  viewerVisualMode: 'grid_only',
  opticsRuntime: { calibrationDistortionOverrideActive: false }
};
ctrl.updateTelemetryUI(activeGridTelemetry);
assert.equal(ctrl.pendingAck, null, 'Pending ack should clear upon matching echo');
assert.equal(ctrl.currentVisualMode, 'grid_only', 'TEST C PASS: Active phone echo confirms grid_only');

// Test D: If visual mode requested without fresh ack, O4 fitting cannot become ACTIVE
ctrl.currentIphoneStatus.state = 'offline';
ctrl.toggleO4FittingMode();
assert.equal(ctrl.o4FittingActive, false, 'TEST D1 PASS: Cannot toggle O4 fitting while phone is offline');

ctrl.currentIphoneStatus.state = 'active';
ctrl.setStage('B');
assert.ok(ctrl.pendingAck !== null, 'Stage switch sets pending ack');
ctrl.toggleO4FittingMode();
assert.equal(ctrl.o4FittingActive, false, 'TEST D2 PASS: Cannot activate O4 fitting while command ack is pending');

// Echo confirms Stage B
ctrl.updateTelemetryUI(activeGridTelemetry);
assert.equal(ctrl.currentStage, 'B');
assert.equal(ctrl.pendingAck, null);

// Test E: With confirmed active Stage B + grid_only, O4 fitting toggle succeeds
ctrl.toggleO4FittingMode();
assert.equal(ctrl.o4FittingActive, true, 'TEST E PASS: O4 fitting successfully activates under confirmed Stage B + grid_only + active phone');

// Test F: Active phone telemetry legitimately changes visual mode (e.g. phone user changed mode or stage)
const activePhoneModeChange = {
  type: 'telemetry_sync',
  calibrationStage: 'B',
  viewerVisualMode: 'vertical_alignment',
  opticsRuntime: { calibrationDistortionOverrideActive: false }
};
ctrl.updateTelemetryUI(activeGridTelemetry);
ctrl.updateTelemetryUI(activePhoneModeChange);
assert.equal(ctrl.currentVisualMode, 'vertical_alignment', 'TEST F PASS: Active phone can legitimately reconcile visual mode');
assert.equal(ctrl.o4FittingActive, false, 'O4 fitting must deactivate when visual mode is no longer grid_only');

// Test G: Diagnostic values in cached telemetry remain readable even when offline
ctrl.currentIphoneStatus.state = 'offline';
ctrl.updateTelemetryUI({
  type: 'telemetry_sync',
  fps: 59.9,
  calibrationStage: 'B',
  viewerVisualMode: 'vertical_alignment'
});
assert.equal(domElements['valFps'].textContent, '59.9 FPS', 'TEST G PASS: Diagnostic telemetry like fps updates even when offline');
assert.equal(ctrl.currentVisualMode, 'vertical_alignment', 'Visual mode remains unchanged by offline telemetry');

// Test H: O4 Panel Derivation & Reconciliation Invariants
// Case 1: active phone, Stage B, grid_only, fitting=false => panelO4Fitting visible
ctrl.currentIphoneStatus.state = 'active';
ctrl.setStage('B');
ctrl.updateTelemetryUI({
  type: 'telemetry_sync',
  calibrationStage: 'B',
  viewerVisualMode: 'grid_only',
  opticsRuntime: { calibrationDistortionOverrideActive: false }
});
assert.equal(domElements['panelO4Fitting'].style.display, 'block', 'TEST H1 PASS: Stage B + grid_only + fitting=false => panelO4Fitting visible');

// Case 2: active reconciliation vertical_alignment -> grid_only => final panel visible
ctrl.updateTelemetryUI({
  type: 'telemetry_sync',
  calibrationStage: 'B',
  viewerVisualMode: 'vertical_alignment',
  opticsRuntime: { calibrationDistortionOverrideActive: false }
});
assert.equal(domElements['panelO4Fitting'].style.display, 'none', 'Intermediate: vertical_alignment hides panel');
ctrl.updateTelemetryUI({
  type: 'telemetry_sync',
  calibrationStage: 'B',
  viewerVisualMode: 'grid_only',
  opticsRuntime: { calibrationDistortionOverrideActive: false }
});
assert.equal(domElements['panelO4Fitting'].style.display, 'block', 'TEST H2 PASS: reconciliation vertical_alignment -> grid_only leaves panel visible');

// Case 3: active reconciliation grid_only -> vertical_alignment => final panel hidden
ctrl.updateTelemetryUI({
  type: 'telemetry_sync',
  calibrationStage: 'B',
  viewerVisualMode: 'vertical_alignment',
  opticsRuntime: { calibrationDistortionOverrideActive: false }
});
assert.equal(domElements['panelO4Fitting'].style.display, 'none', 'TEST H3 PASS: reconciliation grid_only -> vertical_alignment leaves panel hidden');

// Case 4: stage != B => panel hidden
ctrl.updateTelemetryUI({
  type: 'telemetry_sync',
  calibrationStage: 'A',
  viewerVisualMode: 'grid_only',
  opticsRuntime: { calibrationDistortionOverrideActive: false }
});
assert.equal(domElements['panelO4Fitting'].style.display, 'none', 'TEST H4 PASS: stage != B (Stage A) leaves panel hidden');

ctrl.updateTelemetryUI({
  type: 'telemetry_sync',
  calibrationStage: 'C',
  viewerVisualMode: 'grid_only',
  opticsRuntime: { calibrationDistortionOverrideActive: false }
});
assert.equal(domElements['panelO4Fitting'].style.display, 'none', 'TEST H4b PASS: stage != B (Stage C) leaves panel hidden');

console.log('ALL CONTROLLER RECONCILIATION & O4 PANEL DERIVATION TESTS PASSED!');
