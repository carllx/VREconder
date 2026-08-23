// ==========================================
// Video Projection Profile & Viewer Profile Models
// ==========================================

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
    projection: 'equirectangular-180', // 'equirectangular-180' | 'equirectangular-360' | 'flat'
    stereoMode: 'left-right', // 'left-right' | 'top-bottom' | 'mono'
    eyeOrder: 'left-right', // 'left-right' | 'right-left'
    fovHorizontalDeg: 180, // 160 ~ 200 deg
    fovVerticalDeg: 180,
    crop: { top: 0, bottom: 0, left: 0, right: 0 },
    pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    confidence: 'user-calibrated',
    updatedAt: new Date().toISOString()
  };
}

export function createDefaultViewerProfile(profileId = 'cardboard:v2') {
  const presets = {
    'cardboard:v2': {
      viewerProfileId: 'cardboard:v2',
      name: 'Google Cardboard V2',
      lensCorrectionEnabled: false,
      fovDeg: 80, // Per-eye symmetric FOV
      distortion: { k1: 0.16, k2: 0.06 },
      ipdMm: 64
    },
    'vrbox:standard': {
      viewerProfileId: 'vrbox:standard',
      name: 'Standard VR Box / Lens HMD',
      lensCorrectionEnabled: false,
      fovDeg: 88,
      distortion: { k1: 0.22, k2: 0.10 },
      ipdMm: 64
    },
    'custom': {
      viewerProfileId: 'custom',
      name: 'Custom Viewer Profile',
      lensCorrectionEnabled: false,
      fovDeg: 85,
      distortion: { k1: 0.18, k2: 0.08 },
      ipdMm: 64
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
