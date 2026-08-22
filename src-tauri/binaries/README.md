# Mihomo sidecar

Run from the project root on Windows:

```powershell
npm run mihomo:setup
```

The setup script resolves the repository-pinned Mihomo release in
`config/mihomo-release.json`, verifies both the upstream archive SHA-256 and
the extracted pre-Authenticode executable SHA-256, and places the exact
Windows asset here as:

`mihomo-x86_64-pc-windows-msvc.exe` (currently Mihomo v1.19.30)

The setup also resolves the pinned MetaCubeX/meta-rules-dat release tag and
commit, verifies the release asset digests, and downloads `GeoSite.dat` and
`GeoIP.dat` beside the Mihomo sidecar. Their exact release version, commit,
download URLs, SHA-256 values, GPL-3.0 license, and upstream attribution are
recorded in `config/mihomo-release.json` and `THIRD_PARTY_NOTICES.txt`. The
files are packaged as resources so Profiles using `GEOSITE` or `GEOIP` rules
can validate before reload.

That target-triple suffix is required by Tauri's `externalBin` sidecar convention.

Build the elevated Windows Service sidecar before packaging:

```powershell
npm run service:build
```

The service binary is written as `mioproxy-service-x86_64-pc-windows-msvc.exe`.

`THIRD_PARTY_NOTICES.txt` is packaged with this resource directory and records
the exact bundled Mihomo version, upstream archive/extracted-binary hashes,
GeoSite/GeoIP release provenance, GPL-3.0 notice, and source-availability
links. Keep it with any redistributed Mihomo sidecar artifact. The final
post-Authenticode hashes of signed PE files are recorded separately in the
release manifest; they are not the upstream source hashes listed here.

The V1 Windows distribution is NSIS EXE only: `MioProxy_<version>_x64-setup.exe`.
MSI/WiX is not an official artifact. Tauri updater metadata remains supported
and references the signed NSIS installer.
Install it once from an elevated terminal, using the same data directory as the
GUI:

```powershell
.\mioproxy-service-x86_64-pc-windows-msvc.exe --install `
  --data-dir "$env:APPDATA\dev.MioProxy" `
  --mihomo-path ".\mihomo-x86_64-pc-windows-msvc.exe"
```

The pipe ACL is granted to the data-directory owner. When an administrator
installs the Service for another Windows user, pass that user's SID explicitly
with `--user-sid` (for example, from `whoami /user`).

Installation copies the Service and Mihomo binaries into the administrator-owned
`%ProgramFiles%\MioProxy` directory before registering the Service.

After installation the GUI uses the `MioProxyService` named pipe and does not
start a second Mihomo process. Uninstall with `--uninstall` from an elevated
terminal.
