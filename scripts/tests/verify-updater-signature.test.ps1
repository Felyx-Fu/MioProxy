[CmdletBinding()]
param(
    [string]$ArtifactPath = "",
    [string]$SignaturePath = "",
    [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$version = [string](Get-Content -Raw (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$artifactPath = if ([string]::IsNullOrWhiteSpace($ArtifactPath)) {
    Join-Path $repoRoot ("src-tauri\target\release\bundle\nsis\MioProxy_" + $version + "_x64-setup.exe")
} else {
    (Resolve-Path $ArtifactPath).Path
}
$signaturePath = if ([string]::IsNullOrWhiteSpace($SignaturePath)) {
    "$artifactPath.sig"
} else {
    (Resolve-Path $SignaturePath).Path
}
$configPath = if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    Join-Path $repoRoot "src-tauri\tauri.conf.json"
} else {
    (Resolve-Path $ConfigPath).Path
}

foreach ($path in @($artifactPath, $signaturePath, $configPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Updater signature test input is missing: $path"
    }
}

$cargoArguments = @(
    "run",
    "--quiet",
    "--locked",
    "--manifest-path",
    (Join-Path $repoRoot "src-tauri\Cargo.toml"),
    "--bin",
    "verify-updater-signature",
    "--"
)

function Invoke-SignatureVerification {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$CandidateArtifact,
        [Parameter(Mandatory = $true)][string]$CandidateSignature,
        [Parameter(Mandatory = $true)][string]$CandidateConfig,
        [Parameter(Mandatory = $true)][bool]$ExpectSuccess
    )

    $arguments = @($cargoArguments) + @(
        "--artifact",
        $CandidateArtifact,
        "--signature",
        $CandidateSignature,
        "--config",
        $CandidateConfig
    )
    & cargo @arguments
    $exitCode = $LASTEXITCODE
    if ($ExpectSuccess -and $exitCode -ne 0) {
        throw "$Label was expected to pass, but the verifier exited with $exitCode."
    }
    if (-not $ExpectSuccess -and $exitCode -eq 0) {
        throw "$Label was expected to fail, but the verifier accepted it."
    }
    $result = if ($ExpectSuccess) { "accepted" } else { "rejected" }
    Write-Host "$Label $result as expected." -ForegroundColor Green
}

$tempRoot = Join-Path (
    if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
        [IO.Path]::GetTempPath()
    } else {
        $env:RUNNER_TEMP
    }
) ("mioproxy-updater-signature-test-" + [Guid]::NewGuid().ToString("N"))

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

    Invoke-SignatureVerification -Label "Valid generated NSIS artifact and .sig" -CandidateArtifact $artifactPath -CandidateSignature $signaturePath -CandidateConfig $configPath -ExpectSuccess $true

    $tamperedArtifact = Join-Path $tempRoot "tampered-installer.exe"
    Copy-Item -LiteralPath $artifactPath -Destination $tamperedArtifact
    $bytes = [IO.File]::ReadAllBytes($tamperedArtifact)
    if ($bytes.Length -eq 0) {
        throw "The NSIS artifact is empty; cannot run the byte-tamper regression test."
    }
    $bytes[0] = [byte]($bytes[0] -bxor 1)
    [IO.File]::WriteAllBytes($tamperedArtifact, $bytes)

    Invoke-SignatureVerification -Label "One-byte-modified installer copy" -CandidateArtifact $tamperedArtifact -CandidateSignature $signaturePath -CandidateConfig $configPath -ExpectSuccess $false

    $wrongConfig = Join-Path $tempRoot "wrong-public-key-tauri.conf.json"
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $publicKeyText = [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String([string]$config.plugins.updater.pubkey)
    )
    $publicKeyLines = $publicKeyText -split '\r?\n'
    if ($publicKeyLines.Count -lt 2 -or [string]::IsNullOrWhiteSpace($publicKeyLines[1])) {
        throw "The configured updater public key did not have the expected Minisign text form."
    }
    $rawPublicKey = [string]$publicKeyLines[1]
    $mutationIndex = 20
    if ($rawPublicKey.Length -le $mutationIndex) {
        throw "The configured updater public key is too short for the wrong-key regression test."
    }
    $replacement = if ($rawPublicKey[$mutationIndex] -eq "A") { "B" } else { "A" }
    $publicKeyLines[1] = $rawPublicKey.Substring(0, $mutationIndex) + $replacement + $rawPublicKey.Substring($mutationIndex + 1)
    $wrongPublicKeyText = $publicKeyLines -join [Environment]::NewLine
    $config.plugins.updater.pubkey = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($wrongPublicKeyText))
    [IO.File]::WriteAllText(
        $wrongConfig,
        ($config | ConvertTo-Json -Depth 20) + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )

    Invoke-SignatureVerification -Label "Installer with deliberately wrong public key" -CandidateArtifact $artifactPath -CandidateSignature $signaturePath -CandidateConfig $wrongConfig -ExpectSuccess $false
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
