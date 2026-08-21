# MioProxy

MioProxy is a Windows desktop proxy client built with Tauri 2, React,
TypeScript, Vite and Rust. The current architecture separates the normal-user
GUI from the elevated Windows Service that owns the managed Mihomo runtime.

## Current architecture

```text
React / TypeScript UI
        │ Tauri commands
        ▼
MioProxy GUI (normal user)
        │ authenticated named-pipe IPC
        ▼
MioProxy Service (administrator)
        ├── managed Mihomo Core lifecycle
        ├── managed TUN, routes, DNS and recovery snapshots
        └── runtime configuration and update coordination
                 │
                 ▼
              Windows network
```

- The GUI does not call the Mihomo Controller directly. Rust owns Controller
  authentication, response handling and redaction before data reaches the UI.
- The Service owns the managed Mihomo process and rejects ambiguous ownership
  or incompatible IPC peers.
- MioProxy System Proxy is represented through an ownership-aware Windows
  snapshot. An external endpoint or PAC/WPAD owner is never overwritten.
- MioProxy TUN is managed by the Service. TUN enable/disable uses runtime
  snapshots and recovery paths; an externally owned TUN is observed as external
  and is not killed or taken over.
- The tray and window shell are Tauri/Win32 integrations. Closing from the
  Windows taskbar exits normally; the explicit title-bar action hides to tray.

## Development prerequisites

1. Node.js 20 or newer
2. Rust stable with the MSVC Windows target
3. Microsoft C++ Build Tools / Visual Studio Build Tools
4. WebView2 Runtime

Install dependencies and prepare the local sidecars from the repository root:

```powershell
npm ci
npm run mihomo:setup
npm run service:build
npm run tauri dev
```

`mihomo:setup` resolves the repository-pinned Mihomo release in
`config/mihomo-release.json`, verifies the upstream SHA-256 digest, and places
the exact sidecar at `src-tauri/binaries/mihomo-x86_64-pc-windows-msvc.exe`.
The current pinned release is Mihomo v1.19.30; the packaged notice records its
asset, digest, release page, and source archive.

## Runtime defaults

The first managed Core start creates a runtime configuration under
`%APPDATA%\dev.MioProxy`. The settings page reports the actual paths and
runtime state. The generated baseline uses a local mixed port, loopback
Controller, `allow-lan: false`, and rule mode. A real proxy node appears only
after a Profile is added and downloaded.

## Validation and release readiness

The non-network quality gates are reproducible locally:

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\check-version-consistency.ps1
cargo fmt --manifest-path .\src-tauri\Cargo.toml -- --check
cargo check --locked --manifest-path .\src-tauri\Cargo.toml
cargo test --locked --manifest-path .\src-tauri\Cargo.toml
cargo clippy --locked --manifest-path .\src-tauri\Cargo.toml --all-targets --all-features -- -D warnings
```

For the explicit Windows coexistence path, start with both System Proxy and
MioProxy TUN already enabled and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release-system-proxy-tun-readiness.ps1 -Execute -ConfirmManualNetworkChanges
```

The harness refuses an external TUN or externally owned System Proxy, does not
kill processes, and records only redacted readiness evidence. It asks for the
System Proxy toggle in the GUI, uses authenticated Service IPC for the managed
TUN transition, probes domestic/foreign HTTPS and DNS, and requires the final
state to match the initial state. A manual run is required before claiming the
Windows network acceptance gate; this repository does not claim that run has
already passed.

The pre-tag GitHub Actions workflow is `MioProxy Release Readiness`. It is
started with `workflow_dispatch`, performs the locked build/test/lint gates and
an unsigned Windows bundle build, and never creates a GitHub Release.

## Dependency security status

The Windows release surface is checked explicitly with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-windows-dependency-surface.ps1
```

The shared cross-platform `src-tauri/Cargo.lock` contains `glib 0.18.5` only
through Tauri's non-Windows GTK3 dependency graph. The `x86_64-pc-windows-msvc`
release graph does not select `glib`, and it is not compiled into the Windows
application or installer. GitHub Dependabot may still report
[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) from
the cross-platform lockfile.

Forcing `glib 0.20` into this graph is not a safe fix: the current Tauri GTK3
stack requires the `0.18` API line. The complete cross-platform fix belongs to
the upstream Tauri/GTK migration; MioProxy does not silently replace that
stack or claim the unsupported Linux path is patched. The Windows release
workflow fails if `glib` ever enters the Windows target dependency surface.

## Windows release build

The updater signing private key is never stored in this repository. For a local
signed build:

```powershell
npm run release:build
```

The script accepts `-SigningKeyPath` or
`TAURI_SIGNING_PRIVATE_KEY_PATH`. It prefers the generic
`%USERPROFILE%\.tauri\mioproxy.key` name and retains a compatibility fallback
for an existing legacy key file. Never commit the private key or password.

All five release version sources must agree: `package.json`, `package-lock.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`.

## Third-party software

Mihomo is GPL-3.0 software distributed as an independent sidecar. The
repository notice is [THIRD_PARTY.md](THIRD_PARTY.md), and the packaged resource
notice is `binaries/THIRD_PARTY_NOTICES.txt`. It contains the pinned upstream
version, digest, source, release, and license links required for redistribution
information. MioProxy's
own source remains private/unlicensed until a separate licensing decision is
made.

## Scope boundary

This repository intentionally does not claim Windows Snap/DPI/Mica behavior,
external-network reachability, or installer reputation as browser/build-only
facts. Those remain explicit Windows acceptance checks and must be reported as
`MANUAL PENDING` until performed on the target machine.
