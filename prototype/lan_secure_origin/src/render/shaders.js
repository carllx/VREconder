// ==========================================
// WebGL Shaders: Ideal Stereo Scene + Cardboard Screen-Space Lens Distortion Pass
// Faithful implementation of Google WWGC (CardboardBarrelDistortion.js)
// ==========================================

export const vsSource = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

// Pass 1: Ideal Undistorted Equirectangular / Spherical Scene Renderer
export const fsIdealSceneSource = `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uVideoTexture;
  uniform mat3 uCamRot;
  uniform mat3 uPoseRot;
  uniform int uEye;              // 0: Left Eye, 1: Right Eye
  uniform int uEyeSwap;          // 0: Normal, 1: Swapped
  uniform int uProjectionMode;    // 0: Equirect-180, 1: Equirect-360, 2: Flat-2D, 3: Unknown
  uniform int uStereoLayout;     // 0: SBS, 1: TB, 2: Mono
  uniform vec4 uTanBounds;       // vec4(tanLeft, tanRight, tanBottom, tanTop)
  uniform vec2 uCoverageRad;     // vec2(horizontalRad, verticalRad)
  uniform vec4 uCrop;            // vec4(left, right, top, bottom)

  const float PI = 3.14159265358979323846;

  void main() {
    if (uProjectionMode == 3) {
      // Diagnostic Unverified Pattern
      float checker = mod(floor(vUv.x * 24.0) + floor(vUv.y * 24.0), 2.0);
      gl_FragColor = mix(vec4(0.06, 0.09, 0.16, 1.0), vec4(0.12, 0.18, 0.30, 1.0), checker);
      return;
    }

    // Compute Asymmetric Pinhole Ray from Cardboard Tangent Bounds
    // Maps vUv [0, 1] linearly across [-tanLeft, tanRight] and [-tanBottom, tanTop]
    float tanX = mix(-uTanBounds.x, uTanBounds.y, vUv.x);
    float tanY = mix(-uTanBounds.z, uTanBounds.w, vUv.y);
    vec3 rayCam = normalize(vec3(tanX, tanY, -1.0));

    // Combine Head Tracking and Source Pose Rotation
    vec3 dWorld = uPoseRot * (uCamRot * rayCam);

    if (uProjectionMode == 2) {
      gl_FragColor = texture2D(uVideoTexture, vUv);
      return;
    }

    float lon = atan(dWorld.x, -dWorld.z);
    float lat = asin(clamp(dWorld.y, -1.0, 1.0));

    float maxHalfLon = (uProjectionMode == 0) ? (uCoverageRad.x * 0.5) : PI;
    float maxHalfLat = (uCoverageRad.y * 0.5);

    if (abs(lon) > maxHalfLon || abs(lat) > maxHalfLat) {
      gl_FragColor = vec4(0.012, 0.016, 0.024, 1.0);
      return;
    }

    float uLocal = 0.5 + lon / uCoverageRad.x;
    float vLocal = 0.5 + lat / uCoverageRad.y;

    uLocal = uCrop.x + uLocal * (1.0 - uCrop.x - uCrop.y);
    vLocal = uCrop.z + vLocal * (1.0 - uCrop.z - uCrop.w);

    int sourceEye = (uEyeSwap == 1) ? (1 - uEye) : uEye;

    vec2 texUv = vec2(0.0);
    if (uStereoLayout == 0) {
      texUv = vec2(0.5 * (uLocal + float(sourceEye)), vLocal);
    } else if (uStereoLayout == 1) {
      texUv = vec2(uLocal, 0.5 * (vLocal + float(1 - sourceEye)));
    } else {
      texUv = vec2(uLocal, vLocal);
    }

    gl_FragColor = texture2D(uVideoTexture, texUv);
  }
`;

// Pass 2: Google Cardboard Screen-Space Barrel Distortion Pass
// Directly maps Screen Pixels -> Lens Center Offset -> Radial Warp -> Ideal Eye Texture UV
export const fsDistortionPassSource = `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uEyeTexture;
  uniform vec2 uLensCenterNorm;   // Optical lens center in eye viewport [0, 1]
  uniform vec4 uTanBounds;        // vec4(tanLeft, tanRight, tanBottom, tanTop)
  uniform int uLensCorrection;    // 0: OFF (Ideal Undistorted), 1: ON (Cardboard Barrel Pre-Warp)
  uniform vec2 uDistortionK;      // vec2(k1, k2)
  uniform vec2 uScreenTanScale;   // Tangent scale from lens center to eye viewport edges

  void main() {
    if (uLensCorrection == 0) {
      // Pass-through undistorted ideal eye rendering
      gl_FragColor = texture2D(uEyeTexture, vUv);
      return;
    }

    // Offset from Optical Lens Center
    vec2 offsetFromLens = vUv - uLensCenterNorm;
    vec2 tanCoords = offsetFromLens * uScreenTanScale;

    // Cardboard Radial Distortion Polynomial
    float rSq = dot(tanCoords, tanCoords);
    float distort = 1.0 + uDistortionK.x * rSq + uDistortionK.y * rSq * rSq;
    vec2 distortedTan = tanCoords * distort;

    // Map Distorted Tangent Space to Ideal Eye Texture UV [0, 1]
    float uEye = (distortedTan.x - (-uTanBounds.x)) / (uTanBounds.y + uTanBounds.x);
    float vEye = (distortedTan.y - (-uTanBounds.z)) / (uTanBounds.w + uTanBounds.z);

    // Vignette clip at eye viewport boundaries
    if (uEye < 0.0 || uEye > 1.0 || vEye < 0.0 || vEye > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    gl_FragColor = texture2D(uEyeTexture, vec2(uEye, vEye));
  }
`;
