# Mihomo sidecar

Run from the project root on Windows:

```powershell
npm run mihomo:setup
```

The setup script downloads the latest stable `mihomo-windows-amd64-compatible` release and places it here as:

`mihomo-x86_64-pc-windows-msvc.exe`

That target-triple suffix is required by Tauri's `externalBin` sidecar convention.

Build the elevated Windows Service sidecar before packaging:

```powershell
npm run service:build
```

The service binary is written as `mioproxy-service-x86_64-pc-windows-msvc.exe`.
Install it once from an elevated terminal with `--install`; after that the GUI
uses the `MioProxyService` named pipe and does not start a second Mihomo process.
