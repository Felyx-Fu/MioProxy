[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$ConfirmManualNetworkChanges,
    [ValidateRange(30, 600)]
    [int]$TimeoutSeconds = 120,
    [ValidateRange(5, 60)]
    [int]$RequestTimeoutSeconds = 20,
    [string]$LogPath = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
$settingsPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$serviceName = 'MioProxyService'
$servicePath = 'C:\Program Files\MioProxy\mioproxy-service.exe'
$controller = 'http://127.0.0.1:19090'
$artifactDir = Join-Path $root 'artifacts\release-readiness'
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
    $LogPath = Join-Path $artifactDir "system-proxy-tun-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
}

if (-not $Execute) {
    Write-Host 'Read-only plan. No Service command, registry write, process action or network toggle was performed.'
    Write-Host 'To run the explicit Windows acceptance flow, start with MioProxy System Proxy and MioProxy TUN both ON, then use:'
    Write-Host '  powershell -ExecutionPolicy Bypass -File .\scripts\release-system-proxy-tun-readiness.ps1 -Execute -ConfirmManualNetworkChanges'
    return
}
if (-not $ConfirmManualNetworkChanges) {
    throw 'This validation includes an explicit managed TUN transition and asks for a manual System Proxy toggle. Rerun with -ConfirmManualNetworkChanges.'
}

$domesticEndpoints = @(
    [pscustomobject]@{ Name = 'baidu'; Url = 'https://www.baidu.com'; Host = 'www.baidu.com' },
    [pscustomobject]@{ Name = 'gov'; Url = 'https://www.gov.cn'; Host = 'www.gov.cn' }
)
$foreignEndpoints = @(
    [pscustomobject]@{ Name = 'gstatic'; Url = 'https://www.gstatic.com/generate_204'; Host = 'www.gstatic.com' }
)

function Get-Hash12([string]$Value) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))) -replace '-', '').ToLowerInvariant()).Substring(0, 12)
    }
    finally { $sha.Dispose() }
}

function Sanitize([string]$Text) {
    if ($null -eq $Text) { return $null }
    $value = [regex]::Replace($Text, '(?i)(authorization|token|secret|password|uuid|private-key)=?\s*[^\s,;"'']+', '$1=***')
    return [regex]::Replace($value, '(?i)bearer\s+\S+', 'Bearer ***')
}

function Get-ServiceClientVersion {
    if (-not (Test-Path -LiteralPath $servicePath)) { throw "Installed MioProxy Service not found: $servicePath" }
    $version = (Get-Item -LiteralPath $servicePath).VersionInfo.FileVersion
    if ([string]::IsNullOrWhiteSpace($version)) { throw 'Installed MioProxy Service has no file version.' }
    return $version
}

function Invoke-ServiceCommand([hashtable]$Command) {
    $tokenPath = Join-Path $dataDir 'service-token'
    if (-not (Test-Path -LiteralPath $tokenPath)) { throw 'MioProxy Service token is missing.' }
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'MioProxy Service token is empty.' }
    $request = [ordered]@{
        protocolVersion = 1
        clientVersion = Get-ServiceClientVersion
        token = $token
        command = $Command
    } | ConvertTo-Json -Compress -Depth 6
    $lastError = $null
    foreach ($delay in @(0, 250, 500, 1000, 2000)) {
        if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
        $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'MioProxyService', [System.IO.Pipes.PipeDirection]::InOut)
        try {
            $pipe.Connect(1500)
            $writer = [System.IO.StreamWriter]::new($pipe)
            $writer.AutoFlush = $true
            $writer.WriteLine($request)
            $reader = [System.IO.StreamReader]::new($pipe)
            $line = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($line)) { throw 'MioProxy Service returned an empty IPC response.' }
            $response = $line | ConvertFrom-Json
            if (-not $response.ok) { throw (Sanitize ([string]$response.error)) }
            return $response.data
        }
        catch { $lastError = $_.Exception.Message }
        finally { $pipe.Dispose() }
    }
    throw "MioProxy Service IPC failed: $(Sanitize $lastError)"
}

function Get-ProxyObservation([int]$MixedPort) {
    $proxy = Get-ItemProperty -LiteralPath $settingsPath
    $enabled = if ($null -eq $proxy.ProxyEnable) { 0 } else { [int]$proxy.ProxyEnable }
    $proxyServer = [string]$proxy.ProxyServer
    $autoConfigUrl = [string]$proxy.AutoConfigURL
    $autoDetect = if ($null -eq $proxy.AutoDetect) { 0 } else { [int]$proxy.AutoDetect }
    $endpoint = "127.0.0.1:$MixedPort"
    $state = if ($enabled -eq 1 -and $proxyServer -eq $endpoint -and [string]::IsNullOrWhiteSpace($autoConfigUrl) -and $autoDetect -ne 1) {
        'mioproxy'
    } elseif ($enabled -eq 1 -or -not [string]::IsNullOrWhiteSpace($autoConfigUrl) -or $autoDetect -eq 1) {
        'external'
    } else {
        'disabled'
    }
    [pscustomobject]@{
        State = $state
        ProxyEnable = $enabled
        ProxyServer = $proxyServer
        ProxyOverride = [string]$proxy.ProxyOverride
        AutoConfigUrl = $autoConfigUrl
        AutoDetect = $autoDetect
    }
}

function Get-ForeignTunAdapters {
    @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Status -eq 'Up' -and $_.Name -notmatch '(?i)MioProxy' -and
            ($_.Name -match '(?i)clash|mihomo|mimo|meta.*tunnel|wintun|\btun\b' -or
                $_.InterfaceDescription -match '(?i)clash|mihomo|mimo|meta.*tunnel|wintun|\btun\b')
        } |
        Select-Object Name, InterfaceDescription, ifIndex, Status)
}

function Get-NetworkObservation {
    $routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object InterfaceIndex, NextHop, RouteMetric |
        ForEach-Object { [pscustomobject]@{ InterfaceIndex = $_.InterfaceIndex; NextHop = $_.NextHop; RouteMetric = $_.RouteMetric; PolicyStore = $_.PolicyStore } })
    $dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.ServerAddresses.Count -gt 0 } |
        Sort-Object InterfaceIndex |
        ForEach-Object { [pscustomobject]@{ InterfaceIndex = $_.InterfaceIndex; Servers = @($_.ServerAddresses) } })
    $payload = ([pscustomobject]@{ Routes = $routes; Dns = $dns } | ConvertTo-Json -Depth 8 -Compress)
    [pscustomobject]@{ Hash = Get-Hash12 $payload; RouteCount = $routes.Count; DnsInterfaceCount = $dns.Count }
}

function Get-Observation {
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop
    if (-not $service) { throw 'MioProxy Service is not installed.' }
    $status = Invoke-ServiceCommand @{ command = 'status' }
    $mixedPort = [int]$status.core.mixedPort
    $diagnostics = @(Invoke-ServiceCommand @{ command = 'portDiagnostics'; port = $mixedPort })
    $listener = @($diagnostics | Where-Object { $_.owner -eq 'mioProxyManaged' -and $_.state -eq 'listen' } | Select-Object -First 1)[0]
    $adapter = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'MioProxy' -and $_.Status -eq 'Up' } |
        Select-Object -First 1)[0]
    $foreignTun = Get-ForeignTunAdapters
    $proxy = Get-ProxyObservation $mixedPort
    $tunState = if ($foreignTun.Count -gt 0) {
        'external-present'
    } elseif ($status.tunStatus -eq 'running' -and $null -ne $adapter) {
        'mioproxy'
    } elseif ($status.tunStatus -eq 'disabled' -and $null -eq $adapter) {
        'disabled'
    } else {
        'transitioning-or-error'
    }
    $externalMihomo = @(Get-CimInstance Win32_Process -Filter "Name='mihomo.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -ne $service.ProcessId } |
        Select-Object -ExpandProperty ProcessId)
    [pscustomobject]@{
        ServiceState = [string]$service.State
        ServicePid = [int]$service.ProcessId
        CoreState = [string]$status.core.state
        CoreReady = ([string]$service.State -eq 'Running' -and [string]$status.core.state -eq 'ready' -and [bool]$status.core.running -and [bool]$status.ownsCore -and -not [bool]$status.ownershipConflict -and $null -ne $listener)
        MixedPort = $mixedPort
        ManagedListener = ($null -ne $listener)
        Proxy = $proxy
        TunState = $tunState
        TunOwned = ($tunState -eq 'mioproxy')
        TunProfileId = [string]$status.tunProfileId
        ForeignTun = @($foreignTun)
        ExternalMihomoPids = @($externalMihomo)
        Network = Get-NetworkObservation
    }
}

function Get-ObservationSummary($Observation) {
    [pscustomobject]@{
        ServiceState = $Observation.ServiceState
        CoreState = $Observation.CoreState
        CoreReady = $Observation.CoreReady
        MixedPort = $Observation.MixedPort
        SystemProxy = $Observation.Proxy.State
        Tun = $Observation.TunState
        ForeignTunCount = $Observation.ForeignTun.Count
        ExternalMihomoCount = $Observation.ExternalMihomoPids.Count
        NetworkHash = $Observation.Network.Hash
    }
}

function Wait-ForObservation([string]$Description, [scriptblock]$Predicate) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = $null
    do {
        try {
            $current = Get-Observation
            if (& $Predicate $current) { return $current }
        }
        catch { $lastError = $_.Exception.Message }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for $Description. Last error: $(Sanitize $lastError)"
}

function Invoke-HttpsProbe($Endpoint, [ValidateSet('tun', 'proxy')][string]$Path, [int]$MixedPort) {
    $curlArgs = @('--max-time', $RequestTimeoutSeconds, '--silent', '--show-error', '--output', 'NUL', '--write-out', '%{http_code}')
    if ($Path -eq 'tun') { $curlArgs += @('--noproxy', '*') }
    else { $curlArgs += @('--proxy', "http://127.0.0.1:$MixedPort") }
    $curlArgs += $Endpoint.Url
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& curl.exe @curlArgs 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    $status = [regex]::Match($output, '(\d{3})$').Groups[1].Value
    [pscustomobject]@{ Name = $Endpoint.Name; Path = $Path; Passed = ($exitCode -eq 0 -and $status -match '^[23]'); HttpStatus = $status; ExitCode = $exitCode }
}

function Invoke-DnsProbe($Endpoint) {
    try {
        $answers = @(Resolve-DnsName -Name $Endpoint.Host -DnsOnly -ErrorAction Stop |
            Where-Object { $_.IPAddress } |
            Select-Object -ExpandProperty IPAddress -Unique)
        return [pscustomobject]@{ Name = $Endpoint.Name; Passed = ($answers.Count -gt 0); AnswerCount = $answers.Count }
    }
    catch { return [pscustomobject]@{ Name = $Endpoint.Name; Passed = $false; AnswerCount = 0 } }
}

function Invoke-HealthProbe([ValidateSet('tun', 'proxy')][string]$Path, [int]$MixedPort) {
    $https = @($domesticEndpoints + $foreignEndpoints | ForEach-Object { Invoke-HttpsProbe $_ $Path $MixedPort })
    $dns = @($domesticEndpoints + $foreignEndpoints | ForEach-Object { Invoke-DnsProbe $_ })
    [pscustomobject]@{
        Path = $Path
        Https = $https
        Dns = $dns
        Passed = (@($https | Where-Object { -not $_.Passed }).Count -eq 0 -and @($dns | Where-Object { -not $_.Passed }).Count -eq 0)
    }
}

function Assert-BothOn($Observation, [string]$Context) {
    if (-not $Observation.CoreReady) { throw "${Context}: managed Core is not Ready." }
    if ($Observation.Proxy.State -ne 'mioproxy') { throw "${Context}: System Proxy ownership is '$($Observation.Proxy.State)', not MioProxy." }
    if (-not $Observation.TunOwned) { throw "${Context}: MioProxy TUN is not owned and running." }
    if ($Observation.ForeignTun.Count -gt 0) { throw "${Context}: an external TUN is present; refusing to continue." }
}

function Assert-NoForeignTun([string]$Context) {
    $current = Get-Observation
    if ($current.ForeignTun.Count -gt 0) { throw "${Context}: an external TUN appeared; refusing to issue a managed TUN command." }
    return $current
}

$result = [ordered]@{
    SchemaVersion = 1
    StartedAt = (Get-Date).ToString('o')
    Result = 'FAIL'
    Baseline = $null
    Tests = @()
    SystemProxyOffKeepsTunFunctional = $false
    TunOffKeepsSystemProxyFunctional = $false
    FinalStateRestored = $false
    ExternalResourcesPreserved = $false
    RecoveryAttempted = $false
    RecoveryError = $null
    Error = $null
    RecoveryInstruction = 'If this run stops before the final restore, use MioProxy GUI to restore System Proxy and TUN to the recorded initial state. Do not change or kill an external proxy/TUN owner.'
}
$baseline = $null
try {
    $baseline = Get-Observation
    $result.Baseline = Get-ObservationSummary $baseline
    Assert-BothOn $baseline 'Precondition'
    if ([string]::IsNullOrWhiteSpace($baseline.TunProfileId)) { throw 'Precondition: running MioProxy TUN has no recoverable Profile id.' }

    $bothOnHealth = Invoke-HealthProbe 'tun' $baseline.MixedPort
    $result.Tests += [pscustomobject]@{ Name = 'both-on'; Observation = Get-ObservationSummary $baseline; Health = $bothOnHealth }
    if (-not $bothOnHealth.Passed) { throw 'Both-on domestic/foreign HTTPS or DNS probe failed.' }

    Write-Host 'Disable MioProxy System Proxy in the GUI now. Keep MioProxy TUN ON and do not touch any external proxy/TUN. Press Enter when complete.' -ForegroundColor Yellow
    [void](Read-Host)
    $proxyOff = Wait-ForObservation 'MioProxy System Proxy OFF while TUN remains ON' { param($o) $o.Proxy.State -eq 'disabled' -and $o.TunOwned -and $o.ForeignTun.Count -eq 0 }
    $tunWithoutProxyHealth = Invoke-HealthProbe 'tun' $proxyOff.MixedPort
    $result.Tests += [pscustomobject]@{ Name = 'system-proxy-off-tun-on'; Observation = Get-ObservationSummary $proxyOff; Health = $tunWithoutProxyHealth }
    $result.SystemProxyOffKeepsTunFunctional = $tunWithoutProxyHealth.Passed
    if (-not $result.SystemProxyOffKeepsTunFunctional) { throw 'Disabling System Proxy did not leave MioProxy TUN domestic/foreign HTTPS and DNS functional.' }

    Write-Host 'Re-enable MioProxy System Proxy in the GUI now. Keep MioProxy TUN ON. Press Enter when complete.' -ForegroundColor Yellow
    [void](Read-Host)
    $proxyRestored = Wait-ForObservation 'MioProxy System Proxy ON' { param($o) $o.Proxy.State -eq 'mioproxy' -and $o.TunOwned -and $o.ForeignTun.Count -eq 0 }

    [void](Assert-NoForeignTun 'Before TUN OFF')
    [void](Invoke-ServiceCommand @{ command = 'tunSetEnabled'; enabled = $false; profileId = $null; systemProxyEnabled = $true })
    $tunOff = Wait-ForObservation 'MioProxy TUN OFF while System Proxy remains ON' { param($o) $o.Proxy.State -eq 'mioproxy' -and $o.TunState -eq 'disabled' -and $o.ForeignTun.Count -eq 0 }
    $proxyWithoutTunHealth = Invoke-HealthProbe 'proxy' $tunOff.MixedPort
    $result.Tests += [pscustomobject]@{ Name = 'tun-off-system-proxy-on'; Observation = Get-ObservationSummary $tunOff; Health = $proxyWithoutTunHealth }
    $result.TunOffKeepsSystemProxyFunctional = $proxyWithoutTunHealth.Passed
    if (-not $result.TunOffKeepsSystemProxyFunctional) { throw 'Disabling TUN did not leave MioProxy System Proxy domestic/foreign HTTPS and DNS functional.' }

    [void](Assert-NoForeignTun 'Before TUN restore')
    [void](Invoke-ServiceCommand @{ command = 'tunSetEnabled'; enabled = $true; profileId = $baseline.TunProfileId; systemProxyEnabled = $true })
    $final = Wait-ForObservation 'both-on final restore' { param($o) $o.Proxy.State -eq 'mioproxy' -and $o.TunOwned -and $o.ForeignTun.Count -eq 0 }
    $finalHealth = Invoke-HealthProbe 'tun' $final.MixedPort
    $result.Tests += [pscustomobject]@{ Name = 'final-both-on'; Observation = Get-ObservationSummary $final; Health = $finalHealth }
    if (-not $finalHealth.Passed) { throw 'Final both-on domestic/foreign HTTPS or DNS probe failed.' }
    $result.FinalStateRestored = $final.Proxy.State -eq $baseline.Proxy.State -and $final.TunState -eq $baseline.TunState -and $final.Network.Hash -eq $baseline.Network.Hash
    if (-not $result.FinalStateRestored) { throw 'Final managed network state does not match the initial state.' }
    $baselineExternalPids = (@($baseline.ExternalMihomoPids | Sort-Object) -join ',')
    $finalExternalPids = (@($final.ExternalMihomoPids | Sort-Object) -join ',')
    $baselineForeignTun = @($baseline.ForeignTun | ConvertTo-Json -Depth 5 -Compress)
    $finalForeignTun = @($final.ForeignTun | ConvertTo-Json -Depth 5 -Compress)
    $result.ExternalResourcesPreserved = $baselineExternalPids -eq $finalExternalPids -and ($baselineForeignTun -join '') -eq ($finalForeignTun -join '')
    if (-not $result.ExternalResourcesPreserved) { throw 'An external Mihomo/TUN resource changed during validation.' }
    $result.Result = 'PASS'
}
catch {
    $result.Error = Sanitize $_.Exception.Message
}
finally {
    if ($baseline) {
        try {
            $current = Get-Observation
            if ($current.TunState -ne 'mioproxy' -and $current.Proxy.State -eq 'mioproxy' -and $current.ForeignTun.Count -eq 0 -and -not [string]::IsNullOrWhiteSpace($baseline.TunProfileId)) {
                $result.RecoveryAttempted = $true
                [void](Invoke-ServiceCommand @{ command = 'tunSetEnabled'; enabled = $true; profileId = $baseline.TunProfileId; systemProxyEnabled = $true })
                [void](Wait-ForObservation 'managed TUN recovery' { param($o) $o.TunOwned -and $o.Proxy.State -eq 'mioproxy' -and $o.ForeignTun.Count -eq 0 })
            }
        }
        catch { $result.RecoveryError = Sanitize $_.Exception.Message }
    }
    $result.FinishedAt = (Get-Date).ToString('o')
    $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $LogPath -Encoding utf8
}

Write-Host "MioProxy System Proxy + TUN readiness = $($result.Result)"
Write-Host "Log: $LogPath"
if ($result.Result -ne 'PASS') {
    Write-Host $result.RecoveryInstruction -ForegroundColor Yellow
    if ($result.RecoveryError) { Write-Host "Automatic managed-TUN recovery: $($result.RecoveryError)" -ForegroundColor Red }
    exit 1
}
