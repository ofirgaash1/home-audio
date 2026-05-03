# Home Audio

This repo contains a small LAN audio relay app for listening to PC audio on a phone over the same Wi-Fi.

For development run:

```powershell
npm run lan-audio
```

Main app files live in `lan-audio/`.

For live terminal diagnostics/control (including listener refresh/rejoin/leave and server restart), use:

```powershell
powershell -ExecutionPolicy Bypass -File lan-audio/live-console.ps1 -Action status
```

## Desktop App (No Terminal For End Users)

The repo now includes a Windows desktop wrapper with a tray menu that:

- starts/stops the LAN audio server
- opens the host page
- copies listener link
- shows listener QR code
- can launch at Windows login

Development run:

```powershell
npm run desktop:dev
```

Build installer:

```powershell
npm run desktop:dist
```

Installer output goes to `release/`.
