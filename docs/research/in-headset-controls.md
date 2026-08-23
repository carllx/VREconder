# In-headset controls for iPhone Safari VR

Research evidence for Issue #7.

## Question

When an iPhone is physically inside a passive VR headset and the touchscreen is not practically reachable, what control paths can a Safari / Home Screen Web App rely on for playback control?

## Executive conclusion

A usable Web V1 does **not** need to require removing the phone from the headset, but no single input path should be treated as universal.

The capability envelope supports a layered control model:

1. **No-extra-hardware fallback:** head-directed gaze pointer plus dwell/confirmable VR menu. This is application logic built on the already-proven DeviceOrientation path and does not depend on a new browser device API.
2. **Preferred physical input when available:** a Bluetooth/MFi-compatible game controller exposed through the Gamepad API. WebKit has supported MFi gamepads on iOS since Safari 10.1, and Gamepad support continues to be maintained on iOS/WebKit.
3. **Convenience/system supplement:** Media Session handlers for play/pause, previous/next and seeking where the OS / headphones / remote surface those commands.
4. **Volume:** do not promise a web volume slider can control iPhone system media volume. Detect volume-lock and treat physical/system volume controls as authoritative on iPhone.

A generic passive-headset button or cheap Bluetooth remote is **not** portable merely because it has a button. It is reliable only if iOS/WebKit exposes it through a known web input path (for example Gamepad, media commands, keyboard/pointer/touch). There is no standard web API for a generic “VR headset button.”

## VERIFIED platform capability

### Gamepad API on iPhone / Home Screen Web Apps

WebKit’s Safari 10.1 release notes state that all MFi gamepads are supported on iOS through the Gamepad API. Safari 17 added gamepad haptic support, and Safari 18 fixed Gamepad API behavior in WKWebView. A WebKit issue concerning saved-to-Home-Screen web apps records Apple engineers verifying Gamepad API operation there on iOS 14 beta 3. Current WebKit work also explicitly handles iOS system navigation interactions while a webpage is using the Gamepad API.

Sources:
- https://webkit.org/blog/7477/new-web-features-in-safari-10-1/
- https://webkit.org/blog/14445/webkit-features-in-safari-17-0/
- https://webkit.org/blog/15865/webkit-features-in-safari-18-0/
- https://bugs.webkit.org/show_bug.cgi?id=214336
- https://commits.webkit.org/298992@main

The W3C Gamepad specification explicitly describes gamepads as suitable for “10 foot” interfaces such as media viewers. It exposes buttons and axes, and its standard mapping includes D-pad, face buttons, shoulders/triggers and analog sticks. For privacy, `navigator.getGamepads()` returns no exposed controller until a gamepad user gesture has occurred, so VREconder must expect the user to press/move the controller once before it becomes available.

Source:
- https://www.w3.org/TR/gamepad/

**Implication:** a standards-compatible MFi / game controller is a credible physical-control path for a Home Screen VREconder Web App. A generic Bluetooth “remote” should only be advertised as supported after its actual iOS exposure mode has been probed; some remotes may not enumerate as a Gamepad.

### Media Session

Safari 15 added MediaSession API support. The current Media Session standard defines actions including `play`, `pause`, `seekbackward`, `seekforward`, `previoustrack`, `nexttrack`, and `seekto`. WebKit continues to maintain the mapping of OS media commands to MediaSession actions, including recent next/previous command work in 2026.

Sources:
- https://webkit.org/blog/11989/new-webkit-features-in-safari-15/
- https://www.w3.org/TR/2026/WD-mediasession-20260605/
- https://results.webkit.org/commit?id=314839%40main&repository_id=webkit

**Implication:** VREconder can register MediaSession handlers so compatible headphones, lock-screen/system controls, or media remotes can provide useful playback shortcuts. This is a supplement, not the only control path, because the exact controls presented by hardware/OS are outside the web app’s control and WebKit’s implementation continues to receive fixes.

### iPhone media volume

Safari 26 release notes specifically say web-developer volume changes were enabled for **iPadOS**, bringing it in line with macOS and visionOS, while retaining the `:volume-locked` feature-detection mechanism. WebKit’s media state work defines `:volume-locked` as the state where volume cannot be changed.

Sources:
- https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- https://webkit.org/blog/17818/announcing-interop-2026/

**Implication:** do not make “arbitrary in-app volume slider changes system volume on iPhone” part of the V1 contract. V1 can reliably offer mute/unmute only if supported by the media element, while actual loudness should remain controllable through iPhone/system/headphone/remote volume controls. The app should feature-detect volume lock rather than assume behavior.

## INFERRED application capability

### Gaze / dwell menu

The already-proven DeviceOrientation path gives VREconder a continuously updated head/view direction. A reticle at the center of the two-eye VR view can therefore perform ray/region hit testing against a VR control overlay. Holding gaze on a target for a dwell interval can trigger an action without touch or additional hardware.

This requires no additional Safari hardware API. It is ordinary application input derived from the existing head pose.

This is suitable for discrete commands:
- open/close controls;
- play/pause;
- previous/next video;
- seek backward/forward by fixed increments;
- recenter;
- mute/unmute;
- coarse jump points on a timeline.

Pure dwell is **not** a good substitute for fine continuous scrubbing. A fine timeline is better with a separate confirm/trigger, gamepad stick/buttons, or a discrete seek design.

### Passive headset buttons / capacitive triggers

There is no cross-device browser contract called “VR headset trigger.” A physical headset mechanism is only useful to VREconder if it ultimately produces a browser-visible input event. Examples could include a real touchscreen contact, a Gamepad button, or a media command. Headsets and remotes differ, so V1 should not depend on a generic passive-headset button without testing that exact hardware class.

## Practical command mapping envelope

| Function | Gaze/dwell fallback | Gamepad/remote | Media Session / system |
| --- | --- | --- | --- |
| Open/close VR menu | Yes | Yes | No standard action |
| Play/pause | Yes | Yes | Yes |
| Previous/next video | Yes | Yes | Yes (`previoustrack` / `nexttrack`) |
| Seek -/+ fixed amount | Yes | Yes | Yes (`seekbackward` / `seekforward`) |
| Fine scrub/progress | Awkward; coarse only preferred | Strong (stick/buttons) | `seekto` may be surfaced, but OS UI decides |
| Recenter | Yes | Yes | No standard media action |
| Mute | Yes | Yes | Hardware-dependent |
| System loudness | Do not rely on web slider | Controller only if OS maps it outside web | System/headphone volume controls |

## Smallest viable V1 capability model

The smallest robust capability model is **layered**:

- V1 must remain operable with **no extra hardware**, using a gaze/dwell VR menu for essential discrete actions.
- V1 should expose a **Gamepad input adapter** so a compatible MFi/Bluetooth controller can become the preferred ergonomic control path without changing playback logic.
- V1 should register **MediaSession handlers** as a low-cost convenience layer for system/headphone media commands.
- V1 must not make generic headset buttons or JavaScript-controlled iPhone system volume assumptions part of acceptance criteria.

This separates the player’s command model (`play`, `pause`, `previous`, `next`, `seek`, `recenter`, etc.) from input adapters (gaze, gamepad, Media Session). The same command model can later support additional controllers without rewriting playback.

## Product decision still open

Research establishes that V1 **can** support a no-extra-hardware fallback and **can** offer optional physical controls. A separate product decision is still appropriate for whether V1 should:

- ship gaze/dwell as the mandatory baseline and treat a controller as optional/recommended; or
- require/recommend a specific class of physical controller for the intended long-session experience.

That decision is about desired UX and hardware assumptions, not browser capability.
