# Safari VR performance and thermal envelope

Research evidence for Issue #12.

## Executive conclusion

The current black-screen delay and thermal behavior should be measured as a pipeline, not treated as one generic “Safari is slow” problem.

For VREconder on iPhone 15 Pro Safari/Home Screen Web App, separate:

1. **startup latency** — app shell → media list → metadata → first decoded frame → first texture upload → first rendered VR frame;
2. **decode efficiency** — codec/container/hardware decode;
3. **texture-upload cadence** — upload only when a new video frame exists;
4. **head-pose render cadence** — may still render at display cadence even when the video texture has not changed;
5. **render-target resolution / UI compositing** — independent of 4K source resolution;
6. **sustained thermal stability** — detect degradation over time rather than relying on an unavailable browser thermal-state API.

## Primary-source findings

### Apple recommends optimized native video paths and hardware-efficient codecs

Apple’s Safari video guidance recommends MP4/H.264 for static video and explains that playback efficiency depends on using Safari’s optimized media path. Safari 17.4 also added source prioritization for power-efficient hardware-decoded codecs.

Sources:
- https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari
- https://developer.apple.com/documentation/safari-release-notes/safari-17_4-release-notes

**Implication:** V1 codec decisions should prefer a verified hardware-decoded path, but the WebGL VR pipeline still has extra work because the decoded frame is sampled as a texture rather than shown as an ordinary video plane.

### `requestVideoFrameCallback` is the right upload clock

WebKit implemented `HTMLVideoElement.requestVideoFrameCallback()` specifically so web authors can do efficient work when a new decoded video frame reaches the compositor, including painting to canvas/WebGL-style processing. WebKit engineers explicitly cite efficiency/battery advantages for avoiding work at a higher cadence than the media frames.

Sources:
- https://bugs.webkit.org/show_bug.cgi?id=211945
- https://bugs.webkit.org/show_bug.cgi?id=236604

**Implication:** the prototype’s change to update the video texture only when a new decoded frame is available is directionally correct and should remain.

### Texture cadence and head-tracking cadence are different

A 60 Hz head-tracked viewport still needs low-latency pose updates even if the underlying video is 30/59.94/60 fps. Therefore:

- **texture upload**: new decoded video frame only;
- **VR draw / camera orientation**: display/requestAnimationFrame cadence, as needed for head tracking.

Do not tie head tracking entirely to `requestVideoFrameCallback`.

### MediaCapabilities is useful but not infallible

WebKit supports `navigator.mediaCapabilities.decodingInfo()` for codec support/efficiency queries. However, a 2026 WebKit bug showed that AV1 on iPhone 15 Pro could be hardware decoded while `smooth`/`powerEfficient` were underreported in some configurations; the bug was later fixed upstream.

Sources:
- https://webkit.org/blog/9674/new-webkit-features-in-safari-13/
- https://bugs.webkit.org/show_bug.cgi?id=311593

**Implication:** use MediaCapabilities as a signal, not as the only truth. Real-device playback telemetry remains part of VREconder’s source-selection evidence.

### WebKit itself is exploring projected video with WebGL2 + frame callbacks

A 2026 experimental WebKit spatial/projected-video renderer uses WebGL2, uploads frames through `requestVideoFrameCallback`, and uses mipmapping/anisotropic filtering to reduce shimmer in minified projected regions. This work is experimental/off by default and is not evidence that VREconder can rely on Safari’s internal renderer today, but it is useful architecture evidence that projected 180/360 video benefits from these techniques.

Source:
- https://results.webkit.org/commit?id=318691%40main&repository_id=webkit

## Startup-black-screen measurement model

Do not ask the user to estimate where time is being lost. Instrument these timestamps:

```text
appShellReady
mediaListRequested
mediaListReady
sourceSelected
videoLoadStarted
loadedMetadata
loadedData / canPlay
firstVideoFrameCallback
firstTextureUpload
firstVrDraw
firstVisibleVrFrame
```

Log deltas between every stage.

### UX rule

The screen should never present an unexplained black field for seconds.

Immediately show a lightweight state such as:

```text
Loading video…
Reading media metadata…
Decoding first frame…
Ready — Enter VR
```

The VR canvas should switch from loading state to video only after the first decoded frame/texture is actually available. If a poster/thumbnail is available later from the Media Library, it can replace the plain loading state, but thumbnail generation is not required to diagnose the current delay.

### Possible causes to isolate

- media-list/API delay;
- MP4 metadata access / Range behavior;
- first-frame decoder startup;
- source switching/resume logic;
- module initialization before first paint;
- canvas shown before video texture is valid.

Do not assume file size alone is the cause; the existing 206/seek evidence already shows Range works.

## Render resolution is not source resolution

A 4096×2048 source texture does **not** require a 4096×2048 WebGL drawing buffer. The output target is the iPhone display split between two eyes.

Prototype an explicit render-scale control applied to the drawing buffer, for example:

```text
1.00
0.85
0.70
```

while leaving the decoded source untouched.

Measure for each scale:
- visible sharpness in the headset;
- render FPS / frame time;
- dropped/late frames;
- heat over a short sustained session.

If 0.85 is visually indistinguishable in the headset but materially reduces GPU pressure, it is a legitimate viewer/runtime optimization. Do not transcode the source merely to achieve the same effect.

## GPU/compositing hygiene for the prototype

Safe, low-risk items to probe without choosing the final renderer:

- keep `preserveDrawingBuffer` off;
- do not allocate depth/stencil/alpha buffers when not required by the actual pass;
- do not upload the same video frame repeatedly;
- render hidden UI only when needed; when controls are closed, avoid drawing a second full-screen overlay canvas if possible;
- keep the default viewing state content-only;
- avoid expensive visual blur/backdrop effects in the in-headset path;
- use one coherent projection/lens-warp path instead of stacking unnecessary full-resolution intermediate canvases.

These are prototype probes; measure rather than assume each one is material on iPhone Safari.

## Thermal measurement plan

The browser does not expose a reliable general-purpose iPhone thermal-state API to web content. Therefore use indirect evidence:

- VR render FPS / frame time distribution;
- `requestVideoFrameCallback` cadence and presented-frame metadata where available;
- `getVideoPlaybackQuality()` dropped/total frames where supported;
- WebGL context-loss/errors;
- startup latency and seek latency before/after sustained playback;
- device orientation event cadence;
- user report of device becoming noticeably hot, only as a qualitative observation.

### Proportionate first gate

Use a **10-minute** real-headset run for the first thermal gate rather than a very long endurance test.

Compare at least:
- first minute;
- minute 5;
- minute 10.

Pass if there is no material sustained degradation (large FPS collapse, growing dropped-frame rate, context loss, or unusable heat). Only extend duration if the 10-minute result is ambiguous.

## Codec/source matrix for V1

Keep it small and representative.

### Required now

1. current representative 4K AVC/H.264 60 fps file;
2. one representative 4K HEVC file already present locally.

Compare:
- first-frame/startup latency;
- sustained decode/render cadence;
- dropped frames;
- qualitative heat.

### Later, not current blocker

- real AV1 sample on the actual iPhone/iOS path;
- 10-bit/6K/8K variants;
- large formal codec benchmark matrix.

Do not add transcoding merely to populate a benchmark matrix.

## Recommended performance prototype sequence

### P1 — Startup timeline

Add the timestamp telemetry and loading state. Diagnose the current black-screen interval first.

### P2 — Render-scale A/B/C

Test 1.00 / 0.85 / 0.70 on the same real 4K source.

### P3 — AVC vs HEVC representative smoke test

Use existing local files; no new transcode.

### P4 — 10-minute sustained run

Use the best-looking render scale that remains below the obvious quality threshold and compare early/late telemetry.

## Acceptance criteria

V1 performance work should be considered adequate when:

- unexplained black screen is replaced by immediate loading feedback and first-frame timing is measured;
- 4K representative media reaches the first visible VR frame within a known/repeatable envelope;
- video texture upload occurs only on decoded-frame changes;
- head tracking remains responsive at display cadence;
- a render scale is selected from real headset evidence rather than source resolution assumptions;
- representative AVC and HEVC remain smooth enough over a 10-minute session without severe thermal degradation;
- the system can lower render scale before resorting to expensive preprocessing/transcoding.

## Architecture implication

Keep these as separate knobs:

```text
Source Media / Playback Variant
        ↓
Decoder / video frame
        ↓
Video texture update cadence
        ↓
Projection + viewer distortion
        ↓
Render scale / per-eye output
        ↓
Optional controls overlay
```

This separation lets VREconder optimize GPU output without permanently altering a video, and lets codec/source selection remain an upstream Media Library responsibility.
