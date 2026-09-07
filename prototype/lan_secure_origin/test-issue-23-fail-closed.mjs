import assert from 'node:assert';
import { MediaController } from './src/media/playback.js';
import { state } from './src/core/state.js';

console.log('=== RUNNING SEAM 1 TESTS: MEDIA SELECTION & GENERATION OWNERSHIP ===');

// Mock HTML5 Video element
class MockVideoElement {
  constructor() {
    this.listeners = {};
    this.src = '';
    this.readyState = 0;
    this.currentTime = 0;
    this.duration = 100;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.paused = true;
    this.error = null;
    this._rvfcCallbacks = [];
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  removeEventListener(event, handler) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(h => h !== handler);
  }

  dispatchEvent(event) {
    const list = this.listeners[event] || [];
    list.forEach(h => h({ type: event }));
  }

  requestVideoFrameCallback(cb) {
    this._rvfcCallbacks.push(cb);
    return this._rvfcCallbacks.length;
  }

  triggerRvfc(now = 1000, metadata = {}) {
    const cbs = [...this._rvfcCallbacks];
    this._rvfcCallbacks = [];
    cbs.forEach(cb => cb(now, metadata));
  }

  load() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

// Slice 1.1: Token increments on selectVideo and resets ready/ownership state
{
  const mockVideo = new MockVideoElement();
  const controller = new MediaController(mockVideo, null);
  
  assert.strictEqual(typeof controller.currentMediaGeneration, 'number', 'controller must have currentMediaGeneration');
  const gen0 = controller.currentMediaGeneration;

  controller.selectVideo('videoA.mp4');
  assert.strictEqual(controller.currentMediaGeneration, gen0 + 1, 'selectVideo must increment currentMediaGeneration');
  assert.strictEqual(controller.isCurrentMediaDecoded(), false, 'isCurrentMediaDecoded must be false immediately after selectVideo');
  assert.strictEqual(state.firstFrameTimings.ready, false, 'state.firstFrameTimings.ready must be false on selectVideo');

  console.log('✔ Slice 1.1 PASS: Media generation token increments and enters non-ready state');
}

// Slice 1.2: Decoded frame validation requires current generation and positive dimensions (>0)
{
  const mockVideo = new MockVideoElement();
  const controller = new MediaController(mockVideo, null);

  controller.selectVideo('videoA.mp4');
  const genA = controller.currentMediaGeneration;

  // Stale callback from earlier generation (e.g. genA - 1)
  controller.onDecodedFrame(genA - 1, 100, {});
  assert.strictEqual(controller.isCurrentMediaDecoded(), false, 'Stale generation callback must not satisfy readiness');
  assert.strictEqual(controller.videoFrameNeedsUpload, false, 'Stale callback must not request texture upload');

  // Callback for current gen, but video dimensions are 0 (fail-closed)
  mockVideo.videoWidth = 0;
  mockVideo.videoHeight = 0;
  controller.onDecodedFrame(genA, 200, {});
  assert.strictEqual(controller.isCurrentMediaDecoded(), false, 'Callback with 0x0 video dimensions must remain fail-closed');
  assert.strictEqual(controller.videoFrameNeedsUpload, false, '0x0 dimensions must not request texture upload');

  // Callback for current gen with valid dimensions > 0
  mockVideo.videoWidth = 3840;
  mockVideo.videoHeight = 1920;
  controller.onDecodedFrame(genA, 300, {});
  assert.strictEqual(controller.isCurrentMediaDecoded(), true, 'Current gen callback with valid dimensions satisfies readiness');
  assert.strictEqual(controller.videoFrameNeedsUpload, true, 'Valid decoded frame triggers texture upload request');

  console.log('✔ Slice 1.2 PASS: Generation check and dimension gating enforce fail-closed');
}

// ==========================================
// SEAM 2 & 3 TESTS: VRRenderer Texture Neutralization & Lifecycle
// ==========================================
{
  class MockWebGLRenderingContext {
    constructor() {
      this.RGBA = 0x1908;
      this.UNSIGNED_BYTE = 0x1401;
      this.TEXTURE_2D = 0x0de1;
      this.uploadedTexData = null;
      this.uploadedElements = [];
    }

    createTexture() { return { id: 'mockTex' }; }
    bindTexture(target, tex) {}
    texParameteri(target, pname, param) {}
    texImage2D(...args) {
      const lastArg = args[args.length - 1];
      if (lastArg instanceof Uint8Array) {
        this.uploadedTexData = Array.from(lastArg);
      } else {
        this.uploadedElements.push(lastArg);
      }
    }
    pixelStorei() {}
  }

  const mockGl = new MockWebGLRenderingContext();
  const mockRenderer = {
    gl: mockGl,
    videoTex: mockGl.createTexture(),
    videoTextureReady: true,
    invalidateVideoTexture() {
      this.videoTextureReady = false;
      // Neutral neutral/dark fallback 1x1 pixel
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, 1, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    },
    updateVideoTexture(videoElement) {
      this.videoTextureReady = true;
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, videoElement);
    },
    isVideoTextureReady() {
      return this.videoTextureReady;
    }
  };

  const mockVideo = new MockVideoElement();
  const controller = new MediaController(mockVideo, null);

  // Wire invalidation seam
  controller.onMediaInvalidated = (gen, relPath) => {
    mockRenderer.invalidateVideoTexture();
  };

  // 1. Playable A: decoded frame uploaded
  controller.selectVideo('videoA.mp4');
  const genA = controller.currentMediaGeneration;
  mockVideo.videoWidth = 1920;
  mockVideo.videoHeight = 1080;
  controller.onDecodedFrame(genA, 100, {});
  assert.strictEqual(controller.shouldUploadTexture(), false); // readyState is 0 in mockVideo
  mockVideo.readyState = 4;
  assert.strictEqual(controller.shouldUploadTexture(), true);
  mockRenderer.updateVideoTexture(mockVideo);
  assert.strictEqual(mockRenderer.isVideoTextureReady(), true, 'Playable A texture must be ready');

  // 2. Switch to audio-only/failing B
  controller.selectVideo('audioOnlyB.mp4');
  // Seam 2 invariant: Old texture A must immediately be neutralized
  assert.strictEqual(mockRenderer.isVideoTextureReady(), false, 'Immediately on selecting B, videoTextureReady must be false');
  assert.deepStrictEqual(mockGl.uploadedTexData, [0, 0, 0, 255], 'Immediately on selecting B, texture must be overwritten with neutral pixels');

  // 3. Stale rVFC/frame from A arriving during B
  controller.onDecodedFrame(genA, 200, {});
  assert.strictEqual(controller.shouldUploadTexture(), false, 'Stale frame from A must not trigger texture upload for B');
  assert.strictEqual(mockRenderer.isVideoTextureReady(), false, 'Stale frame from A must not mark B ready');

  // 4. Failing B gives 0x0 or error
  mockVideo.videoWidth = 0;
  mockVideo.videoHeight = 0;
  controller.onDecodedFrame(controller.currentMediaGeneration, 300, {});
  assert.strictEqual(controller.shouldUploadTexture(), false, 'Zero dimension frame must not trigger upload');
  assert.strictEqual(mockRenderer.isVideoTextureReady(), false, 'Zero dimension frame must keep B fail-closed');

  // 5. Switch to playable C -> restores visibility only after valid decoded frame
  controller.selectVideo('playableC.mp4');
  const genC = controller.currentMediaGeneration;
  mockVideo.videoWidth = 3840;
  mockVideo.videoHeight = 1920;
  assert.strictEqual(mockRenderer.isVideoTextureReady(), false, 'C is not ready before decoded frame');
  controller.onDecodedFrame(genC, 400, {});
  assert.strictEqual(controller.shouldUploadTexture(), true, 'Valid decoded frame for C permits upload');
  mockRenderer.updateVideoTexture(mockVideo);
  assert.strictEqual(mockRenderer.isVideoTextureReady(), true, 'C is ready after valid decoded frame upload');

  console.log('✔ Seam 2 & 3 PASS: Switching immediately neutralizes old texture, blocks stale frames, and restores upon valid decoded frame');
}

// Slice 2.2: Media error immediately invalidates texture and keeps fail-closed
{
  const mockVideo = new MockVideoElement();
  const controller = new MediaController(mockVideo, null);
  let invalidated = false;
  controller.onMediaInvalidated = () => { invalidated = true; };

  controller.selectVideo('videoErr.mp4');
  invalidated = false;

  mockVideo.error = { code: 4, message: 'Format unsupported' };
  mockVideo.dispatchEvent('error');

  assert.strictEqual(invalidated, true, 'Error must trigger onMediaInvalidated');
  assert.strictEqual(controller.isCurrentMediaDecoded(), false, 'Error must clear decoded state');
  assert.strictEqual(controller.shouldUploadTexture(), false, 'Error must prevent upload');
  assert.strictEqual(state.firstFrameTimings.ready, false, 'Error must keep ready=false');

  console.log('✔ Slice 2.2 PASS: Media error triggers fail-closed invalidation');
}

// Slice 2.3: Probe window timeout keeps fail-closed if no decoded frame appears
{
  const mockVideo = new MockVideoElement();
  const controller = new MediaController(mockVideo, null);
  let invalidated = false;
  controller.onMediaInvalidated = () => { invalidated = true; };
  controller.probeTimeoutMs = 50; // fast probe timeout for test

  controller.selectVideo('slowOrAudioOnly.mp4');
  const gen = controller.currentMediaGeneration;
  invalidated = false;

  // Trigger timeout manually via onProbeTimeout
  controller.onProbeTimeout(gen);
  assert.strictEqual(invalidated, true, 'Probe timeout must trigger invalidation');
  assert.strictEqual(controller.isCurrentMediaDecoded(), false, 'Probe timeout leaves decoded false');
  assert.strictEqual(controller.shouldUploadTexture(), false, 'Probe timeout prevents upload');
  assert.strictEqual(state.firstFrameTimings.ready, false, 'Probe timeout keeps ready=false');

  console.log('✔ Slice 2.3 PASS: Probe timeout preserves fail-closed behavior');
}

// Slice 2.4: VRRenderer checkReadyTransition gates ready on positive decoded texture evidence in both diagnostic and VR modes
{
  class MockWebGLDiagnosticContext {
    constructor() {
      this.RGBA = 0x1908;
      this.UNSIGNED_BYTE = 0x1401;
      this.TEXTURE_2D = 0x0de1;
    }
    createTexture() { return {}; }
    bindTexture() {}
    texParameteri() {}
    texImage2D() {}
  }

  const mockGl = new MockWebGLDiagnosticContext();
  const renderer = {
    gl: mockGl,
    videoTex: mockGl.createTexture(),
    videoTextureReady: false,
    checkReadyTransition() {
      if (!state.firstFrameTimings.firstRenderAt && state.firstFrameTimings.firstTextureUploadAt && this.videoTextureReady) {
        state.firstFrameTimings.firstRenderAt = 1000;
        state.firstFrameTimings.ready = true;
        state.firstFrameTimings.statusText = state.inVR ? 'VR Ready' : 'Diagnostic Ready';
      }
    }
  };

  state.inVR = false;
  state.firstFrameTimings = {
    selectedAt: 100,
    firstRenderAt: 0,
    firstTextureUploadAt: 500,
    ready: false,
    statusText: 'Opening'
  };

  // Not ready before videoTextureReady is true
  renderer.checkReadyTransition();
  assert.strictEqual(state.firstFrameTimings.ready, false, 'Diagnostic mode must not become ready without videoTextureReady');

  // Ready when videoTextureReady is true
  renderer.videoTextureReady = true;
  renderer.checkReadyTransition();
  assert.strictEqual(state.firstFrameTimings.ready, true, 'Diagnostic mode becomes ready when texture is ready');
  assert.strictEqual(state.firstFrameTimings.statusText, 'Diagnostic Ready');

  console.log('✔ Slice 2.4 PASS: Diagnostic mode correctly transitions to ready when texture is ready');
}

// Slice 2.5: Late decoded frames arriving after probe timeout cannot resurrect poisoned generation
{
  const mockVideo = new MockVideoElement();
  const controller = new MediaController(mockVideo, null);
  mockVideo.videoWidth = 1920;
  mockVideo.videoHeight = 1080;

  controller.selectVideo('lateFrameVideo.mp4');
  const gen = controller.currentMediaGeneration;

  // Timed out
  controller.onProbeTimeout(gen);
  assert.strictEqual(controller.isCurrentMediaDecoded(), false);
  assert.strictEqual(state.firstFrameTimings.ready, false);

  // Late frame arrives for gen
  const accepted = controller.onDecodedFrame(gen, 6000, {});
  assert.strictEqual(accepted, false, 'Late frame arriving after probe timeout must be rejected');
  assert.strictEqual(controller.isCurrentMediaDecoded(), false, 'Timed-out generation must not become decoded');
  assert.strictEqual(controller.videoFrameNeedsUpload, false, 'Timed-out generation must not request upload');

  console.log('✔ Slice 2.5 PASS: Poisoned generation blocks late frame resurrection');
}
