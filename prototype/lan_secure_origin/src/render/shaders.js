// ==========================================
// WebGL Shader Sources: Rectilinear Diagnostic View + Cardboard Lens Pre-Warp Model
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
  uniform int uEyeSwap;          // 0: Normal, 1: Swapped
  uniform int uProjectionMode;    // 0: Equirect-180, 1: Equirect-360, 2: Flat-2D, 3: Unknown/Unconfigured
  uniform int uStereoLayout;     // 0: Side-by-Side (SBS), 1: Top-Bottom (TB), 2: Mono
  uniform float uAspect;
  uniform float uFovRad;
  uniform vec2 uCoverageRad;     // vec2(horizontalRad, verticalRad)
  uniform vec4 uCrop;            // vec4(left, right, top, bottom)
  uniform int uLensCorrection;   // 0: OFF (Rectilinear), 1: ON (Cardboard Spec Pre-Warp)
  uniform vec2 uDistortionK;     // vec2(k1, k2)

  const float PI = 3.14159265358979323846;
  const float HALF_PI = 1.57079632679489661923;

  void main() {
    vec2 ndc = (vUv - 0.5) * 2.0;

    // Handle Unverified / Unknown projection
    if (uProjectionMode == 3) {
      // Diagnostic placeholder pattern
      float checker = mod(floor(vUv.x * 20.0) + floor(vUv.y * 20.0), 2.0);
      gl_FragColor = mix(vec4(0.08, 0.12, 0.2, 1.0), vec4(0.15, 0.22, 0.35, 1.0), checker);
      return;
    }

    vec3 rayCam = vec3(0.0);
    float tanHalfFov = tan(uFovRad * 0.5);

    if (uLensCorrection == 1) {
      // Official Google Cardboard Tangent-Space Lens Pre-Distortion Model
      // Reference: Google Cardboard SDK (CardboardDistortion / LensDistortion API)
      vec2 tanCoords = vec2(ndc.x * tanHalfFov * uAspect, ndc.y * tanHalfFov);
      float rSq = tanCoords.x * tanCoords.x + tanCoords.y * tanCoords.y;
      float k1 = uDistortionK.x;
      float k2 = uDistortionK.y;
      float distortionFactor = 1.0 + k1 * rSq + k2 * rSq * rSq;
      vec2 distortedTan = tanCoords * distortionFactor;
      rayCam = normalize(vec3(distortedTan.x, distortedTan.y, -1.0));
    } else {
      // Pure Rectilinear Pinhole Ray (Lens Correction OFF)
      rayCam = normalize(vec3(ndc.x * tanHalfFov * uAspect, ndc.y * tanHalfFov, -1.0));
    }

    // Combine Head Tracking and Camera Pose Matrices
    vec3 dWorld = uPoseRot * (uCamRot * rayCam);

    if (uProjectionMode == 2) {
      // Direct Flat Pass-through
      gl_FragColor = texture2D(uVideoTexture, vUv);
      return;
    }

    // Spherical Coordinates (lon, lat)
    float lon = atan(dWorld.x, -dWorld.z);
    float lat = asin(clamp(dWorld.y, -1.0, 1.0));

    float maxHalfLon = (uProjectionMode == 0) ? (uCoverageRad.x * 0.5) : PI;
    float maxHalfLat = (uCoverageRad.y * 0.5);

    if (abs(lon) > maxHalfLon || abs(lat) > maxHalfLat) {
      gl_FragColor = vec4(0.012, 0.016, 0.024, 1.0);
      return;
    }

    // Normalized UV on Source Hemisphere/Sphere
    float uLocal = 0.5 + lon / uCoverageRad.x;
    float vLocal = 0.5 + lat / uCoverageRad.y;

    // Apply Crop/Bounds
    uLocal = uCrop.x + uLocal * (1.0 - uCrop.x - uCrop.y);
    vLocal = uCrop.z + vLocal * (1.0 - uCrop.z - uCrop.w);

    // Determine Source Eye
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
