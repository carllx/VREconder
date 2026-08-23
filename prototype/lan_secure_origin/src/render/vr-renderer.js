// ==========================================
// WebGL VR & Rectilinear Diagnostic Renderer
// ==========================================
import { vsSource, fsSource } from './shaders.js';
import { Quat } from '../core/quaternion.js';

export class VRRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.locs = {};
    this.posBuffer = null;
    this.videoTex = null;
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

    const vertShader = this.createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fragShader = this.createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (vertShader && fragShader) {
      this.program = gl.createProgram();
      gl.attachShader(this.program, vertShader);
      gl.attachShader(this.program, fragShader);
      gl.linkProgram(this.program);

      this.posBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,  1, -1, -1,  1,
        -1,  1,  1, -1,  1,  1,
      ]), gl.STATIC_DRAW);

      this.locs = {
        aPosition: gl.getAttribLocation(this.program, 'aPosition'),
        uVideoTexture: gl.getUniformLocation(this.program, 'uVideoTexture'),
        uCamRot: gl.getUniformLocation(this.program, 'uCamRot'),
        uPoseRot: gl.getUniformLocation(this.program, 'uPoseRot'),
        uEye: gl.getUniformLocation(this.program, 'uEye'),
        uEyeSwap: gl.getUniformLocation(this.program, 'uEyeSwap'),
        uProjectionMode: gl.getUniformLocation(this.program, 'uProjectionMode'),
        uStereoLayout: gl.getUniformLocation(this.program, 'uStereoLayout'),
        uAspect: gl.getUniformLocation(this.program, 'uAspect'),
        uFovRad: gl.getUniformLocation(this.program, 'uFovRad'),
        uCoverageRad: gl.getUniformLocation(this.program, 'uCoverageRad'),
        uCrop: gl.getUniformLocation(this.program, 'uCrop'),
        uLensCorrection: gl.getUniformLocation(this.program, 'uLensCorrection'),
        uDistortionK: gl.getUniformLocation(this.program, 'uDistortionK')
      };

      this.videoTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 15, 25, 255]));
    }
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

  bindCommonUniforms(videoProfile, viewerProfile) {
    const gl = this.gl;
    const vp = videoProfile || {};
    const hp = viewerProfile || {};

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

    gl.uniform1i(this.locs.uProjectionMode, projMode);
    gl.uniform1i(this.locs.uStereoLayout, stereoLayout);
    gl.uniform1i(this.locs.uEyeSwap, eyeSwap);
    gl.uniform2f(this.locs.uCoverageRad, covH, covV);
    gl.uniform4f(this.locs.uCrop, crop.left || 0, crop.right || 0, crop.top || 0, crop.bottom || 0);
    gl.uniformMatrix3fv(this.locs.uPoseRot, false, poseMat);

    const isLensOn = (hp.lensCorrectionEnabled === true) ? 1 : 0;
    const distK = (hp.distortion) ? [hp.distortion.k1 || 0.34, hp.distortion.k2 || 0.55] : [0, 0];
    gl.uniform1i(this.locs.uLensCorrection, isLensOn);
    gl.uniform2f(this.locs.uDistortionK, distK[0], distK[1]);
  }

  // Diagnostic Mode: Single Fullscreen Rectilinear View (No Headset Lens Distortion)
  renderDiagnosticView(width, height, videoProfile, viewerProfile, selectedEye = 0, cameraPoseMat3 = null, diagnosticFovDeg = 85) {
    const gl = this.gl;
    if (!gl || !this.program) return;

    gl.useProgram(this.program);
    gl.enableVertexAttribArray(this.locs.aPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.vertexAttribPointer(this.locs.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(this.locs.uVideoTexture, 0);

    this.bindCommonUniforms(videoProfile, viewerProfile);

    // Diagnostic view always uses pure rectilinear camera without lens warp
    gl.uniform1i(this.locs.uLensCorrection, 0);
    gl.uniform1f(this.locs.uFovRad, (diagnosticFovDeg * Math.PI) / 180);
    gl.uniformMatrix3fv(this.locs.uCamRot, false, cameraPoseMat3 || this.identityMat3);

    const aspect = width / height;
    gl.uniform1f(this.locs.uAspect, aspect);
    gl.uniform1i(this.locs.uEye, selectedEye);

    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Stereo VR Mode: Dual Viewports with Optional Lens Pre-Distortion
  renderStereoVR(width, height, videoProfile, viewerProfile, headCamRotMat3) {
    const gl = this.gl;
    if (!gl || !this.program) return;

    gl.useProgram(this.program);
    gl.enableVertexAttribArray(this.locs.aPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.vertexAttribPointer(this.locs.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(this.locs.uVideoTexture, 0);

    this.bindCommonUniforms(videoProfile, viewerProfile);

    // Calculate FOV from Viewer Profile eyes geometry
    let fovDeg = 85;
    if (viewerProfile && viewerProfile.eyes && viewerProfile.eyes.left && viewerProfile.eyes.left.fov) {
      const f = viewerProfile.eyes.left.fov;
      fovDeg = (f.leftDeg || 45) + (f.rightDeg || 45);
    }
    gl.uniform1f(this.locs.uFovRad, (fovDeg * Math.PI) / 180);
    gl.uniformMatrix3fv(this.locs.uCamRot, false, headCamRotMat3 || this.identityMat3);

    gl.enable(gl.SCISSOR_TEST);

    const halfW = Math.floor(width / 2);
    const aspectPerEye = (halfW / height);
    gl.uniform1f(this.locs.uAspect, aspectPerEye);

    // Left Eye
    gl.viewport(0, 0, halfW, height);
    gl.scissor(0, 0, halfW, height);
    gl.uniform1i(this.locs.uEye, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Right Eye
    gl.viewport(halfW, 0, halfW, height);
    gl.scissor(halfW, 0, halfW, height);
    gl.uniform1i(this.locs.uEye, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disable(gl.SCISSOR_TEST);
  }
}
