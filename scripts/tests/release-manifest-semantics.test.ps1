$ErrorActionPreference = 'Stop'

$fixturePath = Join-Path $PSScriptRoot 'fixtures/release-manifest-updater-only.json'
$manifest = Get-Content -Raw -LiteralPath $fixturePath | ConvertFrom-Json

foreach ($property in @(
    'schemaVersion',
    'product',
    'version',
    'gitCommit',
    'mihomoProject',
    'mihomoVersion',
    'mihomoReleaseTag',
    'mihomoAsset',
    'mihomoAssetUrl',
    'mihomoSourceUrl',
    'mihomoReleaseUrl',
    'mihomoUpstreamArchiveSha256',
    'mihomoUpstreamBinarySha256',
    'hashPolicy',
    'executables'
)) {
    if ($null -eq $manifest.PSObject.Properties[$property]) {
        throw "Updater-only release manifest fixture is missing property: $property"
    }
}

if ([string]$manifest.hashPolicy.distributedSha256 -ne 'SHA-256 of the exact file shipped to users.') {
    throw 'Release manifest distributed SHA-256 policy is not explicit.'
}
if ([string]$manifest.hashPolicy.reproducibility -notmatch 'Deterministic and traceable inputs.*Tauri updater signatures') {
    throw 'Release manifest reproducibility policy does not identify Tauri updater signatures.'
}
if ([string]$manifest.hashPolicy.reproducibility -match 'Authenticode|RFC 3161') {
    throw 'Updater-only release manifest must not mention Authenticode or RFC 3161.'
}

$legacyNames = @('preAuthenticodeSha256', 'postAuthenticodeSha256', 'authenticodeStatus', 'signer', 'timestamped')
foreach ($property in $legacyNames) {
    if ($null -ne $manifest.PSObject.Properties[$property]) {
        throw "Updater-only release manifest contains obsolete Authenticode evidence: $property"
    }
}
foreach ($property in @($manifest.hashPolicy.PSObject.Properties.Name)) {
    if ($legacyNames -contains $property) {
        throw "Updater-only hash policy contains obsolete Authenticode evidence: $property"
    }
}

$expectedRoles = @('app', 'service', 'mihomo', 'installer')
foreach ($role in $expectedRoles) {
    if (@($manifest.executables | Where-Object { $_.role -eq $role }).Count -ne 1) {
        throw "Updater-only release manifest fixture must contain exactly one $role entry."
    }
}

foreach ($item in $manifest.executables) {
    foreach ($property in @('role', 'path', 'length', 'distributedSha256')) {
        if ($null -eq $item.PSObject.Properties[$property]) {
            throw "Release manifest executable entry is missing property: $property"
        }
    }
    foreach ($property in $legacyNames) {
        if ($null -ne $item.PSObject.Properties[$property]) {
            throw "Release manifest executable entry contains obsolete Authenticode evidence: $property"
        }
    }
    if ([string]$item.path -notmatch '^[^/].*(?<!/)$' -or [string]$item.path -match '(^|/)\.\.(?:/|$)') {
        throw "Release manifest executable path is not a safe relative path: $($item.path)"
    }
    if ([int64]$item.length -lt 0) {
        throw "Release manifest executable length is negative: $($item.path)"
    }
    if ([string]$item.distributedSha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Release manifest executable distributed SHA-256 is malformed: $($item.path)"
    }
}

$mihomo = $manifest.executables | Where-Object { $_.role -eq 'mihomo' } | Select-Object -First 1
if ([string]$mihomo.distributedSha256 -ne [string]$manifest.mihomoUpstreamBinarySha256) {
    throw 'Mihomo distributed SHA-256 must equal the pinned raw upstream binary SHA-256.'
}

Write-Host 'Updater-only release manifest semantics are explicit and deterministic.' -ForegroundColor Green
