param(
    [Parameter(Mandatory = $true)]
    [string]$SnapshotPath,
    [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$settingsPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$requiredFields = @('proxyEnable', 'proxyServer', 'proxyOverride', 'autoConfigUrl', 'autoDetect')

if (-not (Test-Path -LiteralPath $SnapshotPath)) {
    throw "System Proxy snapshot not found: $SnapshotPath"
}
$snapshot = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
foreach ($field in $requiredFields) {
    if ($null -eq $snapshot.PSObject.Properties[$field]) {
        throw "System Proxy snapshot is incomplete: missing $field"
    }
}

if (-not $Execute) {
    Write-Host "Recovery script prepared for exact snapshot: $SnapshotPath"
    exit 0
}

function Restore-Value([string]$Name, $Value) {
    if ($null -eq $Value) {
        Remove-ItemProperty -Path $settingsPath -Name $Name -ErrorAction SilentlyContinue
    } else {
        Set-ItemProperty -Path $settingsPath -Name $Name -Value $Value
    }
}

$logDir = Join-Path $PSScriptRoot '..\artifacts\v09-system-proxy'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir ("recovery-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$before = Get-ItemProperty $settingsPath

Restore-Value 'ProxyEnable' $snapshot.proxyEnable
Restore-Value 'ProxyServer' $snapshot.proxyServer
Restore-Value 'ProxyOverride' $snapshot.proxyOverride
Restore-Value 'AutoConfigURL' $snapshot.autoConfigUrl
Restore-Value 'AutoDetect' $snapshot.autoDetect

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MioProxyWinInet {
    [DllImport("wininet.dll", SetLastError = true)]
    public static extern bool InternetSetOption(IntPtr hInternet, int option, IntPtr buffer, int bufferLength);
}
'@
[void][MioProxyWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void][MioProxyWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)

$after = Get-ItemProperty $settingsPath
$matches =
    $after.ProxyEnable -eq $snapshot.proxyEnable -and
    $after.ProxyServer -eq $snapshot.proxyServer -and
    $after.ProxyOverride -eq $snapshot.proxyOverride -and
    $after.AutoConfigURL -eq $snapshot.autoConfigUrl -and
    $after.AutoDetect -eq $snapshot.autoDetect

[pscustomobject]@{
    at = (Get-Date).ToString('o')
    snapshotPath = $SnapshotPath
    restoredExact = $matches
    before = [pscustomobject]@{
        proxyEnable = $before.ProxyEnable
        proxyServer = $before.ProxyServer
        proxyOverride = $before.ProxyOverride
        autoConfigUrl = $before.AutoConfigURL
        autoDetect = $before.AutoDetect
    }
    after = [pscustomobject]@{
        proxyEnable = $after.ProxyEnable
        proxyServer = $after.ProxyServer
        proxyOverride = $after.ProxyOverride
        autoConfigUrl = $after.AutoConfigURL
        autoDetect = $after.AutoDetect
    }
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $logPath -Encoding utf8

if (-not $matches) {
    throw "System Proxy recovery did not match its exact snapshot. Log: $logPath"
}
Write-Host "Recovery applied and logged to $logPath"
