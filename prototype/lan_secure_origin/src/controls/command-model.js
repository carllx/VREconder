// ==========================================
// Unified Command Model for In-Headset Controls
// ==========================================
import { state, showFeedbackToast, formatTime } from '../core/state.js';
import { startRecenterCalibration, recenterPose } from '../core/recenter.js';
import { playAudioFeedback, triggerHaptic } from './audio-haptics.js';
import { telemetry } from '../telemetry/telemetry.js';

export class CommandModel {
  constructor(mediaController) {
    this.media = mediaController;
  }

  playPause() {
    const video = this.media.video;
    if (video.paused) {
      video.play().catch(e => console.log('Play error:', e));
      showFeedbackToast('▶ 播放中');
    } else {
      video.pause();
      showFeedbackToast('⏸ 已暂停');
    }
    telemetry.recordCommand('playPause', video);
  }

  previous() {
    if (state.videoList && state.videoList.length > 0) {
      state.currentVideoIndex = (state.currentVideoIndex - 1 + state.videoList.length) % state.videoList.length;
      this.media.selectVideo(state.videoList[state.currentVideoIndex].relPath);
      showFeedbackToast('⏮ 上一个视频');
    }
    telemetry.recordCommand('previous', this.media.video);
  }

  next() {
    if (state.videoList && state.videoList.length > 0) {
      state.currentVideoIndex = (state.currentVideoIndex + 1) % state.videoList.length;
      this.media.selectVideo(state.videoList[state.currentVideoIndex].relPath);
      showFeedbackToast('⏭ 下一个视频');
    }
    telemetry.recordCommand('next', this.media.video);
  }

  seekBackward(sec = 10) {
    const video = this.media.video;
    video.currentTime = Math.max(0, video.currentTime - sec);
    showFeedbackToast('⏪ -' + sec + 's (' + formatTime(video.currentTime) + ')');
    telemetry.recordCommand('seekBackward_' + sec + 's', video);
  }

  seekForward(sec = 10) {
    const video = this.media.video;
    video.currentTime = Math.min(video.duration || 999999, video.currentTime + sec);
    showFeedbackToast('⏩ +' + sec + 's (' + formatTime(video.currentTime) + ')');
    telemetry.recordCommand('seekForward_' + sec + 's', video);
  }

  seekToFraction(fraction) {
    const video = this.media.video;
    const dur = video.duration;
    if (typeof dur !== 'number' || isNaN(dur) || !isFinite(dur) || dur <= 0) {
      return;
    }
    const maxSeek = Math.max(0, dur - 5);
    const clampedFrac = Math.max(0, Math.min(1, fraction));
    const targetTime = Math.min(maxSeek, clampedFrac * dur);
    video.currentTime = targetTime;
    const pct = Math.round(clampedFrac * 100);
    showFeedbackToast(`⏱ 跳转至 ${pct}% (${formatTime(targetTime)})`);
    telemetry.recordCommand(`seekToFraction_${pct}%`, video);
  }

  seekToTime(targetSeconds) {
    const video = this.media.video;
    const dur = video.duration;
    if (typeof dur !== 'number' || isNaN(dur) || !isFinite(dur) || dur <= 0) {
      return;
    }
    const maxSeek = Math.max(0, dur - 5);
    const targetTime = Math.max(0, Math.min(maxSeek, targetSeconds));
    video.currentTime = targetTime;
    showFeedbackToast(`⏱ 跳转至 ${formatTime(targetTime)}`);
    telemetry.recordCommand(`seekToTime_${Math.round(targetTime)}s`, video);
  }

  recenter(immediate = false) {
    if (immediate) {
      state.recenterCountdown.active = false;
      recenterPose();
      playAudioFeedback('recenter_done');
      triggerHaptic();
      telemetry.recordCommand('recenter', this.media ? this.media.video : null);
      showFeedbackToast('🎯 视角已精准校准至正前方！');
    } else {
      this.closeControls();
      startRecenterCalibration(2500, '🎯 校准正前方视线');
    }
  }

  openControls() {
    if (state.activePattern === 'A') state.patternA_open = true;
    if (state.activePattern === 'B') state.patternB_open = true;
    if (state.activePattern === 'C') state.patternC_open = true;
    telemetry.menuOpenTime = performance.now();
    showFeedbackToast('⚡ 打开菜单');
  }

  closeControls() {
    state.patternA_open = false;
    state.patternB_open = false;
    state.patternC_open = false;
    showFeedbackToast('✕ 关闭菜单');
  }

  toggleControls() {
    const menuOpen = state.patternA_open || state.patternB_open || state.patternC_open;
    if (menuOpen) {
      this.closeControls();
    } else {
      this.openControls();
    }
  }

  cyclePattern() {
    const patterns = ['B', 'A', 'C'];
    const idx = patterns.indexOf(state.activePattern);
    const nextPat = patterns[(idx + 1) % patterns.length];
    this.setPattern(nextPat);
    showFeedbackToast('切换至 Pattern ' + nextPat);
  }

  setPattern(pat) {
    state.activePattern = pat;
    telemetry.menuOpenTime = performance.now();
    document.querySelectorAll('#grpPatternSelect button').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-pattern') === pat);
    });
    const btn = document.getElementById('btnVrSwitchPattern');
    if (btn) btn.textContent = '🔀 Pattern: ' + pat;
    state.patternA_open = false;
    state.patternB_open = false;
    state.patternC_open = false;
  }
}
