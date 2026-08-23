// ==========================================
// WebGL 2-Pass VR Renderer & Rectilinear Diagnostic
// (Faithful implementation of Google CardboardView & CardboardBarrelDistortion)
// ==========================================
import { vsSource, fsIdealSceneSource, fsDistortionPassSource } from './shaders.js';
import { Quat } from '../core/quaternion.js';
import { activeScreenProfile } from '../core/screen-profile.js';
import { deriveCardboardEyeGeometry } from '../core/projection-profile.js';

export class VRRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.programScene = null;
    this.programDistort = null;
    this.posBuffer = null;
    this.videoTex = null;

    // Offscreen Framebuffer for Ideal Undistorted Eye Texture
    this.eyeFbo = null;
    this.eyeTex = null;
    this.fboWidth = 0;
    this.fboHeight = 0;

    this.identityMat3 = [1, 0, 0,  0, 1, 0,  0, 0, 1];
    this.initWebGL();
  }

  createShader(glCtx, type, source) {
    const shader = glCtx.createShader(type);
    glCtx.shaderSource(shader, source);
    glCtx.compileShader(shader);
    if (!glCtx.getShaderParameter(shader, glCtx.COMPILE_STATUS)) {
      console.error('Shader compile error:', glCtx.getShaderInfoLog(shader));
      glCtx.deleteShader(shader);
      return null;
    }
    return shader;
  }

  initWebGL() {
    try {
      this.gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' }) ||
                this.canvas.getContext('experimental-webgl');
    } catch (e) {
      console.error('WebGL init failed:', e);
      return;
    }

    const gl = this.gl;
    if (!gl) return;

    // 1. Pass 1: Ideal Scene Shader Program
    const vs = this.createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fsScene = this.createShader(gl, gl.FRAGMENT_SHADER, fsIdealSceneSource);
    if (vs && fsScene) {
      this.programScene = gl.createProgram();
      gl.attachShader(this.programScene, vs);
      gl.attachShader(this.programScene, fsScene);
      gl.linkProgram(this.programScene);
    }

    // 2. Pass 2: Screen-Space Distortion Shader Program
    const fsDistort = this.createShader(gl, gl.FRAGMENT_SHADER, fsDistortionPassSource);
    if (vs && fsDistort) {
      this.programDistort = gl.createProgram();
      gl.attachShader(this.programDistort, vs);
      gl.attachShader(this.programDistort, fsDistort);
      gl.linkProgram(this.programDistort);
    }

    // Quad geometry
    this.posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1,  1,
      -1,  1,  1, -1,  1,  1,
    ]), gl.STATIC_DRAW);

    // Video Texture
    this.videoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 15, 25, 255]));
  }

  ensureEyeFbo(width, height) {
    const gl = this.gl;
    if (!gl) return;
    if (this.eyeFbo && this.fboWidth === width && this.fboHeight === height) return;

    this.fboWidth = width;
    this.fboHeight = height;

    if (!this.eyeTex) this.eyeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.eyeTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    if (!this.eyeFbo) this.eyeFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.eyeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.eyeTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  updateVideoTexture(videoElement) {
    const gl = this.gl;
    if (!gl || !this.videoTex) return;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);
  }

  computePoseMatrix(poseDeg) {
    const p = poseDeg || { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
    const deg2rad = Math.PI / 180;
    const q = new Quat().setFromEulerYXZ(
      (p.pitchDeg || 0) * deg2rad,
      (p.yawDeg || 0) * deg2rad,
      (p.rollDeg || 0) * deg2rad
    );
    return q.toMat3ColumnMajor();
  }

  // Diagnostic Mode: Single Fullscreen Rectilinear View (No Headset Lens Distortion)
  renderDiagnosticView(width, height, videoProfile, viewerProfile, selectedEye = 0, cameraPoseMat3 = null, diagnosticFovDeg = 85) {
    const gl = this.gl;
    if (!gl || !this.programScene) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);

    gl.useProgram(this.programScene);
    const locs = {
      aPosition: gl.getAttribLocation(this.programScene, 'aPosition'),
      uVideoTexture: gl.getUniformLocation(this.programScene, 'uVideoTexture'),
      uCamRot: gl.getUniformLocation(this.programScene, 'uCamRot'),
      uPoseRot: gl.getUniformLocation(this.programScene, 'uPoseRot'),
      uEye: gl.getUniformLocation(this.programScene, 'uEye'),
      uEyeSwap: gl.getUniformLocation(this.programScene, 'uEyeSwap'),
      uProjectionMode: gl.getUniformLocation(this.programScene, 'uProjectionMode'),
      uStereoLayout: gl.getUniformLocation(this.programScene, 'uStereoLayout'),
      uTanBounds: gl.getUniformLocation(this.programScene, 'uTanBounds'),
      uCoverageRad: gl.getUniformLocation(this.programScene, 'uCoverageRad'),
      uCrop: gl.getUniformLocation(this.programScene, 'uCrop')
    };

    gl.enableVertexAttribArray(locs.aPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.vertexAttribPointer(locs.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(locs.uVideoTexture, 0);

    const vp = videoProfile || {};
    let projMode = 0;
    if (vp.projection === 'unknown') projMode = 3;
    else if (vp.projection === 'equirectangular-360') projMode = 1;
    else if (vp.projection === 'flat') projMode = 2;
    else projMode = 0;

    const stereoLayout = vp.stereoMode === 'top-bottom' ? 1 : (vp.stereoMode === 'mono' ? 2 : 0);
    const eyeSwap = vp.eyeOrder === 'right-left' ? 1 : 0;
    const covH = ((vp.fovHorizontalDeg || 180) * Math.PI) / 180;
    const covV = ((vp.fovVerticalDeg || 180) * Math.PI) / 180;
    const crop = vp.crop || { left: 0, right: 0, top: 0, bottom: 0 };
    const poseMat = this.computePoseMatrix(vp.pose);

    // Symmetric Tan bounds for flat rectilinear inspection
    const aspect = width / height;
    const tanHalfV = Math.tan((diagnosticFovDeg * 0.5 * Math.PI) / 180);
    const tanHalfH = tanHalfV * aspect;

    gl.uniform1i(locs.uProjectionMode, projMode);
    gl.uniform1i(locs.uStereoLayout, stereoLayout);
    gl.uniform1i(locs.uEyeSwap, eyeSwap);
    gl.uniform1i(locs.uEye, selectedEye);
    gl.uniform2f(locs.uCoverageRad, covH, covV);
    gl.uniform4f(locs.uCrop, crop.left || 0, crop.right || 0, crop.top || 0, crop.bottom || 0);
    gl.uniform4f(locs.uTanBounds, tanHalfH, tanHalfH, tanHalfV, tanHalfV);
    gl.uniformMatrix3fv(locs.uPoseRot, false, poseMat);
    gl.uniformMatrix3fv(locs.uCamRot, false, cameraPoseMat3 || this.identityMat3);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Stereo VR 2-Pass Mode: Renders Ideal Left/Right Scene -> Cardboard Screen-Space Barrel Distortion Pass
  renderStereoVR(width, height, videoProfile, viewerProfile, headCamRotMat3) {
    const gl = this.gl;
    if (!gl || !this.programScene || !this.programDistort) return;

    activeScreenProfile.updateFromViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    const eyeGeom = deriveCardboardEyeGeometry(activeScreenProfile, viewerProfile);
    const halfW = Math.floor(width / 2);

    this.ensureEyeFbo(width, height);

    // ==========================================
    // Pass 1: Render Ideal Left & Right Eye into Offscreen eyeFbo
    // ==========================================
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.eyeFbo);
    gl.useProgram(this.programScene);

    const sLocs = {
      aPosition: gl.getAttribLocation(this.programScene, 'aPosition'),
      uVideoTexture: gl.getUniformLocation(this.programScene, 'uVideoTexture'),
      uCamRot: gl.getUniformLocation(this.programScene, 'uCamRot'),
      uPoseRot: gl.getUniformLocation(this.programScene, 'uPoseRot'),
      uEye: gl.getUniformLocation(this.programScene, 'uEye'),
      uEyeSwap: gl.getUniformLocation(this.programScene, 'uEyeSwap'),
      uProjectionMode: gl.getUniformLocation(this.programScene, 'uProjectionMode'),
      uStereoLayout: gl.getUniformLocation(this.programScene, 'uStereoLayout'),
      uTanBounds: gl.getUniformLocation(this.programScene, 'uTanBounds'),
      uCoverageRad: gl.getUniformLocation(this.programScene, 'uCoverageRad'),
      uCrop: gl.getUniformLocation(this.programScene, 'uCrop')
    };

    gl.enableVertexAttribArray(sLocs.aPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.vertexAttribPointer(sLocs.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(sLocs.uVideoTexture, 0);

    const vp = videoProfile || {};
    let projMode = 0;
    if (vp.projection === 'unknown') projMode = 3;
    else if (vp.projection === 'equirectangular-360') projMode = 1;
    else if (vp.projection === 'flat') projMode = 2;
    else projMode = 0;

    const stereoLayout = vp.stereoMode === 'top-bottom' ? 1 : (vp.stereoMode === 'mono' ? 2 : 0);
    const eyeSwap = vp.eyeOrder === 'right-left' ? 1 : 0;
    const covH = ((vp.fovHorizontalDeg || 180) * Math.PI) / 180;
    const covV = ((vp.fovVerticalDeg || 180) * Math.PI) / 180;
    const crop = vp.crop || { left: 0, right: 0, top: 0, bottom: 0 };
    const poseMat = this.computePoseMatrix(vp.pose);

    gl.uniform1i(sLocs.uProjectionMode, projMode);
    gl.uniform1i(sLocs.uStereoLayout, stereoLayout);
    gl.uniform1i(sLocs.uEyeSwap, eyeSwap);
    gl.uniform2f(sLocs.uCoverageRad, covH, covV);
    gl.uniform4f(sLocs.uCrop, crop.left || 0, crop.right || 0, crop.top || 0, crop.bottom || 0);
    gl.uniformMatrix3fv(sLocs.uPoseRot, false, poseMat);
    gl.uniformMatrix3fv(sLocs.uCamRot, false, headCamRotMat3 || this.identityMat3);

    gl.enable(gl.SCISSOR_TEST);

    // Left Eye Ideal Render (using actual leftEye tanBounds)
    gl.viewport(0, 0, halfW, height);
    gl.scissor(0, 0, halfW, height);
    gl.uniform1i(sLocs.uEye, 0);
    const lTan = eyeGeom.leftEye.tanBounds;
    gl.uniform4f(sLocs.uTanBounds, lTan[0], lTan[1], lTan[2], lTan[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Right Eye Ideal Render (using actual mirrored rightEye tanBounds)
    gl.viewport(halfW, 0, halfW, height);
    gl.scissor(halfW, 0, halfW, height);
    gl.uniform1i(sLocs.uEye, 1);
    const rTan = eyeGeom.rightEye.tanBounds;
    gl.uniform4f(sLocs.uTanBounds, rTan[0], rTan[1], rTan[2], rTan[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ==========================================
    // Pass 2: Screen-Space Distortion Pass to Display Screen
    // ==========================================
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.programDistort);

    const dLocs = {
      aPosition: gl.getAttribLocation(this.programDistort, 'aPosition'),
      uEyeTexture: gl.getUniformLocation(this.programDistort, 'uEyeTexture'),
      uLensCenterNorm: gl.getUniformLocation(this.programDistort, 'uLensCenterNorm'),
      uTanBounds: gl.getUniformLocation(this.programDistort, 'uTanBounds'),
      uLensCorrection: gl.getUniformLocation(this.programDistort, 'uLensCorrection'),
      uDistortionK: gl.getUniformLocation(this.programDistort, 'uDistortionK'),
      uScreenTanScale: gl.getUniformLocation(this.programDistort, 'uScreenTanScale')
    };

    gl.enableVertexAttribArray(dLocs.aPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.vertexAttribPointer(dLocs.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.eyeTex);
    gl.uniform1i(dLocs.uEyeTexture, 0);

    const isLensOn = (viewerProfile && viewerProfile.lensCorrectionEnabled === true) ? 1 : 0;
    const distK = viewerProfile && viewerProfile.distortion ? [viewerProfile.distortion.k1 || 0, viewerProfile.distortion.k2 || 0] : [0, 0];

    gl.uniform1i(dLocs.uLensCorrection, isLensOn);
    gl.uniform2f(dLocs.uDistortionK, distK[0], distK[1]);

    // Scale converting normalized viewport offset [0, 1] to physical tangents
    // tanX = (xPx / pixelsPerMeter) / screenToLensDistance = xNorm * (halfViewportWPx / (pixelsPerMeter * D))
    const tanScaleX = halfW / (eyeGeom.screenPixelsPerMeter * eyeGeom.screenToLensDistance);
    const tanScaleY = height / (eyeGeom.screenPixelsPerMeter * eyeGeom.screenToLensDistance);
    gl.uniform2f(dLocs.uScreenTanScale, tanScaleX, tanScaleY);

    // Left Eye Screen Distortion Pass
    gl.viewport(0, 0, halfW, height);
    gl.scissor(0, 0, halfW, height);
    gl.uniform2f(dLocs.uLensCenterNorm, eyeGeom.leftEye.lensCenterNorm[0], eyeGeom.leftEye.lensCenterNorm[1]);
    gl.uniform4f(dLocs.uTanBounds, lTan[0], lTan[1], lTan[2], lTan[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Right Eye Screen Distortion Pass
    gl.viewport(halfW, 0, halfW, height);
    gl.scissor(halfW, 0, halfW, height);
    gl.uniform2f(dLocs.uLensCenterNorm, eyeGeom.rightEye.lensCenterNorm[0], eyeGeom.rightEye.lensCenterNorm[1]);
    gl.uniform4f(dLocs.uTanBounds, rTan[0], rTan[1], rTan[2], rTan[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disable(gl.SCISSOR_TEST);
  }
}
