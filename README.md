# Home Audio

This repo contains a small LAN audio relay app for listening to PC audio on a phone over the same Wi-Fi.

For development run:

```powershell
npm run lan-audio
```

Main app files live in `lan-audio/`.

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
