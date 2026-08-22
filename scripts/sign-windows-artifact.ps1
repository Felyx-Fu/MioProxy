[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Authenticode signing target does not exist: $Path"
}

$certificatePath = $env:MIOPROXY_AUTHENTICODE_CERTIFICATE_PATH
$certificatePassword = $env:MIOPROXY_AUTHENTICODE_CERTIFICATE_PASSWORD
$timestampUrl = if ([string]::IsNullOrWhiteSpace($env:MIOPROXY_AUTHENTICODE_TIMESTAMP_URL)) {
    "http://timestamp.digicert.com"
} else {
    $env:MIOPROXY_AUTHENTICODE_TIMESTAMP_URL
}

function Get-Sha256 {
    param([string]$FilePath)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($FilePath)
    try {
        return (([BitConverter]::ToString($sha256.ComputeHash($stream)) -replace '-', '').ToLowerInvariant())
    }
    finally {
        $stream.Dispose()
        $sha256.Dispose()
    }
}

function Write-HashRecord {
    param(
        [ValidateSet('preAuthenticode', 'postAuthenticode')]
        [string]$Phase,
        [string]$FilePath,
        [string]$Sha256
    )

    $recordPath = $env:MIOPROXY_AUTHENTICODE_RECORD_PATH
    if ([string]::IsNullOrWhiteSpace($recordPath)) {
        return
    }
    $recordDirectory = Split-Path -Parent $recordPath
    if (-not [string]::IsNullOrWhiteSpace($recordDirectory)) {
        New-Item -ItemType Directory -Force -Path $recordDirectory | Out-Null
    }
    $record = [ordered]@{
        path = (Resolve-Path -LiteralPath $FilePath).Path
        phase = $Phase
        sha256 = $Sha256
    }
    [System.IO.File]::AppendAllText(
        $recordPath,
        (($record | ConvertTo-Json -Compress) + [Environment]::NewLine),
        [System.Text.UTF8Encoding]::new($false)
    )
}

if ([string]::IsNullOrWhiteSpace($certificatePath) -or -not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
    throw "MIOPROXY_AUTHENTICODE_CERTIFICATE_PATH is required for a release signing step. This is separate from TAURI_SIGNING_PRIVATE_KEY."
}
if ($null -eq $certificatePassword) {
    throw "MIOPROXY_AUTHENTICODE_CERTIFICATE_PASSWORD is required for a release signing step."
}

$preAuthenticodeSha256 = Get-Sha256 -FilePath $Path
Write-HashRecord -Phase preAuthenticode -FilePath $Path -Sha256 $preAuthenticodeSha256
$current = Get-AuthenticodeSignature -LiteralPath $Path
if ($current.Status -eq "Valid" -and $null -ne $current.SignerCertificate -and $null -ne $current.TimeStamperCertificate) {
    Write-HashRecord -Phase postAuthenticode -FilePath $Path -Sha256 $preAuthenticodeSha256
    Write-Host "Authenticode already valid and timestamped: $Path" -ForegroundColor DarkGray
    exit 0
}

$signtoolCandidates = @()
$signtoolCommand = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($signtoolCommand) {
    $signtoolCandidates += $signtoolCommand.Source
}
$windowsKitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
if (Test-Path -LiteralPath $windowsKitsRoot) {
    $signtoolCandidates += Get-ChildItem -LiteralPath $windowsKitsRoot -Filter signtool.exe -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
        Sort-Object FullName -Descending |
        Select-Object -ExpandProperty FullName
}
$signtool = $signtoolCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($signtool)) {
    throw "signtool.exe was not found on this Windows runner. Install the Windows SDK before signing."
}

Write-Host "Authenticode signing: $Path" -ForegroundColor Cyan
& $signtool sign /fd SHA256 /td SHA256 /tr $timestampUrl /f $certificatePath /p $certificatePassword /d "MioProxy" $Path
if ($LASTEXITCODE -ne 0) {
    throw "signtool.exe failed for $Path with exit code $LASTEXITCODE."
}

$signed = Get-AuthenticodeSignature -LiteralPath $Path
if ($signed.Status -ne "Valid" -or $null -eq $signed.SignerCertificate) {
    throw "Authenticode verification failed after signing: $Path (status=$($signed.Status))."
}
if ($null -eq $signed.TimeStamperCertificate) {
    throw "Authenticode signature has no trusted timestamp after signing: $Path"
}
$postAuthenticodeSha256 = Get-Sha256 -FilePath $Path
Write-HashRecord -Phase postAuthenticode -FilePath $Path -Sha256 $postAuthenticodeSha256
