# VREconder

VREconder is a VR media workflow whose near-term focus is browser-based VR playback of locally hosted media, with preprocessing used only when the original media cannot be played reasonably as-is.

## Language

**VR Web Player**:
The browser-based VR playback surface running in Safari for VR media served from the local PC.
_Avoid_: Browser, Native Player

**Source Media**:
The original video asset before any compatibility preprocessing for playback.
_Avoid_: Playback copy, Proxy

**Direct Playback**:
Viewing Source Media without first creating a compatibility-specific media variant.
_Avoid_: Raw playback

**Playback Variant**:
A reusable media representation derived from Source Media when Safari compatibility or smooth playback requires preprocessing.
_Avoid_: Temporary transcode, Proxy

**VR Mapping**:
The declared interpretation of a video's stereo layout and projection geometry, such as SBS or TB/OU combined with 180° or 360° equirectangular projection.
_Avoid_: Automatic projection detection

**Playback Item**:
The minimal unit handed to the VR Web Player for one viewing choice: a selected playable source plus the VR-specific declaration needed to render it correctly.
_Avoid_: Video Asset, Library Item

**Playback Queue**:
An ordered collection of Playback Items used for selection, previous/next navigation, automatic advance, and loop playback.
_Avoid_: Folder, Playlist database

**Media Library**:
The media-management side that discovers and describes Video Assets, understands codec/container differences, and selects Source Media or a Playback Variant before handing playback to the Player.
_Avoid_: Player, Playback Queue

**Viewer Profile**:
The persistent headset/device optical model used by the VR Web Player. It owns viewer-global quantities such as per-eye optical geometry, asymmetric FOV, lens/screen geometry and lens distortion/pre-warp. Physical parameters such as Screen-to-Lens belong here and must not be used as per-video zoom or comfort controls.
_Avoid_: Video Profile, Zoom Profile, Per-video Lens Settings

**Per-video Projection Profile**:
The source-specific interpretation of one video's projection and stereo geometry. It owns projection family, stereo layout and eye order, angular coverage/bounds, and other source-mapping information needed to render that media correctly. It must remain separate from Viewer Profile.
_Avoid_: Viewer Profile, Headset Calibration

**Session Controls**:
Transient playback interactions that do not redefine viewer optics or video projection, such as play/pause, seek, previous/next, recenter and opening/closing in-headset controls.
_Avoid_: Viewer Calibration, Video Mapping
