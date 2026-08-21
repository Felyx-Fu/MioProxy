$ErrorActionPreference = 'Stop'

$artifactDir = Join-Path $PSScriptRoot '..\artifacts\v09-foreign-tun'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$logPath = Join-Path $artifactDir ("foreign-tun-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
$token = (Get-Content (Join-Path $dataDir 'service-token') -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($token)) { throw 'MioProxy Service token is unavailable.' }

function Invoke-MioProxyServiceCommand([hashtable]$command) {
    $request = [ordered]@{
        protocolVersion = 1
        clientVersion = '0.9.2'
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

$proxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$serviceBefore = Get-CimInstance Win32_Service -Filter "Name='MioProxyService'"
$foreignBefore = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and $_.Name -ne 'MioProxy' -and ($_.Name -match '(?i)(clash|mihomo|mimo|meta.*tunnel|wintun|\btun\b)' -or $_.InterfaceDescription -match '(?i)(clash|mihomo|mimo|meta.*tunnel|wintun|\btun\b)') } | Select-Object Name,InterfaceDescription,Status
$response = Invoke-MioProxyServiceCommand @{ command = 'tunSetEnabled'; enabled = $true; profileId = ''; systemProxyEnabled = $false }
$status = Invoke-MioProxyServiceCommand @{ command = 'status' }
$serviceAfter = Get-CimInstance Win32_Service -Filter "Name='MioProxyService'"
$after = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$result = [ordered]@{
    at = (Get-Date).ToString('o')
    guiAlive = [bool](Get-Process mioproxy -ErrorAction SilentlyContinue)
    foreignTunBefore = @($foreignBefore)
    tunRequestRejected = -not [bool]$response.ok
    tunRequestError = $response.error
    statusRequestOk = [bool]$status.ok
    serviceStayedRunning = $serviceBefore.State -eq 'Running' -and $serviceAfter.State -eq 'Running'
    servicePidUnchanged = $serviceBefore.ProcessId -eq $serviceAfter.ProcessId
    mioProxyTunUp = [bool](Get-NetAdapter -Name MioProxy -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up')
    systemProxyUnchanged = $proxy.ProxyEnable -eq $after.ProxyEnable -and $proxy.ProxyServer -eq $after.ProxyServer
    pipeAvailable = Test-Path '\\.\pipe\MioProxyService'
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $logPath
$result | ConvertTo-Json -Depth 6 -Compress
