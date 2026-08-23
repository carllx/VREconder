// ==========================================
// WebGL Shaders: Ideal Stereo Scene + Synthetic Scene + Cardboard Screen Distortion
// Faithful port of Google WWGC (CardboardBarrelDistortion.js & CardboardView.js)
// ==========================================

export const vsSource = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

// Pass 1: Ideal Undistorted Scene Shader (Video or Synthetic Calibration Grid)
export const fsIdealSceneSource = `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uVideoTexture;
  uniform mat3 uCamRot;
  uniform mat3 uPoseRot;
  uniform int uEye;              // 0: Left Eye, 1: Right Eye
  uniform int uEyeSwap;          // 0: Normal, 1: Swapped
  uniform int uSceneType;        // 0: Video, 1: Synthetic Calibration Grid
  uniform int uProjectionMode;    // 0: Equirect-180, 1: Equirect-360, 2: Flat-2D, 3: Unknown
  uniform int uStereoLayout;     // 0: SBS, 1: TB, 2: Mono
  uniform vec4 uVirtTanBounds;   // vec4(tanVirtLeft, tanVirtRight, tanVirtBottom, tanVirtTop)
  uniform vec2 uCoverageRad;     // vec2(horizontalRad, verticalRad)
  uniform vec4 uCrop;            // vec4(left, right, top, bottom)

  const float PI = 3.14159265358979323846;

  void main() {
    // 1. Compute Asymmetric Virtual Ray Camera Tangents from uVirtTanBounds
    float tanX = mix(-uVirtTanBounds.x, uVirtTanBounds.y, vUv.x);
    float tanY = mix(-uVirtTanBounds.z, uVirtTanBounds.w, vUv.y);
    vec3 rayCam = normalize(vec3(tanX, tanY, -1.0));

    // 2. Synthetic Calibration Scene (Straight Grid, 90° Corners & Crosshairs)
    if (uSceneType == 1) {
      // Perspective grid on a virtual rectilinear reference plane at z = -1.0
      vec2 gridPos = vec2(tanX, tanY) * 8.0;
      vec2 gridFract = abs(fract(gridPos - 0.5) - 0.5) / fwidth(gridPos);
      float line = min(gridFract.x, gridFract.y);
      float gridAlpha = 1.0 - min(line, 1.0);

      // Center crosshair (x=0, y=0)
      float crossX = abs(tanX) / fwidth(tanX);
      float crossY = abs(tanY) / fwidth(tanY);
      float isCross = (crossX < 1.5 || crossY < 1.5) ? 1.0 : 0.0;

      // 90-degree corner targets
      float cornerBox = (abs(abs(tanX) - 0.4) < 0.005 || abs(abs(tanY) - 0.4) < 0.005) ? 0.7 : 0.0;

      vec3 bg = vec3(0.05, 0.08, 0.14);
      vec3 gridColor = vec3(0.2, 0.6, 0.9);
      vec3 crossColor = vec3(1.0, 0.25, 0.25);

      vec3 finalCol = mix(bg, gridColor, gridAlpha * 0.7);
      finalCol = mix(finalCol, vec3(1.0, 0.8, 0.2), cornerBox);
      finalCol = mix(finalCol, crossColor, isCross);

      gl_FragColor = vec4(finalCol, 1.0);
      return;
    }

    // 3. Unknown / Unverified Video Warning Texture
    if (uProjectionMode == 3) {
      float checker = mod(floor(vUv.x * 24.0) + floor(vUv.y * 24.0), 2.0);
      gl_FragColor = mix(vec4(0.06, 0.09, 0.16, 1.0), vec4(0.12, 0.18, 0.30, 1.0), checker);
      return;
    }

    // Combine Head Tracking and Video Pose Rotation
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
// Maps Screen Coordinates -> Optical Offset -> Radial Warp -> Virtual Eye Texture UV
export const fsDistortionPassSource = `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uEyeTexture;
  uniform vec2 uLensCenterNorm;   // Optical center in eye viewport [0, 1]
  uniform vec4 uVirtTanBounds;    // vec4(tanVirtLeft, tanVirtRight, tanVirtBottom, tanVirtTop)
  uniform int uLensCorrection;    // 0: OFF (Ideal Undistorted), 1: ON (Cardboard Pre-Warp)
  uniform vec2 uDistortionK;      // vec2(k1, k2)
  uniform vec2 uScreenTanScale;   // Scale from viewport pixels to physical screen tangents

  void main() {
    if (uLensCorrection == 0) {
      // Pass-through undistorted ideal eye rendering
      gl_FragColor = texture2D(uEyeTexture, vUv);
      return;
    }

    // 1. Physical Tangent Offset from Optical Lens Center
    vec2 offsetNorm = vUv - uLensCenterNorm;
    vec2 physTan = offsetNorm * uScreenTanScale;

    // 2. Cardboard Radial Barrel Distortion Polynomial: r' = r * (1 + k1*r^2 + k2*r^4)
    float rSq = dot(physTan, physTan);
    float factor = 1.0 + uDistortionK.x * rSq + uDistortionK.y * rSq * rSq;
    vec2 virtTan = physTan * factor;

    // 3. Map Distorted Virtual Tangent to Ideal Eye Texture UV [0, 1]
    float uEye = (virtTan.x - (-uVirtTanBounds.x)) / (uVirtTanBounds.y + uVirtTanBounds.x);
    float vEye = (virtTan.y - (-uVirtTanBounds.z)) / (uVirtTanBounds.w + uVirtTanBounds.z);

    // Vignette boundary
    if (uEye < 0.0 || uEye > 1.0 || vEye < 0.0 || vEye > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    gl_FragColor = texture2D(uEyeTexture, vec2(uEye, vEye));
  }
`;
