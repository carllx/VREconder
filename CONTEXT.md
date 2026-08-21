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
