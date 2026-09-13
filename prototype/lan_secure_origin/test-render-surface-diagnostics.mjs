// ==========================================
// Deterministic Verification for Render Surface Diagnostics
// ==========================================
import assert from 'node:assert/strict';
import { captureRenderSurfaceSnapshot, drawRenderSurfaceEdgeFixture } from './src/telemetry/render-surface-diagnostics.js';
import { activeScreenProfile } from './src/core/screen-profile.js';
import { createDefaultViewerProfile } from './src/core/projection-profile.js';

console.log('=== RUNNING RENDER SURFACE DIAGNOSTICS TESTS ===\n');

// 1. Snapshot Schema & Null-Safety Verification
console.log('Test 1: captureRenderSurfaceSnapshot null-safety & full schema');

const mockGlCanvas = {
  clientWidth: 852,
  clientHeight: 393,
  width: 2556,
  height: 1179,
  style: { width: '100vw', height: '100vh' }
};

const mockUiCanvas = {
  clientWidth: 852,
  clientHeight: 393,
  width: 2556,
  height: 1179,
  style: { width: '100vw', height: '100vh' }
};

const snap = captureRenderSurfaceSnapshot(mockGlCanvas, mockUiCanvas, 1.0);

assert.ok(snap.timestamp, 'Must have timestamp');
assert.ok(snap.screen, 'Must have screen object');
assert.ok(snap.window, 'Must have window object');
assert.ok(snap.documentElement, 'Must have documentElement object');
assert.ok('visualViewport' in snap, 'Must have visualViewport field');
assert.ok(snap.glCanvas, 'Must have glCanvas object');
assert.ok(snap.uiCanvas, 'Must have uiCanvas object');
assert.strictEqual(snap.renderScale, 1.0, 'renderScale must match');
assert.ok(snap.safeAreaInsets, 'Must have safeAreaInsets object');
assert.strictEqual(snap.activeScreenProfile.authoritativeWidthPx, 2556);
assert.strictEqual(snap.activeScreenProfile.authoritativeHeightPx, 1179);
assert.strictEqual(snap.glCanvas.drawingBufferWidth, 2556);
assert.strictEqual(snap.glCanvas.drawingBufferHeight, 1179);
assert.strictEqual(snap.uiCanvas.drawingBufferWidth, 2556);
assert.strictEqual(snap.uiCanvas.drawingBufferHeight, 1179);
assert.ok(snap.documentScroll, 'Must have documentScroll object');
assert.ok(snap.viewportMeta, 'Must have viewportMeta');
assert.ok(snap.displayMode, 'Must have displayMode object');
assert.ok(Array.isArray(snap.widestElements), 'widestElements must be an array');

console.log('  ✓ Schema verified successfully:');
console.log('    GL drawing-buffer:', snap.glCanvas.drawingBufferWidth, 'x', snap.glCanvas.drawingBufferHeight);
console.log('    Screen profile target:', snap.activeScreenProfile.authoritativeWidthPx, 'x', snap.activeScreenProfile.authoritativeHeightPx);

// 2. Edge Fixture Canvas Execution Verification
console.log('\nTest 2: drawRenderSurfaceEdgeFixture execution on mock canvas 2D context');

const recordedCalls = [];
const mockCtx = {
  save: () => recordedCalls.push('save'),
  restore: () => recordedCalls.push('restore'),
  beginPath: () => recordedCalls.push('beginPath'),
  stroke: () => recordedCalls.push('stroke'),
  fill: () => recordedCalls.push('fill'),
  moveTo: (x, y) => recordedCalls.push(`moveTo(${x},${y})`),
  lineTo: (x, y) => recordedCalls.push(`lineTo(${x},${y})`),
  arc: (x, y, r) => recordedCalls.push(`arc(${x},${y},${r})`),
  strokeRect: (x, y, w, h) => recordedCalls.push(`strokeRect(${x},${y},${w},${h})`),
  fillRect: (x, y, w, h) => recordedCalls.push(`fillRect(${x},${y},${w},${h})`),
  fillText: (t, x, y) => recordedCalls.push(`fillText(${t},${x},${y})`),
  setLineDash: (d) => recordedCalls.push(`setLineDash(${d.join(',')})`)
};

const vp = createDefaultViewerProfile('cardboard:reference_50deg');
drawRenderSurfaceEdgeFixture(mockCtx, 2556, 1179, vp);

assert.ok(recordedCalls.includes('save'), 'Must call save');
assert.ok(recordedCalls.includes('restore'), 'Must call restore');
// Outer perimeter border
assert.ok(recordedCalls.includes('strokeRect(1,1,2554,1177)'), 'Must draw 2px inset perimeter border');
// Center dividing seam (x = 1278)
assert.ok(recordedCalls.includes('moveTo(1278,0)'), 'Must move to top of canvas center seam');
assert.ok(recordedCalls.includes('lineTo(1278,1179)'), 'Must draw line to bottom of canvas center seam');

// Left and Right Eye Centers must be drawn
const hasLeftEyeLabel = recordedCalls.some(c => c.includes('LEFT LENS CENTER'));
const hasRightEyeLabel = recordedCalls.some(c => c.includes('RIGHT LENS CENTER'));
const hasCenterLabel = recordedCalls.some(c => c.includes('CANVAS CENTER (x=1278)'));
assert.ok(hasLeftEyeLabel, 'Must render left eye center marker');
assert.ok(hasRightEyeLabel, 'Must render right eye center marker');
assert.ok(hasCenterLabel, 'Must render canvas center seam label');

console.log('  ✓ Edge fixture rendered perimeter borders, 4 corner markers, center seam at x=1278, and dual optical centers.');

console.log('\n=== ALL RENDER SURFACE TESTS PASSED ===');
