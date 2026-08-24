// ==========================================
// Video Projection Profile & Cardboard Viewer Optics Derivation
// Based on Google Open Source: googlevr/wwgc (CardboardView.js & CardboardDevice.proto)
// ==========================================
import { activeScreenProfile } from './screen-profile.js';

export function computeMediaFingerprint(videoItem) {
  if (!videoItem) return 'unknown_media';
  const name = videoItem.name || videoItem.relPath || 'unknown';
  const size = videoItem.sizeBytes || 0;
  return `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}_${size}`;
}

export function createDefaultVideoProfile(mediaId, name = '') {
  return {
    mediaId: mediaId,
    name: name,
    projection: 'unknown',       // 'unknown' | 'equirectangular-180' | 'equirectangular-360' | 'flat'
    stereoMode: 'unknown',       // 'unknown' | 'left-right' | 'top-bottom' | 'mono'
    eyeOrder: 'unknown',         // 'unknown' | 'left-right' | 'right-left'
    fovHorizontalDeg: 180,
    fovVerticalDeg: 180,
    crop: { top: 0, bottom: 0, left: 0, right: 0 },
    pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    confidence: 'unverified',
    notes: 'Awaiting Stage A calibration in Flat Diagnostic View',
    updatedAt: new Date().toISOString()
  };
}

export function createDefaultViewerProfile(profileId = 'cardboard:reference_50deg') {
  const presets = {
    'cardboard:reference_50deg': {
      viewerProfileId: 'cardboard:reference_50deg',
      name: 'Cardboard-inspired Reference (50° Guidance)',
      source: 'Cardboard-inspired Reference Optics (50° FOV Guidance — Not Factory Ground Truth)',
      confidence: 'historical-reference',
      isCalibrated: false,
      lensCorrectionEnabled: false,
      screenToLensDistance: 0.0393, // 39.3 mm
      interLensDistance: 0.0639,    // 63.9 mm
      verticalAlignment: 'BOTTOM',
      trayToLensDistance: 0.0350,   // 35.0 mm
      maxFovAngles: { outerDeg: 50.0, innerDeg: 50.0, upperDeg: 50.0, lowerDeg: 50.0 },
      distortion: { model: 'cardboard-radial-polynomial', k1: 0.33582564, k2: 0.55348791 }
    },
    'unknown:uncalibrated': {
      viewerProfileId: 'unknown:uncalibrated',
      name: 'Unknown / Uncalibrated Baseline (Internal)',
      source: 'Internal Fail-closed Baseline',
      confidence: 'uncalibrated',
      isCalibrated: false,
      lensCorrectionEnabled: false,
      screenToLensDistance: 0.0393,
      interLensDistance: 0.0639,
      verticalAlignment: 'BOTTOM',
      trayToLensDistance: 0.0350,
      maxFovAngles: { outerDeg: 50.0, innerDeg: 50.0, upperDeg: 50.0, lowerDeg: 50.0 },
      distortion: { model: 'uncalibrated', k1: 0.0, k2: 0.0 }
    }
  };
  // Aliases for backwards compatibility
  presets['cardboard:v2_2015'] = presets['cardboard:reference_50deg'];

  if (profileId === 'viewer:my_profile' || profileId === 'custom:subjective_working_candidate' || profileId === 'custom:calibrated') {
    if (typeof profileStorage !== 'undefined' && profileStorage.savedMyViewerProfile) {
      return JSON.parse(JSON.stringify(profileStorage.savedMyViewerProfile));
    }
    return null;
  }

  return presets[profileId] || presets['cardboard:reference_50deg'];
}

export function distortRadius(r, k1 = 0, k2 = 0) {
  const rSq = r * r;
  return r * (1.0 + k1 * rSq + k2 * rSq * rSq);
}

// =========================================================================
// Cardboard Optical Geometry Derivation
// Ported faithfully from Google WWGC (googlevr/wwgc: www/js/CardboardView.js)
// =========================================================================
export function deriveCardboardEyeGeometry(screenProfile, viewerProfile) {
  const s = screenProfile || activeScreenProfile;
  const v = viewerProfile || createDefaultViewerProfile('unknown:uncalibrated');

  const halfScreenW = s.widthMeters / 2.0;
  const halfIpd = (v.interLensDistance || 0.064) / 2.0;
  const D = v.screenToLensDistance || 0.040;

  // 1. Distance from lens center to screen edges (Meters)
  const eyeLeftOuterDist = halfScreenW - halfIpd;
  const eyeLeftInnerDist = halfIpd;

  // 2. Vertical Lens Position Y relative to screen bottom (Meters)
  let eyeY = s.heightMeters / 2.0;
  if (v.verticalAlignment === 'CENTER') {
    eyeY = s.heightMeters / 2.0;
  } else if (v.verticalAlignment === 'TOP') {
    eyeY = s.heightMeters - (v.trayToLensDistance || 0.035) + (s.borderSizeMeters || 0.003);
  } else {
    // Default 'BOTTOM': eye_y = tray_to_lens_distance - screen.border_size_meters
    eyeY = (v.trayToLensDistance || 0.035) - (s.borderSizeMeters || 0.003);
  }

  const eyeBottomDist = Math.max(0.001, eyeY);
  const eyeTopDist = Math.max(0.001, s.heightMeters - eyeY);

  // 3. Physical Screen Tangents (Undistorted ray tangents from screen geometry)
  const leftPhysTanLeft = eyeLeftOuterDist / D;
  const leftPhysTanRight = eyeLeftInnerDist / D;
  const physTanBottom = eyeBottomDist / D;
  const physTanTop = eyeTopDist / D;

  const rightPhysTanLeft = leftPhysTanRight; // Inner
  const rightPhysTanRight = leftPhysTanLeft; // Outer

  // 4. Virtual Render FOV Tangents with Distortion Expansion (WWGC getLeftEyeFov())
  const isLensOn = (v.lensCorrectionEnabled === true);
  const dist = v.distortion || { k1: 0, k2: 0 };
  const k1 = isLensOn ? (dist.k1 || 0) : 0;
  const k2 = isLensOn ? (dist.k2 || 0) : 0;

  const deg2rad = Math.PI / 180;
  const maxFov = v.maxFovAngles || { outerDeg: 50, innerDeg: 50, upperDeg: 50, lowerDeg: 50 };
  const maxTanOuter = Math.tan((maxFov.outerDeg || 50) * deg2rad);
  const maxTanInner = Math.tan((maxFov.innerDeg || 50) * deg2rad);
  const maxTanUpper = Math.tan((maxFov.upperDeg || 50) * deg2rad);
  const maxTanLower = Math.tan((maxFov.lowerDeg || 50) * deg2rad);

  const leftVirtTanLeft = Math.min(maxTanOuter, distortRadius(leftPhysTanLeft, k1, k2));
  const leftVirtTanRight = Math.min(maxTanInner, distortRadius(leftPhysTanRight, k1, k2));
  const virtTanBottom = Math.min(maxTanLower, distortRadius(physTanBottom, k1, k2));
  const virtTanTop = Math.min(maxTanUpper, distortRadius(physTanTop, k1, k2));

  const rightVirtTanLeft = leftVirtTanRight;
  const rightVirtTanRight = leftVirtTanLeft;

  // 5. Optical center normalized coordinates within single eye viewport [0, 1]
  // In physical meters: left viewport width = halfScreenW
  const leftLensCenterNormX = eyeLeftOuterDist / halfScreenW;
  const rightLensCenterNormX = eyeLeftInnerDist / halfScreenW;
  const lensCenterNormY = eyeY / s.heightMeters;

  // 6. Tangent scale derived purely from immutable physical screen dimensions
  const physicalTanScaleX = halfScreenW / D;
  const physicalTanScaleY = s.heightMeters / D;

  return {
    screenToLensDistance: D,
    interLensDistance: v.interLensDistance,
    physicalTanScale: [physicalTanScaleX, physicalTanScaleY],
    isCalibrated: v.isCalibrated === true,
    leftEye: {
      physTanBounds: [leftPhysTanLeft, leftPhysTanRight, physTanBottom, physTanTop],
      virtTanBounds: [leftVirtTanLeft, leftVirtTanRight, virtTanBottom, virtTanTop],
      fovDeg: {
        left: Math.atan(leftVirtTanLeft) / deg2rad,
        right: Math.atan(leftVirtTanRight) / deg2rad,
        bottom: Math.atan(virtTanBottom) / deg2rad,
        top: Math.atan(virtTanTop) / deg2rad
      },
      lensCenterNorm: [leftLensCenterNormX, lensCenterNormY],
      eyeFromHeadMeters: [-halfIpd, 0, 0]
    },
    rightEye: {
      physTanBounds: [rightPhysTanLeft, rightPhysTanRight, physTanBottom, physTanTop],
      virtTanBounds: [rightVirtTanLeft, rightVirtTanRight, virtTanBottom, virtTanTop],
      fovDeg: {
        left: Math.atan(rightVirtTanLeft) / deg2rad,
        right: Math.atan(rightVirtTanRight) / deg2rad,
        bottom: Math.atan(virtTanBottom) / deg2rad,
        top: Math.atan(virtTanTop) / deg2rad
      },
      lensCenterNorm: [rightLensCenterNormX, lensCenterNormY],
      eyeFromHeadMeters: [halfIpd, 0, 0]
    },
    distortion: { k1, k2 }
  };
}

export class ProfileStorage {
  constructor() {
    this.videoProfiles = {};
    this.savedMyViewerProfile = null;
    this.activeViewerProfile = createDefaultViewerProfile('cardboard:reference_50deg');
    this.loadFromLocalStorage();
  }

  loadFromLocalStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      const myStr = localStorage.getItem('vreconder_saved_my_profile');
      if (myStr) {
        this.savedMyViewerProfile = JSON.parse(myStr);
        if (this.savedMyViewerProfile) this.savedMyViewerProfile.isCalibrated = false;
      }
      const vStr = localStorage.getItem('vreconder_video_profiles');
      if (vStr) this.videoProfiles = JSON.parse(vStr);
      const hStr = localStorage.getItem('vreconder_viewer_profile');
      if (hStr) {
        this.activeViewerProfile = JSON.parse(hStr);
        if (this.activeViewerProfile && this.activeViewerProfile.confidence === 'working-user-tuned') {
          this.activeViewerProfile.isCalibrated = false;
        }
      } else if (this.savedMyViewerProfile) {
        this.activeViewerProfile = JSON.parse(JSON.stringify(this.savedMyViewerProfile));
      }
    } catch (e) {
      console.warn('Profile storage warning:', e);
    }
  }

  saveToLocalStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem('vreconder_video_profiles', JSON.stringify(this.videoProfiles));
      localStorage.setItem('vreconder_viewer_profile', JSON.stringify(this.activeViewerProfile));
      if (this.savedMyViewerProfile) {
        localStorage.setItem('vreconder_saved_my_profile', JSON.stringify(this.savedMyViewerProfile));
      }
    } catch (e) {}
  }

  async loadServerProfiles() {
    try {
      const res = await fetch('/api/profiles');
      if (res.ok) {
        const data = await res.json();
        if (data.videoProfiles) this.videoProfiles = { ...this.videoProfiles, ...data.videoProfiles };
        if (data.viewerProfile && (data.viewerProfile.viewerProfileId === 'viewer:my_profile' || data.viewerProfile.confidence === 'working-user-tuned')) {
          data.viewerProfile.isCalibrated = false;
          data.viewerProfile.source = 'User-tuned Working Profile (Unvalidated)';
          this.savedMyViewerProfile = data.viewerProfile;
          this.activeViewerProfile = data.viewerProfile;
        } else if (data.viewerProfile) {
          this.activeViewerProfile = { ...this.activeViewerProfile, ...data.viewerProfile };
        }
        this.saveToLocalStorage();
      }
    } catch (e) {}
  }

  getVideoProfile(mediaId, name = '') {
    if (!this.videoProfiles[mediaId]) {
      this.videoProfiles[mediaId] = createDefaultVideoProfile(mediaId, name);
    }
    return this.videoProfiles[mediaId];
  }

  async saveVideoProfile(profile) {
    if (!profile || !profile.mediaId) return false;
    if (profile.projection === 'unknown' || profile.stereoMode === 'unknown') {
      console.warn('[ProfileStorage] Cannot save unknown mapping without explicit user selection.');
      return false;
    }
    profile.confidence = 'user-confirmed';
    profile.updatedAt = new Date().toISOString();
    this.videoProfiles[profile.mediaId] = profile;
    this.saveToLocalStorage();

    try {
      await fetch('/api/profiles/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      });
    } catch (e) {}
    return true;
  }

  async saveViewerProfile(viewerProfile) {
    if (!viewerProfile) return false;
    viewerProfile.viewerProfileId = 'viewer:my_profile';
    viewerProfile.name = 'My Viewer Profile (working)';
    viewerProfile.source = 'User-tuned Working Profile (Unvalidated)';
    viewerProfile.confidence = 'working-user-tuned';
    viewerProfile.isCalibrated = false; // Fail-honest: unvalidated until 2-video gate pass
    viewerProfile.updatedAt = new Date().toISOString();
    this.savedMyViewerProfile = JSON.parse(JSON.stringify(viewerProfile));
    this.activeViewerProfile = viewerProfile;
    this.saveToLocalStorage();

    try {
      await fetch('/api/profiles/viewer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(viewerProfile)
      });
    } catch (e) {}
    return true;
  }
}

export const profileStorage = new ProfileStorage();
