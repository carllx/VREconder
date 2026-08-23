# Throwaway Prototype: Secure LAN Origin for iPhone Safari VR (Issue #6)

## Purpose
Prove the lightest, most practical approach for a Windows PC to serve a Secure Context (`isSecureContext === true`) to iPhone Safari on a local area network (LAN), preserving:
1. Valid HTTPS Secure Context without browser security blocks.
2. `DeviceOrientation` sensor access via user gesture (`DeviceOrientationEvent.requestPermission()`).
3. HTTP Range / 206 Partial Content video streaming & random seek.
4. Single same-origin simplicity for HTML, Video, and future WebGL/WebXR assets.

## How to Run

```bash
# In repository root:
node prototype/lan_secure_origin/server.mjs
```

## iPhone Validation Steps

1. **CA Installation (One-time only)**:
   - On iPhone Safari, open: `http://192.168.10.10:8080`
   - Tap **"Download Root CA Profile"** &rarr; tap **Allow**.
   - Open iPhone **Settings** &rarr; tap **Profile Downloaded** &rarr; tap **Install** &rarr; enter PIN &rarr; tap **Install**.
   - In iPhone **Settings**, go to: `General > About > Certificate Trust Settings` (at the bottom).
   - Under **ENABLE FULL TRUST FOR ROOT CERTIFICATES**, switch **VREconder LAN Root CA** to **ON** &rarr; tap **Continue**.

2. **Run Secure Probe**:
   - On iPhone Safari, open: `https://192.168.10.10:8443`
   - Observe Section A: `isSecureContext: true (PASS)` with green lock.
   - Observe Section B: Tap **"1. Tap to Enable Motion (User Gesture)"** &rarr; tap **Allow** &rarr; verify real-time alpha/beta/gamma degrees.
   - Observe Section C: Video loads & controls work &rarr; tap **"Seek 2s"**, **"Seek 5s"**, **"Seek 8s"** &rarr; verify 206 Partial Content & instant seek & continuous playback.
   - Tap **"Sync to PC"** to post machine-readable telemetry back to PC server.
