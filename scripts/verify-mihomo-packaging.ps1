[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$releasePolicyPath = Join-Path $PSScriptRoot 'mihomo-release-policy.ps1'
if (-not (Test-Path -LiteralPath $releasePolicyPath)) { throw "Mihomo release policy helper is missing: $releasePolicyPath" }
. $releasePolicyPath

function Get-Sha256 {
    param([string]$Path)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return (([BitConverter]::ToString($sha256.ComputeHash($stream)) -replace '-', '').ToLowerInvariant())
    }
    finally {
        $stream.Dispose()
        $sha256.Dispose()
    }
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'config\mihomo-release.json'
$noticePath = Join-Path $repoRoot 'src-tauri\binaries\THIRD_PARTY_NOTICES.txt'
$binaryPath = Join-Path $repoRoot 'src-tauri\binaries\mihomo-x86_64-pc-windows-msvc.exe'
$geoSitePath = Join-Path $repoRoot 'src-tauri\binaries\GeoSite.dat'
$geoIpPath = Join-Path $repoRoot 'src-tauri\binaries\GeoIP.dat'
$tauriConfigPath = Join-Path $repoRoot 'src-tauri\tauri.conf.json'

if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Mihomo release manifest is missing: $manifestPath" }
if (-not (Test-Path -LiteralPath $noticePath)) { throw "Mihomo third-party notice is missing: $noticePath" }
if (-not (Test-Path -LiteralPath $binaryPath)) { throw "Pinned Mihomo sidecar is missing: $binaryPath" }
if (-not (Test-Path -LiteralPath $geoSitePath)) { throw "Pinned GeoSite.dat is missing: $geoSitePath" }
if (-not (Test-Path -LiteralPath $geoIpPath)) { throw "Pinned GeoIP.dat is missing: $geoIpPath" }
if (-not (Test-Path -LiteralPath $tauriConfigPath)) { throw "Tauri configuration is missing: $tauriConfigPath" }

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$tag = [string]$manifest.tag
$asset = [string]$manifest.asset
$digest = ([string]$manifest.upstreamArchiveSha256).ToLowerInvariant()
$binaryDigest = ([string]$manifest.upstreamBinarySha256).ToLowerInvariant()
$geodata = $manifest.geodata
$notice = Get-Content -LiteralPath $noticePath -Raw

Assert-PinnedSha256 -Expected $binaryDigest -Actual (Get-Sha256 -Path $binaryPath) -Artifact 'bundled Mihomo executable'

if ($tag -ne "v$version") { throw "Mihomo manifest tag/version are inconsistent." }
$vendoredGeodata = @(
    [pscustomobject]@{ File = [string]$manifest.geodata.geoSite.file; Path = $geoSitePath; UpstreamSha256 = ([string]$manifest.geodata.geoSite.upstreamSha256).ToLowerInvariant() },
    [pscustomobject]@{ File = [string]$manifest.geodata.geoIp.file; Path = $geoIpPath; UpstreamSha256 = ([string]$manifest.geodata.geoIp.upstreamSha256).ToLowerInvariant() }
)
Assert-VendoredGeodata -Items $vendoredGeodata
if ([string]$geodata.project -ne 'MetaCubeX/meta-rules-dat' -or [string]$geodata.releaseTag -ne 'latest' -or [string]$geodata.releaseMetadataPolicy -ne 'informational-for-mutable-tag' -or [string]$geodata.releaseCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'GeoSite/GeoIP provenance or mutable-release metadata policy is invalid.'
}
foreach ($requiredText in @(
    "Bundled release: Mihomo $tag",
    "Bundled Windows asset: $asset",
    "Upstream archive SHA-256 (source archive): $digest",
    "Upstream extracted mihomo.exe SHA-256 (raw bundled binary): $binaryDigest",
    "GeoSite.dat SHA-256 (upstream data): $([string]$manifest.geodata.geoSite.upstreamSha256)",
    "GeoIP.dat SHA-256 (upstream data): $([string]$manifest.geodata.geoIp.upstreamSha256)",
    "Source archive: $([string]$manifest.sourceUrl)",
    "Release: $([string]$manifest.releaseUrl)",
    "Bundled GeoSite/GeoIP project: $([string]$geodata.project)",
    "Geodata release version: $([string]$geodata.releaseVersion)",
    'Geodata latest release metadata: informational only; SHA-256 values are the integrity pins.',
    "Geodata release commit: $([string]$geodata.releaseCommit)",
    "Geodata license: $([string]$geodata.license)",
    "Geodata release: $([string]$geodata.releaseUrl)",
    'GNU General Public License, version 3 (GPL-3.0)',
    'Distributed SHA-256 records',
    'Tauri updater .sig files'
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
