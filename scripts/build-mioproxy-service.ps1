$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$manifest = Join-Path $repoRoot "src-tauri\Cargo.toml"
$source = Join-Path $repoRoot "src-tauri\target\release\mioproxy-service.exe"
$outDir = Join-Path $repoRoot "src-tauri\binaries"
$outFile = Join-Path $outDir "mioproxy-service-x86_64-pc-windows-msvc.exe"

Write-Host "[1/3] Building MioProxy Service..." -ForegroundColor Cyan
cargo build --release --locked --manifest-path $manifest --bin mioproxy-service

Write-Host "[2/3] Copying service sidecar..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item -LiteralPath $source -Destination $outFile -Force

if (-not [string]::IsNullOrWhiteSpace($env:MIOPROXY_AUTHENTICODE_CERTIFICATE_PATH)) {
    $signScript = Join-Path $repoRoot "scripts\sign-windows-artifact.ps1"
    $mihomoFile = Join-Path $outDir "mihomo-x86_64-pc-windows-msvc.exe"
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $signScript -Path $outFile
    if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed for the Service sidecar." }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $signScript -Path $mihomoFile
    if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed for the Mihomo sidecar." }
    Write-Host "Authenticode signatures applied to Service and Mihomo sidecars." -ForegroundColor Green
}

Write-Host "[3/3] Ready: $outFile" -ForegroundColor Green
