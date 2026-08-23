# Projection and optical calibration for VREconder

Research evidence for Issue #11.

## Executive conclusion

VREconder must not treat “perspective” as one adjustable FOV slider. A correct passive-phone VR view is the composition of three different parameter layers:

1. **Per-video media projection** — how video pixels map to rays on the captured spherical/partial-spherical field: projection kind, stereo layout/eye order, angular coverage, crop/projection bounds, initial pose, and possibly a projection mesh.
2. **Per-viewer/device optics** — how each ideal eye image must be projected and pre-distorted for the actual phone screen and headset lenses: eye-from-head transform, per-side FOV, screen geometry, and lens-distortion mesh/coefficients.
3. **User/session calibration** — recenter and only genuinely user-specific alignment/comfort values. This must not be used to hide source-projection or viewer-optics errors.

The current prototype uses a fixed ~94.5° FOV and no verified headset-specific lens pre-distortion. That is not a sufficient geometric model for a Cardboard-style viewer and is a plausible explanation for strong edge curvature. Differences between videos also indicate that some files may not share the same source projection/crop/FOV even when their pixel dimensions look similar.

## Primary-source findings

### Viewer/device optics are headset-specific, not video-specific

Google Cardboard’s open-source SDK creates a `CardboardLensDistortion` object from **encoded viewer parameters plus display width/height**. The API then provides, per eye:

- eye-from-head matrix;
- field-of-view half angles;
- ideal projection matrix;
- distortion mesh;
- distorted/undistorted UV mappings.

The official quickstart updates these parameters whenever a different viewer QR code is scanned, then recreates the lens-distortion object and renderer. Google’s iOS documentation also requires screen parameters for each phone model.

Sources:
- https://developers.google.com/cardboard/reference/c/group/lens-distortion
- https://developers.google.com/cardboard/develop/ios/quickstart
- https://developers.google.com/cardboard/develop/ios/screen-params
- https://github.com/googlevr/cardboard
- https://github.com/googlevr/wwgc

**Implication:** lens correction, eye center and per-eye FOV belong in a **Viewer Profile** keyed by headset + device/screen configuration. They should not be tuned independently for every video.

### Media projection can legitimately vary per video

Google Spherical Video V2 defines MP4/WebM metadata for:

- stereoscopic mode (`st3d`) including top-bottom, left-right and right-left;
- projection type (`sv3d/proj`), including equirectangular, cubemap and mesh;
- initial yaw/pitch/roll;
- equirectangular projection bounds/cropping;
- arbitrary mesh projections for projections that cannot be represented by a simple equirectangular formula.

Google’s VR180 format builds on Spherical Video V2 and explicitly says a frame may use a global static projection, “typically to only a sub-180 FOV part,” with mesh projection available to describe the pixel-to-spherical mapping.

Sources:
- https://github.com/google/spatial-media/blob/master/docs/spherical-video-v2-rfc.md
- https://github.com/google/spatial-media/blob/master/docs/vr180.md
- https://github.com/google/spatial-media

**Implication:** width/height or a filename cannot safely determine projection. Two 4096×2048 files may need different projection bounds or even different projection models.

### Per-eye FOV should be represented as four angular bounds

OpenXR represents a view using a pose and an `XrFovf` with independent left/right/up/down angles; systems can have asymmetric per-eye frusta. It explicitly defines +Y up, +X right and -Z forward for view space.

Sources:
- https://registry.khronos.org/OpenXR/specs/1.1-khr/html/xrspec.html
- https://registry.khronos.org/OpenXR/specs/1.1/man/html/XrView.html

**Implication:** a single symmetric scalar FOV is a useful prototype shortcut but should not become VREconder’s final geometry contract.

## What “correct perspective” means

For a correctly mapped spherical source viewed through the correct per-eye projection and lens compensation, a small local view behaves like an ordinary rectilinear camera view.

### Useful diagnostic observations

1. **Straight architectural-line test**
   - Door frames, cabinet edges and long ceiling/wall lines that are physically straight should appear straight in the rectilinear viewport.
   - If they bow more strongly near the physical screen/lens edges across many different videos, suspect missing/wrong viewer lens pre-distortion.
   - If the same line is bent at the same place in the source as the head turns, suspect source stitching/projection error.

2. **FOV/scale test**
   - Wrong FOV mainly changes apparent angular scale (“too zoomed” / “too wide”) and perspective strength.
   - A scalar FOV change should not be the primary repair for strongly curved straight lines. Curvature points more directly to projection warp/lens distortion/source stitching.

3. **Horizon/vertical test**
   - A horizon or plumb vertical is useful for pitch/roll/orientation diagnosis.
   - It is not sufficient to calibrate lens distortion or source angular coverage.

4. **Head-turn stability test**
   - A fixed room feature should not stretch/breathe as it moves from center toward the edge and back.
   - If geometry changes with screen position, suspect viewer/frustum/lens correction.

5. **Stereo sanity test**
   - Distant scene structure should be easy to fuse and should not demand a large arbitrary left/right shift.
   - Eye-order errors can be corrected as media metadata. Arbitrary stereo offsets should not be used to compensate for a wrong viewer IPD/projection model.

These tests are diagnostic signals, not a claim that arbitrary footage provides enough ground truth to automatically reconstruct its camera model.

## Diagnostic decision tree

### Step 1 — Identify media projection before changing FOV

1. Parse `sv3d`, `st3d`, projection bounds and VR180/mesh metadata when present.
2. If absent, mark mapping as **unknown**, not “standard 180” merely from aspect ratio.
3. Let the user choose/test plausible source mappings: equirectangular 180/360, stereo layout/eye order, and later known fisheye/mesh profiles.

### Step 2 — Validate mapping without headset lens effects

Provide a flat-screen debug mode that reprojects the video into a normal rectilinear viewport. Use straight-line/horizon references in the footage.

- If geometry is already wrong here, the issue is source mapping/stitching/FOV/bounds, not headset lens correction.
- If it looks geometrically natural on the flat viewport but bends in the headset, prioritize viewer optics/lens pre-distortion.

### Step 3 — Apply a Viewer Profile

For the actual headset + iPhone:

- load/derive viewer parameters;
- compute per-eye eye-from-head transform and asymmetric FOV;
- apply the viewer’s lens pre-distortion/distortion mesh;
- keep the viewer profile constant when switching videos.

A strong validation rule is: **one viewer profile should improve multiple correctly tagged videos in the same headset**. If each video needs different lens coefficients, the model is mixing source and viewer errors.

### Step 4 — Only then expose per-video calibration

Allow source-specific adjustments only for media properties: projection type/bounds/pose/angular coverage/eye order or a selected mesh profile.

## Proposed configuration model

### Viewer Profile (headset + phone)

```json
{
  "viewerProfileId": "cardboard:<qr-or-custom-id>",
  "deviceModel": "iPhone15,2",
  "display": {
    "widthPx": 2556,
    "heightPx": 1179,
    "ppi": null
  },
  "eyes": {
    "left": {
      "fov": { "left": null, "right": null, "up": null, "down": null },
      "eyeFromHead": null,
      "distortionProfileId": null
    },
    "right": {
      "fov": { "left": null, "right": null, "up": null, "down": null },
      "eyeFromHead": null,
      "distortionProfileId": null
    }
  },
  "source": "cardboard-qr-or-custom-calibration"
}
```

Do not hardcode the example pixel dimensions as optical truth; obtain actual screen parameters/profile data for the device in implementation.

### Per-video Projection Profile

```json
{
  "mediaId": "stable-library-id-or-fingerprint",
  "projection": "equirectangular-180",
  "stereoMode": "left-right",
  "eyeOrder": "left-right",
  "angularCoverage": { "horizontalDeg": 180, "verticalDeg": null },
  "projectionBounds": { "top": 0, "bottom": 0, "left": 0, "right": 0 },
  "poseDeg": { "yaw": 0, "pitch": 0, "roll": 0 },
  "meshProfileId": null,
  "confidence": "user-calibrated",
  "notes": null
}
```

For V1, store this as reversible Media-Library/player metadata rather than modifying the original MP4. Later, when the mapping is known and standards-compatible, optional export/injection into `sv3d/st3d` can be considered.

## Minimal calibration prototype

Do not start with a free-form “perspective strength” slider. Use staged controls so each knob has one meaning.

### Stage A — Source mapping

- projection type;
- stereo layout / eye order;
- 180/360 or source angular coverage;
- projection bounds/crop if needed;
- initial yaw/pitch/roll.

Show a center crosshair plus optional horizon/vertical/grid overlay. Allow freeze-frame/seek to a scene with useful architectural lines.

### Stage B — Viewer optics

- import/select a viewer profile (ideally Cardboard QR compatible or derived from an equivalent calibration);
- toggle lens correction on/off for A/B validation;
- show per-eye FOV/profile identity;
- do **not** expose arbitrary lens coefficients as normal per-video controls.

### Stage C — Save

Save only per-video mapping values into the video’s Projection Profile. Save viewer/lens values separately into Viewer Profile.

## What can be automatic

Can be automatic or metadata-driven now:
- parse embedded spherical/stereo metadata;
- remember a selected viewer profile;
- remember a user-confirmed per-video profile;
- auto-apply both profiles on later playback.

Should remain explicit/assisted when metadata is absent:
- projection type;
- exact angular coverage/crop;
- arbitrary mesh choice;
- confirmation that a source is correctly stitched.

Do not claim automatic geometric reconstruction from aspect ratio or a single room line.

## Implications for the current Safari prototype

1. Stop treating fixed `FOV = 1.65 rad` as the final perspective model.
2. Add a flat rectilinear debug viewport to separate media-mapping errors from headset optics.
3. Add a viewer-profile seam before implementing more UI-depth tuning.
4. Prototype Cardboard-compatible per-eye FOV + distortion mesh/pre-warp in WebGL without changing the media source.
5. Keep per-video calibration as a sidecar profile so calibrated values automatically reapply on future playback.
6. UI stereoscopic depth should be calculated using the same per-eye viewer projection, not independent pixel offsets.

## Gate recommendation

Before resuming fine UX comparison in #9, run a focused projection/optics prototype that proves:

- one Viewer Profile works across at least two representative videos;
- per-video mapping can be changed/saved independently;
- straight-line/edge distortion improves when headset lens correction is enabled;
- source-specific distortion remains identifiable rather than being hidden by viewer parameters.
