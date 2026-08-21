[CmdletBinding()]
param(
    [string]$ManifestPath,
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ManifestPath = Join-Path $scriptDirectory '..\src-tauri\Cargo.toml'
}

$tree = & cargo tree --quiet --manifest-path $ManifestPath --locked --target $Target 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the locked dependency tree for target $Target."
}

if ($tree | Select-String -Pattern '(^|\s)glib v') {
    throw "The Windows release dependency surface unexpectedly includes glib."
}

Write-Output "Windows dependency surface is clear: glib is not selected for $Target."
