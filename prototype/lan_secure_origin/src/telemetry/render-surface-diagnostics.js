// ==========================================
// Safari Real-Device Render-Surface Diagnostics
// Captures exact display geometry, viewports, insets, and renders edge fixtures
// ==========================================
import { deriveCardboardEyeGeometry } from '../core/projection-profile.js';
import { activeScreenProfile } from '../core/screen-profile.js';

let cachedSafeAreaElement = null;

function getSafeAreaInsets() {
  if (typeof document === 'undefined') {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  if (!cachedSafeAreaElement) {
    const el = document.createElement('div');
    el.id = 'safeAreaProbeElement';
    el.style.position = 'fixed';
    el.style.top = '0';
    el.style.left = '0';
    el.style.width = '0';
    el.style.height = '0';
    el.style.paddingTop = 'env(safe-area-inset-top, 0px)';
    el.style.paddingRight = 'env(safe-area-inset-right, 0px)';
    el.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
    el.style.paddingLeft = 'env(safe-area-inset-left, 0px)';
    el.style.pointerEvents = 'none';
    el.style.visibility = 'hidden';
    el.style.zIndex = '-1000';
    (document.body || document.documentElement).appendChild(el);
    cachedSafeAreaElement = el;
  }

  const cs = window.getComputedStyle(cachedSafeAreaElement);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0
  };
}

export function captureRenderSurfaceSnapshot(glCanvas, uiCanvas, renderScale = 1.0) {
  const isBrowser = typeof window !== 'undefined';
  const scr = isBrowser && window.screen ? window.screen : {};
  const vv = isBrowser && window.visualViewport ? window.visualViewport : null;
  const docEl = isBrowser && document && document.documentElement ? document.documentElement : {};

  const glCss = glCanvas ? {
    width: glCanvas.clientWidth || 0,
    height: glCanvas.clientHeight || 0,
    styleWidth: glCanvas.style.width || '',
    styleHeight: glCanvas.style.height || ''
  } : { width: 0, height: 0, styleWidth: '', styleHeight: '' };

  const glDraw = glCanvas ? {
    width: glCanvas.width || 0,
    height: glCanvas.height || 0
  } : { width: 0, height: 0 };

  const uiCss = uiCanvas ? {
    width: uiCanvas.clientWidth || 0,
    height: uiCanvas.clientHeight || 0,
    styleWidth: uiCanvas.style.width || '',
    styleHeight: uiCanvas.style.height || ''
  } : { width: 0, height: 0, styleWidth: '', styleHeight: '' };

  const uiDraw = uiCanvas ? {
    width: uiCanvas.width || 0,
    height: uiCanvas.height || 0
  } : { width: 0, height: 0 };

  let screenOrientation = 'unknown';
  if (isBrowser) {
    if (scr.orientation && scr.orientation.type) {
      screenOrientation = String(scr.orientation.type) + ' (' + String(scr.orientation.angle || 0) + 'deg)';
    } else if (typeof window.orientation !== 'undefined') {
      screenOrientation = 'window.orientation:' + String(window.orientation) + 'deg';
    }
  }

  const insets = getSafeAreaInsets();

  return {
    timestamp: new Date().toISOString(),
    screen: {
      width: scr.width || 0,
      height: scr.height || 0,
      availWidth: scr.availWidth || 0,
      availHeight: scr.availHeight || 0
    },
    window: {
      innerWidth: isBrowser ? window.innerWidth : 0,
      innerHeight: isBrowser ? window.innerHeight : 0,
      outerWidth: isBrowser ? window.outerWidth : 0,
      outerHeight: isBrowser ? window.outerHeight : 0,
      devicePixelRatio: isBrowser ? (window.devicePixelRatio || 1) : 1
    },
    documentElement: {
      clientWidth: docEl.clientWidth || 0,
      clientHeight: docEl.clientHeight || 0
    },
    visualViewport: vv ? {
      width: Number(vv.width.toFixed(2)),
      height: Number(vv.height.toFixed(2)),
      offsetLeft: Number(vv.offsetLeft.toFixed(2)),
      offsetTop: Number(vv.offsetTop.toFixed(2)),
      scale: Number(vv.scale.toFixed(4))
    } : null,
    glCanvas: {
      cssWidth: glCss.width,
      cssHeight: glCss.height,
      drawingBufferWidth: glDraw.width,
      drawingBufferHeight: glDraw.height
    },
    uiCanvas: {
      cssWidth: uiCss.width,
      cssHeight: uiCss.height,
      drawingBufferWidth: uiDraw.width,
      drawingBufferHeight: uiDraw.height
    },
    renderScale: Number(renderScale || 1.0),
    orientation: screenOrientation,
    safeAreaInsets: insets,
    documentScroll: {
      documentElementScrollWidth: docEl.scrollWidth || 0,
      documentElementScrollHeight: docEl.scrollHeight || 0,
      bodyScrollWidth: isBrowser && document.body ? document.body.scrollWidth : 0,
      bodyScrollHeight: isBrowser && document.body ? document.body.scrollHeight : 0
    },
    viewportMeta: isBrowser && document.querySelector ? (document.querySelector('meta[name="viewport"]')?.getAttribute('content') || 'none') : 'none',
    displayMode: {
      navigatorStandalone: isBrowser ? Boolean(navigator.standalone) : false,
      mediaStandalone: isBrowser && typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)').matches : false
    },
    navigatorInfo: isBrowser ? {
      userAgent: navigator.userAgent || '',
      platform: navigator.platform || '',
      maxTouchPoints: navigator.maxTouchPoints || 0
    } : null,
    widestElements: isBrowser ? findWidestElements(5) : [],
    activeScreenProfile: {
      deviceModel: activeScreenProfile.deviceModel,
      authoritativeWidthPx: activeScreenProfile.widthPx,
      authoritativeHeightPx: activeScreenProfile.heightPx,
      ppi: activeScreenProfile.ppi
    }
  };
}

function findWidestElements(topCount = 5) {
  if (typeof document === 'undefined' || !document.querySelectorAll) return [];
  try {
    const all = Array.from(document.querySelectorAll('*'));
    const measurements = [];
    for (const el of all) {
      if (!el.getBoundingClientRect) continue;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      // Identify selector / tag
      let identifier = el.tagName ? el.tagName.toLowerCase() : 'unknown';
      if (el.id) identifier += '#' + el.id;
      else if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) identifier += '.' + cls;
      }
      measurements.push({
        element: identifier,
        width: Number(rect.width.toFixed(1)),
        height: Number(rect.height.toFixed(1)),
        left: Number(rect.left.toFixed(1)),
        right: Number(rect.right.toFixed(1)),
        computedWidth: style ? style.width : '',
        minWidth: style ? style.minWidth : '',
        overflowX: style ? style.overflowX : ''
      });
    }
    measurements.sort((a, b) => b.width - a.width);
    return measurements.slice(0, topCount);
  } catch (err) {
    return [{ error: String(err && err.message ? err.message : err) }];
  }
}

export function drawRenderSurfaceEdgeFixture(uiCtx, width, height, viewerProfile = null) {
  if (!uiCtx || width <= 0 || height <= 0) return;

  uiCtx.save();

  // 1. Perimeter Edge Borders (Highlight outer pixel boundaries)
  uiCtx.strokeStyle = '#00ffff';
  uiCtx.lineWidth = 2.0;
  uiCtx.strokeRect(1, 1, width - 2, height - 2);

  // 2. Corner markers (16x16px corner notches)
  uiCtx.fillStyle = '#ff0055';
  const cornerSize = Math.max(12, Math.min(24, Math.floor(width * 0.015)));
  // Top-left
  uiCtx.fillRect(0, 0, cornerSize, 4);
  uiCtx.fillRect(0, 0, 4, cornerSize);
  // Top-right
  uiCtx.fillRect(width - cornerSize, 0, cornerSize, 4);
  uiCtx.fillRect(width - 4, 0, 4, cornerSize);
  // Bottom-left
  uiCtx.fillRect(0, height - 4, cornerSize, 4);
  uiCtx.fillRect(0, height - cornerSize, 4, cornerSize);
  // Bottom-right
  uiCtx.fillRect(width - cornerSize, height - 4, cornerSize, 4);
  uiCtx.fillRect(width - 4, height - cornerSize, 4, cornerSize);

  // 3. Physical / Canvas Center Vertical Line (x = width / 2)
  const cx = width / 2;
  uiCtx.strokeStyle = '#ffff00';
  uiCtx.lineWidth = 2.0;
  uiCtx.setLineDash([8, 6]);
  uiCtx.beginPath();
  uiCtx.moveTo(cx, 0);
  uiCtx.lineTo(cx, height);
  uiCtx.stroke();
  uiCtx.setLineDash([]);

  // Label for center dividing seam
  uiCtx.font = 'bold 11px ui-monospace, monospace';
  uiCtx.fillStyle = '#ffff00';
  uiCtx.textAlign = 'center';
  uiCtx.textBaseline = 'top';
  uiCtx.fillText('CANVAS CENTER (x=' + cx + ')', cx, 8);

  // 4. Left-Eye Center and Right-Eye Center
  const halfW = width / 2;
  const eyeGeom = deriveCardboardEyeGeometry(activeScreenProfile, viewerProfile);

  const leftCenterNormX = eyeGeom.leftEye.lensCenterNorm[0];
  const rightCenterNormX = eyeGeom.rightEye.lensCenterNorm[0];
  const centerNormY = eyeGeom.leftEye.lensCenterNorm[1];

  const leftEyePx = leftCenterNormX * halfW;
  const leftEyePy = (1.0 - centerNormY) * height;

  const rightEyePx = halfW + rightCenterNormX * halfW;
  const rightEyePy = (1.0 - centerNormY) * height;

  drawEyeCrosshair(uiCtx, leftEyePx, leftEyePy, 'LEFT LENS CENTER', '#38bdf8', leftCenterNormX, centerNormY);
  drawEyeCrosshair(uiCtx, rightEyePx, rightEyePy, 'RIGHT LENS CENTER', '#34d399', rightCenterNormX, centerNormY);

  // 5. Dimension HUD Banner in lower center
  uiCtx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  uiCtx.strokeStyle = '#38bdf8';
  uiCtx.lineWidth = 1;
  const hudW = Math.min(width - 40, 520);
  const hudH = 34;
  const hudX = (width - hudW) / 2;
  const hudY = height - hudH - 8;
  uiCtx.fillRect(hudX, hudY, hudW, hudH);
  uiCtx.strokeRect(hudX, hudY, hudW, hudH);

  uiCtx.fillStyle = '#ffffff';
  uiCtx.font = '11px ui-monospace, monospace';
  uiCtx.textAlign = 'center';
  uiCtx.textBaseline = 'middle';
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  uiCtx.fillText('CANVAS: ' + width + '×' + height + ' (DPR: ' + dpr + ') | TARGET DISPLAY: 2556×1179', width / 2, hudY + hudH / 2);

  uiCtx.restore();
}

function drawEyeCrosshair(ctx, x, y, label, color, normX, normY) {
  const sz = 18;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.0;

  // Cross lines
  ctx.beginPath();
  ctx.moveTo(x - sz, y);
  ctx.lineTo(x + sz, y);
  ctx.moveTo(x, y - sz);
  ctx.lineTo(x, y + sz);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.stroke();

  // Label
  ctx.font = 'bold 10px ui-monospace, monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, x, y - sz - 3);
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('(' + x.toFixed(1) + ', ' + y.toFixed(1) + ') [u:' + normX.toFixed(3) + ', v:' + normY.toFixed(3) + ']', x, y + 8);
}
