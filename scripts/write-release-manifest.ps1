[CmdletBinding()]
param(
    [string]$BundleRoot = "",
    [string]$ManifestPath = "",
    [string]$Sha256Path = "",
    [string]$AuthenticodeRecordPath = ""
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
$bundleRoot = if ([string]::IsNullOrWhiteSpace($BundleRoot)) { Join-Path $repoRoot "src-tauri\target\release\bundle" } else { (Resolve-Path $BundleRoot).Path }
$version = [string](Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$manifestPath = if ([string]::IsNullOrWhiteSpace($ManifestPath)) { Join-Path $bundleRoot "MioProxy-$version-release-manifest.json" } else { $ManifestPath }
$sha256Path = if ([string]::IsNullOrWhiteSpace($Sha256Path)) { Join-Path $bundleRoot "MioProxy-$version-SHA256SUMS.txt" } else { $Sha256Path }
$authenticodeRecordPath = if ([string]::IsNullOrWhiteSpace($AuthenticodeRecordPath)) { $env:MIOPROXY_AUTHENTICODE_RECORD_PATH } else { $AuthenticodeRecordPath }

$hashRecords = @{}
if (-not [string]::IsNullOrWhiteSpace($authenticodeRecordPath) -and (Test-Path -LiteralPath $authenticodeRecordPath -PathType Leaf)) {
    foreach ($line in Get-Content -LiteralPath $authenticodeRecordPath) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $record = $line | ConvertFrom-Json
        $recordPath = (Resolve-Path -LiteralPath ([string]$record.path)).Path
        if (-not $hashRecords.ContainsKey($recordPath)) {
            $hashRecords[$recordPath] = @{}
        }
        $hashRecords[$recordPath][[string]$record.phase] = ([string]$record.sha256).ToLowerInvariant()
    }
}

$roleByPath = @{}
$roleByPath[(Resolve-Path (Join-Path $repoRoot "src-tauri\target\release\mioproxy.exe")).Path] = "app"
$roleByPath[(Resolve-Path (Join-Path $repoRoot "src-tauri\binaries\mioproxy-service-x86_64-pc-windows-msvc.exe")).Path] = "service"
$roleByPath[(Resolve-Path (Join-Path $repoRoot "src-tauri\binaries\mihomo-x86_64-pc-windows-msvc.exe")).Path] = "mihomo"

$paths = @(
    (Join-Path $repoRoot "src-tauri\target\release\mioproxy.exe"),
    (Join-Path $repoRoot "src-tauri\binaries\mioproxy-service-x86_64-pc-windows-msvc.exe"),
    (Join-Path $repoRoot "src-tauri\binaries\mihomo-x86_64-pc-windows-msvc.exe")
)
$paths += Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -Filter "MioProxy_${version}_*.exe" -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName
$paths = $paths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Sort-Object -Unique
if ($paths.Count -eq 0) {
    throw "No shipped Windows executables were found for MioProxy $version."
}

$items = foreach ($path in $paths) {
    $file = Get-Item -LiteralPath $path
    $resolvedPath = $file.FullName
    $distributedHash = Get-Sha256 -Path $path
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    $record = if ($hashRecords.ContainsKey($resolvedPath)) { $hashRecords[$resolvedPath] } else { $null }
    $preAuthenticodeHash = if ($null -ne $record -and $record.ContainsKey('preAuthenticode')) {
        $record['preAuthenticode']
    } elseif ($signature.Status -eq 'NotSigned') {
        $distributedHash
    } else {
        $null
    }
    $postAuthenticodeHash = if ($null -ne $record -and $record.ContainsKey('postAuthenticode')) {
        $record['postAuthenticode']
    } elseif ($signature.Status -eq 'Valid') {
        $distributedHash
    } else {
        $null
    }
    [pscustomobject]@{
        path = $path.Substring($repoRoot.Length).TrimStart('\', '/') -replace '\\', '/'
        role = if ($roleByPath.ContainsKey($resolvedPath)) { $roleByPath[$resolvedPath] } else { 'installer' }
        length = [int64]$file.Length
        preAuthenticodeSha256 = $preAuthenticodeHash
        postAuthenticodeSha256 = $postAuthenticodeHash
        distributedSha256 = $distributedHash
        authenticodeStatus = [string]$signature.Status
        signer = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
        timestamped = $null -ne $signature.TimeStamperCertificate
    }
}

$commit = (& git -C $repoRoot rev-parse HEAD).Trim()
$sidecarManifest = Get-Content -Raw (Join-Path $repoRoot "config\mihomo-release.json") | ConvertFrom-Json
$document = [ordered]@{
    schemaVersion = 1
    product = "MioProxy"
    version = $version
    gitCommit = $commit
    mihomoVersion = [string]$sidecarManifest.version
    mihomoUpstreamArchiveSha256 = ([string]$sidecarManifest.upstreamArchiveSha256).ToLowerInvariant()
    mihomoUpstreamBinarySha256 = ([string]$sidecarManifest.upstreamBinarySha256).ToLowerInvariant()
    hashPolicy = [ordered]@{
        preAuthenticodeSha256 = "Hash of a PE before Authenticode signing."
        postAuthenticodeSha256 = "Hash of the final signed PE after Authenticode and RFC 3161 timestamping."
        distributedSha256 = "The postAuthenticodeSha256 hash used for the shipped artifact."
        reproducibility = "Deterministic and traceable inputs with verifiable signed outputs; RFC 3161 timestamps make signed bytes time-dependent."
    }
    executables = @($items)
}
$json = $document | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

$sumLines = $items | Sort-Object path | ForEach-Object { "$($_.distributedSha256)  $($_.path)" }
[System.IO.File]::WriteAllLines($sha256Path, [string[]]$sumLines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Release executable manifest: $manifestPath" -ForegroundColor Green
Write-Host "Release SHA-256 record: $sha256Path" -ForegroundColor Green
