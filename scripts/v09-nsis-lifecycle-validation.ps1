param(
    [switch]$IUnderstandCodexMayDisconnect,
    [switch]$SkipInstall,
    [string]$InstallerPath = ""
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $packageVersion = [string](Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
    if ([string]::IsNullOrWhiteSpace($packageVersion)) { throw 'Unable to read package version for the NSIS installer path.' }
    $InstallerPath = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis\MioProxy_${packageVersion}_x64-setup.exe"
}
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path

if (-not $IUnderstandCodexMayDisconnect) {
    throw 'This validation restarts MioProxyService. Review the current control path, then rerun with -IUnderstandCodexMayDisconnect.'
}
if (-not (Test-Path -LiteralPath $InstallerPath)) {
    throw "NSIS installer not found: $InstallerPath"
}

$logDir = Join-Path $PSScriptRoot '..\artifacts\v09-lifecycle'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir ("nsis-lifecycle-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$settingsPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

function Get-ProcessSnapshot {
    @(Get-CimInstance Win32_Process -Filter "Name='mihomo.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object {
            $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue |
                Sort-Object LocalPort, LocalAddress |
                Select-Object LocalAddress, LocalPort, State)
            [pscustomobject]@{
                pid = $_.ProcessId
                parentPid = $_.ParentProcessId
                path = $_.ExecutablePath
                listeners = $ports
            }
        })
}

function Invoke-MioProxyServiceCommand([hashtable]$Command) {
    $dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
    $token = (Get-Content -LiteralPath (Join-Path $dataDir 'service-token') -Raw).Trim()
    $servicePath = 'C:\Program Files\MioProxy\mioproxy-service.exe'
    $clientVersion = (Get-Item -LiteralPath $servicePath).VersionInfo.FileVersion
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'MioProxyService', [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(2000)
        $writer = [System.IO.StreamWriter]::new($client)
        $writer.AutoFlush = $true
        $request = @{ protocolVersion = 1; clientVersion = $clientVersion; token = $token; command = $Command } | ConvertTo-Json -Compress -Depth 4
        $writer.WriteLine($request)
        $reader = [System.IO.StreamReader]::new($client)
        $response = $reader.ReadLine() | ConvertFrom-Json
        if (-not $response.ok) { throw "MioProxy Service IPC failed: $($response.error)" }
        return $response.data
    }
    finally {
        $client.Dispose()
    }
}

function Get-State {
    $proxy = Get-ItemProperty -Path $settingsPath
    $service = Get-CimInstance Win32_Service -Filter "Name='MioProxyService'" -ErrorAction SilentlyContinue
    [pscustomobject]@{
        at = (Get-Date).ToString('o')
        systemProxy = [pscustomobject]@{
            proxyEnable = $proxy.ProxyEnable
            proxyServer = $proxy.ProxyServer
            proxyOverride = $proxy.ProxyOverride
        }
        service = [pscustomobject]@{
            state = if ($service) { $service.State } else { 'Missing' }
            pid = if ($service) { $service.ProcessId } else { $null }
        }
        mihomo = Get-ProcessSnapshot
        foreignTun = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Status -eq 'Up' -and
                $_.Name -notmatch 'MioProxy' -and
                ($_.Name -match 'clash|mihomo|mimo|meta.*tunnel|wintun|\btun\b' -or $_.InterfaceDescription -match 'clash|mihomo|mimo|meta.*tunnel|wintun|\btun\b')
            } |
            Select-Object Name, InterfaceDescription, Status, ifIndex)
        mioProxyTunUp = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'MioProxy' -and $_.Status -eq 'Up' }).Count
        defaultRoutes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
            Select-Object InterfaceIndex, NextHop, RouteMetric, ifMetric, PolicyStore)
        dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.ServerAddresses.Count -gt 0 } |
            Select-Object InterfaceIndex, ServerAddresses)
    }
}

$before = Get-State
$recoveryScript = Join-Path $PSScriptRoot 'v09-service-ipc-recovery.ps1'
if (-not (Test-Path -LiteralPath $recoveryScript)) {
    throw "Required Service recovery script not found: $recoveryScript"
}
$result = [ordered]@{
    before = $before
    installer = (Get-Item -LiteralPath $InstallerPath).FullName
    startedGuiWithoutCoreAction = $false
    serviceReady = $false
    managedCore = @()
    mixedPort = $null
    serviceReportedMixedPort = $null
    mixedPortListenerOwned = $false
    runtimeInterfaceName = $null
    encryptedProxyServerDns = $false
    controllerHealthy = $false
    guiVersion = $null
    serviceVersion = $null
    explicitProxyHttpCode = $null
    systemProxyPreserved = $false
    externalMihomoPreserved = $false
    externalTunPreserved = $false
    routesPreserved = $false
    dnsPreserved = $false
    after = $null
    error = $null
}

try {
    if (-not $SkipInstall) {
        Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait
    }
    $guiPath = 'C:\Program Files\MioProxy\mioproxy.exe'
    if (-not (Test-Path -LiteralPath $guiPath)) {
        throw "Installed GUI not found: $guiPath"
    }
    Start-Process -FilePath $guiPath
    $result.startedGuiWithoutCoreAction = $true
    $result.guiVersion = (Get-Item -LiteralPath $guiPath).VersionInfo.FileVersion
    $result.serviceVersion = (Get-Item -LiteralPath 'C:\Program Files\MioProxy\mioproxy-service.exe').VersionInfo.FileVersion

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $service = Get-CimInstance Win32_Service -Filter "Name='MioProxyService'" -ErrorAction SilentlyContinue
        $managed = @(Get-ProcessSnapshot | Where-Object { $service -and $_.parentPid -eq $service.ProcessId })
        if ($service -and $service.State -eq 'Running' -and $managed.Count -gt 0) {
            $result.serviceReady = $true
            $result.managedCore = $managed
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $result.serviceReady) {
        throw 'MioProxyService did not reach Running with a managed Mihomo child within 30 seconds.'
    }

    $configPath = Join-Path $env:APPDATA 'dev.MioProxy\config.yaml'
    $config = Get-Content -LiteralPath $configPath -Raw
    $match = [regex]::Match($config, '(?m)^mixed-port:\s*(\d+)\s*$')
    if (-not $match.Success) {
        throw 'Runtime mixed-port was not recorded in the generated MioProxy config.'
    }
    $result.mixedPort = [int]$match.Groups[1].Value
    if ($result.mixedPort -in @(7890, 7891, 7892)) {
        throw "MioProxy selected externally occupied mixed-port $($result.mixedPort)."
    }
    $interfaceMatch = [regex]::Match($config, '(?m)^interface-name:\s*["'']?([^\r\n"'']+)["'']?\s*$')
    if ($interfaceMatch.Success) {
        $result.runtimeInterfaceName = $interfaceMatch.Groups[1].Value.Trim()
    }
    $proxyServerNameserver = [regex]::Match($config, '(?ms)^\s*proxy-server-nameserver:\s*\r?\n(?<items>(?:\s*-\s*.*(?:\r?\n|$))+)')
    $result.encryptedProxyServerDns = $proxyServerNameserver.Success -and $proxyServerNameserver.Groups['items'].Value -match '(?m)^\s*-\s*(tls://|https://).+$'
    if ($before.foreignTun.Count -gt 0 -and [string]::IsNullOrWhiteSpace($result.runtimeInterfaceName)) {
        throw 'Foreign TUN is active but generated runtime config has no safe outbound interface binding.'
    }
    if ($before.foreignTun.Count -gt 0 -and -not $result.encryptedProxyServerDns) {
        throw 'Foreign TUN is active but generated runtime config has no encrypted proxy-server-nameserver.'
    }
    $managedPid = [int]$result.managedCore[0].pid
    $result.mixedPortListenerOwned = @(Get-NetTCPConnection -State Listen -LocalPort $result.mixedPort -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $managedPid }).Count -gt 0
    if (-not $result.mixedPortListenerOwned) {
        throw "MioProxy mixed-port $($result.mixedPort) is not owned by managed Mihomo PID $managedPid."
    }
    $status = Invoke-MioProxyServiceCommand @{ command = 'status' }
    $result.serviceReportedMixedPort = [int]$status.core.mixedPort
    if (-not $status.running -or -not $status.ownsCore -or $result.serviceReportedMixedPort -ne $result.mixedPort) {
        throw 'MioProxy Service status did not report a healthy owned Core at the generated mixed-port.'
    }
    $listeners = @(Invoke-MioProxyServiceCommand @{ command = 'portDiagnostics'; port = $result.mixedPort })
    if (@($listeners | Where-Object { $_.owner -eq 'mioProxyManaged' -and $_.owningPid -eq $managedPid -and $_.state -eq 'listen' }).Count -eq 0) {
        throw "MioProxy Service native detector did not attribute mixed-port $($result.mixedPort) to PID $managedPid."
    }
    $controllerSecret = (Get-Content -LiteralPath (Join-Path $env:APPDATA 'dev.MioProxy\controller-secret') -Raw).Trim()
    $controllerResponse = Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = "Bearer $controllerSecret" } -TimeoutSec 5 -Uri 'http://127.0.0.1:19090/version'
    $result.controllerHealthy = $controllerResponse.StatusCode -eq 200
    if (-not $result.controllerHealthy) { throw 'MioProxy controller health check failed.' }
    $result.explicitProxyHttpCode = (& curl.exe --proxy "http://127.0.0.1:$($result.mixedPort)" --connect-timeout 5 --max-time 15 -sS -o NUL -w '%{http_code}' https://www.baidu.com 2>&1 | Out-String).Trim()
    if ($result.explicitProxyHttpCode -ne '200') {
        throw "MioProxy explicit proxy validation failed: $($result.explicitProxyHttpCode)"
    }
    $after = Get-State
    $result.after = $after
    $result.systemProxyPreserved =
        $before.systemProxy.proxyEnable -eq $after.systemProxy.proxyEnable -and
        $before.systemProxy.proxyServer -eq $after.systemProxy.proxyServer -and
        $before.systemProxy.proxyOverride -eq $after.systemProxy.proxyOverride
    $externalBefore = @($before.mihomo | Where-Object { $_.parentPid -ne $before.service.pid })
    $afterPids = @($after.mihomo | ForEach-Object { $_.pid })
    $result.externalMihomoPreserved = @($externalBefore | Where-Object { $afterPids -contains $_.pid }).Count -eq $externalBefore.Count
    $result.externalTunPreserved = ($before.foreignTun | ConvertTo-Json -Compress) -eq ($after.foreignTun | ConvertTo-Json -Compress)
    $result.routesPreserved = ($before.defaultRoutes | ConvertTo-Json -Compress) -eq ($after.defaultRoutes | ConvertTo-Json -Compress)
    $result.dnsPreserved = ($before.dns | ConvertTo-Json -Compress) -eq ($after.dns | ConvertTo-Json -Compress)
    if (-not $result.systemProxyPreserved) {
        throw 'Windows System Proxy changed during NSIS validation; recovery was not applied automatically.'
    }
    if (-not $result.externalMihomoPreserved) {
        throw 'An external Mihomo PID was not preserved during NSIS validation.'
    }
    if (-not $result.externalTunPreserved -or -not $result.routesPreserved -or -not $result.dnsPreserved) {
        throw 'External TUN, default route, or DNS changed during NSIS validation; no external recovery was attempted.'
    }
} catch {
    $result.error = $_.Exception.Message
} finally {
    if (-not $result.after) { $result.after = Get-State }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $logPath -Encoding utf8
}

if ($result.error) {
    throw "$($result.error) Log: $logPath"
}
Write-Host "Lifecycle validation passed. Log: $logPath"
