$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $repoRoot 'scripts/mihomo-release-policy.ps1')
$setupText = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts/setup-mihomo.ps1')
$updateText = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts/update-geodata.ps1')
$binaryReadmeText = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'src-tauri/binaries/README.md')
$gitignoreText = Get-Content -Raw -LiteralPath (Join-Path $repoRoot '.gitignore')

$manifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'config/mihomo-release.json') | ConvertFrom-Json
if ([string]$manifest.geodata.releaseTag -ne 'latest') {
    throw 'The release-integrity policy fixture must exercise the mutable latest tag.'
}
if ([string]$manifest.geodata.releaseMetadataPolicy -ne 'informational-for-mutable-tag') {
    throw 'The geodata manifest must label latest release metadata as informational.'
}

$expectedVendoredGeodata = @(
    [pscustomobject]@{
        File = 'GeoSite.dat'
        RelativePath = 'src-tauri/binaries/GeoSite.dat'
        Path = Join-Path $repoRoot 'src-tauri/binaries/GeoSite.dat'
        PinnedSha256 = '8c9e9ec13807174ffb3582d95655e00559af3fb30253b5e30c0385e46366d9dc'
        ManifestItem = $manifest.geodata.geoSite
    },
    [pscustomobject]@{
        File = 'GeoIP.dat'
        RelativePath = 'src-tauri/binaries/GeoIP.dat'
        Path = Join-Path $repoRoot 'src-tauri/binaries/GeoIP.dat'
        PinnedSha256 = '8ebcb11333f7deed4bf2740f2ce3249aa8997ef03d437150c7ae373c011cd72a'
        ManifestItem = $manifest.geodata.geoIp
    }
)

if ($gitignoreText -notmatch '(?m)^src-tauri/binaries/\*\.exe\r?$') {
    throw 'Executable binaries must remain ignored by .gitignore.'
}
foreach ($resource in $expectedVendoredGeodata) {
    if ([string]$resource.ManifestItem.file -ne $resource.File) {
        throw "Manifest geodata resource name is not canonical: $($resource.File)"
    }
    if ([string]$resource.ManifestItem.upstreamSha256 -ne $resource.PinnedSha256) {
        throw "Manifest geodata SHA-256 pin changed unexpectedly: $($resource.File)"
    }
    if (-not (Test-Path -LiteralPath $resource.Path -PathType Leaf)) {
        throw "Expected repository-vendored resource is missing: $($resource.Path)"
    }
    if ($gitignoreText -match "(?m)^$([regex]::Escape($resource.RelativePath))\r?$") {
        throw "Repository-vendored resource is still ignored by .gitignore: $($resource.RelativePath)"
    }
    & git -C $repoRoot check-ignore --quiet -- $resource.RelativePath 2>$null
    if ($LASTEXITCODE -eq 0) {
        throw "Repository-vendored resource is ignored by Git: $($resource.RelativePath)"
    }
}

foreach ($requiredReadmeText in @(
    'repository vendors `GeoSite.dat` and `GeoIP.dat`',
    'Normal setup and release builds require these files to already exist',
    'verify their pinned SHA-256 values',
    'does not download or overwrite them',
    'scripts/update-geodata.ps1',
    'is an explicit',
    'maintenance action only'
)) {
    if ($binaryReadmeText.IndexOf($requiredReadmeText, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Vendored geodata README is missing required architecture wording: $requiredReadmeText"
    }
}
if ($binaryReadmeText -match 'downloads `GeoSite\.dat`|downloads `GeoIP\.dat`') {
    throw 'Vendored geodata README must not describe normal setup as downloading geodata.'
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
if ($setupText -match '(?im)^\s*(?:Copy-Item|Move-Item|Set-Content|Add-Content|Remove-Item|WriteAllText|WriteAllBytes)[^\r\n]*(?:GeoSite|GeoIP|\$geodata|\$item\.Path)') {
    throw 'Normal Mihomo setup must not mutate repository-vendored geodata.'
}
$vendoredVerificationIndex = $setupText.IndexOf('Assert-VendoredGeodata -Items $geodata', [System.StringComparison]::Ordinal)
$mihomoNetworkIndex = $setupText.IndexOf('Invoke-RestMethod -Uri "https://api.github.com/repos/$project/releases/tags/$tag"', [System.StringComparison]::Ordinal)
if ($vendoredVerificationIndex -lt 0 -or $mihomoNetworkIndex -lt 0 -or $vendoredVerificationIndex -gt $mihomoNetworkIndex) {
    throw 'Normal Mihomo setup must fail closed on vendored geodata before network preparation.'
}
$vendoredItems = @(
    [pscustomobject]@{ File = $expectedVendoredGeodata[0].File; Path = $expectedVendoredGeodata[0].Path; UpstreamSha256 = $expectedVendoredGeodata[0].PinnedSha256 },
    [pscustomobject]@{ File = $expectedVendoredGeodata[1].File; Path = $expectedVendoredGeodata[1].Path; UpstreamSha256 = $expectedVendoredGeodata[1].PinnedSha256 }
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
    [IO.File]::WriteAllText($testSitePath, 'pinned geosite')
    $testItems[1].UpstreamSha256 = Get-FileSha256 -Path $testIpPath
    Remove-Item -LiteralPath $testIpPath -ErrorAction Stop
    Assert-ExpectedFailure -CaseName 'Vendored GeoIP.dat is missing' -ScriptBlock {
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
