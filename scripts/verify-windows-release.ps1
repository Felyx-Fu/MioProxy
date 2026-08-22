[CmdletBinding()]
param(
    [string]$ManifestPath = "",
    [string]$ExpectedSignerThumbprint = "",
    [string]$ExpectedSignerSubject = ""
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

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "release-artifact-paths.ps1")
$expectedThumbprint = ($ExpectedSignerThumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
if ([string]::IsNullOrWhiteSpace($expectedThumbprint)) {
    $expectedThumbprint = (($env:MIOPROXY_EXPECTED_AUTHENTICODE_SIGNER_THUMBPRINT -replace '[^0-9A-Fa-f]', '').ToUpperInvariant())
}
if ($expectedThumbprint -notmatch '^[0-9A-F]{40}$') {
    throw "Expected Authenticode signer thumbprint must be supplied as a 40-hex-character release configuration value."
}
$expectedSubject = if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
    [string]$env:MIOPROXY_EXPECTED_AUTHENTICODE_SIGNER_SUBJECT
} else {
    $ExpectedSignerSubject
}
$version = [string](Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$bundleRoot = Join-Path $repoRoot "src-tauri\target\release\bundle"
$manifestPath = if ([string]::IsNullOrWhiteSpace($ManifestPath)) { Join-Path $bundleRoot "MioProxy-$version-release-manifest.json" } else { $ManifestPath }
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Release executable manifest is missing: $manifestPath"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne "MioProxy" -or $manifest.version -ne $version) {
    throw "Release executable manifest metadata is inconsistent."
}
$sidecarManifest = Get-Content -Raw (Join-Path $repoRoot "config\mihomo-release.json") | ConvertFrom-Json
if ([string]$manifest.mihomoUpstreamArchiveSha256 -ne ([string]$sidecarManifest.upstreamArchiveSha256).ToLowerInvariant() -or
    [string]$manifest.mihomoUpstreamBinarySha256 -ne ([string]$sidecarManifest.upstreamBinarySha256).ToLowerInvariant()) {
    throw "Release manifest Mihomo upstream hashes do not match config/mihomo-release.json."
}
if ([string]$manifest.hashPolicy.reproducibility -notmatch 'Deterministic and traceable inputs.*RFC 3161') {
    throw "Release manifest must describe deterministic/traceable inputs and time-dependent RFC 3161 signed outputs."
}
if (@($manifest.executables).Count -lt 4) {
    throw "Release executable manifest must include MioProxy, Service, Mihomo, and the final installer."
}

$requiredRoles = Get-ReleaseExecutableRelativePaths
foreach ($role in $requiredRoles.Keys) {
    if (@($manifest.executables | Where-Object { $_.path -eq $requiredRoles[$role] }).Count -ne 1) {
        throw "Release executable manifest is missing the required $role executable."
    }
}
if (@($manifest.executables | Where-Object { $_.path -match '/bundle/nsis/MioProxy_' -and $_.path -match '_x64-setup\.exe$' }).Count -lt 1) {
    throw "Release executable manifest is missing the final NSIS installer."
}

foreach ($item in $manifest.executables) {
    $path = Join-Path $repoRoot ([string]$item.path -replace '/', '\')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Manifest executable is missing: $path"
    }
    $actualHash = Get-Sha256 -Path $path
    if ([string]::IsNullOrWhiteSpace([string]$item.preAuthenticodeSha256) -or
        [string]::IsNullOrWhiteSpace([string]$item.postAuthenticodeSha256) -or
        [string]::IsNullOrWhiteSpace([string]$item.distributedSha256)) {
        throw "Release manifest must record pre-Authenticode, post-Authenticode, and distributed hashes for $path."
    }
    if ([string]$item.postAuthenticodeSha256 -ne [string]$item.distributedSha256) {
        throw "Release manifest post-Authenticode and distributed hashes differ for $path."
    }
    if ($actualHash -ne ([string]$item.distributedSha256).ToLowerInvariant()) {
        throw "SHA-256 changed after the release manifest was written: $path"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) {
        throw "Authenticode verification failed for $path (status=$($signature.Status))."
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "Authenticode timestamp is missing for $path."
    }
    $actualThumbprint = ([string]$signature.SignerCertificate.Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    if ($actualThumbprint -ne $expectedThumbprint) {
        throw "Authenticode signer thumbprint mismatch for $path (expected=$expectedThumbprint, actual=$actualThumbprint)."
    }
    if (-not [string]::IsNullOrWhiteSpace($expectedSubject) -and [string]$signature.SignerCertificate.Subject -ne $expectedSubject) {
        throw "Authenticode signer subject mismatch for $path (expected=$expectedSubject, actual=$($signature.SignerCertificate.Subject))."
    }
    if ([string]$item.role -eq 'mihomo' -and ([string]$item.preAuthenticodeSha256).ToLowerInvariant() -ne ([string]$sidecarManifest.upstreamBinarySha256).ToLowerInvariant()) {
        throw "Mihomo pre-Authenticode hash does not match the pinned upstream extracted binary hash."
    }
    Write-Host ("Verified {0} | pre-Authenticode {1} | distributed/post-Authenticode {2} | signer {3} ({4}) | timestamped" -f $item.path, $item.preAuthenticodeSha256, $item.distributedSha256, $signature.SignerCertificate.Subject, $actualThumbprint) -ForegroundColor Green
}

Write-Host "Windows release verification passed for MioProxy $version." -ForegroundColor Green
