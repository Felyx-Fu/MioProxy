$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $repoRoot 'scripts/mihomo-release-policy.ps1')
$setupText = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts/setup-mihomo.ps1')
$updateText = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts/update-geodata.ps1')

$manifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'config/mihomo-release.json') | ConvertFrom-Json
if ([string]$manifest.geodata.releaseTag -ne 'latest') {
    throw 'The release-integrity policy fixture must exercise the mutable latest tag.'
}
if ([string]$manifest.geodata.releaseMetadataPolicy -ne 'informational-for-mutable-tag') {
    throw 'The geodata manifest must label latest release metadata as informational.'
}

function New-RepeatedString {
    param(
        [string]$Character,
        [int]$Length
    )

    return (($Character * $Length) -join '')
}

function Assert-ExpectedFailure {
    param(
        [scriptblock]$ScriptBlock,
        [string]$CaseName
    )

    $failed = $false
    try {
        & $ScriptBlock
    }
    catch {
        $failed = $true
    }
    if (-not $failed) {
        throw "Expected failure did not occur: $CaseName"
    }
}

$expectedCommit = New-RepeatedString -Character 'a' -Length 40
$movedCommit = New-RepeatedString -Character 'b' -Length 40
$release = [pscustomobject]@{
    tag_name = 'latest'
    name = 'Release title changed'
    published_at = '2026-08-22T22:47:54Z'
}
$movedRef = [pscustomobject]@{
    object = [pscustomobject]@{
        type = 'commit'
        sha = $movedCommit
    }
}

# A: changing only the latest release title is not a trust failure.
Assert-GeodataReleaseMetadata -ReleaseTag 'latest' -ExpectedReleaseVersion 'Historical title' -ExpectedPublishedAt '2026-08-21T22:50:37Z' -ExpectedCommit $expectedCommit -Release $release -TagRef $movedRef
Assert-PinnedSha256 -Expected (New-RepeatedString -Character 'c' -Length 64) -Actual (New-RepeatedString -Character 'c' -Length 64) -Artifact 'GeoSite.dat'

# B: changing only latest published_at is not a trust failure.
$release.published_at = '2026-08-23T22:47:54Z'
Assert-GeodataReleaseMetadata -ReleaseTag 'latest' -ExpectedReleaseVersion 'Historical title' -ExpectedPublishedAt '2026-08-21T22:50:37Z' -ExpectedCommit $expectedCommit -Release $release -TagRef $movedRef

# C: moving the latest tag commit is not treated as immutable identity.
$movedRef.object.sha = New-RepeatedString -Character 'd' -Length 40
Assert-GeodataReleaseMetadata -ReleaseTag 'latest' -ExpectedReleaseVersion 'Historical title' -ExpectedPublishedAt '2026-08-21T22:50:37Z' -ExpectedCommit $expectedCommit -Release $release -TagRef $movedRef

# A/B/C: normal setup is independent of mutable geodata metadata and assets.
if ($setupText -match 'releases/tags/\$geodataReleaseTag' -or $setupText -match 'Invoke-WebRequest -Uri \$item\.Url') {
    throw 'Normal Mihomo setup must not query or download mutable upstream geodata.'
}
if ($setupText -notmatch 'Assert-VendoredGeodata') {
    throw 'Normal Mihomo setup must verify repository-vendored geodata.'
}
if ($setupText -match 'update-geodata') {
    throw 'Normal Mihomo setup must not invoke the explicit geodata maintenance path.'
}
$vendoredItems = @(
    [pscustomobject]@{ File = [string]$manifest.geodata.geoSite.file; Path = Join-Path $repoRoot 'src-tauri/binaries/GeoSite.dat'; UpstreamSha256 = ([string]$manifest.geodata.geoSite.upstreamSha256).ToLowerInvariant() },
    [pscustomobject]@{ File = [string]$manifest.geodata.geoIp.file; Path = Join-Path $repoRoot 'src-tauri/binaries/GeoIP.dat'; UpstreamSha256 = ([string]$manifest.geodata.geoIp.upstreamSha256).ToLowerInvariant() }
)
Assert-VendoredGeodata -Items $vendoredItems
$assetComparison = New-GeodataAssetComparison -File 'GeoSite.dat' -OldSha256 $vendoredItems[0].UpstreamSha256 -NewSha256 (New-RepeatedString -Character 'f' -Length 64)
if (-not $assetComparison.Changed -or $assetComparison.OldSha256 -eq $assetComparison.NewSha256) {
    throw 'Changed upstream geodata must be reported as a comparison, not silently accepted by normal setup.'
}

# G: the explicit update path reports changes and is the only path allowed to apply them.
if ($updateText -notmatch '\[switch\]\$Apply' -or $updateText -notmatch 'if \(-not \$Apply\)' -or $updateText -notmatch 'New-GeodataAssetComparison') {
    throw 'Explicit geodata maintenance must require -Apply after reporting the staged comparison.'
}
foreach ($workflowName in @('release-candidate.yml', 'release.yml', 'release-readiness.yml')) {
    $workflowPath = Join-Path $repoRoot (Join-Path '.github/workflows' $workflowName)
    $workflowText = Get-Content -Raw -LiteralPath $workflowPath
    if ($workflowText -match 'update-geodata\.ps1') {
        throw "Normal release workflow must not invoke explicit geodata maintenance: $workflowName"
    }
    if ($workflowText -notmatch 'mihomo:setup' -or $workflowText -notmatch 'verify-mihomo-packaging\.ps1') {
        throw "Normal release workflow must prepare and verify the repository snapshot: $workflowName"
    }
}

# D/E/F: vendored content and presence remain hard failures.
$testDir = Join-Path $env:TEMP ('mioproxy-geodata-policy-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $testDir | Out-Null
try {
    $testSitePath = Join-Path $testDir 'GeoSite.dat'
    $testIpPath = Join-Path $testDir 'GeoIP.dat'
    [IO.File]::WriteAllText($testSitePath, 'pinned geosite')
    [IO.File]::WriteAllText($testIpPath, 'pinned geoip')
    $testItems = @(
        [pscustomobject]@{ File = 'GeoSite.dat'; Path = $testSitePath; UpstreamSha256 = Get-FileSha256 -Path $testSitePath },
        [pscustomobject]@{ File = 'GeoIP.dat'; Path = $testIpPath; UpstreamSha256 = Get-FileSha256 -Path $testIpPath }
    )
    Assert-VendoredGeodata -Items $testItems
    $testItems[0].UpstreamSha256 = New-RepeatedString -Character 'e' -Length 64
    Assert-ExpectedFailure -CaseName 'Vendored GeoSite.dat SHA differs from pinned SHA' -ScriptBlock {
        Assert-VendoredGeodata -Items $testItems
    }
    $testItems[0].UpstreamSha256 = Get-FileSha256 -Path $testSitePath
    $testItems[1].UpstreamSha256 = New-RepeatedString -Character '2' -Length 64
    Assert-ExpectedFailure -CaseName 'Vendored GeoIP.dat SHA differs from pinned SHA' -ScriptBlock {
        Assert-VendoredGeodata -Items $testItems
    }
    Remove-Item -LiteralPath $testSitePath -ErrorAction Stop
    Assert-ExpectedFailure -CaseName 'Vendored GeoSite.dat is missing' -ScriptBlock {
        Assert-VendoredGeodata -Items $testItems
    }
}
finally {
    if (Test-Path -LiteralPath $testDir) {
        Remove-Item -LiteralPath $testDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# H: Mihomo content digests remain hard failures.
Assert-ExpectedFailure -CaseName 'GeoSite.dat SHA differs from pinned SHA' -ScriptBlock {
    Assert-PinnedSha256 -Expected (New-RepeatedString -Character 'e' -Length 64) -Actual (New-RepeatedString -Character 'f' -Length 64) -Artifact 'GeoSite.dat'
}
Assert-ExpectedFailure -CaseName 'GeoIP.dat SHA differs from pinned SHA' -ScriptBlock {
    Assert-PinnedSha256 -Expected (New-RepeatedString -Character '1' -Length 64) -Actual (New-RepeatedString -Character '2' -Length 64) -Artifact 'GeoIP.dat'
}
Assert-ExpectedFailure -CaseName 'Mihomo v1.19.30 asset SHA differs from pinned SHA' -ScriptBlock {
    Assert-PinnedSha256 -Expected (New-RepeatedString -Character '3' -Length 64) -Actual (New-RepeatedString -Character '4' -Length 64) -Artifact 'Mihomo v1.19.30 asset'
}

Write-Host 'Mutable latest metadata and immutable content-integrity policies passed.' -ForegroundColor Green
