// ==========================================
// Screen Profile & Physical Device Display Geometry
// (iPhone 15 Pro Physical Parameters)
// ==========================================

export class ScreenProfile {
  constructor() {
    // Authoritative Display Specifications:
    // Source: Apple Technical Specifications (iPhone 15 Pro display)
    // Resolution: 2556 x 1179 px (Landscape orientation), 460 PPI
    this.deviceModel = 'iPhone 15 Pro (iPhone15,2)';
    this.widthPx = 2556;
    this.heightPx = 1179;
    this.ppi = 460;

    // Physical Derivation: meters = (pixels / PPI) * 0.0254
    const metersPerInch = 0.0254;
    this.widthMeters = (this.widthPx / this.ppi) * metersPerInch;   // 0.1411513 m (141.15 mm)
    this.heightMeters = (this.heightPx / this.ppi) * metersPerInch; // 0.0651013 m (65.10 mm)
    this.metersPerPixel = metersPerInch / this.ppi;                // 0.000055217 m/px
    this.pixelsPerMeter = 1.0 / this.metersPerPixel;               // 18110.236 px/m

    // Bottom Tray Bezel Offset:
    // Provenance: WWGC default mobile tray border fallback estimate (3.0 mm)
    // NOTE: This is an estimated mechanical input; user calibration can adjust tray-to-lens distance.
    this.borderSizeMeters = 0.0030; // 3.0 mm tray bezel estimate
  }
}

export const activeScreenProfile = new ScreenProfile();
