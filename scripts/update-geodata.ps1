[CmdletBinding()]
param(
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$policyPath = Join-Path $PSScriptRoot 'mihomo-release-policy.ps1'
if (-not (Test-Path -LiteralPath $policyPath)) {
    throw "Mihomo release policy helper is missing: $policyPath"
}
. $policyPath

$manifestPath = Join-Path $repoRoot 'config\mihomo-release.json'
$noticePath = Join-Path $repoRoot 'src-tauri\binaries\THIRD_PARTY_NOTICES.txt'
$thirdPartyPath = Join-Path $repoRoot 'THIRD_PARTY.md'
$binaryDirectory = Join-Path $repoRoot 'src-tauri\binaries'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$geodata = @(
    [pscustomobject]@{ Key = 'geoSite'; File = [string]$manifest.geodata.geoSite.file; Path = Join-Path $binaryDirectory ([string]$manifest.geodata.geoSite.file); Url = [string]$manifest.geodata.geoSite.url; ChecksumUrl = [string]$manifest.geodata.geoSite.checksumUrl; UpstreamSha256 = ([string]$manifest.geodata.geoSite.upstreamSha256).ToLowerInvariant() },
    [pscustomobject]@{ Key = 'geoIp'; File = [string]$manifest.geodata.geoIp.file; Path = Join-Path $binaryDirectory ([string]$manifest.geodata.geoIp.file); Url = [string]$manifest.geodata.geoIp.url; ChecksumUrl = [string]$manifest.geodata.geoIp.checksumUrl; UpstreamSha256 = ([string]$manifest.geodata.geoIp.upstreamSha256).ToLowerInvariant() }
)

if ([string]$manifest.geodata.project -ne 'MetaCubeX/meta-rules-dat' -or [string]$manifest.geodata.releaseTag -ne 'latest') {
    throw 'Explicit geodata maintenance currently supports only MetaCubeX/meta-rules-dat latest.'
}

function Get-GitHubHeaders {
    $headers = @{ 'User-Agent' = 'MioProxy-Geodata-Maintenance' }
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
        $headers['Authorization'] = "Bearer $($githubToken.Trim())"
    }
    return $headers
}

function Get-ChecksumDigest {
    param(
        [string]$Content,
        [string]$ExpectedFile
    )

    $line = @($Content -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
    if ($line.Count -ne 1) {
        throw "Checksum file is empty: $ExpectedFile"
    }
    $match = [regex]::Match([string]$line[0], '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$')
    if (-not $match.Success) {
        throw "Checksum file does not contain a valid SHA-256 record: $ExpectedFile"
    }
    $reportedFile = [IO.Path]::GetFileName($match.Groups[2].Value.Trim()).ToLowerInvariant()
    if ($reportedFile -ne $ExpectedFile.ToLowerInvariant()) {
        throw "Checksum file names the wrong asset: expected $ExpectedFile, got $reportedFile"
    }
    return $match.Groups[1].Value.ToLowerInvariant()
}

function Set-TextLine {
    param(
        [string]$Path,
        [string]$Prefix,
        [string]$NewLine
    )

    $text = [IO.File]::ReadAllText($Path)
    $pattern = '(?m)^' + [regex]::Escape($Prefix) + '.*\r?$'
    $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{ param($match) return $NewLine }
    $updated = [regex]::Replace($text, $pattern, $evaluator, 1)
    if ($updated -eq $text) {
        throw "Expected provenance line was not found in $($Path): $Prefix"
    }
    return $updated
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [IO.File]::WriteAllText($Path, $Content, $encoding)
}

$stageDir = Join-Path $env:TEMP ('mioproxy-geodata-update-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

try {
    $headers = Get-GitHubHeaders
    $project = [string]$manifest.geodata.project
    $releaseTag = [string]$manifest.geodata.releaseTag
    Write-Host "Resolving explicit geodata maintenance source $project/$releaseTag..." -ForegroundColor Cyan
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$project/releases/tags/$releaseTag" -Headers $headers
    $tagRef = Invoke-RestMethod -Uri "https://api.github.com/repos/$project/git/ref/tags/$releaseTag" -Headers $headers
    Assert-GeodataReleaseMetadata -ReleaseTag $releaseTag -ExpectedReleaseVersion ([string]$manifest.geodata.releaseVersion) -ExpectedPublishedAt ([string]$manifest.geodata.releasePublishedAt) -ExpectedCommit ([string]$manifest.geodata.releaseCommit) -Release $release -TagRef $tagRef
    if ([string]$tagRef.object.type -ne 'commit' -or ([string]$tagRef.object.sha) -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'The latest geodata tag did not resolve directly to a commit.'
    }
    $releaseCommit = ([string]$tagRef.object.sha).ToLowerInvariant()

    $comparisons = @()
    foreach ($item in $geodata) {
        $upstreamAsset = $release.assets | Where-Object { $_.name -eq $item.File.ToLowerInvariant() } | Select-Object -First 1
        if (-not $upstreamAsset -or [string]$upstreamAsset.browser_download_url -ne $item.Url) {
            throw "Expected geodata asset was not found at its manifest URL: $($item.File)"
        }
        $apiDigest = ([string]$upstreamAsset.digest).ToLowerInvariant()
        if ($apiDigest -notmatch '^sha256:[0-9a-f]{64}$') {
            throw "GitHub did not provide a valid asset SHA-256 digest: $($item.File)"
        }

        $checksumResponse = Invoke-WebRequest -Uri $item.ChecksumUrl -Headers $headers -UseBasicParsing
        $checksumContent = $checksumResponse.Content
        if ($checksumContent -is [byte[]]) {
            $checksumContent = [Text.Encoding]::UTF8.GetString($checksumContent)
        }
        else {
            $checksumContent = [string]$checksumContent
        }
        $checksumDigest = Get-ChecksumDigest -Content $checksumContent -ExpectedFile $item.File.ToLowerInvariant()
        Assert-PinnedSha256 -Expected $apiDigest.Substring(7) -Actual $checksumDigest -Artifact "checksum record for $($item.File)"

        $stagedPath = Join-Path $stageDir $item.File
        Invoke-WebRequest -Uri $item.Url -Headers $headers -OutFile $stagedPath -UseBasicParsing
        $actualDigest = Get-FileSha256 -Path $stagedPath
        Assert-PinnedSha256 -Expected $apiDigest.Substring(7) -Actual $actualDigest -Artifact "downloaded $($item.File)"
        $comparison = New-GeodataAssetComparison -File $item.File -OldSha256 $item.UpstreamSha256 -NewSha256 $actualDigest
        $comparisons += $comparison
        Write-Host ("{0}: {1} -> {2}" -f $comparison.File, $comparison.OldSha256, $comparison.NewSha256) -ForegroundColor $(if ($comparison.Changed) { 'Yellow' } else { 'Green' })
    }

    Write-Host "Latest release: $([string]$release.name)" -ForegroundColor Cyan
    Write-Host "Published at: $([string]$release.published_at)" -ForegroundColor Cyan
    Write-Host "Tag commit: $releaseCommit" -ForegroundColor Cyan

    if (-not $Apply) {
        Write-Host 'Preview complete. No repository files were changed. Re-run with -Apply to update vendored geodata and provenance.' -ForegroundColor Yellow
        return
    }

    $stagedManifestPath = Join-Path $stageDir 'mihomo-release.json'
    $stagedNoticePath = Join-Path $stageDir 'THIRD_PARTY_NOTICES.txt'
    $stagedThirdPartyPath = Join-Path $stageDir 'THIRD_PARTY.md'
    Copy-Item -LiteralPath $manifestPath -Destination $stagedManifestPath
    Copy-Item -LiteralPath $noticePath -Destination $stagedNoticePath
    Copy-Item -LiteralPath $thirdPartyPath -Destination $stagedThirdPartyPath

    $manifest.geodata.releaseVersion = [string]$release.name
    $manifest.geodata.releaseCommit = $releaseCommit
    $manifest.geodata.releasePublishedAt = [string]$release.published_at
    $manifest.geodata.licenseUrl = "https://github.com/$project/blob/$releaseCommit/LICENSE"
    $manifest.geodata.sourceWorkflowUrl = "https://github.com/$project/blob/$releaseCommit/.github/workflows/run.yml"
    $manifest.geodata.sourceAttributionUrl = "https://github.com/$project/blob/$releaseCommit/README.md"
    foreach ($comparison in $comparisons) {
        if ($comparison.File -eq 'GeoSite.dat') { $manifest.geodata.geoSite.upstreamSha256 = $comparison.NewSha256 }
        if ($comparison.File -eq 'GeoIP.dat') { $manifest.geodata.geoIp.upstreamSha256 = $comparison.NewSha256 }
    }
    Write-Utf8NoBom -Path $stagedManifestPath -Content (($manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine)

    $noticeText = [IO.File]::ReadAllText($stagedNoticePath)
    $noticeText = Set-TextLine -Path $stagedNoticePath -Prefix 'Geodata release version: ' -NewLine "Geodata release version: $([string]$release.name)"
    Write-Utf8NoBom -Path $stagedNoticePath -Content $noticeText
    $noticeText = Set-TextLine -Path $stagedNoticePath -Prefix 'Geodata release commit: ' -NewLine "Geodata release commit: $releaseCommit"
    Write-Utf8NoBom -Path $stagedNoticePath -Content $noticeText
    $noticeText = Set-TextLine -Path $stagedNoticePath -Prefix 'Geodata release published: ' -NewLine "Geodata release published: $([string]$release.published_at)"
    Write-Utf8NoBom -Path $stagedNoticePath -Content $noticeText
    $noticeText = Set-TextLine -Path $stagedNoticePath -Prefix 'Geodata license text: ' -NewLine "Geodata license text: https://github.com/$project/blob/$releaseCommit/LICENSE"
    Write-Utf8NoBom -Path $stagedNoticePath -Content $noticeText
    $noticeText = Set-TextLine -Path $stagedNoticePath -Prefix 'Geodata build/source workflow: ' -NewLine "Geodata build/source workflow: https://github.com/$project/blob/$releaseCommit/.github/workflows/run.yml"
    Write-Utf8NoBom -Path $stagedNoticePath -Content $noticeText
    $noticeText = Set-TextLine -Path $stagedNoticePath -Prefix 'Geodata source attribution: ' -NewLine "Geodata source attribution: https://github.com/$project/blob/$releaseCommit/README.md"
    Write-Utf8NoBom -Path $stagedNoticePath -Content $noticeText
    foreach ($comparison in $comparisons) {
        if ($comparison.File -eq 'GeoSite.dat') { $noticeText = Set-TextLine -Path $stagedNoticePath -Prefix 'GeoSite.dat SHA-256 (upstream data): ' -NewLine "GeoSite.dat SHA-256 (upstream data): $($comparison.NewSha256)" }
        if ($comparison.File -eq 'GeoIP.dat') { $noticeText = Set-TextLine -Path $stagedNoticePath -Prefix 'GeoIP.dat SHA-256 (upstream data): ' -NewLine "GeoIP.dat SHA-256 (upstream data): $($comparison.NewSha256)" }
        Write-Utf8NoBom -Path $stagedNoticePath -Content $noticeText
    }

    $thirdPartyText = [IO.File]::ReadAllText($stagedThirdPartyPath)
    $thirdPartyText = Set-TextLine -Path $stagedThirdPartyPath -Prefix '- Release metadata snapshot: ' -NewLine "- Release metadata snapshot: ``$([string]$release.name)`` (published ``$([string]$release.published_at)``)"
    Write-Utf8NoBom -Path $stagedThirdPartyPath -Content $thirdPartyText
    $thirdPartyText = Set-TextLine -Path $stagedThirdPartyPath -Prefix '- Tag commit snapshot: ' -NewLine "- Tag commit snapshot: ``$releaseCommit``"
    Write-Utf8NoBom -Path $stagedThirdPartyPath -Content $thirdPartyText
    foreach ($comparison in $comparisons) {
        if ($comparison.File -eq 'GeoSite.dat') { $thirdPartyText = Set-TextLine -Path $stagedThirdPartyPath -Prefix '- GeoSite.dat SHA-256: ' -NewLine "- GeoSite.dat SHA-256: ``$($comparison.NewSha256)``" }
        if ($comparison.File -eq 'GeoIP.dat') { $thirdPartyText = Set-TextLine -Path $stagedThirdPartyPath -Prefix '- GeoIP.dat SHA-256: ' -NewLine "- GeoIP.dat SHA-256: ``$($comparison.NewSha256)``" }
        Write-Utf8NoBom -Path $stagedThirdPartyPath -Content $thirdPartyText
    }

    foreach ($item in $geodata) {
        $replacementPath = "$($item.Path).new"
        Copy-Item -LiteralPath (Join-Path $stageDir $item.File) -Destination $replacementPath -Force
        Move-Item -LiteralPath $replacementPath -Destination $item.Path -Force
    }
    Move-Item -LiteralPath $stagedManifestPath -Destination $manifestPath -Force
    Move-Item -LiteralPath $stagedNoticePath -Destination $noticePath -Force
    Move-Item -LiteralPath $stagedThirdPartyPath -Destination $thirdPartyPath -Force
    Write-Host 'Explicit geodata update applied to vendored files, manifest, and notices.' -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $stageDir) {
        Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
