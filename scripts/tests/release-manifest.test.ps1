$ErrorActionPreference = 'Stop'

foreach ($testName in @('release-manifest-path.test.ps1', 'release-manifest-semantics.test.ps1')) {
    $testPath = Join-Path $PSScriptRoot $testName
    & $testPath
    if (-not $?) { throw "Release manifest test failed: $testName" }
}

Write-Host 'Release manifest tests passed.' -ForegroundColor Green
