// ==========================================
// 2D Stereo UI Overlay & Reticle Rendering
// (Suppressed during Optics Calibration Stage B & C to prevent visual contamination)
// ==========================================
import { state } from '../core/state.js';
import { qCameraInv } from '../core/orientation.js';
import { getActiveInteractiveItems } from './patterns.js';

const FOV_RAD = 1.65;
const TAN_HALF_FOV = Math.tan(FOV_RAD * 0.5);

export function projectWorldDirToEye(dirWorld, eyeIndex, halfW, height) {
  if (!dirWorld) return null;
  const aspect = halfW / height;
  const dCam = qCameraInv.transformVector(dirWorld);
  if (dCam[2] >= -0.01) return null;

  const zDepth = -dCam[2];
  const ndcX = dCam[0] / (zDepth * TAN_HALF_FOV * aspect);
  const ndcY = dCam[1] / (zDepth * TAN_HALF_FOV);

  if (Math.abs(ndcX) > 1.35 || Math.abs(ndcY) > 1.35) return null;

  const stereoDisparityPx = (eyeIndex === 0 ? +5.5 : -5.5);
  const px = (eyeIndex * halfW) + (ndcX * 0.5 + 0.5) * halfW + stereoDisparityPx;
  const py = (1.0 - (ndcY * 0.5 + 0.5)) * height;
  return { x: px, y: py, ndcX, ndcY, zDepth };
}

export function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  if (typeof radius === 'undefined') radius = 5;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

export function renderStereoUI(uiCtx, gazeEngine, commandModel, videoElement, now, width, height) {
  if (!uiCtx) return;
  uiCtx.clearRect(0, 0, width, height);
  if (!state.inVR) return;

  const halfW = Math.floor(width / 2);
  const isOpticsMode = (state.calibrationStage === 'B' || state.calibrationStage === 'C');

  for (let eye = 0; eye < 2; eye++) {
    const eyeOffsetX = eye * halfW;
    const eyeCenterX = eyeOffsetX + halfW * 0.5;
    const eyeCenterY = height * 0.5;

    uiCtx.save();
    uiCtx.beginPath();
    uiCtx.rect(eyeOffsetX, 0, halfW, height);
    uiCtx.clip();

    // 1. Recenter Calibration Modal (Always allowed when active)
    if (state.recenterCountdown.active) {
      const elapsed = now - state.recenterCountdown.startTime;
      const dur = state.recenterCountdown.durationMs;
      const remainSec = Math.max(1, Math.ceil((dur - elapsed) / 1000));
      const progress = Math.max(0, Math.min(1, elapsed / dur));

      const cardW = 320, cardH = 150;
      uiCtx.fillStyle = 'rgba(15, 23, 42, 0.94)';
      uiCtx.strokeStyle = '#38bdf8';
      uiCtx.lineWidth = 2;
      roundRect(uiCtx, eyeCenterX - cardW/2, eyeCenterY - cardH/2, cardW, cardH, 18, true, true);

      uiCtx.font = 'bold 15px -apple-system, sans-serif';
      uiCtx.fillStyle = '#38bdf8';
      uiCtx.textAlign = 'center';
      uiCtx.textBaseline = 'top';
      uiCtx.fillText(state.recenterCountdown.label, eyeCenterX, eyeCenterY - cardH/2 + 15);

      uiCtx.font = '13px -apple-system, sans-serif';
      uiCtx.fillStyle = '#e2e8f0';
      uiCtx.fillText('请调整好舒适坐姿，面朝正前方', eyeCenterX, eyeCenterY - cardH/2 + 38);

      const numCenterY = eyeCenterY + 22;
      uiCtx.beginPath();
      uiCtx.arc(eyeCenterX, numCenterY, 26, 0, Math.PI * 2);
      uiCtx.fillStyle = 'rgba(30, 41, 59, 0.9)';
      uiCtx.fill();
      uiCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      uiCtx.lineWidth = 2.5;
      uiCtx.stroke();

      uiCtx.beginPath();
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + (Math.PI * 2 * (1.0 - progress));
      uiCtx.arc(eyeCenterX, numCenterY, 26, startAngle, endAngle);
      uiCtx.strokeStyle = '#34d399';
      uiCtx.lineWidth = 3.5;
      uiCtx.stroke();

      uiCtx.font = 'bold 22px -apple-system, monospace';
      uiCtx.fillStyle = '#ffffff';
      uiCtx.textAlign = 'center';
      uiCtx.textBaseline = 'middle';
      uiCtx.fillText(remainSec, eyeCenterX, numCenterY);

      uiCtx.restore();
      continue;
    }

    // 2. Loading Buffer Splash Indicator in VR Stage C
    if (state.calibrationStage === 'C' && !state.firstFrameTimings.ready) {
      uiCtx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      uiCtx.strokeStyle = '#38bdf8';
      uiCtx.lineWidth = 1.5;
      const tw = 260, th = 40;
      roundRect(uiCtx, eyeCenterX - tw/2, eyeCenterY - th/2, tw, th, 10, true, true);

      uiCtx.font = 'bold 12px -apple-system, monospace';
      uiCtx.fillStyle = '#38bdf8';
      uiCtx.textAlign = 'center';
      uiCtx.textBaseline = 'middle';
      uiCtx.fillText('⏳ ' + (state.firstFrameTimings.statusText || 'Loading Frame...'), eyeCenterX, eyeCenterY);
      uiCtx.restore();
      continue;
    }

    // In Optics Experiment Stage B & C: Completely suppress legacy playback UI & gaze nodes
    if (isOpticsMode) {
      // Show subtle feedback toast if triggered from PC controller
      if (state.toastText && (now - state.toastTime < 2000)) {
        const alpha = Math.min(1.0, 1.0 - (now - state.toastTime - 1200) / 800);
        if (alpha > 0) {
          uiCtx.fillStyle = 'rgba(15, 23, 42, ' + (0.88 * alpha) + ')';
          uiCtx.strokeStyle = 'rgba(56, 189, 248, ' + (0.8 * alpha) + ')';
          uiCtx.lineWidth = 1.2;
          const tw = 240, th = 30;
          const toastY = eyeCenterY - 100;
          roundRect(uiCtx, eyeCenterX - tw/2, toastY - th/2, tw, th, 15, true, true);

          uiCtx.font = 'bold 12px -apple-system, sans-serif';
          uiCtx.fillStyle = 'rgba(255, 255, 255, ' + alpha + ')';
          uiCtx.textAlign = 'center';
          uiCtx.textBaseline = 'middle';
          uiCtx.fillText(state.toastText, eyeCenterX, toastY);
        }
      }
      uiCtx.restore();
      continue;
    }

    // 3. Draw Interactive Circular Icon Nodes (Only in non-calibration general playback)
    const items = getActiveInteractiveItems(commandModel, videoElement);
    items.forEach(item => {
      if (!item.dirWorld) return;
      const p = projectWorldDirToEye(item.dirWorld, eye, halfW, height);
      if (!p) return;

      const isHovered = (gazeEngine.currentHoveredItem && gazeEngine.currentHoveredItem.id === item.id);
      const isActivated = (gazeEngine.activatedItemId === item.id && (now - gazeEngine.activationFlashTime < 300));
      const btnR = Math.max(20, (item.radiusDeg * 4.6) * (halfW / 400));

      uiCtx.save();
      uiCtx.beginPath();
      uiCtx.arc(p.x, p.y, btnR, 0, Math.PI * 2);

      if (isActivated) {
        uiCtx.fillStyle = 'rgba(16, 185, 129, 0.95)';
        uiCtx.strokeStyle = '#34d399';
        uiCtx.lineWidth = 3;
      } else if (isHovered) {
        uiCtx.fillStyle = item.color ? (item.color + 'dd') : 'rgba(37, 99, 235, 0.9)';
        uiCtx.strokeStyle = '#38bdf8';
        uiCtx.lineWidth = 2.5;
        uiCtx.shadowColor = '#38bdf8';
        uiCtx.shadowBlur = 10;
      } else {
        uiCtx.fillStyle = item.color ? (item.color + '66') : 'rgba(15, 23, 42, 0.8)';
        uiCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        uiCtx.lineWidth = 1.4;
      }
      uiCtx.fill();
      uiCtx.stroke();

      if (isHovered && gazeEngine.dwellProgress > 0) {
        uiCtx.beginPath();
        const startAngle = -Math.PI / 2;
        const endAngle = startAngle + (Math.PI * 2 * gazeEngine.dwellProgress);
        uiCtx.arc(p.x, p.y, btnR + 3.5, startAngle, endAngle);
        uiCtx.strokeStyle = '#34d399';
        uiCtx.lineWidth = 3.5;
        uiCtx.stroke();
      }

      uiCtx.shadowBlur = 0;
      uiCtx.font = 'bold ' + Math.round(btnR * 0.85) + 'px -apple-system, sans-serif';
      uiCtx.fillStyle = '#ffffff';
      uiCtx.textAlign = 'center';
      uiCtx.textBaseline = 'middle';
      uiCtx.fillText(item.icon, p.x, p.y);
      uiCtx.restore();
    });

    // 4. Center Gaze Reticle
    const isHovering = gazeEngine.currentHoveredItem !== null;
    const reticleR = isHovering ? 12 : 7;

    uiCtx.beginPath();
    uiCtx.arc(eyeCenterX, eyeCenterY, reticleR, 0, Math.PI * 2);
    uiCtx.strokeStyle = isHovering ? '#38bdf8' : 'rgba(255, 255, 255, 0.6)';
    uiCtx.lineWidth = isHovering ? 2.2 : 1.2;
    uiCtx.stroke();

    uiCtx.beginPath();
    uiCtx.arc(eyeCenterX, eyeCenterY, 2.5, 0, Math.PI * 2);
    uiCtx.fillStyle = isHovering ? '#38bdf8' : 'rgba(255, 255, 255, 0.85)';
    uiCtx.fill();

    uiCtx.restore();
  }
}
