$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $repoRoot 'scripts/release-artifact-paths.ps1')

$fixturePath = Join-Path $PSScriptRoot 'fixtures/release-manifest-app-path.json'
$fixture = Get-Content -Raw -LiteralPath $fixturePath | ConvertFrom-Json
$paths = Get-ReleaseExecutableRelativePaths
$app = @($fixture.executables | Where-Object { $_.role -eq 'app' })

if ($app.Count -ne 1) {
    throw 'The release manifest path fixture must contain exactly one app entry.'
}
if ([string]$app[0].path -ne $paths.app) {
    throw "The release manifest app path fixture is not canonical: $($app[0].path)"
}

$absolutePaths = Get-ReleaseExecutablePaths -RepoRoot $repoRoot
$expectedAbsolute = [IO.Path]::GetFullPath((Join-Path $repoRoot ($paths.app -replace '/', '\')))
if ([IO.Path]::GetFullPath($absolutePaths.app) -ne $expectedAbsolute) {
    throw "The release manifest app path does not resolve from the repository root: $($absolutePaths.app)"
}

Write-Host "Release manifest app path is canonical: $($paths.app)" -ForegroundColor Green
