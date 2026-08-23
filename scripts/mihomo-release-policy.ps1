function Get-FileSha256 {
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

function Assert-PinnedSha256 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Artifact
    )

    $expectedDigest = ([string]$Expected).ToLowerInvariant()
    $actualDigest = ([string]$Actual).ToLowerInvariant()
    if ($expectedDigest -notmatch '^[0-9a-f]{64}$') {
        throw "Pinned SHA-256 is malformed for $Artifact."
    }
    if ($actualDigest -notmatch '^[0-9a-f]{64}$') {
        throw "Observed SHA-256 is malformed for $Artifact."
    }
    if ($actualDigest -ne $expectedDigest) {
        throw "SHA-256 verification failed for $Artifact."
    }
}

function Assert-VendoredGeodata {
    param(
        [Parameter(Mandatory = $true)][object[]]$Items
    )

    foreach ($item in $Items) {
        $path = [string]$item.Path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Vendored geodata file is missing: $path"
        }
        Assert-PinnedSha256 -Expected ([string]$item.UpstreamSha256) -Actual (Get-FileSha256 -Path $path) -Artifact "vendored geodata $($item.File)"
    }
}

function New-GeodataAssetComparison {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string]$OldSha256,
        [Parameter(Mandatory = $true)][string]$NewSha256
    )

    $oldDigest = ([string]$OldSha256).ToLowerInvariant()
    $newDigest = ([string]$NewSha256).ToLowerInvariant()
    return [pscustomobject]@{
        File = $File
        OldSha256 = $oldDigest
        NewSha256 = $newDigest
        Changed = $oldDigest -ne $newDigest
    }
}

function Assert-GeodataReleaseMetadata {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseTag,
        [Parameter(Mandatory = $true)][string]$ExpectedReleaseVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedPublishedAt,
        [Parameter(Mandatory = $true)][string]$ExpectedCommit,
        [Parameter(Mandatory = $true)]$Release,
        $TagRef
    )

    if ([string]$Release.tag_name -ne $ReleaseTag) {
        throw "Upstream GeoSite/GeoIP release tag does not match the requested tag $ReleaseTag."
    }

    # The upstream latest tag and release are mutable. Its title, publication
    # time, and tag commit are provenance observations, not content identity.
    if ($ReleaseTag -eq 'latest') {
        return
    }

    if ([string]$Release.name -ne $ExpectedReleaseVersion) {
        throw "Upstream GeoSite/GeoIP release metadata does not match the pinned tag/version."
    }

    try {
        $expectedPublishedTicks = [DateTimeOffset]::Parse($ExpectedPublishedAt).ToUniversalTime().Ticks
        $actualPublishedTicks = [DateTimeOffset]::Parse([string]$Release.published_at).ToUniversalTime().Ticks
    }
    catch {
        throw "Upstream GeoSite/GeoIP release published_at is not a valid timestamp."
    }
    if ($actualPublishedTicks -ne $expectedPublishedTicks) {
        throw "Upstream GeoSite/GeoIP release published_at does not match the pinned release metadata."
    }

    if ($null -eq $TagRef -or [string]$TagRef.object.type -ne 'commit' -or ([string]$TagRef.object.sha).ToLowerInvariant() -ne $ExpectedCommit.ToLowerInvariant()) {
        throw "Upstream GeoSite/GeoIP release tag does not resolve to the pinned commit."
    }
}
