// ==========================================
// WebGL Shader Sources (3D Stereo SBS 180°)
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
  uniform int uEye;
  uniform float uAspect;

  const float PI = 3.14159265358979323846;
  const float HALF_PI = 1.57079632679489661923;
  const float FOV = 1.65;

  void main() {
    vec2 ndc = (vUv - 0.5) * 2.0;
    float tanHalfFov = tan(FOV * 0.5);
    vec3 rayCam = normalize(vec3(ndc.x * tanHalfFov * uAspect, ndc.y * tanHalfFov, -1.0));
    
    vec3 dWorld = uCamRot * rayCam;

    float lon = atan(dWorld.x, -dWorld.z);
    float lat = asin(clamp(dWorld.y, -1.0, 1.0));

    if (abs(lon) > HALF_PI) {
      gl_FragColor = vec4(0.02, 0.03, 0.05, 1.0);
      return;
    }

    float uLocal = 0.5 + lon / PI;
    float vLocal = 0.5 + lat / PI;

    float sourceEye = float(uEye);
    vec2 texUv = vec2(0.5 * (uLocal + sourceEye), vLocal);

    gl_FragColor = texture2D(uVideoTexture, texUv);
  }
`;
