[CmdletBinding()]
param(
    [string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Read-CargoVersion([string]$Path) {
    $match = [regex]::Match((Get-Content -LiteralPath $Path -Raw), '(?m)^version\s*=\s*"([^"]+)"\s*$')
    if (-not $match.Success) { throw "Cargo package version is missing: $Path" }
    return $match.Groups[1].Value
}

function Read-LockedCargoVersion([string]$Path) {
    $match = [regex]::Match((Get-Content -LiteralPath $Path -Raw), '(?ms)\[\[package\]\]\s*name\s*=\s*"mioproxy"\s*version\s*=\s*"([^"]+)"')
    if (-not $match.Success) { throw "Locked MioProxy package version is missing: $Path" }
    return $match.Groups[1].Value
}

$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$packageLockText = Get-Content -LiteralPath (Join-Path $root "package-lock.json") -Raw
$packageLockVersionMatch = [regex]::Match($packageLockText, '(?m)^\s*"version"\s*:\s*"([^"]+)"\s*,')
if (-not $packageLockVersionMatch.Success) { throw "Locked npm package version is missing." }
$tauri = Get-Content -LiteralPath (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$versions = [ordered]@{
    package = [string]$package.version
    packageLock = $packageLockVersionMatch.Groups[1].Value
    tauri = [string]$tauri.version
    cargo = Read-CargoVersion (Join-Path $root "src-tauri\Cargo.toml")
    cargoLock = Read-LockedCargoVersion (Join-Path $root "src-tauri\Cargo.lock")
}

if ($versions.Values | Where-Object { [string]::IsNullOrWhiteSpace($_) }) {
    throw "One or more release versions are empty: $($versions | ConvertTo-Json -Compress)"
}

$uniqueVersions = @($versions.Values | Select-Object -Unique)
if ($uniqueVersions.Count -ne 1) {
    throw "Release version mismatch: $($versions | ConvertTo-Json -Compress)"
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and $uniqueVersions[0] -ne $ExpectedVersion) {
    throw "Expected release version $ExpectedVersion does not match: $($versions | ConvertTo-Json -Compress)"
}

Write-Host "Release versions consistent: $($uniqueVersions[0])"
Write-Host ($versions | ConvertTo-Json -Compress)
