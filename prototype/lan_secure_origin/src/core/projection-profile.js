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
    confidence: 'unverified',    // 'unverified' | 'metadata-inferred' | 'user-calibrated'
    notes: 'Awaiting Stage A calibration in Flat Diagnostic View',
    updatedAt: new Date().toISOString()
  };
}

export function createDefaultViewerProfile(profileId = 'unknown:uncalibrated') {
  const presets = {
    'unknown:uncalibrated': {
      viewerProfileId: 'unknown:uncalibrated',
      name: 'Unknown / Uncalibrated Viewer (Default)',
      source: 'Uncalibrated Baseline (No Headset Lens Assumptions)',
      confidence: 'uncalibrated',
      lensCorrectionEnabled: false,
      screenToLensDistance: 0.0393, // 39.3 mm
      interLensDistance: 0.0639,    // 63.9 mm
      verticalAlignment: 'BOTTOM',  // BOTTOM | CENTER | TOP
      trayToLensDistance: 0.0350,   // 35.0 mm
      maxFovAngles: {
        outerDeg: 53.0,
        innerDeg: 53.0,
        upperDeg: 53.0,
        lowerDeg: 53.0
      },
      distortion: {
        model: 'uncalibrated-radial',
        k1: 0.0,
        k2: 0.0
      }
    },
    'cardboard:v2_2015': {
      viewerProfileId: 'cardboard:v2_2015',
      name: 'Google Cardboard v2 (Historical Ref: Google I/O 2015 Spec)',
      source: 'Google Cardboard Device Parameters Specification (v2.0)',
      confidence: 'historical-specification',
      lensCorrectionEnabled: false,
      screenToLensDistance: 0.0393, // 39.3 mm
      interLensDistance: 0.0639,    // 63.9 mm
      verticalAlignment: 'BOTTOM',
      trayToLensDistance: 0.0350,   // 35.0 mm
      maxFovAngles: {
        outerDeg: 53.0,
        innerDeg: 53.0,
        upperDeg: 53.0,
        lowerDeg: 53.0
      },
      distortion: {
        model: 'cardboard-radial-polynomial',
        k1: 0.33582564,
        k2: 0.55348791
      }
    },
    'cardboard:v1_2014': {
      viewerProfileId: 'cardboard:v1_2014',
      name: 'Google Cardboard v1 (Historical Ref: Google I/O 2014 Spec)',
      source: 'Google Cardboard Device Parameters Specification (v1.0)',
      confidence: 'historical-specification',
      lensCorrectionEnabled: false,
      screenToLensDistance: 0.0420, // 42.0 mm
      interLensDistance: 0.0600,    // 60.0 mm
      verticalAlignment: 'BOTTOM',
      trayToLensDistance: 0.0350,   // 35.0 mm
      maxFovAngles: {
        outerDeg: 40.0,
        innerDeg: 40.0,
        upperDeg: 40.0,
        lowerDeg: 40.0
      },
      distortion: {
        model: 'cardboard-radial-polynomial',
        k1: 0.441,
        k2: 0.156
      }
    },
    'custom:calibrated': {
      viewerProfileId: 'custom:calibrated',
      name: 'Custom Viewer Profile (Manual Device Parameter Input)',
      source: 'User Calibrated Optical Geometry',
      confidence: 'user-calibrated',
      lensCorrectionEnabled: false,
      screenToLensDistance: 0.0400,
      interLensDistance: 0.0640,
      verticalAlignment: 'BOTTOM',
      trayToLensDistance: 0.0350,
      maxFovAngles: {
        outerDeg: 50.0,
        innerDeg: 50.0,
        upperDeg: 50.0,
        lowerDeg: 50.0
      },
      distortion: {
        model: 'custom-radial-polynomial',
        k1: 0.25,
        k2: 0.15
      }
    }
  };
  return presets[profileId] || presets['unknown:uncalibrated'];
}

// =========================================================================
// Cardboard Optical Geometry Derivation
// Ported faithfully from Google WWGC (googlevr/wwgc: www/js/CardboardView.js)
// =========================================================================
export function deriveCardboardEyeGeometry(screen, viewer) {
  const s = screen || activeScreenProfile;
  const v = viewer || createDefaultViewerProfile('unknown:uncalibrated');

  const halfScreenW = s.widthMeters * 0.5;
  const halfIpd = v.interLensDistance * 0.5;
  const D = v.screenToLensDistance;

  // 1. Physical Distances from Left Lens Center to Screen Edges
  const eyeLeftOuterDist = halfScreenW - halfIpd; // Distance to left outer edge
  const eyeLeftInnerDist = halfIpd;              // Distance to center divider

  let eyeBottomDist = 0.0;
  let eyeTopDist = 0.0;

  if (v.verticalAlignment === 'CENTER') {
    eyeBottomDist = s.heightMeters * 0.5;
    eyeTopDist = s.heightMeters * 0.5;
  } else if (v.verticalAlignment === 'TOP') {
    const fromTop = v.trayToLensDistance + s.borderSizeMeters;
    eyeTopDist = fromTop;
    eyeBottomDist = s.heightMeters - fromTop;
  } else {
    // Default 'BOTTOM'
    const fromBottom = v.trayToLensDistance + s.borderSizeMeters;
    eyeBottomDist = fromBottom;
    eyeTopDist = s.heightMeters - fromBottom;
  }

  // 2. Physical Screen Tangents clamped by Max FOV (from CardboardView.js)
  const deg2rad = Math.PI / 180;
  const maxTanOuter = Math.tan((v.maxFovAngles.outerDeg || 50) * deg2rad);
  const maxTanInner = Math.tan((v.maxFovAngles.innerDeg || 50) * deg2rad);
  const maxTanUpper = Math.tan((v.maxFovAngles.upperDeg || 50) * deg2rad);
  const maxTanLower = Math.tan((v.maxFovAngles.lowerDeg || 50) * deg2rad);

  const leftEyeTanLeft = Math.min(maxTanOuter, eyeLeftOuterDist / D);
  const leftEyeTanRight = Math.min(maxTanInner, eyeLeftInnerDist / D);
  const eyeTanBottom = Math.min(maxTanLower, eyeBottomDist / D);
  const eyeTanTop = Math.min(maxTanUpper, eyeTopDist / D);

  // 3. Right eye mirrors horizontal tangents across the center divider
  const rightEyeTanLeft = leftEyeTanRight;  // Inner (facing divider)
  const rightEyeTanRight = leftEyeTanLeft;  // Outer (facing right edge)

  // 4. Optical center coordinates in Normalized Viewport Space [0, 1] per eye
  // Left eye lens center pixel within left viewport [0, widthPx/2]
  const leftLensCenterXPx = (halfScreenW - halfIpd) * s.pixelsPerMeter;
  const rightLensCenterXPx = (halfIpd) * s.pixelsPerMeter; // relative to right viewport
  const lensCenterYPx = eyeBottomDist * s.pixelsPerMeter;

  const halfViewportWPx = s.widthPx * 0.5;
  const viewportHPx = s.heightPx;

  const leftLensCenterNorm = [leftLensCenterXPx / halfViewportWPx, lensCenterYPx / viewportHPx];
  const rightLensCenterNorm = [rightLensCenterXPx / halfViewportWPx, lensCenterYPx / viewportHPx];

  return {
    screenToLensDistance: D,
    interLensDistance: v.interLensDistance,
    screenPixelsPerMeter: s.pixelsPerMeter,
    leftEye: {
      tanBounds: [leftEyeTanLeft, leftEyeTanRight, eyeTanBottom, eyeTanTop], // [left, right, bottom, top]
      fovDeg: {
        left: Math.atan(leftEyeTanLeft) / deg2rad,
        right: Math.atan(leftEyeTanRight) / deg2rad,
        bottom: Math.atan(eyeTanBottom) / deg2rad,
        top: Math.atan(eyeTanTop) / deg2rad
      },
      lensCenterNorm: leftLensCenterNorm,
      eyeFromHeadMeters: [-halfIpd, 0, 0]
    },
    rightEye: {
      tanBounds: [rightEyeTanLeft, rightEyeTanRight, eyeTanBottom, eyeTanTop],
      fovDeg: {
        left: Math.atan(rightEyeTanLeft) / deg2rad,
        right: Math.atan(rightEyeTanRight) / deg2rad,
        bottom: Math.atan(eyeTanBottom) / deg2rad,
        top: Math.atan(eyeTanTop) / deg2rad
      },
      lensCenterNorm: rightLensCenterNorm,
      eyeFromHeadMeters: [halfIpd, 0, 0]
    },
    distortion: v.distortion || { k1: 0, k2: 0 }
  };
}

export class ProfileStorage {
  constructor() {
    this.videoProfiles = {};
    this.activeViewerProfile = createDefaultViewerProfile('unknown:uncalibrated');
    this.loadFromLocalStorage();
  }

  loadFromLocalStorage() {
    try {
      const vStr = localStorage.getItem('vreconder_video_profiles');
      if (vStr) this.videoProfiles = JSON.parse(vStr);
      const hStr = localStorage.getItem('vreconder_viewer_profile');
      if (hStr) this.activeViewerProfile = JSON.parse(hStr);
    } catch (e) {
      console.warn('Profile local storage warning:', e);
    }
  }

  saveToLocalStorage() {
    try {
      localStorage.setItem('vreconder_video_profiles', JSON.stringify(this.videoProfiles));
      localStorage.setItem('vreconder_viewer_profile', JSON.stringify(this.activeViewerProfile));
    } catch (e) {}
  }

  async loadServerProfiles() {
    try {
      const res = await fetch('/api/profiles');
      if (res.ok) {
        const data = await res.json();
        if (data.videoProfiles) {
          this.videoProfiles = { ...this.videoProfiles, ...data.videoProfiles };
        }
        if (data.viewerProfile) {
          this.activeViewerProfile = { ...this.activeViewerProfile, ...data.viewerProfile };
        }
        this.saveToLocalStorage();
      }
    } catch (e) {
      console.warn('Could not sync profiles with server:', e.message);
    }
  }

  getVideoProfile(mediaId, name = '') {
    if (!this.videoProfiles[mediaId]) {
      this.videoProfiles[mediaId] = createDefaultVideoProfile(mediaId, name);
    }
    return this.videoProfiles[mediaId];
  }

  async saveVideoProfile(profile) {
    if (!profile || !profile.mediaId) return;
    profile.confidence = 'user-calibrated';
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
  }

  async saveViewerProfile(viewerProfile) {
    if (!viewerProfile) return;
    this.activeViewerProfile = viewerProfile;
    this.saveToLocalStorage();

    try {
      await fetch('/api/profiles/viewer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(viewerProfile)
      });
    } catch (e) {}
  }
}

export const profileStorage = new ProfileStorage();
