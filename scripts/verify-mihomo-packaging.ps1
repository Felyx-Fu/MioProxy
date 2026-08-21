[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'config\mihomo-release.json'
$noticePath = Join-Path $repoRoot 'src-tauri\binaries\THIRD_PARTY_NOTICES.txt'
$binaryPath = Join-Path $repoRoot 'src-tauri\binaries\mihomo-x86_64-pc-windows-msvc.exe'
$tauriConfigPath = Join-Path $repoRoot 'src-tauri\tauri.conf.json'

if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Mihomo release manifest is missing: $manifestPath" }
if (-not (Test-Path -LiteralPath $noticePath)) { throw "Mihomo third-party notice is missing: $noticePath" }
if (-not (Test-Path -LiteralPath $binaryPath)) { throw "Pinned Mihomo sidecar is missing: $binaryPath" }
if (-not (Test-Path -LiteralPath $tauriConfigPath)) { throw "Tauri configuration is missing: $tauriConfigPath" }

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$tag = [string]$manifest.tag
$asset = [string]$manifest.asset
$digest = ([string]$manifest.sha256).ToLowerInvariant()
$notice = Get-Content -LiteralPath $noticePath -Raw

if ($tag -ne "v$version") { throw "Mihomo manifest tag/version are inconsistent." }
foreach ($requiredText in @(
    "Bundled release: Mihomo $tag",
    "Bundled Windows asset: $asset",
    "Bundled asset SHA-256: $digest",
    "Source archive: $([string]$manifest.sourceUrl)",
    "Release: $([string]$manifest.releaseUrl)",
    'GNU General Public License, version 3 (GPL-3.0)'
)) {
    if ($notice.IndexOf($requiredText, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Mihomo third-party notice does not record required pinned release information: $requiredText"
    }
}

$config = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
if (@($config.bundle.resources) -notcontains 'binaries') {
    throw 'Tauri resources no longer include the binaries directory.'
}

Write-Host "Mihomo packaging/source availability verified for $tag ($digest)." -ForegroundColor Green
