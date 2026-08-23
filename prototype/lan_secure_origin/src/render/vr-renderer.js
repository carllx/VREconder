// ==========================================
// WebGL VR Stereo 180° Renderer
// ==========================================
import { vsSource, fsSource } from './shaders.js';
import { cameraMat3 } from '../core/orientation.js';

export class VRRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.aPositionLoc = -1;
    this.uVideoTextureLoc = null;
    this.uCamRotLoc = null;
    this.uEyeLoc = null;
    this.uAspectLoc = null;
    this.posBuffer = null;
    this.videoTex = null;
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

      this.aPositionLoc = gl.getAttribLocation(this.program, 'aPosition');
      this.uVideoTextureLoc = gl.getUniformLocation(this.program, 'uVideoTexture');
      this.uCamRotLoc = gl.getUniformLocation(this.program, 'uCamRot');
      this.uEyeLoc = gl.getUniformLocation(this.program, 'uEye');
      this.uAspectLoc = gl.getUniformLocation(this.program, 'uAspect');

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

  render(width, height) {
    const gl = this.gl;
    if (!gl || !this.program) return;

    gl.useProgram(this.program);
    gl.enableVertexAttribArray(this.aPositionLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.vertexAttribPointer(this.aPositionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(this.uVideoTextureLoc, 0);

    gl.uniformMatrix3fv(this.uCamRotLoc, false, cameraMat3);

    gl.enable(gl.SCISSOR_TEST);

    const halfW = Math.floor(width / 2);
    const aspectPerEye = (halfW / height);
    gl.uniform1f(this.uAspectLoc, aspectPerEye);

    // Left Eye (Maps [0, 0.5])
    gl.viewport(0, 0, halfW, height);
    gl.scissor(0, 0, halfW, height);
    gl.uniform1i(this.uEyeLoc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Right Eye (Maps [0.5, 1.0])
    gl.viewport(halfW, 0, halfW, height);
    gl.scissor(halfW, 0, halfW, height);
    gl.uniform1i(this.uEyeLoc, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disable(gl.SCISSOR_TEST);
  }
}
