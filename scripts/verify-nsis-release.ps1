[CmdletBinding()]
param(
    [string]$BundleRoot = "",
    [switch]$RequireUpdaterMetadata
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$version = [string](Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$bundleRoot = if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
    (Resolve-Path (Join-Path $repoRoot "src-tauri\target\release\bundle")).Path
} else {
    (Resolve-Path $BundleRoot).Path
}
$tauriConfig = Get-Content -Raw (Join-Path $repoRoot "src-tauri\tauri.conf.json") | ConvertFrom-Json

$targets = @($tauriConfig.bundle.targets | ForEach-Object { [string]$_ })
if ($targets.Count -ne 1 -or $targets[0] -ne "nsis") {
    throw "V1 Windows packaging must configure exactly one Tauri target: nsis. Found: $($targets -join ', ')"
}
if ($null -ne $tauriConfig.bundle.windows.wix) {
    throw "V1 Windows packaging must not configure a WiX target."
}
if ($tauriConfig.bundle.createUpdaterArtifacts -ne $true) {
    throw "Tauri updater artifacts must remain enabled in the V1 packaging configuration."
}

$nsisDirectory = Join-Path $bundleRoot "nsis"
$nsis = @(Get-ChildItem -LiteralPath $nsisDirectory -File -Filter "MioProxy_${version}_x64-setup.exe" -ErrorAction SilentlyContinue)
if ($nsis.Count -ne 1) {
    throw "V1 Windows packaging must produce exactly one NSIS installer: MioProxy_${version}_x64-setup.exe"
}
if ($RequireUpdaterMetadata -and -not (Test-Path -LiteralPath "$($nsis[0].FullName).sig" -PathType Leaf)) {
    throw "The NSIS installer updater signature is missing: $($nsis[0].FullName).sig"
}

$msi = @(Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -Filter "*.msi" -ErrorAction SilentlyContinue)
if ($msi.Count -gt 0) {
    throw "MSI/WiX artifacts are not supported V1 Windows artifacts: $($msi.FullName -join ', ')"
}

if ($RequireUpdaterMetadata) {
    $latestPath = Join-Path $bundleRoot "latest.json"
    if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) {
        throw "Tauri updater metadata is missing: $latestPath"
    }
    $latest = Get-Content -Raw -LiteralPath $latestPath | ConvertFrom-Json
    $platforms = @($latest.platforms.psobject.Properties)
    if ($platforms.Count -eq 0) {
        throw "Tauri updater metadata contains no platforms."
    }
    $canonical = $platforms | Where-Object Name -eq "windows-x86_64" | Select-Object -First 1
    if (-not $canonical -or [string]$canonical.Value.url -notmatch "MioProxy_${version}_x64-setup\.exe$") {
        throw "windows-x86_64 updater metadata must point to the NSIS installer."
    }
    foreach ($platform in $platforms) {
        $url = [string]$platform.Value.url
        if ($url -match '\.msi($|\?)') {
            throw "Updater metadata must not reference MSI artifacts: $($platform.Name) -> $url"
        }
        if ($url -notmatch "MioProxy_${version}_x64-setup\.exe$") {
            throw "Updater metadata must reference the V1 NSIS installer: $($platform.Name) -> $url"
        }
        if ([string]::IsNullOrWhiteSpace([string]$platform.Value.signature)) {
            throw "Updater signature is missing for platform $($platform.Name)."
        }
    }
}

Write-Host "V1 Windows packaging policy verified: NSIS EXE only for MioProxy $version." -ForegroundColor Green
