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

// Shared Coarse Seek Nodes for Timeline MVP (Pitch: -12.0°, Non-overlapping with all menu nodes)
export const COARSE_SEEK_FRACTIONS = [
  { frac: 0.0, label: '0%', yaw: -21 },
  { frac: 0.167, label: '17%', yaw: -14 },
  { frac: 0.333, label: '33%', yaw: -7 },
  { frac: 0.50, label: '50%', yaw: 0 },
  { frac: 0.667, label: '67%', yaw: 7 },
  { frac: 0.833, label: '83%', yaw: 14 },
  { frac: 1.0, label: '100%', yaw: 21 }
];

export function getActiveInteractiveItems(commandModel, videoElement) {
  const items = [];
  const isPlay = !videoElement.paused;
  const floorAnchorPitch = -34;

  const isMenuOpen = (state.activePattern === 'A' && state.patternA_open) ||
                     (state.activePattern === 'B' && state.patternB_open) ||
                     (state.activePattern === 'C' && state.patternC_open);

  if (state.activePattern === 'A') {
    // Pattern A: Floor Arc (Only return items when menu is OPEN)
    if (state.patternA_open) {
      const arcNodes = [
        { id: 'prev', icon: '⏮', yaw: -20, pitch: floorAnchorPitch, radiusDeg: 3.6, cmd: () => commandModel.previous() },
        { id: 'seek_back', icon: '⏪', yaw: -10, pitch: floorAnchorPitch, radiusDeg: 3.6, cmd: () => commandModel.seekBackward(10) },
        { id: 'play_pause', icon: isPlay ? '⏸' : '▶', yaw: 0, pitch: floorAnchorPitch, radiusDeg: 4.0, cmd: () => commandModel.playPause(), color: '#2563eb' },
        { id: 'seek_fwd', icon: '⏩', yaw: 10, pitch: floorAnchorPitch, radiusDeg: 3.6, cmd: () => commandModel.seekForward(10) },
        { id: 'next', icon: '⏭', yaw: 20, pitch: floorAnchorPitch, radiusDeg: 3.6, cmd: () => commandModel.next() },
        { id: 'recenter', icon: '🎯', yaw: 0, pitch: floorAnchorPitch + 10, radiusDeg: 3.8, cmd: () => commandModel.recenter(), color: '#059669' },
        { id: 'close_arc', icon: '✕', yaw: 0, pitch: floorAnchorPitch - 10, radiusDeg: 3.6, cmd: () => commandModel.closeControls(), color: '#ef4444' }
      ];
      arcNodes.forEach(b => {
        items.push({ ...b, pattern: 'A', dirWorld: sphericalToDir(b.yaw, b.pitch) });
      });
    }
  } else if (state.activePattern === 'B') {
    // Pattern B: Floor Radial (Only return items when menu is OPEN)
    if (state.patternB_open) {
      const radialR = 15.0;

      // Center Dismiss Button
      items.push({
        id: 'close_radial',
        icon: '✕',
        pattern: 'B',
        yaw: 0,
        pitch: floorAnchorPitch,
        radiusDeg: 4.0,
        color: '#ef4444',
        cmd: () => commandModel.closeControls(),
        dirWorld: sphericalToDir(0, floorAnchorPitch)
      });

      // 6 Radial Nodes
      const radialNodes = [
        { id: 'recenter', icon: '🎯', angleDeg: 90, cmd: () => commandModel.recenter(), color: '#059669', radiusDeg: 3.8 },
        { id: 'seek_fwd', icon: '⏩', angleDeg: 30, cmd: () => commandModel.seekForward(10), radiusDeg: 3.8 },
        { id: 'next', icon: '⏭', angleDeg: -30, cmd: () => commandModel.next(), radiusDeg: 3.8 },
        { id: 'play_pause', icon: isPlay ? '⏸' : '▶', angleDeg: -90, cmd: () => commandModel.playPause(), color: '#2563eb', radiusDeg: 4.0 },
        { id: 'prev', icon: '⏮', angleDeg: -150, cmd: () => commandModel.previous(), radiusDeg: 3.8 },
        { id: 'seek_back', icon: '⏪', angleDeg: 150, cmd: () => commandModel.seekBackward(10), radiusDeg: 3.8 }
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
          radiusDeg: rn.radiusDeg,
          color: rn.color,
          cmd: rn.cmd,
          dirWorld: sphericalToDir(yaw, pitch)
        });
      });
    }
  } else if (state.activePattern === 'C') {
    // Pattern C: Floor HUD (Only return items when menu is OPEN)
    if (state.patternC_open) {
      const hudNodes = [
        { id: 'seek_b60', icon: '⏮ 60s', yaw: -18, pitch: floorAnchorPitch + 5, radiusDeg: 3.4, cmd: () => commandModel.seekBackward(60) },
        { id: 'seek_b10', icon: '⏪ 10s', yaw: -6, pitch: floorAnchorPitch + 5, radiusDeg: 3.4, cmd: () => commandModel.seekBackward(10) },
        { id: 'seek_f10', icon: '10s ⏩', yaw: 6, pitch: floorAnchorPitch + 5, radiusDeg: 3.4, cmd: () => commandModel.seekForward(10) },
        { id: 'seek_f60', icon: '60s ⏭', yaw: 18, pitch: floorAnchorPitch + 5, radiusDeg: 3.4, cmd: () => commandModel.seekForward(60) },

        { id: 'prev', icon: '⏮', yaw: -18, pitch: floorAnchorPitch - 6, radiusDeg: 3.6, cmd: () => commandModel.previous() },
        { id: 'play_pause', icon: isPlay ? '⏸' : '▶', yaw: -6, pitch: floorAnchorPitch - 6, radiusDeg: 4.0, cmd: () => commandModel.playPause(), color: '#2563eb' },
        { id: 'next', icon: '⏭', yaw: 6, pitch: floorAnchorPitch - 6, radiusDeg: 3.6, cmd: () => commandModel.next() },
        { id: 'recenter', icon: '🎯', yaw: 18, pitch: floorAnchorPitch - 6, radiusDeg: 3.6, cmd: () => commandModel.recenter(), color: '#059669' },
        { id: 'close_hud', icon: '✕', yaw: 0, pitch: floorAnchorPitch - 15, radiusDeg: 3.5, color: '#ef4444', cmd: () => commandModel.closeControls() }
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

  // Shared Timeline Coarse Seek Nodes (Visible & active whenever any pattern menu is OPEN)
  if (isMenuOpen) {
    const timelinePitch = -12.0;
    COARSE_SEEK_FRACTIONS.forEach(cs => {
      items.push({
        id: `seek_frac_${Math.round(cs.frac * 100)}`,
        icon: '•',
        fraction: cs.frac,
        label: cs.label,
        isTimelineNode: true,
        yaw: cs.yaw,
        pitch: timelinePitch,
        radiusDeg: 1.8,
        cmd: () => commandModel.seekToFraction(cs.frac),
        dirWorld: sphericalToDir(cs.yaw, timelinePitch)
      });
    });
  }

  return items;
}
