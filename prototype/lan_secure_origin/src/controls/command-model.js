// ==========================================
// Unified Command Model for In-Headset Controls
// ==========================================
import { state, showFeedbackToast, formatTime } from '../core/state.js';
import { startRecenterCalibration } from '../core/recenter.js';
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

  recenter() {
    startRecenterCalibration(2500, '🎯 校准正前方视线');
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
