$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$workflowPath = Join-Path $repoRoot '.github/workflows/release.yml'
$notesPath = Join-Path $repoRoot 'docs/releases/v1.0.1.md'
$workflowText = Get-Content -Raw -LiteralPath $workflowPath

function Assert-Contains {
    param(
        [string]$Text,
        [string]$Needle,
        [string]$Description
    )

    if ($Text.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Release workflow assertion failed: $Description ($Needle)"
    }
}

if (-not (Test-Path -LiteralPath $notesPath -PathType Leaf)) {
    throw "Version-specific release notes are missing: $notesPath"
}

$notesText = Get-Content -Raw -Encoding UTF8 -LiteralPath $notesPath
foreach ($requiredNotesText in @(
    '# MioProxy v1.0.1',
    '**`MioProxy_1.0.1_x64-setup.exe`**',
    'Windows Authenticode',
    'Tauri updater'
)) {
    Assert-Contains -Text $notesText -Needle $requiredNotesText -Description 'v1.0.1 release notes content'
}

$h2Lines = @($notesText -split '\r?\n' | Where-Object { $_ -match '^## ' })
if ($h2Lines.Count -ne 2) {
    throw "v1.0.1 release notes must contain exactly two level-two sections, found $($h2Lines.Count)."
}
$h3Lines = @($notesText -split '\r?\n' | Where-Object { $_ -match '^### ' })
if ($h3Lines.Count -ne 2) {
    throw "v1.0.1 release notes must contain exactly two level-three update sections, found $($h3Lines.Count)."
}
if ($notesText -notmatch '(?ms)^## [^\r\n]+\r?\n\r?\n?Windows x64.*MioProxy_1\.0\.1_x64-setup\.exe') {
    throw 'v1.0.1 release notes do not contain the required Download section and installer.'
}
$lastNotesLine = ($notesText.TrimEnd() -split '\r?\n')[-1]
if ($lastNotesLine -notmatch '^> MioProxy .*Windows Authenticode.*Tauri updater.*$') {
    throw 'v1.0.1 release notes do not end at the required Windows publisher notice.'
}

foreach ($requiredWorkflowText in @(
    'docs/releases/$($env:RELEASE_TAG).md',
    'Test-Path -LiteralPath $notesPath -PathType Leaf',
    '[System.IO.File]::ReadAllText($notesPath',
    '$env:GITHUB_OUTPUT',
    'body: ${{ steps.release_notes.outputs.body }}',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    'name: MioProxy-${{ github.ref_name }}-release-evidence',
    'retention-days: 90',
    'src-tauri/target/release/bundle/nsis/MioProxy_*_x64-setup.exe.sig',
    'src-tauri/target/release/bundle/MioProxy-*-release-manifest.json',
    'src-tauri/target/release/bundle/MioProxy-*-SHA256SUMS.txt',
    'src-tauri/binaries/THIRD_PARTY_NOTICES.txt',
    'config/mihomo-release.json',
    'npm audit --omit=dev --audit-level=high',
    'npm run test:ui',
    'cargo test --locked --manifest-path src-tauri/Cargo.toml',
    'cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings',
    './scripts/verify-mihomo-packaging.ps1',
    './scripts/verify-nsis-release.ps1',
    './scripts/verify-windows-release.ps1',
    './scripts/tests/verify-updater-signature.test.ps1'
)) {
    Assert-Contains -Text $workflowText -Needle $requiredWorkflowText -Description 'release workflow gate or evidence configuration'
}

if ($workflowText -match '(?m)^\s*body:\s*Tauri updater-signed') {
    throw 'Release workflow still contains a hard-coded generic release body.'
}

$workflowLines = $workflowText -split '\r?\n'
$publicFiles = @()
$insidePublicFiles = $false
foreach ($line in $workflowLines) {
    if ($line -eq '          files: |') {
        $insidePublicFiles = $true
        continue
    }
    if ($insidePublicFiles) {
        if ($line -match '^            \S') {
            $publicFiles += $line.Trim()
            continue
        }
        break
    }
}

$expectedPublicFiles = @(
    'src-tauri/target/release/bundle/nsis/MioProxy_*_x64-setup.exe',
    'src-tauri/target/release/bundle/latest.json'
)
if ($publicFiles.Count -ne $expectedPublicFiles.Count) {
    throw "Future public release asset count is $($publicFiles.Count), expected $($expectedPublicFiles.Count): $($publicFiles -join ', ')"
}
foreach ($expectedFile in $expectedPublicFiles) {
    if ($publicFiles -notcontains $expectedFile) {
        throw "Future public release assets are missing: $expectedFile"
    }
}
foreach ($publicFile in $publicFiles) {
    if ($expectedPublicFiles -notcontains $publicFile) {
        throw "Internal release evidence would be exposed as a public asset: $publicFile"
    }
}

$notesStepIndex = $workflowText.IndexOf('id: release_notes', [System.StringComparison]::Ordinal)
$publishStepIndex = $workflowText.IndexOf('uses: softprops/action-gh-release@', [System.StringComparison]::Ordinal)
if ($notesStepIndex -lt 0 -or $publishStepIndex -lt 0 -or $notesStepIndex -gt $publishStepIndex) {
    throw 'Version-specific release notes must be loaded before GitHub Release publication.'
}

Write-Host 'Release workflow public/evidence split and versioned notes policy passed.' -ForegroundColor Green
