// ==========================================
// Gaze Hit Testing & Dwell Interaction Engine
// ==========================================
import { state, showFeedbackToast } from '../core/state.js';
import { recenterPose } from '../core/recenter.js';
import { playAudioFeedback, triggerHaptic } from './audio-haptics.js';
import { telemetry } from '../telemetry/telemetry.js';
import { getActiveInteractiveItems, TIMELINE_GEOMETRY, sphericalToDir } from './patterns.js';

export class GazeEngine {
  constructor(commandModel, videoElement) {
    this.cmd = commandModel;
    this.video = videoElement;
    this.currentHoveredItem = null;
    this.dwellProgress = 0;
    this.activationFlashTime = 0;
    this.activatedItemId = null;
    this.actionCooldownUntil = 0;

    // Continuous Timeline Gaze State
    this.timelineHover = {
      active: false,
      fraction: 0,
      previewTime: 0,
      dirWorld: null
    };
  }

  getGazeAngularDistanceDeg(targetDirWorld) {
    if (!targetDirWorld) return 999;
    const fwd = state.cameraForward;
    const dot = fwd[0] * targetDirWorld[0] + fwd[1] * targetDirWorld[1] + fwd[2] * targetDirWorld[2];
    const clamped = Math.max(-1, Math.min(1, dot));
    return Math.acos(clamped) * (180 / Math.PI);
  }

  update(now) {
    if (!state.inVR) return;

    // Handle Recenter Posture Calibration Countdown
    if (state.recenterCountdown.active) {
      this.currentHoveredItem = null;
      this.timelineHover.active = false;
      this.dwellProgress = 0;
      const elapsed = now - state.recenterCountdown.startTime;
      const remainingSec = Math.max(1, Math.ceil((state.recenterCountdown.durationMs - elapsed) / 1000));
      
      if (remainingSec !== state.recenterCountdown.lastSecondTick) {
        state.recenterCountdown.lastSecondTick = remainingSec;
        playAudioFeedback('tick');
      }

      if (elapsed >= state.recenterCountdown.durationMs) {
        state.recenterCountdown.active = false;
        recenterPose();
        playAudioFeedback('recenter_done');
        triggerHaptic();
        telemetry.recordCommand('recenter', this.video);
        showFeedbackToast('🎯 视角已精准校准至正前方！');
        this.actionCooldownUntil = now + 500;
      }
      return;
    }

    if (now < this.actionCooldownUntil) {
      this.dwellProgress = 0;
      this.timelineHover.active = false;
      return;
    }

    const isMenuOpen = (state.activePattern === 'A' && state.patternA_open) ||
                       (state.activePattern === 'B' && state.patternB_open) ||
                       (state.activePattern === 'C' && state.patternC_open);

    const items = getActiveInteractiveItems(this.cmd, this.video);
    let bestItem = null;
    let minAng = 999;

    items.forEach(item => {
      if (!item.dirWorld) return;
      const ang = this.getGazeAngularDistanceDeg(item.dirWorld);
      if (ang <= item.radiusDeg && ang < minAng) {
        minAng = ang;
        bestItem = item;
      }
    });

    // Check Continuous Timeline Gaze when menu is open
    let timelineHit = false;
    let timelineCandidate = null;

    if (isMenuOpen && this.video && this.video.duration && isFinite(this.video.duration) && this.video.duration > 0) {
      const fwd = state.cameraForward;
      const fwdPitchDeg = Math.asin(Math.max(-1, Math.min(1, fwd[1]))) * (180 / Math.PI);
      const fwdYawDeg = Math.atan2(fwd[0], -fwd[2]) * (180 / Math.PI);

      const tg = TIMELINE_GEOMETRY;
      const pitchDiff = Math.abs(fwdPitchDeg - tg.pitchDeg);

      if (pitchDiff <= tg.hitRadiusDeg && fwdYawDeg >= (tg.minYawDeg - tg.hitRadiusDeg) && fwdYawDeg <= (tg.maxYawDeg + tg.hitRadiusDeg)) {
        const clampedYaw = Math.max(tg.minYawDeg, Math.min(tg.maxYawDeg, fwdYawDeg));
        const fraction = (clampedYaw - tg.minYawDeg) / (tg.maxYawDeg - tg.minYawDeg);
        const dur = this.video.duration;
        const maxSeek = Math.max(0, dur - 5);
        const previewTime = Math.min(maxSeek, fraction * dur);
        const hitDir = sphericalToDir(clampedYaw, tg.pitchDeg);
        const angDist = this.getGazeAngularDistanceDeg(hitDir);

        if (angDist <= tg.hitRadiusDeg && angDist < minAng) {
          timelineHit = true;
          timelineCandidate = {
            id: 'timeline_continuous',
            fraction,
            previewTime,
            dirWorld: hitDir,
            cmd: () => this.cmd.seekToTime(previewTime)
          };
          bestItem = timelineCandidate;
        }
      }
    }

    if (bestItem) {
      if (timelineHit) {
        this.timelineHover.active = true;
        this.timelineHover.fraction = timelineCandidate.fraction;
        this.timelineHover.previewTime = timelineCandidate.previewTime;
        this.timelineHover.dirWorld = timelineCandidate.dirWorld;
      } else {
        this.timelineHover.active = false;
      }

      if (!this.currentHoveredItem || this.currentHoveredItem.id !== bestItem.id) {
        if (this.currentHoveredItem) {
          telemetry.recordDwellCancel(state.activePattern, this.currentHoveredItem.id, (now - telemetry.hoverStartTime));
        }
        this.currentHoveredItem = bestItem;
        telemetry.recordTargetEnter(state.activePattern, bestItem.id);
      }

      const elapsed = now - telemetry.hoverStartTime;
      const threshold = (bestItem.id.startsWith('open_')) ? 400 : state.dwellThresholdMs;
      this.dwellProgress = Math.min(1.0, elapsed / threshold);

      if (this.dwellProgress >= 1.0) {
        this.activatedItemId = bestItem.id;
        this.activationFlashTime = now;
        this.actionCooldownUntil = now + 350;
        telemetry.recordDwellComplete(state.activePattern, bestItem.id, elapsed);
        bestItem.cmd();
        this.dwellProgress = 0;
        this.currentHoveredItem = null;
        this.timelineHover.active = false;
      }
    } else {
      if (this.currentHoveredItem) {
        telemetry.recordDwellCancel(state.activePattern, this.currentHoveredItem.id, (now - telemetry.hoverStartTime));
        this.currentHoveredItem = null;
      }
      this.timelineHover.active = false;
      this.dwellProgress = 0;
    }
  }
}
