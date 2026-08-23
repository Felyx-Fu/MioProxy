$ErrorActionPreference = "Stop"

$releasePolicyPath = Join-Path $PSScriptRoot "mihomo-release-policy.ps1"
if (-not (Test-Path -LiteralPath $releasePolicyPath)) {
    throw "Mihomo release policy helper is missing: $releasePolicyPath"
}
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
$manifestSha256 = ([string]$manifest.upstreamArchiveSha256).ToLowerInvariant()
$binarySha256 = ([string]$manifest.upstreamBinarySha256).ToLowerInvariant()
$geodataProject = [string]$manifest.geodata.project
$geodataSourceRepository = [string]$manifest.geodata.sourceRepository
$geodataReleaseTag = [string]$manifest.geodata.releaseTag
$geodataReleaseMetadataPolicy = [string]$manifest.geodata.releaseMetadataPolicy
$geodataReleaseVersion = [string]$manifest.geodata.releaseVersion
$geodataReleaseCommit = ([string]$manifest.geodata.releaseCommit).ToLowerInvariant()
$geodataReleasePublishedAt = [string]$manifest.geodata.releasePublishedAt
$geodataReleaseUrl = [string]$manifest.geodata.releaseUrl
$geodataLicense = [string]$manifest.geodata.license
$geodataLicenseUrl = [string]$manifest.geodata.licenseUrl
$geodata = @(
    [pscustomobject]@{ Key = 'geoSite'; File = [string]$manifest.geodata.geoSite.file; Path = Join-Path $outDir ([string]$manifest.geodata.geoSite.file); Url = [string]$manifest.geodata.geoSite.url; ChecksumUrl = [string]$manifest.geodata.geoSite.checksumUrl; UpstreamSha256 = ([string]$manifest.geodata.geoSite.upstreamSha256).ToLowerInvariant() },
    [pscustomobject]@{ Key = 'geoIp'; File = [string]$manifest.geodata.geoIp.file; Path = Join-Path $outDir ([string]$manifest.geodata.geoIp.file); Url = [string]$manifest.geodata.geoIp.url; ChecksumUrl = [string]$manifest.geodata.geoIp.checksumUrl; UpstreamSha256 = ([string]$manifest.geodata.geoIp.upstreamSha256).ToLowerInvariant() }
)

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
if ($manifestSha256 -notmatch '^[0-9a-f]{64}$' -or $binarySha256 -notmatch '^[0-9a-f]{64}$') { throw "Mihomo release manifest must contain valid archive and extracted-binary SHA-256 digests." }
if ($geodataProject -ne 'MetaCubeX/meta-rules-dat' -or $geodataSourceRepository -ne 'https://github.com/MetaCubeX/meta-rules-dat') {
    throw "Unexpected GeoSite/GeoIP project or source repository in release manifest."
}
if ([string]::IsNullOrWhiteSpace($geodataReleaseTag) -or $geodataReleaseMetadataPolicy -ne 'informational-for-mutable-tag' -or [string]::IsNullOrWhiteSpace($geodataReleaseVersion) -or $geodataReleaseCommit -notmatch '^[0-9a-f]{40}$' -or [string]::IsNullOrWhiteSpace($geodataReleasePublishedAt)) {
    throw "GeoSite/GeoIP release tag and informational metadata snapshot are invalid."
}
try {
    [DateTimeOffset]::Parse($geodataReleasePublishedAt) | Out-Null
}
catch {
    throw "GeoSite/GeoIP releasePublishedAt must be a valid timestamp."
}
if ($geodataReleaseUrl -ne "https://github.com/$geodataProject/releases/tag/$geodataReleaseTag") {
    throw "GeoSite/GeoIP release URL is inconsistent with the pinned project and tag."
}
if ($geodataLicense -ne 'GNU General Public License, version 3 (GPL-3.0)' -or $geodataLicenseUrl -notmatch '^https://') {
    throw "GeoSite/GeoIP license metadata is missing or unexpected."
}
foreach ($item in $geodata) {
    $expectedGeoUrl = "https://github.com/$geodataProject/releases/download/$geodataReleaseTag/$($item.File.ToLowerInvariant())"
    $expectedChecksumUrl = "$expectedGeoUrl.sha256sum"
    if ($item.File -notmatch '^(GeoSite|GeoIP)\.dat$' -or $item.Url -ne $expectedGeoUrl -or $item.ChecksumUrl -ne $expectedChecksumUrl) {
        throw "Invalid pinned geodata manifest entry: $($item.Key)."
    }
    if ($item.UpstreamSha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Pinned geodata entry $($item.Key) must contain a 64-character SHA-256 digest."
    }
}
Assert-VendoredGeodata -Items $geodata
Write-Host "Verified repository-pinned GeoSite.dat and GeoIP.dat; normal setup will not refresh mutable upstream geodata." -ForegroundColor Green

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
    Assert-PinnedSha256 -Expected $manifestSha256 -Actual $upstreamDigest.Substring(7) -Artifact "Mihomo $tag archive"

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
    Assert-PinnedSha256 -Expected $manifestSha256 -Actual $actualDigest -Artifact $assetName
    Write-Host "SHA-256 verified: $manifestSha256" -ForegroundColor Green

    Write-Host "[3/4] Extracting..." -ForegroundColor Cyan
    Expand-Archive -Path $zipFile -DestinationPath $tempDir -Force
    $exe = Get-ChildItem -Path $tempDir -Filter "mihomo*.exe" -Recurse | Select-Object -First 1
    if (-not $exe) { throw "Downloaded archive did not contain mihomo.exe." }
    $actualBinaryDigest = Get-Sha256 -Path $exe.FullName
    Assert-PinnedSha256 -Expected $binarySha256 -Actual $actualBinaryDigest -Artifact "extracted Mihomo executable"
    Copy-Item $exe.FullName $outFile -Force

    Write-Host "[4/4] Ready: $outFile and repository-pinned geodata resources" -ForegroundColor Green
    Write-Host "Mihomo version: $tag" -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
}
