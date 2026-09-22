// ============================================================================
// Nonius Alignment & Dichoptic Registration Harness
// Issue #31: Diagnostic-only measurement of net subjective binocular registration
// Primary Contract: Independent of G1/G2/G3; eye-local angular coordinate model;
// zero-offset fusion lock; symmetric dichoptic Nonius offsets; no persistence.
// ============================================================================

export const REGISTRATION_BOUNDS = Object.freeze({
  minXDeg: -5.0,
  maxXDeg: 5.0,
  minYDeg: -3.0,
  maxYDeg: 3.0
});

export const REGISTRATION_STEPS = Object.freeze({
  coarseDeg: 0.50,
  fineDeg: 0.05
});

/**
 * Fail-closed validation for registration offsets.
 * Rejects NaN, Infinity, non-numbers, and out-of-bounds values.
 */
export function validateRegistrationOffset(xDeg, yDeg) {
  if (typeof xDeg !== 'number' || !Number.isFinite(xDeg) || Number.isNaN(xDeg)) {
    return { valid: false, reason: 'xDeg must be a finite number' };
  }
  if (typeof yDeg !== 'number' || !Number.isFinite(yDeg) || Number.isNaN(yDeg)) {
    return { valid: false, reason: 'yDeg must be a finite number' };
  }
  if (xDeg < REGISTRATION_BOUNDS.minXDeg || xDeg > REGISTRATION_BOUNDS.maxXDeg) {
    return { valid: false, reason: `xDeg ${xDeg} out of bounds [${REGISTRATION_BOUNDS.minXDeg}, ${REGISTRATION_BOUNDS.maxXDeg}]` };
  }
  if (yDeg < REGISTRATION_BOUNDS.minYDeg || yDeg > REGISTRATION_BOUNDS.maxYDeg) {
    return { valid: false, reason: `yDeg ${yDeg} out of bounds [${REGISTRATION_BOUNDS.minYDeg}, ${REGISTRATION_BOUNDS.maxYDeg}]` };
  }
  return { valid: true };
}

/**
 * Convert eye-local visual angles (in degrees) to canvas pixel coordinates.
 * Eye index: 0 = left eye, 1 = right eye.
 * Positive angleX = rightward visual angle.
 * Positive angleY = upward visual angle (canvas Y inverted: larger angleY -> smaller py).
 */
export function visualAngleToEyeCanvasPx(angleXDeg, angleYDeg, eyeIndex, eyeGeom, halfW, height) {
  if (!eyeGeom) return null;
  const eye = (eyeIndex === 0) ? eyeGeom.leftEye : eyeGeom.rightEye;
  const [tanL, tanR, tanB, tanT] = eye.virtTanBounds;

  const tanX = Math.tan(angleXDeg * (Math.PI / 180));
  const tanY = Math.tan(angleYDeg * (Math.PI / 180));

  const u = (tanX + tanL) / (tanL + tanR);
  const v = (tanY + tanB) / (tanB + tanT);

  const px = (eyeIndex * halfW) + u * halfW;
  const py = (1.0 - v) * height;

  return { px, py, u, v, tanX, tanY };
}

/**
 * Derive applied pixel offsets for telemetry from actual render geometry.
 */
export function deriveRegistrationPixelOffsets(offsetXDeg, offsetYDeg, eyeGeom, halfW, height) {
  if (!eyeGeom) return { offsetXPx: 0, offsetYPx: 0 };
  const pL_X0 = visualAngleToEyeCanvasPx(0, 0, 0, eyeGeom, halfW, height);
  const pL_X = visualAngleToEyeCanvasPx(-offsetXDeg / 2, 0, 0, eyeGeom, halfW, height);
  const pR_X0 = visualAngleToEyeCanvasPx(0, 0, 1, eyeGeom, halfW, height);
  const pR_X = visualAngleToEyeCanvasPx(+offsetXDeg / 2, 0, 1, eyeGeom, halfW, height);

  const pL_Y0 = visualAngleToEyeCanvasPx(0, 0, 0, eyeGeom, halfW, height);
  const pL_Y = visualAngleToEyeCanvasPx(0, -offsetYDeg / 2, 0, eyeGeom, halfW, height);
  const pR_Y0 = visualAngleToEyeCanvasPx(0, 0, 1, eyeGeom, halfW, height);
  const pR_Y = visualAngleToEyeCanvasPx(0, +offsetYDeg / 2, 1, eyeGeom, halfW, height);

  // Relative shift: Right displacement minus Left displacement
  const dxR = pR_X.px - pR_X0.px;
  const dxL = pL_X.px - pL_X0.px;
  const dyR = pR_Y.py - pR_Y0.py;
  const dyL = pL_Y.py - pL_Y0.py;

  return {
    offsetXPx: Number((dxR - dxL).toFixed(2)),
    offsetYPx: Number((dyR - dyL).toFixed(2))
  };
}

/**
 * Render the dedicated dichoptic Nonius registration screen.
 * - Complete opaque black background over both eyes (no video visible).
 * - Identical binocular fusion-lock frame & central fixation dot (zero offset).
 * - Dichoptic Nonius segments with symmetric +/- half-offset.
 * - NO numeric or technical diagnostic text inside headset.
 */
export function renderNoniusRegistrationScreen(uiCtx, width, height, eyeGeom, appState) {
  if (!uiCtx || !eyeGeom) return false;

  const halfW = Math.floor(width / 2);
  const offsetXDeg = (appState && typeof appState.uiRegistrationOffsetXDeg === 'number')
    ? appState.uiRegistrationOffsetXDeg
    : 0.0;
  const offsetYDeg = (appState && typeof appState.uiRegistrationOffsetYDeg === 'number')
    ? appState.uiRegistrationOffsetYDeg
    : 0.0;

  // 1. Cover BOTH eyes with opaque black
  uiCtx.save();
  uiCtx.fillStyle = '#000000';
  uiCtx.fillRect(0, 0, width, height);

  for (let eye = 0; eye < 2; eye++) {
    const eyeOffsetX = eye * halfW;

    uiCtx.save();
    uiCtx.beginPath();
    uiCtx.rect(eyeOffsetX, 0, halfW, height);
    uiCtx.clip();

    // ------------------------------------------------------------------------
    // A. Binocular Fusion-Lock Frame & Central Fixation Target (Zero Offset)
    // Must remain IDENTICAL in both eyes at (0, 0) visual angle.
    // ------------------------------------------------------------------------
    const pCenter = visualAngleToEyeCanvasPx(0, 0, eye, eyeGeom, halfW, height);
    const pBoxTopLeft = visualAngleToEyeCanvasPx(-3.0, 3.0, eye, eyeGeom, halfW, height);
    const pBoxBottomRight = visualAngleToEyeCanvasPx(3.0, -3.0, eye, eyeGeom, halfW, height);

    if (pCenter && pBoxTopLeft && pBoxBottomRight) {
      const boxW = pBoxBottomRight.px - pBoxTopLeft.px;
      const boxH = pBoxBottomRight.py - pBoxTopLeft.py;

      // Outer fusion-lock square frame (3.0 deg semi-field)
      uiCtx.strokeStyle = 'rgba(255, 255, 255, 0.90)';
      uiCtx.lineWidth = 2.5;
      uiCtx.strokeRect(pBoxTopLeft.px, pBoxTopLeft.py, boxW, boxH);

      // Peripheral corner tick brackets (extending 0.5 deg outward)
      const tickCornerOuter = visualAngleToEyeCanvasPx(3.5, 3.5, eye, eyeGeom, halfW, height);
      if (tickCornerOuter) {
        const tickLen = Math.abs(tickCornerOuter.px - pBoxBottomRight.px);
        uiCtx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
        uiCtx.lineWidth = 1.8;

        // Top-left corner tick
        uiCtx.beginPath();
        uiCtx.moveTo(pBoxTopLeft.px - tickLen, pBoxTopLeft.py);
        uiCtx.lineTo(pBoxTopLeft.px, pBoxTopLeft.py);
        uiCtx.lineTo(pBoxTopLeft.px, pBoxTopLeft.py - tickLen);
        uiCtx.stroke();

        // Top-right corner tick
        uiCtx.beginPath();
        uiCtx.moveTo(pBoxBottomRight.px + tickLen, pBoxTopLeft.py);
        uiCtx.lineTo(pBoxBottomRight.px, pBoxTopLeft.py);
        uiCtx.lineTo(pBoxBottomRight.px, pBoxTopLeft.py - tickLen);
        uiCtx.stroke();

        // Bottom-left corner tick
        uiCtx.beginPath();
        uiCtx.moveTo(pBoxTopLeft.px - tickLen, pBoxBottomRight.py);
        uiCtx.lineTo(pBoxTopLeft.px, pBoxBottomRight.py);
        uiCtx.lineTo(pBoxTopLeft.px, pBoxBottomRight.py + tickLen);
        uiCtx.stroke();

        // Bottom-right corner tick
        uiCtx.beginPath();
        uiCtx.moveTo(pBoxBottomRight.px + tickLen, pBoxBottomRight.py);
        uiCtx.lineTo(pBoxBottomRight.px, pBoxBottomRight.py);
        uiCtx.lineTo(pBoxBottomRight.px, pBoxBottomRight.py + tickLen);
        uiCtx.stroke();
      }

      // Central fixation ring / dot (identical zero-offset anchor at 0 deg)
      uiCtx.beginPath();
      uiCtx.arc(pCenter.px, pCenter.py, 3.0, 0, Math.PI * 2);
      uiCtx.fillStyle = '#ffffff';
      uiCtx.fill();
    }

    // ------------------------------------------------------------------------
    // B. Dichoptic Nonius Stimulus (Symmetric +/- half-offset)
    // Horizontal stimulus:
    //   Left eye (eye 0)  -> UPPER vertical segment at X = -offsetXDeg / 2
    //   Right eye (eye 1) -> LOWER vertical segment at X = +offsetXDeg / 2
    // Vertical stimulus:
    //   Left eye (eye 0)  -> LEFT horizontal segment at Y = -offsetYDeg / 2
    //   Right eye (eye 1) -> RIGHT horizontal segment at Y = +offsetYDeg / 2
    // ------------------------------------------------------------------------
    const xNoniusDeg = (eye === 0) ? (-offsetXDeg / 2) : (+offsetXDeg / 2);
    const yNoniusDeg = (eye === 0) ? (-offsetYDeg / 2) : (+offsetYDeg / 2);

    uiCtx.lineWidth = 3.0;
    uiCtx.lineCap = 'square';

    if (eye === 0) {
      // --- LEFT EYE ---
      // 1. Upper vertical segment: Y from +0.6 deg to +2.4 deg, X = xNoniusDeg
      const pUpperStart = visualAngleToEyeCanvasPx(xNoniusDeg, 0.6, eye, eyeGeom, halfW, height);
      const pUpperEnd = visualAngleToEyeCanvasPx(xNoniusDeg, 2.4, eye, eyeGeom, halfW, height);
      if (pUpperStart && pUpperEnd) {
        uiCtx.strokeStyle = '#38bdf8'; // High-contrast bright cyan
        uiCtx.beginPath();
        uiCtx.moveTo(pUpperStart.px, pUpperStart.py);
        uiCtx.lineTo(pUpperEnd.px, pUpperEnd.py);
        uiCtx.stroke();
      }

      // 2. Left horizontal segment: X from -2.4 deg to -0.6 deg, Y = yNoniusDeg
      const pLeftStart = visualAngleToEyeCanvasPx(-2.4, yNoniusDeg, eye, eyeGeom, halfW, height);
      const pLeftEnd = visualAngleToEyeCanvasPx(-0.6, yNoniusDeg, eye, eyeGeom, halfW, height);
      if (pLeftStart && pLeftEnd) {
        uiCtx.strokeStyle = '#34d399'; // High-contrast bright emerald
        uiCtx.beginPath();
        uiCtx.moveTo(pLeftStart.px, pLeftStart.py);
        uiCtx.lineTo(pLeftEnd.px, pLeftEnd.py);
        uiCtx.stroke();
      }
    } else {
      // --- RIGHT EYE ---
      // 1. Lower vertical segment: Y from -2.4 deg to -0.6 deg, X = xNoniusDeg
      const pLowerStart = visualAngleToEyeCanvasPx(xNoniusDeg, -2.4, eye, eyeGeom, halfW, height);
      const pLowerEnd = visualAngleToEyeCanvasPx(xNoniusDeg, -0.6, eye, eyeGeom, halfW, height);
      if (pLowerStart && pLowerEnd) {
        uiCtx.strokeStyle = '#38bdf8'; // Matching bright cyan
        uiCtx.beginPath();
        uiCtx.moveTo(pLowerStart.px, pLowerStart.py);
        uiCtx.lineTo(pLowerEnd.px, pLowerEnd.py);
        uiCtx.stroke();
      }

      // 2. Right horizontal segment: X from +0.6 deg to +2.4 deg, Y = yNoniusDeg
      const pRightStart = visualAngleToEyeCanvasPx(0.6, yNoniusDeg, eye, eyeGeom, halfW, height);
      const pRightEnd = visualAngleToEyeCanvasPx(2.4, yNoniusDeg, eye, eyeGeom, halfW, height);
      if (pRightStart && pRightEnd) {
        uiCtx.strokeStyle = '#34d399'; // Matching bright emerald
        uiCtx.beginPath();
        uiCtx.moveTo(pRightStart.px, pRightStart.py);
        uiCtx.lineTo(pRightEnd.px, pRightEnd.py);
        uiCtx.stroke();
      }
    }

    uiCtx.restore();
  }

  uiCtx.restore();
  return true;
}
