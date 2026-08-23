// ==========================================
// Screen Profile & Physical Device Display Geometry
// (Authoritative iPhone 15 Pro Physical Parameters)
// ==========================================

export class ScreenProfile {
  constructor() {
    // Authoritative iPhone 15 Pro Physical Specification
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

    // Bezel Border Specification:
    // Source: Apple Industrial Design (iPhone 15 Pro uniform display border: 1.55 mm)
    this.borderSizeMeters = 0.00155; // 1.55 mm bottom tray bezel offset
  }

  // NOTE: Physical display geometry is strictly constant for the physical iPhone 15 Pro.
  // Runtime canvas buffer pixel dimensions are tracked separately in the renderer viewport.
}

export const activeScreenProfile = new ScreenProfile();
