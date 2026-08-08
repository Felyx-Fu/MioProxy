$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$outDir = Join-Path $repoRoot "src-tauri\binaries"
$outFile = Join-Path $outDir "mihomo-x86_64-pc-windows-msvc.exe"
$tempDir = Join-Path $env:TEMP ("mioproxy-mihomo-" + [guid]::NewGuid().ToString("N"))
$zipFile = Join-Path $tempDir "mihomo.zip"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

Write-Host "[1/4] Querying latest stable Mihomo release..." -ForegroundColor Cyan
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest" -Headers @{ "User-Agent" = "MioProxy-Setup" }

$asset = $release.assets | Where-Object { $_.name -like "mihomo-windows-amd64-compatible-*.zip" } | Select-Object -First 1
if (-not $asset) {
    $asset = $release.assets | Where-Object { $_.name -like "mihomo-windows-amd64-*.zip" } | Select-Object -First 1
}
if (-not $asset) { throw "No Windows amd64 Mihomo zip asset found in release $($release.tag_name)." }

Write-Host "[2/4] Downloading $($asset.name)..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipFile -UseBasicParsing

Write-Host "[3/4] Extracting..." -ForegroundColor Cyan
Expand-Archive -Path $zipFile -DestinationPath $tempDir -Force
$exe = Get-ChildItem -Path $tempDir -Filter "mihomo*.exe" -Recurse | Select-Object -First 1
if (-not $exe) { throw "Downloaded archive did not contain mihomo.exe." }
Copy-Item $exe.FullName $outFile -Force

Write-Host "[4/4] Ready: $outFile" -ForegroundColor Green
Write-Host "Mihomo version: $($release.tag_name)" -ForegroundColor Green

Remove-Item $tempDir -Recurse -Force
