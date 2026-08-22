[CmdletBinding()]
param(
    [string]$Tag = "",
    [string]$BaseUrl = "",
    [string]$Notes = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$version = [string](Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$Tag = if ([string]::IsNullOrWhiteSpace($Tag)) { "v$version" } else { $Tag }
$bundleRoot = Join-Path $repoRoot "src-tauri\target\release\bundle"
$nsis = Get-ChildItem -LiteralPath (Join-Path $bundleRoot "nsis") -File -Filter "MioProxy_${version}_x64-setup.exe" | Select-Object -First 1
if (-not $nsis) { throw "Expected NSIS artifact was not found for MioProxy $version." }

function Read-Signature([string]$ArtifactPath) {
    $signaturePath = "$ArtifactPath.sig"
    if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
        throw "Tauri updater signature is missing: $signaturePath"
    }
    (Get-Content -Raw -LiteralPath $signaturePath).Trim()
}

$commitDate = (& git -C $repoRoot show -s --format=%cI HEAD).Trim()
$baseUrl = if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    "https://github.com/Felyx-Fu/MioProxy/releases/download/$Tag"
} else {
    $BaseUrl.TrimEnd('/')
}
$notes = if ([string]::IsNullOrWhiteSpace($Notes)) {
    "Tauri updater-signed Windows x86_64 NSIS release for MioProxy."
} else {
    $Notes
}
$document = [ordered]@{
    version = $version
    notes = $notes
    pub_date = $commitDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = Read-Signature $nsis.FullName
            url = "$baseUrl/$($nsis.Name)"
        }
        "windows-x86_64-nsis" = [ordered]@{
            signature = Read-Signature $nsis.FullName
            url = "$baseUrl/$($nsis.Name)"
        }
    }
}
$output = Join-Path $bundleRoot "latest.json"
[System.IO.File]::WriteAllText($output, (($document | ConvertTo-Json -Depth 6) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
Write-Host "Updater manifest written: $output" -ForegroundColor Green
