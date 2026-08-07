# Mihomo sidecar

Run from the project root on Windows:

```powershell
npm run mihomo:setup
```

The setup script downloads the latest stable `mihomo-windows-amd64-compatible` release and places it here as:

`mihomo-x86_64-pc-windows-msvc.exe`

That target-triple suffix is required by Tauri's `externalBin` sidecar convention.
