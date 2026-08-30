// ==========================================
// Runtime Viewer Profile & Derived Eye Geometry Dump
// ==========================================
import { deriveCardboardEyeGeometry, createDefaultViewerProfile } from './src/core/projection-profile.js';
import { activeScreenProfile } from './src/core/screen-profile.js';
import { state } from './src/core/state.js';

console.log('=== RUNTIME VIEWER PROFILE & DERIVED EYE GEOMETRY DUMP ===\n');

const profile = createDefaultViewerProfile('cardboard:reference_50deg');
const eyeGeom = deriveCardboardEyeGeometry(activeScreenProfile, profile);

const dump = {
  viewerProfileId: profile.id,
  confidence: profile.confidence,
  isCalibrated: profile.isCalibrated,
  lensCorrectionEnabled: profile.lensCorrectionEnabled,
  interLensDistance: profile.interLensDistance,
  screenToLensDistance: profile.screenToLensDistance,
  trayToLensDistance: profile.trayToLensDistance,
  verticalAlignment: profile.verticalAlignment,
  k1: profile.distortion ? profile.distortion.k1 : 0,
  k2: profile.distortion ? profile.distortion.k2 : 0,
  menuVirtualDepth: state.menuVirtualDepth || 2.0,
  screen: {
    widthMeters: activeScreenProfile.widthMeters,
    heightMeters: activeScreenProfile.heightMeters,
    borderSizeMeters: activeScreenProfile.borderSizeMeters
  },
  leftEye: {
    physTanBounds: eyeGeom.leftEye.physTanBounds,
    virtTanBounds: eyeGeom.leftEye.virtTanBounds,
    lensCenterNorm: eyeGeom.leftEye.lensCenterNorm,
    eyeFromHeadMeters: eyeGeom.leftEye.eyeFromHeadMeters,
    fovDeg: eyeGeom.leftEye.fovDeg
  },
  rightEye: {
    physTanBounds: eyeGeom.rightEye.physTanBounds,
    virtTanBounds: eyeGeom.rightEye.virtTanBounds,
    lensCenterNorm: eyeGeom.rightEye.lensCenterNorm,
    eyeFromHeadMeters: eyeGeom.rightEye.eyeFromHeadMeters,
    fovDeg: eyeGeom.rightEye.fovDeg
  },
  physicalTanScale: eyeGeom.physicalTanScale
};

console.log(JSON.stringify(dump, null, 2));
