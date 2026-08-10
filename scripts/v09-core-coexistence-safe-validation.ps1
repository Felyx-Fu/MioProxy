$ErrorActionPreference = 'Stop'

$artifactDir = Join-Path $PSScriptRoot '..\artifacts\v09-core-coexistence'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$logPath = Join-Path $artifactDir ("core-coexistence-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
$token = (Get-Content (Join-Path $dataDir 'service-token') -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($token)) { throw 'MioProxy Service token is unavailable.' }

function Invoke-MioProxyServiceCommand([hashtable]$command) {
    $request = [ordered]@{
        protocolVersion = 1
        clientVersion = '0.9.1'
        token = $token
        command = $command
    } | ConvertTo-Json -Compress -Depth 5
    $lastError = $null
    foreach ($delay in @(0, 250, 500, 1000, 2000, 4000)) {
        if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
        $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'MioProxyService', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None)
        try {
            $pipe.Connect(1000)
            $writer = [System.IO.StreamWriter]::new($pipe)
            $writer.AutoFlush = $true
            $writer.WriteLine($request)
            $reader = [System.IO.StreamReader]::new($pipe)
            return $reader.ReadLine() | ConvertFrom-Json
        } catch {
            $lastError = $_
        } finally {
            $pipe.Dispose()
        }
    }
    throw $lastError
}

function Get-MihomoProcesses {
    Get-CimInstance Win32_Process -Filter "Name='mihomo.exe'" | ForEach-Object {
        $ports = Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty LocalPort
        [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; path = $_.ExecutablePath; listeningPorts = @($ports) }
    }
}

$proxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$before = @(Get-MihomoProcesses)
$start = Invoke-MioProxyServiceCommand @{ command = 'start' }
if (-not $start.ok) { throw "MioProxy managed Core did not start: $($start.error)" }
$status = Invoke-MioProxyServiceCommand @{ command = 'status' }
if (-not $status.ok -or -not $status.data.core.running) { throw 'MioProxy managed Core did not pass the Service health check.' }
$after = @(Get-MihomoProcesses)
$managed = @($after | Where-Object { $_.path -eq 'C:\Program Files\MioProxy\mihomo.exe' })
$afterProxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$result = [ordered]@{
    at = (Get-Date).ToString('o')
    coreRunning = [bool]$status.data.core.running
    managedCore = @($managed)
    externalMihomoBefore = @($before | Where-Object { $_.path -ne 'C:\Program Files\MioProxy\mihomo.exe' })
    externalMihomoAfter = @($after | Where-Object { $_.path -ne 'C:\Program Files\MioProxy\mihomo.exe' })
    mixedPort = $status.data.core.mixedPort
    controller = $status.data.core.controller
    systemProxyUnchanged = $proxy.ProxyEnable -eq $afterProxy.ProxyEnable -and $proxy.ProxyServer -eq $afterProxy.ProxyServer
    mioProxyTunUp = [bool](Get-NetAdapter -Name MioProxy -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up')
    serviceRunning = (Get-Service MioProxyService).Status.ToString()
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $logPath
$result | ConvertTo-Json -Depth 6 -Compress
