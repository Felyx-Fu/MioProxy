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

Write-Host "[3/3] Ready: $outFile" -ForegroundColor Green
