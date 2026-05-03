# LAN Audio Relay

This mini app serves two pages:

- `http://localhost:43117/host` on the PC
- `http://<your-pc-lan-ip>:43117/listen` on the phone

It now supports a better VB-CABLE path: capture `CABLE Output` as an input device, stream that directly to the phone, and use a separate delayed local monitor output on the PC.

## Run

```powershell
npm run lan-audio
```

## Live terminal control and diagnostics

Use the live console script for status/watch/events, listener commands, and restart:

```powershell
powershell -ExecutionPolicy Bypass -File lan-audio/live-console.ps1 -Action status
powershell -ExecutionPolicy Bypass -File lan-audio/live-console.ps1 -Action watch
powershell -ExecutionPolicy Bypass -File lan-audio/live-console.ps1 -Action events
powershell -ExecutionPolicy Bypass -File lan-audio/live-console.ps1 -Action refresh-all
powershell -ExecutionPolicy Bypass -File lan-audio/live-console.ps1 -Action rejoin -ListenerId listener-k2891nmq
powershell -ExecutionPolicy Bypass -File lan-audio/live-console.ps1 -Action restart
```

`watch-debug.ps1` remains available for a focused debug-state view.

## Important limitation

The PC host page should be opened on `localhost`, not on the LAN IP, because browser media permissions are tied to secure or trustworthy origins.

## VB-CABLE routing

- Keep Windows default playback on your real speakers/headphones.
- In Windows Volume Mixer, route only the source app you want to stream to `CABLE Input (VB-Audio Virtual Cable)`.
- In the host page, select `CABLE Output` as the source device.
- Select your real speakers/headphones as the monitor output and set the local delay slider.

## Browser guidance

- On the PC, use Chrome or Edge.
- On the phone, modern Chrome or Safari should work as the listener.
- The host page uses microphone-style device capture and a separate local monitor output, not screen sharing.
