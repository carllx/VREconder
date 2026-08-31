import fs from 'node:fs';
import path from 'node:path';

export function normalizeServerVideoProfile(raw, defaultMediaId = '') {
  if (!raw) return null;
  const mediaId = raw.mediaId || defaultMediaId;
  let projection = raw.projection || 'unknown';
  let horizontalCoverageDeg = (typeof raw.horizontalCoverageDeg === 'number')
    ? raw.horizontalCoverageDeg
    : ((typeof raw.fovHorizontalDeg === 'number') ? raw.fovHorizontalDeg : 180);
  let verticalCoverageDeg = (typeof raw.verticalCoverageDeg === 'number')
    ? raw.verticalCoverageDeg
    : ((typeof raw.fovVerticalDeg === 'number') ? raw.fovVerticalDeg : 180);

  if (projection === 'equirectangular-180') {
    projection = 'equirectangular';
    horizontalCoverageDeg = 180;
    verticalCoverageDeg = 180;
  } else if (projection === 'equirectangular-360') {
    projection = 'equirectangular';
    horizontalCoverageDeg = 360;
    verticalCoverageDeg = 180;
  } else if (projection !== 'equirectangular' && projection !== 'flat') {
    projection = 'unknown';
  }

  let stereoMode = raw.stereoMode || 'unknown';
  if (!['left-right', 'top-bottom', 'mono', 'unknown'].includes(stereoMode)) stereoMode = 'unknown';

  let eyeOrder = raw.eyeOrder || 'unknown';
  if (eyeOrder === 'left-first') eyeOrder = 'left-right';
  else if (eyeOrder === 'right-first') eyeOrder = 'right-left';
  if (!['left-right', 'right-left', 'unknown'].includes(eyeOrder)) eyeOrder = 'unknown';

  return {
    mediaId,
    name: raw.name || '',
    projection,
    horizontalCoverageDeg,
    verticalCoverageDeg,
    stereoMode,
    eyeOrder,
    crop: raw.crop || { top: 0, bottom: 0, left: 0, right: 0 },
    pose: raw.pose || { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    confidence: raw.confidence || 'unverified',
    notes: raw.notes || 'Awaiting Stage A calibration in Flat Diagnostic View',
    updatedAt: raw.updatedAt || new Date().toISOString()
  };
}

export function handleProfileRoutes(req, res, pathname, __dirname) {
  const VIDEO_PROFILES_FILE = path.join(__dirname, 'prototype_video_profiles.json');
  const VIEWER_PROFILE_FILE = path.join(__dirname, 'prototype_viewer_profile.json');

  if ((pathname === '/api/profiles' || pathname === '/api/profiles/videos') && req.method === 'GET') {
    let videoProfiles = {};
    let viewerProfile = null;
    try {
      if (fs.existsSync(VIDEO_PROFILES_FILE)) {
        const rawMap = JSON.parse(fs.readFileSync(VIDEO_PROFILES_FILE, 'utf8'));
        for (const [k, v] of Object.entries(rawMap)) {
          videoProfiles[k] = normalizeServerVideoProfile(v, k);
        }
      }
      if (fs.existsSync(VIEWER_PROFILE_FILE)) {
        viewerProfile = JSON.parse(fs.readFileSync(VIEWER_PROFILE_FILE, 'utf8'));
        if (viewerProfile && (viewerProfile.confidence === 'working-user-tuned' || viewerProfile.viewerProfileId === 'viewer:my_profile')) {
          viewerProfile.isCalibrated = false;
          viewerProfile.source = 'User-tuned Working Profile (Unvalidated)';
        }
      }
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ videoProfiles, viewerProfile }));
    return true;
  }

  if ((pathname === '/api/profiles/video' || pathname === '/api/profiles/videos') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const profile = JSON.parse(body);
        let existing = {};
        if (fs.existsSync(VIDEO_PROFILES_FILE)) {
          try {
            const rawMap = JSON.parse(fs.readFileSync(VIDEO_PROFILES_FILE, 'utf8'));
            for (const [k, v] of Object.entries(rawMap)) {
              existing[k] = normalizeServerVideoProfile(v, k);
            }
          } catch (e) {}
        }
        if (profile && profile.mediaId) {
          const canonical = normalizeServerVideoProfile(profile, profile.mediaId);
          existing[profile.mediaId] = canonical;
          fs.writeFileSync(VIDEO_PROFILES_FILE, JSON.stringify(existing, null, 2), 'utf8');
          console.log(`[Profile] Saved Projection Profile for ${profile.mediaId} (${canonical.projection})`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', saved: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  if (pathname === '/api/profiles/viewer' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const profile = JSON.parse(body);
        if (profile && (profile.confidence === 'working-user-tuned' || profile.viewerProfileId === 'viewer:my_profile')) {
          profile.confidence = 'working-user-tuned';
          profile.isCalibrated = false;
          profile.source = 'User-tuned Working Profile (Unvalidated)';
        }
        fs.writeFileSync(VIEWER_PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf8');
        console.log(`[Profile] Saved Viewer Profile: ${profile.viewerProfileId} (Lens: ${profile.lensCorrectionEnabled ? 'ON' : 'OFF'})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', saved: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  if (pathname === '/api/profiles/viewer' && req.method === 'GET') {
    let viewerProfile = null;
    try {
      if (fs.existsSync(VIEWER_PROFILE_FILE)) viewerProfile = JSON.parse(fs.readFileSync(VIEWER_PROFILE_FILE, 'utf8'));
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(viewerProfile));
    return true;
  }

  return false;
}
