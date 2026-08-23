// ==========================================
// Recenter Pose & Posture Calibration State Machine
// ==========================================
import { state, showFeedbackToast } from './state.js';
import {
  computePoseQuaternion,
  qPoseCurrent,
  qRefInv,
  qCamera,
  qCameraInv,
  cameraMat3
} from './orientation.js';
import { playAudioFeedback, triggerHaptic } from '../controls/audio-haptics.js';
import { telemetry } from '../telemetry/telemetry.js';

export function recenterPose() {
  const currentQ = computePoseQuaternion(
    state.rawOrientation.alpha,
    state.rawOrientation.beta,
    state.rawOrientation.gamma,
    state.screenAngle
  );

  qPoseCurrent.copy(currentQ);
  qRefInv.copy(qPoseCurrent.clone().invert());
  qCamera.copy(qRefInv.clone().multiply(qPoseCurrent));
  qCameraInv.copy(qCamera.clone().invert());

  const mat = qCamera.toMat3ColumnMajor();
  for (let i = 0; i < 9; i++) {
    cameraMat3[i] = mat[i];
  }

  state.cameraForward = qCamera.transformVector([0, 0, -1]);
  state.cameraUp = qCamera.transformVector([0, 1, 0]);
  state.qPose = [qPoseCurrent.x, qPoseCurrent.y, qPoseCurrent.z, qPoseCurrent.w];
  state.qRefInv = [qRefInv.x, qRefInv.y, qRefInv.z, qRefInv.w];
  state.qCamera = [qCamera.x, qCamera.y, qCamera.z, qCamera.w];

  const elFwd = document.getElementById('valCamFwd');
  if (elFwd) {
    elFwd.textContent = state.cameraForward[0].toFixed(2) + ',' + state.cameraForward[1].toFixed(2) + ',' + state.cameraForward[2].toFixed(2);
  }
}

export function startRecenterCalibration(durationMs = 2500, label = '校准姿势中 (Recenter)') {
  state.recenterCountdown.active = true;
  state.recenterCountdown.startTime = performance.now();
  state.recenterCountdown.durationMs = durationMs;
  state.recenterCountdown.lastSecondTick = -1;
  state.recenterCountdown.label = label;
  playAudioFeedback('tick');
  showFeedbackToast('🎯 请面朝正前方坐正...');
}
