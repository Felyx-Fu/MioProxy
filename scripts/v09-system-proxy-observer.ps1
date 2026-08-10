param(
    [ValidateRange(1, 65535)]
    [int]$MixedPort = 7893,
    [ValidateRange(60, 7200)]
    [int]$DurationSeconds = 1800,
    [ValidateRange(1, 30)]
    [int]$IntervalSeconds = 2,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
$settingsPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$serviceName = 'MioProxyService'
if (-not $LogPath) {
    $directory = Join-Path $PSScriptRoot '..\artifacts\v09-system-proxy'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $LogPath = Join-Path $directory ("observer-{0}.jsonl" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}

function Invoke-ServiceStatus {
    try {
        $token = (Get-Content -LiteralPath (Join-Path $dataDir 'service-token') -Raw).Trim()
        $version = (Get-Item -LiteralPath 'C:\Program Files\MioProxy\mioproxy-service.exe').VersionInfo.FileVersion
        $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'MioProxyService', [System.IO.Pipes.PipeDirection]::InOut)
        try {
            $pipe.Connect(1000)
            $writer = [System.IO.StreamWriter]::new($pipe)
            $writer.AutoFlush = $true
            $request = @{ protocolVersion = 1; clientVersion = $version; token = $token; command = @{ command = 'status' } } | ConvertTo-Json -Compress -Depth 4
            $writer.WriteLine($request)
            $reader = [System.IO.StreamReader]::new($pipe)
            $response = $reader.ReadLine() | ConvertFrom-Json
            if (-not $response.ok) { throw $response.error }
            return $response.data
        }
        finally { $pipe.Dispose() }
    }
    catch { return [pscustomobject]@{ observerError = $_.Exception.Message } }
}

function Get-ObserverState {
    $proxy = Get-ItemProperty -Path $settingsPath
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
    $mihomo = @(Get-CimInstance Win32_Process -Filter "Name='mihomo.exe'" -ErrorAction SilentlyContinue |
        Select-Object ProcessId, ParentProcessId)
    $status = Invoke-ServiceStatus
    $managedPid = if ($service) { @($mihomo | Where-Object ParentProcessId -eq $service.ProcessId | Select-Object -First 1).ProcessId } else { $null }
    $externalPids = @($mihomo | Where-Object ProcessId -ne $managedPid | ForEach-Object ProcessId)
    $endpoint = "127.0.0.1:$MixedPort"
    [pscustomobject]@{
        at = (Get-Date).ToString('o')
        systemProxy = [pscustomobject]@{
            proxyEnable = $proxy.ProxyEnable
            proxyServer = $proxy.ProxyServer
            proxyOverride = $proxy.ProxyOverride
            autoConfigUrl = $proxy.AutoConfigURL
            autoDetect = $proxy.AutoDetect
            ownership = if ($proxy.ProxyEnable -eq 1 -and $proxy.ProxyServer -eq $endpoint) { 'MioProxy' } elseif ($proxy.ProxyEnable -eq 1) { 'External' } else { 'None' }
        }
        service = [pscustomobject]@{ state = if ($service) { $service.State } else { 'Missing' }; pid = if ($service) { $service.ProcessId } else { $null } }
        core = [pscustomobject]@{
            mixedPort = $MixedPort
            managedPid = $managedPid
            externalMihomoPids = $externalPids
            running = if ($status.observerError) { $null } else { $status.running }
            ownsCore = if ($status.observerError) { $null } else { $status.ownsCore }
            serviceError = $status.observerError
        }
        foreignTun = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
            Where-Object { $_.Status -eq 'Up' -and $_.Name -notmatch 'MioProxy' -and $_.InterfaceDescription -match 'Mimo|Meta Tunnel' } |
            Select-Object Name, InterfaceDescription, ifIndex, Status)
        defaultRoutes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
            Select-Object InterfaceIndex, NextHop, RouteMetric)
        dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.ServerAddresses.Count -gt 0 } |
            Select-Object InterfaceIndex, ServerAddresses)
    }
}

$deadline = (Get-Date).AddSeconds($DurationSeconds)
while ((Get-Date) -lt $deadline) {
    Get-ObserverState | ConvertTo-Json -Depth 7 -Compress | Add-Content -LiteralPath $LogPath -Encoding utf8
    Start-Sleep -Seconds $IntervalSeconds
}
