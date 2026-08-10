param(
    [switch]$IUnderstandCodexMayDisconnect
)

$ErrorActionPreference = 'Stop'

if (-not $IUnderstandCodexMayDisconnect) {
    throw 'This test stops MioProxyService for 30 seconds. Run it manually with -IUnderstandCodexMayDisconnect after confirming Codex connectivity can be interrupted.'
}

$artifactDir = Join-Path $PSScriptRoot '..\artifacts\v09-service-ipc'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $artifactDir "service-ipc-$timestamp.json"
$service = Get-CimInstance Win32_Service -Filter "Name='MioProxyService'"
if ($null -eq $service) {
    throw 'MioProxyService is not installed.'
}

$internetSettings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$defaultRoutes = Get-NetRoute -PolicyStore ActiveStore | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } |
    Sort-Object RouteMetric | Select-Object -First 2 InterfaceAlias, NextHop, RouteMetric
$result = [ordered]@{
    startedAt = (Get-Date).ToString('o')
    serviceWasRunning = $service.State -eq 'Running'
    servicePidBefore = $service.ProcessId
    mihomoCountBefore = @(Get-Process mihomo -ErrorAction SilentlyContinue).Count
    systemProxyBefore = [ordered]@{ enabled = [bool]$internetSettings.ProxyEnable; endpoint = $internetSettings.ProxyServer }
    defaultRoutesBefore = @($defaultRoutes)
    pipeBefore = Test-Path '\\.\pipe\MioProxyService'
    retries = @()
}

try {
    if ($result.serviceWasRunning) {
        Stop-Service -Name MioProxyService
    }
    Start-Sleep -Seconds 30
    $result.pipeWhileStopped = Test-Path '\\.\pipe\MioProxyService'
    $result.guiAliveWhileStopped = [bool](Get-Process mioproxy -ErrorAction SilentlyContinue)
    $result.mihomoCountWhileStopped = @(Get-Process mihomo -ErrorAction SilentlyContinue).Count
    if ($result.serviceWasRunning) {
        Start-Service -Name MioProxyService
    }
    foreach ($delay in @(250, 500, 1000, 2000, 4000)) {
        Start-Sleep -Milliseconds $delay
        $pipeReady = Test-Path '\\.\pipe\MioProxyService'
        $result.retries += [ordered]@{ delayMs = $delay; pipeReady = $pipeReady }
        if ($pipeReady) { break }
    }
} finally {
    $current = Get-Service -Name MioProxyService
    if ($result.serviceWasRunning -and $current.Status -ne 'Running') {
        Start-Service -Name MioProxyService
    }
    $after = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    $result.finishedAt = (Get-Date).ToString('o')
    $result.serviceAfter = (Get-Service -Name MioProxyService).Status.ToString()
    $result.servicePidAfter = (Get-CimInstance Win32_Service -Filter "Name='MioProxyService'").ProcessId
    $result.mihomoCountAfter = @(Get-Process mihomo -ErrorAction SilentlyContinue).Count
    $result.pipeAfter = Test-Path '\\.\pipe\MioProxyService'
    $result.systemProxyAfter = [ordered]@{ enabled = [bool]$after.ProxyEnable; endpoint = $after.ProxyServer }
    $result | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $logPath
    Write-Output $logPath
}
