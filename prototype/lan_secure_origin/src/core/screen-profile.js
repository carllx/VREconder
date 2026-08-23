// ==========================================
// Screen Profile & Physical Geometry Model
// (Authoritative iPhone 15 Pro Physical Parameters)
// ==========================================

export class ScreenProfile {
  constructor() {
    // Authoritative iPhone 15 Pro Physical Display Specification
    // Resolution: 2556 x 1179 px (Landscape), 460 PPI
    this.deviceModel = 'iPhone 15 Pro (iPhone15,2)';
    this.widthPx = 2556;
    this.heightPx = 1179;
    this.ppi = 460;

    // Physical derivation: meters = (pixels / PPI) * 0.0254
    const metersPerInch = 0.0254;
    this.widthMeters = (this.widthPx / this.ppi) * metersPerInch;   // ~0.14115 m (141.15 mm)
    this.heightMeters = (this.heightPx / this.ppi) * metersPerInch; // ~0.06510 m (65.10 mm)
    this.metersPerPixel = metersPerInch / this.ppi;                // ~0.0000552 m/px
    this.pixelsPerMeter = 1.0 / this.metersPerPixel;               // ~18110.2 px/m

    this.borderSizeMeters = 0.003; // ~3mm bottom tray border / bezel approximation
  }

  updateFromViewport(windowWidthPx, windowHeightPx, dpr = 1.0) {
    // Allows dynamic scaling while keeping calibrated physical PPI
    const totalW = windowWidthPx * dpr;
    const totalH = windowHeightPx * dpr;
    if (totalW > 0 && totalH > 0) {
      this.widthPx = totalW;
      this.heightPx = totalH;
      const metersPerInch = 0.0254;
      this.widthMeters = (this.widthPx / this.ppi) * metersPerInch;
      this.heightMeters = (this.heightPx / this.ppi) * metersPerInch;
    }
  }
}

export const activeScreenProfile = new ScreenProfile();
