# iPhone Safari Capability Envelope

Research ticket: **Establish the iPhone Safari capability envelope**

Date: 2026-08-23
Target: iPhone 15 Pro + current stable Safari 26.6, with media hosted on a PC over the local LAN.

This note records only facts that materially affect the VR Web Player architecture. It distinguishes **VERIFIED**, **INFERRED**, and **UNKNOWN** rather than treating browser support as equivalent to a proven VR workload.

## Executive conclusion

The Safari route remains technically credible for the current V1 source set, but it has three architecture constraints that must be designed around rather than discovered late:

1. **Secure context is now mandatory for motion/orientation on current Safari.** A plain `http://<PC-LAN-IP>/...` origin is not a trustworthy origin under the Secure Contexts model, so the V1 LAN delivery path needs an HTTPS/trusted-origin strategy before head tracking can be treated as viable.
2. **Custom iPhone fullscreen remains constrained.** Safari supports inline video and video-element fullscreen, but arbitrary-element fullscreen on iPhone is still an open WebKit gap in 2026. A VR canvas therefore cannot assume `Element.requestFullscreen()` will provide a true fullscreen custom UI on iPhone; viewport/PWA behavior must be evaluated in the prototype.
3. **The renderer decision has widened.** Safari 26 ships WebGPU on iOS and WebKit recommends WebGPU for new web apps; WebGL/WebGL2 remain viable and can consume `HTMLVideoElement` as textures. The production renderer choice must therefore compare WebGPU as well as WebGL/framework options, using the representative prototype rather than deciding from API availability alone.

## VERIFIED

### 1. Current Safari baseline

- Safari **26.6** is the current stable Safari release as of this research date and ships with iOS 26.6.
- Safari 27 is still beta and is not used as the V1 baseline.

Sources:
- Apple Safari Release Notes: https://developer.apple.com/documentation/safari-release-notes
- Safari 26.6 release notes: https://developer.apple.com/documentation/safari-release-notes/safari-26_6-release-notes

### 2. Codec availability on iPhone 15 Pro

- Apple lists **HEVC, H.264, AV1, and ProRes** among iPhone 15 Pro supported video playback formats.
- Safari 17 added **AV1 web video playback on devices with hardware decoding support**, explicitly naming iPhone 15 Pro / Pro Max.
- Safari 17.5 included a fix for AV1 hardware decode on iPhone 15 Pro.
- Safari 17.4 can prefer a source with hardware decoding support; WebKit names H.264, HEVC, VP9 and AV1 among hardware-decodable codecs on appropriate Apple devices.

Sources:
- iPhone 15 Pro technical specifications: https://support.apple.com/en-us/111829
- WebKit, Safari 17 AV1: https://webkit.org/blog/14445/webkit-features-in-safari-17-0/
- WebKit, Safari 17.4 media selection: https://webkit.org/blog/15063/webkit-features-in-safari-17-4/
- WebKit, Safari 17.5 AV1 fix: https://webkit.org/blog/15383/webkit-features-in-safari-17-5/

**Architecture implication:** AVC/H.264 and HEVC/H.265 remain reasonable V1 direct-play candidates; AV1 is a real Safari capability on this hardware, but it is not yet a V1 acceptance blocker because the current representative local source set does not contain AV1.

### 3. Runtime codec capability probing exists

- WebKit supports `navigator.mediaCapabilities.decodingInfo()` and reports support, smoothness and power-efficiency dimensions.
- Safari 17 added AV1 support to the Media Capabilities API on hardware-supported devices.
- A 2026 WebKit bug documented that AV1 `smooth` / `powerEfficient` reporting could be wrong on iPhone 15 Pro with iOS 26.4; the upstream bug was fixed in May 2026.

Sources:
- WebKit, Safari 13 Media Capabilities: https://webkit.org/blog/9674/new-webkit-features-in-safari-13/
- Safari 17 release notes: https://developer.apple.com/documentation/safari-release-notes/safari-17-release-notes
- WebKit bug 311593: https://bugs.webkit.org/show_bug.cgi?id=311593

**Architecture implication:** use Media Capabilities as one runtime signal, not as the sole truth for acceptance. The representative-device prototype remains authoritative for smoothness.

### 4. Progressive media over HTTP Range is a supported Safari delivery mechanism

- Apple’s Safari/iOS media documentation states that HTTP servers hosting media for iOS must support **byte-range requests** because iOS uses them for random access playback.
- Apple documents MP4 (`video/mp4`) as a supported web media MIME type and notes that iOS can handle media files larger than 2 GB, subject to server support.
- Safari 26 contains fixes specifically for MP4 seeking and scrubbing behavior, confirming that ordinary MP4 seeking is an active supported path.

Sources:
- Apple, Creating Video / Configuring Your Server: https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/CreatingVideoforSafarioniPhone/CreatingVideoforSafarioniPhone.html
- Safari 26 release notes: https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes

**Architecture implication:** the existing PC-server + HTTP Range concept remains valid. This does **not** verify the project’s still-open 8GB+ long-session performance question.

### 5. Inline video is required for custom web rendering on iPhone

- Apple recommends `<video playsinline>` when video must remain inside the webpage on iPhone.
- Without inline playback, iPhone video uses native fullscreen behavior.

Source:
- Apple, Delivering Video Content for Safari: https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari

**Architecture implication:** a VR renderer that samples a `<video>` into a canvas should treat `playsinline` as part of the baseline media element configuration.

### 6. Arbitrary-element fullscreen on iPhone remains a limitation

- Apple documents iPhone video-element fullscreen APIs (`webkitEnterFullscreen` / `webkitExitFullscreen`).
- WebKit bug 206854, requesting arbitrary-element Fullscreen API support on iPhone, remains open and had renewed comments in June 2026 after Safari 27 beta was announced.

Sources:
- Apple, Delivering Video Content for Safari: https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari
- WebKit bug 206854: https://bugs.webkit.org/show_bug.cgi?id=206854

**Architecture implication:** do not design V1 around `canvas.requestFullscreen()` on iPhone. The prototype must evaluate a viewport-filling inline canvas and, if useful, Home Screen web-app presentation as actual user experiences.

### 7. DeviceOrientation / DeviceMotion require permission and a secure context

- Since Safari 13, websites must call `DeviceOrientationEvent.requestPermission()` / `DeviceMotionEvent.requestPermission()` to request access on iOS/iPadOS.
- Safari 26.4 aligned these interfaces with the specification so they are exposed only in **secure contexts**.
- The W3C Secure Contexts algorithm treats HTTPS and loopback/localhost as potentially trustworthy; an ordinary private-LAN IP served over plain HTTP is not included in those trusted cases.

Sources:
- WebKit, Safari 13 permission model: https://webkit.org/blog/9674/new-webkit-features-in-safari-13/
- WebKit, Safari 26.4 secure-context change: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- W3C Secure Contexts: https://www.w3.org/TR/secure-contexts/

**Architecture implication:** the current development pattern `http://192.168.x.x:<port>` cannot be assumed to provide head tracking on current Safari. A trusted HTTPS LAN origin (or another genuinely secure origin) is a prerequisite for the representative VR prototype.

### 8. Screen Wake Lock is available

- Safari 16.4 added the Screen Wake Lock API.
- Safari 18.4 extended/fixed it for Home Screen web apps on iOS/iPadOS.

Sources:
- WebKit, Safari 16.4: https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
- WebKit, Safari 18.4: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/

**Architecture implication:** preventing screen sleep is not a reason by itself to abandon the Web route, but session/reacquisition behavior still belongs in device testing.

### 9. Video can be used as a GPU texture; WebGPU is now a real option

- The WebGL specification allows an `HTMLVideoElement` as a texture source for `texImage2D` / `texSubImage2D`; cross-origin video requires proper CORS/origin handling.
- Safari 26 ships **WebGPU on iOS**, and WebKit states it is preferred for new sites/web apps over WebGL because it maps better to modern GPU hardware.
- WebKit’s WebGPU examples include using a video element with WebGPU; the WebGPU specification defines external textures sourced from `HTMLVideoElement` or `VideoFrame`.

Sources:
- Khronos WebGL specification: https://registry.khronos.org/webgl/specs/latest/2.0/
- WebKit, Safari 26 WebGPU: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- WebKit WebGPU demos: https://webkit.org/demos/webgpu/
- WebGPU external textures: https://gpuweb.github.io/gpuweb/

**Architecture implication:** the later renderer decision must compare WebGPU and WebGL paths at representative 4K-class video texture load. API existence does not prove the required sustained performance.

## INFERRED

### 1. Current representative AVC/HEVC sources are plausible direct-play candidates

The project’s local fact probe found the dominant real-source set to be MP4 + AVC High 8-bit or HEVC Main 8-bit around 4096×2048 at 30/60 fps, roughly 2–15 Mbps. Apple supports these codec families broadly and its HLS authoring requirements allow H.264 through High Profile Level 5.2 and HEVC through Main 10 Level 5.1 High Tier.

However, the Apple HLS authoring limits are HLS-specific and are **not** direct proof that every progressive MP4 at 4096×2048@60 will decode smoothly in Safari while simultaneously feeding a GPU VR renderer.

Source:
- Apple HLS Authoring Specification: https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/

### 2. Same secure origin is the simplest V1 delivery shape

Because head tracking requires a secure context, GPU texture use is origin-sensitive, and mixed-content/CORS rules complicate combining secure pages with insecure media, the simplest architecture to prototype is likely:

`https://trusted-local-origin/player` + `https://trusted-local-origin/media/...` with HTTP Range support.

This is an architectural inference, not yet a chosen deployment strategy.

Sources:
- W3C Secure Contexts: https://www.w3.org/TR/secure-contexts/
- W3C Mixed Content: https://www.w3.org/TR/mixed-content/
- Khronos WebGL origin restrictions: https://registry.khronos.org/webgl/specs/latest/2.0/

## UNKNOWN / MUST BE PROTOTYPED

The following are not established by browser-support tables or documentation and remain empirical gates:

1. Sustained **4096×2048 @ 59.94/60 fps** decoding while simultaneously uploading/sampling frames in WebGL or WebGPU and rendering stereo VR geometry.
2. Startup, seek recovery and long-session stability for the representative AVC/HEVC files over the real PC→LAN→iPhone path.
3. True **8GB+ complete-file** behavior and frequent random seeking; Apple’s >2GB statement is not enough to claim the project’s 8GB target verified.
4. AV1 at the project’s eventual real resolutions/bitrates, including whether it is actually smoother or more efficient than HEVC for this workload.
5. 10-bit HEVC, 6K and 8K source playback in the custom rendering pipeline.
6. Maximum practical texture size / memory pressure / frame-copy cost on iPhone 15 Pro. This must be queried/measured on the target device rather than assumed from a generic WebGL/WebGPU limit.
7. Whether viewport-filling inline Safari, or a Home Screen web app, gives an acceptable immersive VR presentation despite the arbitrary-element fullscreen limitation.
8. DeviceOrientation latency, drift and stability during a sustained VR session.
9. Wake Lock behavior across background/foreground transitions in the actual player lifecycle.

## Decision impact

This research does **not** reject the Safari Web route. It changes the order of work:

1. Establish a trusted secure LAN origin that can serve both the player and byte-range media to iPhone Safari and can obtain DeviceOrientation permission.
2. Then run the representative minimal Safari VR prototype using the V1 source contract.
3. Use that prototype to choose the renderer/backend and to decide whether the Web route meets the experience gate or warrants a Native-App evaluation.

It also updates the renderer fog from “Three.js vs WebGL” to a broader decision that includes **WebGPU**, WebGL/WebGL2, and framework abstractions over them.