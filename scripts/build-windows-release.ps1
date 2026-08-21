[CmdletBinding()]
param(
    [string]$SigningKeyPath = ""
)

$ErrorActionPreference = "Stop"

function Restore-EnvironmentVariable {
    param(
        [string]$Name,
        [AllowNull()][string]$Value
    )

    if ($null -eq $Value) {
        Remove-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
    } else {
        Set-Item -Path "Env:$Name" -Value $Value
    }
}

function Read-SigningPassword {
    $securePassword = Read-Host "Enter the Tauri updater signing key password" -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$defaultKeyPath = Join-Path $env:USERPROFILE ".tauri\mioproxy-v0.8.key"
if ([string]::IsNullOrWhiteSpace($SigningKeyPath)) {
    $SigningKeyPath = if (-not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH
    } else {
        $defaultKeyPath
    }
}

$resolvedKey = Resolve-Path -LiteralPath $SigningKeyPath -ErrorAction Stop
$previousKey = $env:TAURI_SIGNING_PRIVATE_KEY
$previousKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
$previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
Push-Location -LiteralPath $repoRoot

try {
    $env:TAURI_SIGNING_PRIVATE_KEY = $resolvedKey.Path
    $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $resolvedKey.Path
    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-SigningPassword
    }

    Write-Host "Using updater signing key: $($resolvedKey.Path)" -ForegroundColor Cyan
    Write-Host "Building signed Windows bundles..." -ForegroundColor Cyan
    npm run tauri build
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Restore-EnvironmentVariable -Name "TAURI_SIGNING_PRIVATE_KEY" -Value $previousKey
    Restore-EnvironmentVariable -Name "TAURI_SIGNING_PRIVATE_KEY_PATH" -Value $previousKeyPath
    Restore-EnvironmentVariable -Name "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" -Value $previousPassword
    Pop-Location
}
