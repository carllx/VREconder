// ==========================================
// In-Headset Control Pattern Definitions (Floor Zone Pitch -34°)
// ==========================================
import { state } from '../core/state.js';

export function sphericalToDir(yawDeg, pitchDeg) {
  const yawRad = yawDeg * (Math.PI / 180);
  const pitchRad = pitchDeg * (Math.PI / 180);
  const cosP = Math.cos(pitchRad);
  return [
    Math.sin(yawRad) * cosP,
    Math.sin(pitchRad),
    -Math.cos(yawRad) * cosP
  ];
}

export function getActiveInteractiveItems(commandModel, videoElement) {
  const items = [];
  const isPlay = !videoElement.paused;
  const floorAnchorPitch = -34;

  if (state.activePattern === 'A') {
    // Pattern A: Floor Arc
    if (!state.patternA_open) {
      items.push({
        id: 'open_arc',
        icon: '⚡',
        pattern: 'A',
        yaw: 0,
        pitch: floorAnchorPitch,
        radiusDeg: 6.5,
        color: '#7c3aed',
        cmd: () => commandModel.openControls(),
        dirWorld: sphericalToDir(0, floorAnchorPitch)
      });
    } else {
      const arcNodes = [
        { id: 'prev', icon: '⏮', yaw: -20, pitch: floorAnchorPitch, radiusDeg: 4.2, cmd: () => commandModel.previous() },
        { id: 'seek_back', icon: '⏪', yaw: -10, pitch: floorAnchorPitch, radiusDeg: 4.2, cmd: () => commandModel.seekBackward(10) },
        { id: 'play_pause', icon: isPlay ? '⏸' : '▶', yaw: 0, pitch: floorAnchorPitch, radiusDeg: 5.0, cmd: () => commandModel.playPause(), color: '#2563eb' },
        { id: 'seek_fwd', icon: '⏩', yaw: 10, pitch: floorAnchorPitch, radiusDeg: 4.2, cmd: () => commandModel.seekForward(10) },
        { id: 'next', icon: '⏭', yaw: 20, pitch: floorAnchorPitch, radiusDeg: 4.2, cmd: () => commandModel.next() },
        { id: 'recenter', icon: '🎯', yaw: 0, pitch: floorAnchorPitch + 10, radiusDeg: 4.5, cmd: () => commandModel.recenter(), color: '#059669' },
        { id: 'close_arc', icon: '✕', yaw: 0, pitch: floorAnchorPitch - 10, radiusDeg: 4.0, cmd: () => commandModel.closeControls(), color: '#ef4444' }
      ];
      arcNodes.forEach(b => {
        items.push({ ...b, pattern: 'A', dirWorld: sphericalToDir(b.yaw, b.pitch) });
      });
    }
  } else if (state.activePattern === 'B') {
    // Pattern B: Floor Radial (100% Zero-occlusion)
    if (!state.patternB_open) {
      items.push({
        id: 'open_radial',
        icon: '⚡',
        pattern: 'B',
        yaw: 0,
        pitch: floorAnchorPitch,
        radiusDeg: 6.5,
        color: '#7c3aed',
        cmd: () => commandModel.openControls(),
        dirWorld: sphericalToDir(0, floorAnchorPitch)
      });
    } else {
      const radialR = 15.0;

      // Center Dismiss Button
      items.push({
        id: 'close_radial',
        icon: '✕',
        pattern: 'B',
        yaw: 0,
        pitch: floorAnchorPitch,
        radiusDeg: 4.5,
        color: '#ef4444',
        cmd: () => commandModel.closeControls(),
        dirWorld: sphericalToDir(0, floorAnchorPitch)
      });

      // 6 Radial Nodes
      const radialNodes = [
        { id: 'recenter', icon: '🎯', angleDeg: 90, cmd: () => commandModel.recenter(), color: '#059669' },
        { id: 'seek_fwd', icon: '⏩', angleDeg: 30, cmd: () => commandModel.seekForward(10) },
        { id: 'next', icon: '⏭', angleDeg: -30, cmd: () => commandModel.next() },
        { id: 'play_pause', icon: isPlay ? '⏸' : '▶', angleDeg: -90, cmd: () => commandModel.playPause(), color: '#2563eb' },
        { id: 'prev', icon: '⏮', angleDeg: -150, cmd: () => commandModel.previous() },
        { id: 'seek_back', icon: '⏪', angleDeg: 150, cmd: () => commandModel.seekBackward(10) }
      ];

      radialNodes.forEach(rn => {
        const rad = rn.angleDeg * (Math.PI / 180);
        const yaw = radialR * Math.cos(rad);
        const pitch = floorAnchorPitch + radialR * Math.sin(rad);
        items.push({
          id: rn.id,
          icon: rn.icon,
          pattern: 'B',
          yaw: yaw,
          pitch: pitch,
          radiusDeg: 4.4,
          color: rn.color,
          cmd: rn.cmd,
          dirWorld: sphericalToDir(yaw, pitch)
        });
      });
    }
  } else if (state.activePattern === 'C') {
    // Pattern C: Floor HUD
    if (!state.patternC_open) {
      items.push({
        id: 'open_hud',
        icon: '📺',
        pattern: 'C',
        yaw: 0,
        pitch: floorAnchorPitch,
        radiusDeg: 6.5,
        color: '#0891b2',
        cmd: () => commandModel.openControls(),
        dirWorld: sphericalToDir(0, floorAnchorPitch)
      });
    } else {
      const hudNodes = [
        { id: 'seek_b60', icon: '⏮ 60s', yaw: -18, pitch: floorAnchorPitch + 5, radiusDeg: 3.8, cmd: () => commandModel.seekBackward(60) },
        { id: 'seek_b10', icon: '⏪ 10s', yaw: -7, pitch: floorAnchorPitch + 5, radiusDeg: 3.8, cmd: () => commandModel.seekBackward(10) },
        { id: 'seek_f10', icon: '10s ⏩', yaw: 7, pitch: floorAnchorPitch + 5, radiusDeg: 3.8, cmd: () => commandModel.seekForward(10) },
        { id: 'seek_f60', icon: '60s ⏭', yaw: 18, pitch: floorAnchorPitch + 5, radiusDeg: 3.8, cmd: () => commandModel.seekForward(60) },

        { id: 'prev', icon: '⏮', yaw: -18, pitch: floorAnchorPitch - 6, radiusDeg: 4.2, cmd: () => commandModel.previous() },
        { id: 'play_pause', icon: isPlay ? '⏸' : '▶', yaw: -6, pitch: floorAnchorPitch - 6, radiusDeg: 4.8, cmd: () => commandModel.playPause(), color: '#2563eb' },
        { id: 'next', icon: '⏭', yaw: 6, pitch: floorAnchorPitch - 6, radiusDeg: 4.2, cmd: () => commandModel.next() },
        { id: 'recenter', icon: '🎯', yaw: 18, pitch: floorAnchorPitch - 6, radiusDeg: 4.2, cmd: () => commandModel.recenter(), color: '#059669' },
        { id: 'close_hud', icon: '✕', yaw: 0, pitch: floorAnchorPitch - 15, radiusDeg: 3.8, color: '#ef4444', cmd: () => commandModel.closeControls() }
      ];

      hudNodes.forEach(hn => {
        items.push({
          id: hn.id,
          icon: hn.icon,
          pattern: 'C',
          yaw: hn.yaw,
          pitch: hn.pitch,
          radiusDeg: hn.radiusDeg,
          color: hn.color,
          cmd: hn.cmd,
          dirWorld: sphericalToDir(hn.yaw, hn.pitch)
        });
      });
    }
  }

  return items;
}
