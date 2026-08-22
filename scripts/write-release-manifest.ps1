[CmdletBinding()]
param(
    [string]$BundleRoot = "",
    [string]$ManifestPath = "",
    [string]$Sha256Path = ""
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
$bundleRoot = if ([string]::IsNullOrWhiteSpace($BundleRoot)) { Join-Path $repoRoot "src-tauri\target\release\bundle" } else { (Resolve-Path $BundleRoot).Path }
$version = [string](Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$manifestPath = if ([string]::IsNullOrWhiteSpace($ManifestPath)) { Join-Path $bundleRoot "MioProxy-$version-release-manifest.json" } else { $ManifestPath }
$sha256Path = if ([string]::IsNullOrWhiteSpace($Sha256Path)) { Join-Path $bundleRoot "MioProxy-$version-SHA256SUMS.txt" } else { $Sha256Path }

$releaseExecutablePaths = Get-ReleaseExecutablePaths -RepoRoot $repoRoot
$roleByPath = @{}
foreach ($role in $releaseExecutablePaths.Keys) {
    $roleByPath[(Resolve-Path $releaseExecutablePaths[$role]).Path] = $role
}

$paths = @($releaseExecutablePaths.Values)
$paths += Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -Filter "MioProxy_${version}_*.exe" -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName
$paths = $paths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Sort-Object -Unique
if ($paths.Count -eq 0) {
    throw "No shipped Windows executables were found for MioProxy $version."
}

$sidecarManifest = Get-Content -Raw (Join-Path $repoRoot "config\mihomo-release.json") | ConvertFrom-Json
$mihomoUpstreamBinaryHash = ([string]$sidecarManifest.upstreamBinarySha256).ToLowerInvariant()
if ($mihomoUpstreamBinaryHash -notmatch '^[0-9a-f]{64}$') {
    throw "The pinned Mihomo upstream binary SHA-256 is missing or malformed."
}

$items = foreach ($path in $paths) {
    $file = Get-Item -LiteralPath $path
    $resolvedPath = $file.FullName
    $distributedHash = Get-Sha256 -Path $path
    $role = if ($roleByPath.ContainsKey($resolvedPath)) { $roleByPath[$resolvedPath] } else { 'installer' }
    if ($role -eq 'mihomo' -and $distributedHash -ne $mihomoUpstreamBinaryHash) {
        throw "The bundled raw Mihomo binary hash does not match config/mihomo-release.json."
    }
    [pscustomobject]@{
        path = $path.Substring($repoRoot.Length).TrimStart('\', '/') -replace '\\', '/'
        role = $role
        length = [int64]$file.Length
        distributedSha256 = $distributedHash
    }
}

$commit = (& git -C $repoRoot rev-parse HEAD).Trim()
$document = [ordered]@{
    schemaVersion = 1
    product = "MioProxy"
    version = $version
    gitCommit = $commit
    mihomoProject = [string]$sidecarManifest.project
    mihomoVersion = [string]$sidecarManifest.version
    mihomoReleaseTag = [string]$sidecarManifest.tag
    mihomoAsset = [string]$sidecarManifest.asset
    mihomoAssetUrl = [string]$sidecarManifest.assetUrl
    mihomoSourceUrl = [string]$sidecarManifest.sourceUrl
    mihomoReleaseUrl = [string]$sidecarManifest.releaseUrl
    mihomoUpstreamArchiveSha256 = ([string]$sidecarManifest.upstreamArchiveSha256).ToLowerInvariant()
    mihomoUpstreamBinarySha256 = $mihomoUpstreamBinaryHash
    hashPolicy = [ordered]@{
        distributedSha256 = "SHA-256 of the exact file shipped to users."
        reproducibility = "Deterministic and traceable inputs; final artifacts are verified by SHA-256 and Tauri updater signatures."
    }
    executables = @($items)
}
$json = $document | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

$sumLines = $items | Sort-Object path | ForEach-Object { "$($_.distributedSha256)  $($_.path)" }
[System.IO.File]::WriteAllLines($sha256Path, [string[]]$sumLines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Release executable manifest: $manifestPath" -ForegroundColor Green
Write-Host "Release SHA-256 record: $sha256Path" -ForegroundColor Green
