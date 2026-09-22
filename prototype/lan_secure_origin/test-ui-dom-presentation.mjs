import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CalibrationUI } from './src/controls/calibration-ui.js';
import { state } from './src/core/state.js';
import { createDefaultViewerProfile } from './src/core/projection-profile.js';

// Run the actual lifecycle functions with DOM/service doubles, not an iPhone simulation.
const main = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
const lifecycle = main.slice(main.indexOf('async function localArmAndEnterVR()'),
  main.indexOf('// Event Listeners', main.indexOf('function exitVRMode()')));
assert.ok(lifecycle.includes('function exitVRMode()'));
let bridge;
globalThis.EventSource = class { constructor() { bridge = this; } };
const bitmap = new Uint8Array([12, 34, 56, 255]);
const canvas = { style: {}, width: 1920, height: 1080, bitmap };
globalThis.document = { getElementById: id => id === 'uiCanvas' ? canvas : null };
let cssVisibility = 'visible';
globalThis.getComputedStyle = element => ({
  visibility: cssVisibility === 'visible' ? (element.style.visibility || 'visible') : cssVisibility,
  display: element.style.display || 'block'
});
let runtime;
const calibrationUI = new CalibrationUI({
  storage: { activeViewerProfile: createDefaultViewerProfile() },
  onEnterVR: () => runtime.enterVRMode(),
  onExitVR: () => runtime.exitVRMode()
});
calibrationUI.activeVideoProfile = { projection: 'equirectangular', stereoMode: 'left-right' };
const noop = () => {};
runtime = vm.createContext({ state, calibrationUI, uiCanvas: canvas,
  btnEnterVR: null, stageBanner: null, vrFloatingBar: null, vrRenderer: {},
  video: { play: () => Promise.resolve() }, telemetry: { syncSummary: noop },
  console: { warn: noop }, showFeedbackToast: noop, remoteLog: noop,
  updateScreenOrientation: noop, requestWakeLock: noop, initAudioContext: noop });
vm.runInContext(lifecycle, runtime);
const expression = main.match(/domCanvasPresentationVisible:\s*([^,\n]+)/)[1];
const visible = () => vm.runInContext(expression, runtime);
const send = message => bridge.onmessage({ data: JSON.stringify(message) });
const protectedState = () => JSON.stringify({ viewer: calibrationUI.activeViewerProfile,
  video: calibrationUI.activeVideoProfile, candidate: state.candidateDistortion,
  preview: state.provisionalOpticsPreviewActive, renderScale: state.renderScale,
  depth: state.menuVirtualDepth, offset: state.temporaryScreenToLensOffset });
const before = protectedState();
const check = expected => {
  assert.equal(visible(), expected);
  assert.equal(protectedState(), before, 'Optics, profiles and render settings unchanged');
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1080);
  assert.equal(canvas.bitmap, bitmap);
  assert.deepEqual([...bitmap], [12, 34, 56, 255]);
};
const obsoleteActionCannotOverride = expected => {
  for (const value of [true, false, 'true', null]) {
    send({ action: 'set_ui_dom_presentation', visible: value });
    check(expected);
  }
};
state.calibrationStage = 'A';
state.isArmed = false;
check(true);
obsoleteActionCannotOverride(true);
for (const stage of ['B', 'C']) {
  send({ action: 'set_stage', stage });
  assert.equal(state.inVR, false, 'Unarmed entry stays non-VR');
  assert.equal(calibrationUI.currentMode, 'diagnostic');
  check(true);
}
send({ action: 'set_stage', stage: 'A' });
await runtime.localArmAndEnterVR();
assert.equal(state.inVR, true);
check(false);
obsoleteActionCannotOverride(false);
runtime.exitVRMode();
check(true);
runtime.DeviceOrientationEvent = { requestPermission: async () => 'granted' };
await runtime.localArmAndEnterVR();
assert.equal(state.isArmed, true, 'iOS permission path enters the same lifecycle');
check(false);
runtime.exitVRMode();
check(true);
for (const stage of ['B', 'C', 'B', 'C']) {
  send({ action: 'set_stage', stage });
  assert.equal(state.inVR, true);
  assert.equal(calibrationUI.currentMode, 'vr');
  check(false);
  obsoleteActionCannotOverride(false);
  send({ action: 'set_stage', stage: 'A' });
  assert.equal(state.inVR, false);
  check(true);
}
// Actual computed style remains the telemetry authority.
cssVisibility = 'hidden';
assert.equal(visible(), false);
cssVisibility = 'visible';
check(true);

// Wiring/design checks; browser GPU output remains a separate real-device gate.
assert.match(main, /onEnterVR: \(\) => enterVRMode\(\)/);
assert.match(main, /onExitVR: \(\) => exitVRMode\(\)/);
const renderBlock = main.slice(main.indexOf('const uiRendered = renderStereoUI('),
  main.indexOf('requestAnimationFrame(renderLoop);', main.indexOf('const uiRendered = renderStereoUI(')));
assert.match(renderBlock, /vrRenderer\.renderStereoVR\(/);
assert.match(renderBlock, /uiCanvas,\s*shouldUploadUI/);
assert.doesNotMatch(renderBlock, /domCanvasPresentationVisible|style\.visibility/);
const renderer = fs.readFileSync(new URL('./src/render/vr-renderer.js', import.meta.url), 'utf8');
assert.match(renderer, /gl\.texImage2D\([^;]*uiCanvas\)/);
assert.doesNotMatch(renderer, /domCanvasPresentationVisible|style\.visibility/);
console.log('PASS: local/Stage B/C entry hides DOM; exit/Stage A restores; unarmed entry stays non-VR;');
console.log('obsolete action cannot override; telemetry reads style; optics/bitmap/render paths preserved.');
