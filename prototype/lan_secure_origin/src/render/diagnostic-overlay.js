// ==========================================
// Flat Rectilinear Diagnostic Canvas Overlay
// ==========================================

export class DiagnosticOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.showGrid = true;
    this.showPlumbLines = true;
    this.showHorizon = true;
    this.showCrosshair = true;
  }

  render(width, height, videoProfile, viewerProfile, selectedEye, isPaused, currentTime, duration) {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;

    // 1. Rectilinear Grid
    if (this.showGrid) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.18)';
      ctx.lineWidth = 1;
      const step = 60;

      for (let x = cx % step; x < width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = cy % step; y < height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }

    // 2. Plumb Vertical Guide Lines (For door frames, locker doors, wall edges)
    if (this.showPlumbLines) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);

      const offsets = [-0.35, -0.2, 0, 0.2, 0.35];
      offsets.forEach(off => {
        const x = cx + off * width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      });

      ctx.setLineDash([]);
    }

    // 3. Horizon Reference Line (Pitch Level)
    if (this.showHorizon) {
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2.0;

      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(width, cy);
      ctx.stroke();

      ctx.fillStyle = '#10b981';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText('HORIZON (0° PITCH)', width - 12, cy - 6);
    }

    // 4. Center Crosshair
    if (this.showCrosshair) {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2.0;

      const sz = 24;
      ctx.beginPath();
      ctx.moveTo(cx - sz, cy);
      ctx.lineTo(cx + sz, cy);
      ctx.moveTo(cx, cy - sz);
      ctx.lineTo(cx, cy + sz);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#ef4444';
      ctx.stroke();
    }

    // 5. Diagnostic Header HUD Banner
    const vp = videoProfile || {};
    const isUnverified = vp.confidence === 'unverified' || vp.projection === 'unknown';

    ctx.fillStyle = isUnverified ? 'rgba(239, 68, 68, 0.88)' : 'rgba(15, 23, 42, 0.88)';
    ctx.strokeStyle = isUnverified ? '#fca5a5' : 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.fillRect(10, 10, 380, 95);
    ctx.strokeRect(10, 10, 380, 95);

    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    const statusTag = isUnverified ? '⚠️ [UNVERIFIED MEDIA]' : '✓ [CALIBRATED]';
    ctx.fillText(`📐 RECTILINEAR DIAGNOSTIC VIEW ${statusTag}`, 20, 28);

    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(`Eye: ${selectedEye === 0 ? 'LEFT' : 'RIGHT'} | Proj: ${vp.projection || 'unknown'} | Stereo: ${vp.stereoMode || 'unknown'}`, 20, 46);
    const pose = vp.pose || { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
    ctx.fillText(`Pose: Y:${pose.yawDeg || 0}° P:${pose.pitchDeg || 0}° R:${pose.rollDeg || 0}° | Cov: ${vp.fovHorizontalDeg || 180}°H`, 20, 62);
    ctx.fillText(`Time: ${currentTime.toFixed(1)}s / ${duration.toFixed(1)}s [${isPaused ? 'FREEZE' : 'PLAY'}]`, 20, 78);
    if (isUnverified) {
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillStyle = '#fef08a';
      ctx.fillText('Select Stage A candidate projection below to begin calibration', 20, 94);
    }
  }
}
