$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$manifestPath = Join-Path $repoRoot "config\mihomo-release.json"
$outDir = Join-Path $repoRoot "src-tauri\binaries"
$outFile = Join-Path $outDir "mihomo-x86_64-pc-windows-msvc.exe"

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Pinned Mihomo release manifest is missing: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$project = [string]$manifest.project
$tag = [string]$manifest.tag
$version = [string]$manifest.version
$assetName = [string]$manifest.asset
$assetUrl = [string]$manifest.assetUrl
$manifestSha256 = ([string]$manifest.sha256).ToLowerInvariant()

if ([int]$manifest.schemaVersion -ne 1) { throw "Unsupported Mihomo release manifest schema." }
if ($project -ne 'MetaCubeX/mihomo') { throw "Unexpected Mihomo project in release manifest: $project" }
if ($tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$' -or $version -ne $tag.Substring(1)) {
    throw "Mihomo release manifest tag/version are inconsistent."
}
if ([string]::IsNullOrWhiteSpace($assetName) -or $assetName -notmatch '^mihomo-windows-amd64-(compatible-)?v[0-9]+\.[0-9]+\.[0-9]+\.zip$') {
    throw "Mihomo release manifest has an invalid Windows asset name."
}
$expectedAssetUrl = "https://github.com/$project/releases/download/$tag/$assetName"
if ($assetUrl -ne $expectedAssetUrl) { throw "Mihomo release manifest asset URL is inconsistent with its pinned tag and asset." }
if ($manifestSha256 -notmatch '^[0-9a-f]{64}$') { throw "Mihomo release manifest must contain a 64-character SHA-256 digest." }

$tempDir = Join-Path $env:TEMP ("mioproxy-mihomo-" + [guid]::NewGuid().ToString("N"))
$zipFile = Join-Path $tempDir "mihomo.zip"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
    Write-Host "[1/4] Resolving pinned Mihomo release $tag..." -ForegroundColor Cyan
    $githubHeaders = @{ "User-Agent" = "MioProxy-Setup" }
    $githubToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN }
    if (-not $githubToken -and (Get-Command gh -ErrorAction SilentlyContinue)) {
        try {
            $githubToken = (& gh auth token 2>$null | Select-Object -First 1)
        }
        catch {
            $githubToken = $null
        }
    }
    if ($githubToken) {
        $githubHeaders["Authorization"] = "Bearer $($githubToken.Trim())"
    }

    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$project/releases/tags/$tag" -Headers $githubHeaders
    if ([string]$release.tag_name -ne $tag) { throw "Upstream release tag does not match the pinned tag $tag." }
    $asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
    if (-not $asset) { throw "Pinned Windows amd64 Mihomo asset was not found in release $($tag): $assetName" }
    if ([string]$asset.browser_download_url -ne $assetUrl) { throw "Upstream asset URL does not match the pinned release manifest." }
    $upstreamDigest = ([string]$asset.digest).ToLowerInvariant()
    if ($upstreamDigest -notmatch '^sha256:[0-9a-f]{64}$') {
        throw "Upstream release asset $assetName did not provide a valid SHA-256 digest."
    }
    if ($upstreamDigest.Substring(7) -ne $manifestSha256) {
        throw "Pinned Mihomo manifest digest does not match the upstream release digest."
    }

    Write-Host "[2/4] Downloading $assetName..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $assetUrl -OutFile $zipFile -UseBasicParsing
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $zipStream = [System.IO.File]::OpenRead($zipFile)
    try {
        $actualDigest = ([BitConverter]::ToString($sha256.ComputeHash($zipStream)) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $zipStream.Dispose()
        $sha256.Dispose()
    }
    if ($actualDigest -ne $manifestSha256) {
        throw "SHA-256 verification failed for $assetName."
    }
    Write-Host "SHA-256 verified: $manifestSha256" -ForegroundColor Green

    Write-Host "[3/4] Extracting..." -ForegroundColor Cyan
    Expand-Archive -Path $zipFile -DestinationPath $tempDir -Force
    $exe = Get-ChildItem -Path $tempDir -Filter "mihomo*.exe" -Recurse | Select-Object -First 1
    if (-not $exe) { throw "Downloaded archive did not contain mihomo.exe." }
    Copy-Item $exe.FullName $outFile -Force

    Write-Host "[4/4] Ready: $outFile" -ForegroundColor Green
    Write-Host "Mihomo version: $tag" -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
}
