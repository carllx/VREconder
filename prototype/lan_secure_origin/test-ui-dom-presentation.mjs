import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CalibrationUI } from './src/controls/calibration-ui.js';
import { state } from './src/core/state.js';
import { createDefaultViewerProfile } from './src/core/projection-profile.js';

// Exercise the real SSE callback and telemetry expression with a small DOM double.
// This verifies instrumentation, not browser compositing or the human visual hypothesis.
let bridge;
globalThis.EventSource = class { constructor() { bridge = this; } };
const bitmap = new Uint8Array([12, 34, 56, 255]);
let canvas = { style: {}, width: 1920, height: 1080, bitmap };
globalThis.document = { getElementById: id => id === 'uiCanvas' ? canvas : null };
let cssVisibility = 'visible';
globalThis.getComputedStyle = element => ({
  visibility: cssVisibility === 'visible' ? (element.style.visibility || 'visible') : cssVisibility,
  display: element.style.display || 'block'
});
const calibrationUI = new CalibrationUI({
  storage: { activeViewerProfile: createDefaultViewerProfile() }
});
calibrationUI.activeVideoProfile = { projection: 'equirectangular', stereoMode: 'sbs' };
const before = JSON.stringify({ state, viewer: calibrationUI.activeViewerProfile,
  video: calibrationUI.activeVideoProfile });
const main = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
const expression = main.match(/domCanvasPresentationVisible:\s*([^,\n]+)/)[1];
const telemetryVisible = () => vm.runInNewContext(expression, { calibrationUI });
const send = visible => bridge.onmessage({
  data: JSON.stringify({ action: 'set_ui_dom_presentation', visible })
});
assert.equal(telemetryVisible(), true, 'Fresh default');
for (const visible of [false, true, false, true]) {
  send(visible);
  assert.equal(telemetryVisible(), visible);
  assert.equal(canvas.style.visibility, visible ? 'visible' : 'hidden');
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1080);
  assert.equal(canvas.bitmap, bitmap);
  assert.deepEqual([...bitmap], [12, 34, 56, 255]);
  assert.equal(JSON.stringify({ state, viewer: calibrationUI.activeViewerProfile,
    video: calibrationUI.activeVideoProfile }), before, 'No application/profile state mutation');
}
for (const invalid of [undefined, null, 'false', 0, {}]) {
  send(invalid);
  assert.equal(telemetryVisible(), true, 'Reject non-boolean values');
}
// A stylesheet override must be reported, even after a request to show the canvas.
cssVisibility = 'hidden';
send(true);
assert.equal(telemetryVisible(), false, 'Read actual style, not the command');
cssVisibility = 'visible';
canvas.style.display = 'none';
assert.equal(telemetryVisible(), false);
delete canvas.style.display;
send(false);
canvas = { style: {}, width: 1920, height: 1080, bitmap };
assert.equal(telemetryVisible(), true, 'Fresh DOM resets without persistence');
canvas = null;
send(false);
assert.equal(telemetryVisible(), false, 'Missing canvas is not presented');

// Design checks: presentation visibility does not gate the existing render/upload calls.
const renderBlock = main.slice(main.indexOf('const uiRendered = renderStereoUI('),
  main.indexOf('requestAnimationFrame(renderLoop);', main.indexOf('const uiRendered = renderStereoUI(')));
assert.match(renderBlock, /vrRenderer\.renderStereoVR\(/);
assert.match(renderBlock, /uiCanvas,\s*shouldUploadUI/);
assert.doesNotMatch(renderBlock, /domCanvasPresentationVisible|style\.visibility/);
const renderer = fs.readFileSync(new URL('./src/render/vr-renderer.js', import.meta.url), 'utf8');
assert.match(renderer, /gl\.texImage2D\([^;]*uiCanvas\)/);
assert.doesNotMatch(renderer, /domCanvasPresentationVisible|style\.visibility/);
console.log('PASS: telemetry true -> false -> true; boolean validation; computed-state readback;');
console.log('bitmap/dimensions and application/profiles unchanged; render/upload preserved by design.');
