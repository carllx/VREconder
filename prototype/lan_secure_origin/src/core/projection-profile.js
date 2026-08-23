// ==========================================
// Video Projection Profile & Viewer Profile Models
// (Authoritative Cardboard Specs & Untagged Media Semantics)
// ==========================================

export function computeMediaFingerprint(videoItem) {
  if (!videoItem) return 'unknown_media';
  const name = videoItem.name || videoItem.relPath || 'unknown';
  const size = videoItem.sizeBytes || 0;
  return `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}_${size}`;
}

// Untagged media default: unknown/unverified (Never infer 180 SBS automatically)
export function createDefaultVideoProfile(mediaId, name = '') {
  return {
    mediaId: mediaId,
    name: name,
    projection: 'unknown',       // 'unknown' | 'equirectangular-180' | 'equirectangular-360' | 'flat'
    stereoMode: 'unknown',       // 'unknown' | 'left-right' | 'top-bottom' | 'mono'
    eyeOrder: 'unknown',         // 'unknown' | 'left-right' | 'right-left'
    fovHorizontalDeg: 180,       // Default candidate scale if 180 selected
    fovVerticalDeg: 180,
    crop: { top: 0, bottom: 0, left: 0, right: 0 },
    pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    confidence: 'unverified',    // 'unverified' | 'metadata-inferred' | 'user-calibrated'
    notes: 'Awaiting Stage A calibration in Flat Diagnostic View',
    updatedAt: new Date().toISOString()
  };
}

// Authoritative Viewer Profiles from Google Cardboard Specifications
// Sources:
// - Google Cardboard v1 Spec (Google I/O 2014): inter-lens 60mm, screen-to-lens 42mm, k1=0.441, k2=0.156
// - Google Cardboard v2 Spec (Google I/O 2015): inter-lens 64mm, screen-to-lens 39mm, k1=0.34, k2=0.55
// - iPhone 15 Pro Physical Display: 133mm x 62mm active area, 460 PPI
export function createDefaultViewerProfile(profileId = 'cardboard:v2') {
  const presets = {
    'cardboard:v2': {
      viewerProfileId: 'cardboard:v2',
      name: 'Google Cardboard v2 (Official I/O 2015 Spec)',
      source: 'https://support.google.com/cardboard/manufacturers/answer/6321873',
      lensCorrectionEnabled: false,
      interLensDistanceMm: 64.0,
      screenToLensDistanceMm: 39.0,
      screenAlignment: 'center', // optical center alignment
      eyes: {
        left: {
          fov: { leftDeg: 53.0, rightDeg: 53.0, upDeg: 53.0, downDeg: 53.0 },
          eyeFromHeadMm: [-32.0, 0.0, 0.0]
        },
        right: {
          fov: { leftDeg: 53.0, rightDeg: 53.0, upDeg: 53.0, downDeg: 53.0 },
          eyeFromHeadMm: [32.0, 0.0, 0.0]
        }
      },
      distortion: {
        model: 'cardboard-radial-polynomial',
        k1: 0.34,
        k2: 0.55
      }
    },
    'cardboard:v1': {
      viewerProfileId: 'cardboard:v1',
      name: 'Google Cardboard v1 (Official I/O 2014 Spec)',
      source: 'https://support.google.com/cardboard/manufacturers/answer/6321873',
      lensCorrectionEnabled: false,
      interLensDistanceMm: 60.0,
      screenToLensDistanceMm: 42.0,
      screenAlignment: 'center',
      eyes: {
        left: {
          fov: { leftDeg: 40.0, rightDeg: 40.0, upDeg: 40.0, downDeg: 40.0 },
          eyeFromHeadMm: [-30.0, 0.0, 0.0]
        },
        right: {
          fov: { leftDeg: 40.0, rightDeg: 40.0, upDeg: 40.0, downDeg: 40.0 },
          eyeFromHeadMm: [30.0, 0.0, 0.0]
        }
      },
      distortion: {
        model: 'cardboard-radial-polynomial',
        k1: 0.441,
        k2: 0.156
      }
    },
    'custom:uncalibrated': {
      viewerProfileId: 'custom:uncalibrated',
      name: 'Custom / Uncalibrated Viewer (Manual Warp Tuning)',
      source: 'User Manual Calibration',
      lensCorrectionEnabled: false,
      interLensDistanceMm: 64.0,
      screenToLensDistanceMm: 40.0,
      screenAlignment: 'center',
      eyes: {
        left: {
          fov: { leftDeg: 45.0, rightDeg: 45.0, upDeg: 45.0, downDeg: 45.0 },
          eyeFromHeadMm: [-32.0, 0.0, 0.0]
        },
        right: {
          fov: { leftDeg: 45.0, rightDeg: 45.0, upDeg: 45.0, downDeg: 45.0 },
          eyeFromHeadMm: [32.0, 0.0, 0.0]
        }
      },
      distortion: {
        model: 'custom-polynomial',
        k1: 0.20,
        k2: 0.10
      }
    }
  };
  return presets[profileId] || presets['cardboard:v2'];
}

export class ProfileStorage {
  constructor() {
    this.videoProfiles = {};
    this.activeViewerProfile = createDefaultViewerProfile('cardboard:v2');
    this.loadFromLocalStorage();
  }

  loadFromLocalStorage() {
    try {
      const vStr = localStorage.getItem('vreconder_video_profiles');
      if (vStr) this.videoProfiles = JSON.parse(vStr);
      const hStr = localStorage.getItem('vreconder_viewer_profile');
      if (hStr) this.activeViewerProfile = JSON.parse(hStr);
    } catch (e) {
      console.warn('Profile local storage load warning:', e);
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
