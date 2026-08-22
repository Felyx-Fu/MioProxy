[CmdletBinding()]
param(
    [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"

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

function Has-Property {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    return $null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "release-artifact-paths.ps1")
$version = [string](Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$bundleRoot = Join-Path $repoRoot "src-tauri\target\release\bundle"
$manifestPath = if ([string]::IsNullOrWhiteSpace($ManifestPath)) { Join-Path $bundleRoot "MioProxy-$version-release-manifest.json" } else { $ManifestPath }
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Release executable manifest is missing: $manifestPath"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$sidecarManifest = Get-Content -Raw (Join-Path $repoRoot "config\mihomo-release.json") | ConvertFrom-Json

foreach ($property in @('schemaVersion', 'product', 'version', 'gitCommit', 'mihomoProject', 'mihomoVersion', 'mihomoReleaseTag', 'mihomoAsset', 'mihomoAssetUrl', 'mihomoSourceUrl', 'mihomoReleaseUrl', 'mihomoUpstreamArchiveSha256', 'mihomoUpstreamBinarySha256', 'hashPolicy', 'executables')) {
    if (-not (Has-Property $manifest $property)) {
        throw "Release executable manifest is missing required property: $property"
    }
}
if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne "MioProxy" -or $manifest.version -ne $version) {
    throw "Release executable manifest metadata is inconsistent."
}
if ([string]$manifest.gitCommit -notmatch '^[0-9a-f]{40}$') {
    throw "Release executable manifest gitCommit must be a full lowercase commit SHA-1."
}

$provenance = [ordered]@{
    mihomoProject = [string]$sidecarManifest.project
    mihomoVersion = [string]$sidecarManifest.version
    mihomoReleaseTag = [string]$sidecarManifest.tag
    mihomoAsset = [string]$sidecarManifest.asset
    mihomoAssetUrl = [string]$sidecarManifest.assetUrl
    mihomoSourceUrl = [string]$sidecarManifest.sourceUrl
    mihomoReleaseUrl = [string]$sidecarManifest.releaseUrl
    mihomoUpstreamArchiveSha256 = ([string]$sidecarManifest.upstreamArchiveSha256).ToLowerInvariant()
    mihomoUpstreamBinarySha256 = ([string]$sidecarManifest.upstreamBinarySha256).ToLowerInvariant()
}
foreach ($property in $provenance.Keys) {
    if ([string]$manifest.$property -ne [string]$provenance[$property]) {
        throw "Release manifest Mihomo provenance does not match config/mihomo-release.json: $property"
    }
}

if (-not (Has-Property $manifest.hashPolicy 'distributedSha256') -or
    [string]$manifest.hashPolicy.distributedSha256 -ne "SHA-256 of the exact file shipped to users.") {
    throw "Release manifest hashPolicy must describe distributed SHA-256 values."
}
if (-not (Has-Property $manifest.hashPolicy 'reproducibility') -or
    [string]$manifest.hashPolicy.reproducibility -notmatch 'Deterministic and traceable inputs.*Tauri updater signatures') {
    throw "Release manifest must describe deterministic inputs and Tauri updater signatures."
}
if ([string]$manifest.hashPolicy.reproducibility -match 'Authenticode|RFC 3161') {
    throw "Release manifest must not claim Authenticode signing or RFC 3161 timestamps."
}
$legacyNames = @('preAuthenticodeSha256', 'postAuthenticodeSha256', 'authenticodeStatus', 'signer', 'timestamped')
foreach ($property in $legacyNames) {
    if (Has-Property $manifest $property) {
        throw "Release manifest contains obsolete Authenticode evidence: $property"
    }
}
foreach ($property in @($manifest.hashPolicy.PSObject.Properties.Name)) {
    if ($legacyNames -contains $property) {
        throw "Release manifest contains obsolete Authenticode evidence: $property"
    }
}

if (@($manifest.executables).Count -lt 4) {
    throw "Release executable manifest must include MioProxy, Service, Mihomo, and the final installer."
}

$requiredRoles = Get-ReleaseExecutableRelativePaths
foreach ($role in $requiredRoles.Keys) {
    if (@($manifest.executables | Where-Object { $_.path -eq $requiredRoles[$role] -and $_.role -eq $role }).Count -ne 1) {
        throw "Release executable manifest is missing the required $role executable."
    }
}
if (@($manifest.executables | Where-Object { $_.path -match '/bundle/nsis/MioProxy_' -and $_.path -match '_x64-setup\.exe$' -and $_.role -eq 'installer' }).Count -lt 1) {
    throw "Release executable manifest is missing the final NSIS installer."
}

foreach ($item in $manifest.executables) {
    foreach ($property in @('path', 'role', 'length', 'distributedSha256')) {
        if (-not (Has-Property $item $property)) {
            throw "Release executable manifest entry is missing required property: $property"
        }
    }
    $itemProperties = @($item.PSObject.Properties.Name)
    foreach ($property in $legacyNames) {
        if ($itemProperties -contains $property) {
            throw "Release executable manifest entry contains obsolete Authenticode evidence: $property"
        }
    }
    $relativePath = [string]$item.path
    if ([string]::IsNullOrWhiteSpace($relativePath) -or
        $relativePath -match '(^/|^[A-Za-z]:|(^|/)\.\.(?:/|$))') {
        throw "Release executable manifest path is not a safe repository-relative path: $relativePath"
    }
    $path = Join-Path $repoRoot ($relativePath -replace '/', '\')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Manifest executable is missing: $path"
    }
    $expectedLength = 0L
    if (-not [long]::TryParse([string]$item.length, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$expectedLength) -or $expectedLength -lt 0) {
        throw "Release executable length is invalid for $relativePath."
    }
    $file = Get-Item -LiteralPath $path
    if ([int64]$file.Length -ne $expectedLength) {
        throw "Release executable length changed after the manifest was written: $path"
    }
    $expectedHash = ([string]$item.distributedSha256).ToLowerInvariant()
    if ($expectedHash -notmatch '^[0-9a-f]{64}$') {
        throw "Release executable distributedSha256 is invalid for $path."
    }
    $actualHash = Get-Sha256 -Path $path
    if ($actualHash -ne $expectedHash) {
        throw "SHA-256 changed after the release manifest was written: $path"
    }
    if ([string]$item.role -eq 'mihomo' -and $actualHash -ne $provenance.mihomoUpstreamBinarySha256) {
        throw "The bundled raw Mihomo binary does not match its pinned upstream SHA-256."
    }
    Write-Host ("Verified {0} | distributed SHA-256 {1}" -f $item.path, $item.distributedSha256) -ForegroundColor Green
}

Write-Host "Windows x86_64 NSIS hash and provenance verification passed for MioProxy $version; Tauri updater signatures remain verified by the NSIS/updater metadata gate." -ForegroundColor Green
