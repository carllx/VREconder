// ==========================================
// DeviceOrientation Sensor & Screen Orientation
// ==========================================
import { Quat } from './quaternion.js';
import { state } from './state.js';
import { telemetry } from '../telemetry/telemetry.js';

export const qCameraCorrect = new Quat(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
export const qScreenZ = new Quat();

export let qPoseCurrent = new Quat();
export let qRefInv = new Quat();
export let qCamera = new Quat();
export let qCameraInv = new Quat();
export let cameraMat3 = [1, 0, 0,  0, 1, 0,  0, 0, 1];

export function updateScreenOrientation() {
  let angle = 0;
  if (screen.orientation && typeof screen.orientation.angle === 'number') {
    angle = screen.orientation.angle;
  } else if (typeof window.orientation === 'number') {
    angle = window.orientation;
  }

  // Fallback for iOS Safari Standalone / PWA when orientation property reports 0 in landscape
  if (angle === 0 && window.innerWidth > window.innerHeight) {
    angle = 90;
  }

  state.screenAngle = angle;
  state.viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
}

export function computePoseQuaternion(alphaDeg, betaDeg, gammaDeg, screenAngleDeg) {
  const deg2rad = Math.PI / 180;
  const betaRad = betaDeg * deg2rad;
  const alphaRad = alphaDeg * deg2rad;
  const gammaRad = gammaDeg * deg2rad;
  const screenRad = screenAngleDeg * deg2rad;

  const q = new Quat().setFromEulerYXZ(betaRad, alphaRad, -gammaRad);
  q.multiply(qCameraCorrect);
  qScreenZ.setFromAxisAngle(0, 0, 1, -screenRad);
  q.multiply(qScreenZ);
  return q;
}

export function initOrientationListeners(onOrientationUpdateCallback) {
  window.addEventListener('orientationchange', () => {
    setTimeout(updateScreenOrientation, 50);
  });
  window.addEventListener('resize', updateScreenOrientation);
  updateScreenOrientation();

  window.addEventListener('deviceorientation', (e) => {
    if (e.alpha === null) return;
    state.motionEventCount++;
    state.rawOrientation.alpha = e.alpha;
    state.rawOrientation.beta = e.beta || 0;
    state.rawOrientation.gamma = e.gamma || 0;

    qPoseCurrent = computePoseQuaternion(e.alpha, e.beta || 0, e.gamma || 0, state.screenAngle);
    qCamera = qRefInv.clone().multiply(qPoseCurrent);
    qCameraInv = qCamera.clone().invert();
    
    const mat = qCamera.toMat3ColumnMajor();
    for (let i = 0; i < 9; i++) {
      cameraMat3[i] = mat[i];
    }

    state.cameraForward = qCamera.transformVector([0, 0, -1]);
    state.cameraUp = qCamera.transformVector([0, 1, 0]);
    state.qPose = [qPoseCurrent.x, qPoseCurrent.y, qPoseCurrent.z, qPoseCurrent.w];
    state.qCamera = [qCamera.x, qCamera.y, qCamera.z, qCamera.w];

    telemetry.onHeadMove(state.cameraForward);

    const fx = state.cameraForward[0];
    const fy = state.cameraForward[1];
    let hState = 'Center';
    if (fx > 0.25) hState = 'Turn RIGHT';
    else if (fx < -0.25) hState = 'Turn LEFT';
    else if (fy > 0.25) hState = 'Look UP';
    else if (fy < -0.25) hState = 'Look DOWN';
    state.headStateText = hState;

    if (onOrientationUpdateCallback) {
      onOrientationUpdateCallback();
    }
  }, { passive: true });
}
