// ==========================================
// WebGL Shader Sources: Rectilinear Diagnostic View + Stereo VR with Lens Correction
// ==========================================

export const vsSource = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

export const fsSource = `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uVideoTexture;
  uniform mat3 uCamRot;
  uniform mat3 uPoseRot;
  uniform int uEye;              // 0: Left Eye, 1: Right Eye
  uniform int uEyeSwap;          // 0: Left-Right, 1: Right-Left
  uniform int uProjectionMode;    // 0: Equirect-180, 1: Equirect-360, 2: Flat-2D
  uniform int uStereoLayout;     // 0: Side-by-Side (SBS), 1: Top-Bottom (TB), 2: Mono
  uniform float uAspect;
  uniform float uFovRad;
  uniform vec2 uCoverageRad;     // vec2(horizontalRad, verticalRad)
  uniform vec4 uCrop;            // vec4(left, right, top, bottom)
  uniform int uLensCorrection;   // 0: OFF (Rectilinear), 1: ON (Radial Pre-warp)
  uniform vec2 uDistortionK;     // vec2(k1, k2)

  const float PI = 3.14159265358979323846;
  const float HALF_PI = 1.57079632679489661923;

  void main() {
    vec2 ndc = (vUv - 0.5) * 2.0;

    // Apply Lens Pre-Distortion (Brown-Conrady Radial Model)
    if (uLensCorrection == 1) {
      float rSq = ndc.x * ndc.x + ndc.y * ndc.y;
      float k1 = uDistortionK.x;
      float k2 = uDistortionK.y;
      float distortFactor = 1.0 + k1 * rSq + k2 * rSq * rSq;
      // Normalization scale at r=1 to avoid clipping active frame
      float normScale = 1.0 + k1 + k2;
      ndc = (ndc * distortFactor) / normScale;
    }

    // Pinhole Rectilinear Ray Generation
    float tanHalfFov = tan(uFovRad * 0.5);
    vec3 rayCam = normalize(vec3(ndc.x * tanHalfFov * uAspect, ndc.y * tanHalfFov, -1.0));

    // Combine Head Pose and Media Pose Rotation
    vec3 dWorld = uPoseRot * (uCamRot * rayCam);

    if (uProjectionMode == 2) {
      // Direct Flat pass-through
      gl_FragColor = texture2D(uVideoTexture, vUv);
      return;
    }

    // Spherical Coordinates (lon, lat)
    float lon = atan(dWorld.x, -dWorld.z);
    float lat = asin(clamp(dWorld.y, -1.0, 1.0));

    float maxHalfLon = (uProjectionMode == 0) ? (uCoverageRad.x * 0.5) : PI;
    float maxHalfLat = (uCoverageRad.y * 0.5);

    if (abs(lon) > maxHalfLon || abs(lat) > maxHalfLat) {
      gl_FragColor = vec4(0.015, 0.02, 0.03, 1.0);
      return;
    }

    // Map to Local Sphere UV [0, 1]
    float uLocal = 0.5 + lon / uCoverageRad.x;
    float vLocal = 0.5 + lat / uCoverageRad.y;

    // Apply Crop
    uLocal = uCrop.x + uLocal * (1.0 - uCrop.x - uCrop.y);
    vLocal = uCrop.z + vLocal * (1.0 - uCrop.z - uCrop.w);

    // Determine Source Eye Index (handling eye swap)
    int sourceEye = uEye;
    if (uEyeSwap == 1) {
      sourceEye = (uEye == 0) ? 1 : 0;
    }

    vec2 texUv = vec2(0.0);
    if (uStereoLayout == 0) {
      // Side-by-Side (SBS)
      texUv = vec2(0.5 * (uLocal + float(sourceEye)), vLocal);
    } else if (uStereoLayout == 1) {
      // Top-Bottom (TB)
      texUv = vec2(uLocal, 0.5 * (vLocal + float(1 - sourceEye)));
    } else {
      // Mono
      texUv = vec2(uLocal, vLocal);
    }

    gl_FragColor = texture2D(uVideoTexture, texUv);
  }
`;
