param(
    [ValidateRange(30, 900)]
    [int]$WaitForTunSeconds = 180,
    [ValidateRange(5, 60)]
    [int]$StartupGraceSeconds = 15,
    [ValidateRange(5, 30)]
    [int]$RequestTimeoutSeconds = 15,
    [switch]$ValidateActiveTun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifactDir = Join-Path $root 'artifacts\v09-core-functional'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $artifactDir "tun-core-functional-$stamp.json"
$dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
$controller = 'http://127.0.0.1:19090'
$domesticEndpoints = @(
    [pscustomobject]@{ Name = 'baidu'; Url = 'https://www.baidu.com' },
    [pscustomobject]@{ Name = 'gov'; Url = 'https://www.gov.cn' }
)
$foreignEndpoint = [pscustomobject]@{ Name = 'gstatic'; Url = 'https://www.gstatic.com/generate_204' }

function Get-Hash([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value)) |
            ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
    }
    finally { $sha.Dispose() }
}

function Sanitize([string]$Text, [string]$SelectedNode) {
    if ($null -eq $Text) { return $null }
    $value = $Text
    if ($SelectedNode) {
        $value = $value.Replace($SelectedNode, "node:$((Get-Hash $SelectedNode))")
    }
    $value = [regex]::Replace($value, '(?i)(authorization|token|secret|password|uuid|private-key)=?\s*[^\s,;"'']+', '$1=***')
    $value = [regex]::Replace($value, '(?i)bearer\s+\S+', 'Bearer ***')
    # Never persist arbitrary upstream hostnames from Mihomo diagnostics.
    $value = [regex]::Replace($value, '(?i)(?<![\w-])([a-z0-9-]+\.)+[a-z]{2,}(?![\w-])', 'hostname:***')
    return $value
}

function Invoke-ServiceStatus {
    $tokenPath = Join-Path $dataDir 'service-token'
    if (-not (Test-Path -LiteralPath $tokenPath)) { throw 'MioProxy service token is missing.' }
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $serviceVersion = (Get-Item -LiteralPath 'C:\Program Files\MioProxy\mioproxy-service.exe').VersionInfo.FileVersion
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'MioProxyService', [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $pipe.Connect(1500)
        $writer = [System.IO.StreamWriter]::new($pipe)
        $writer.AutoFlush = $true
        $request = @{ protocolVersion = 1; clientVersion = $serviceVersion; token = $token; command = @{ command = 'status' } } |
            ConvertTo-Json -Compress -Depth 4
        $writer.WriteLine($request)
        $reader = [System.IO.StreamReader]::new($pipe)
        $response = $reader.ReadLine() | ConvertFrom-Json
        if (-not $response.ok) { throw $response.error }
        return $response.data
    }
    finally { $pipe.Dispose() }
}

function Get-ControllerHeaders {
    $secretPath = Join-Path $dataDir 'controller-secret'
    if (-not (Test-Path -LiteralPath $secretPath)) { throw 'MioProxy controller secret is missing.' }
    return @{ Authorization = "Bearer $((Get-Content -LiteralPath $secretPath -Raw).Trim())" }
}

function Get-CoreObservation {
    $service = Get-CimInstance Win32_Service -Filter "Name='MioProxyService'" -ErrorAction Stop
    $status = Invoke-ServiceStatus
    $headers = Get-ControllerHeaders
    $version = Invoke-RestMethod -Headers $headers -TimeoutSec 10 -Uri "$controller/version"
    $managedPid = @(Get-CimInstance Win32_Process -Filter "Name='mihomo.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $service.ProcessId } |
        Select-Object -First 1 -ExpandProperty ProcessId)[0]
    $mixedPort = [int]$status.core.mixedPort
    $listener = Get-NetTCPConnection -State Listen -LocalPort $mixedPort -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $managedPid } |
        Select-Object -First 1
    [pscustomobject]@{
        ServicePid = $service.ProcessId
        ManagedCorePid = $managedPid
        MixedPort = $mixedPort
        ControllerHealthy = ($null -ne $version.version)
        CoreRunning = [bool]$status.core.running
        ListenerOwnedByManagedCore = ($null -ne $listener)
        Ready = ([bool]$status.core.running -and $null -ne $managedPid -and $null -ne $listener -and $null -ne $version.version)
    }
}

function Get-SelectionObservation {
    $proxies = Invoke-RestMethod -Headers (Get-ControllerHeaders) -TimeoutSec 10 -Uri "$controller/proxies"
    $selectors = @($proxies.proxies.PSObject.Properties | ForEach-Object {
            if ($_.Value.type -in @('Selector', 'URLTest', 'Fallback', 'LoadBalance') -and $_.Value.now) {
                [pscustomobject]@{ Group = $_.Name; Node = [string]$_.Value.now }
            }
        })
    $selected = @($selectors | Where-Object { $_.Group -eq 'PROXY' } | Select-Object -First 1)[0]
    if (-not $selected) { $selected = @($selectors | Select-Object -First 1)[0] }
    [pscustomobject]@{
        Group = if ($selected) { $selected.Group } else { $null }
        SelectedNode = if ($selected) { $selected.Node } else { $null }
        SelectedNodeHash = if ($selected) { Get-Hash $selected.Node } else { $null }
    }
}

function Get-TunObservation {
    $status = Invoke-ServiceStatus
    $configs = Invoke-RestMethod -Headers (Get-ControllerHeaders) -TimeoutSec 10 -Uri "$controller/configs"
    $adapter = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
        Where-Object { $_.Status -eq 'Up' -and $_.Name -eq 'MioProxy' } |
        Select-Object -First 1)[0]
    [pscustomobject]@{
        ServiceStatus = $status.tunStatus
        RuntimeConfigEnabled = [bool]$configs.tun.enable
        AdapterPresent = ($null -ne $adapter)
        AdapterIfIndex = if ($adapter) { $adapter.ifIndex } else { $null }
        ActualOn = ($status.tunStatus -eq 'running' -and [bool]$configs.tun.enable -and $null -ne $adapter)
    }
}

function Get-NetworkState {
    [pscustomobject]@{
        DefaultRoutes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
            Sort-Object RouteMetric | Select-Object InterfaceAlias, InterfaceIndex, NextHop, RouteMetric)
        Dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.ServerAddresses.Count -gt 0 } |
            ForEach-Object { [pscustomobject]@{ InterfaceAlias = $_.InterfaceAlias; InterfaceIndex = $_.InterfaceIndex; Servers = @($_.ServerAddresses) } })
    }
}

function Invoke-Delay([string]$SelectedNode) {
    if ([string]::IsNullOrWhiteSpace($SelectedNode)) { return [pscustomobject]@{ Passed = $false; DelayMs = $null; Error = 'No controller node is selected.' } }
    $path = "/proxies/$([uri]::EscapeDataString($SelectedNode))/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=10000"
    try {
        $response = Invoke-RestMethod -Headers (Get-ControllerHeaders) -TimeoutSec 15 -Uri "$controller$path"
        return [pscustomobject]@{ Passed = ($null -ne $response.delay); DelayMs = $response.delay; Error = $null }
    }
    catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
        return [pscustomobject]@{ Passed = $false; DelayMs = $null; Error = if ($status) { "HTTP $status" } else { 'Controller delay request failed.' } }
    }
}

function Invoke-TunCurl([pscustomobject]$Endpoint) {
    # --noproxy * makes this request independent of Windows System Proxy; it must use the active TUN path.
    $previousPreference = $ErrorActionPreference
    try {
        # A native curl failure is a test result, not a PowerShell harness failure.
        $ErrorActionPreference = 'Continue'
        $output = (& curl.exe --noproxy '*' --max-time $RequestTimeoutSeconds --silent --show-error --output NUL --write-out '%{http_code}' $Endpoint.Url 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    $status = [regex]::Match($output, '(\d{3})$').Groups[1].Value
    [pscustomobject]@{ Name = $Endpoint.Name; Passed = ($exitCode -eq 0 -and $status -match '^[23]'); HttpStatus = $status; ExitCode = $exitCode }
}

function Invoke-DnsProbe([pscustomobject]$Endpoint) {
    $hostName = ([uri]$Endpoint.Url).Host
    try {
        $answers = @(Resolve-DnsName -Name $hostName -DnsOnly -ErrorAction Stop |
            Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress -Unique)
        return [pscustomobject]@{ Name = $Endpoint.Name; Passed = ($answers.Count -gt 0); AnswerCount = $answers.Count }
    }
    catch { return [pscustomobject]@{ Name = $Endpoint.Name; Passed = $false; AnswerCount = 0 } }
}

function Start-LogCapture {
    param([string]$Token, [int]$Seconds)
    Start-Job -ArgumentList $Token, $Seconds -ScriptBlock {
        param($ControllerToken, $Duration)
        $socket = [Net.WebSockets.ClientWebSocket]::new()
        try {
            $socket.Options.SetRequestHeader('Authorization', "Bearer $ControllerToken")
            $socket.ConnectAsync([Uri]'ws://127.0.0.1:19090/logs?level=debug', [Threading.CancellationToken]::None).GetAwaiter().GetResult()
            $deadline = [DateTime]::UtcNow.AddSeconds($Duration)
            $buffer = New-Object byte[] 16384
            while ([DateTime]::UtcNow -lt $deadline -and $socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
                $receive = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None)
                if (-not $receive.Wait(1000)) { continue }
                $message = $receive.GetAwaiter().GetResult()
                if ($message.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
                [Text.Encoding]::UTF8.GetString($buffer, 0, $message.Count)
            }
        }
        finally { $socket.Dispose() }
    }
}

function Get-RouteClassification([object[]]$Logs, [string]$Domain, [string]$SelectedNode) {
    $matching = @($Logs | Where-Object { $_ -match [regex]::Escape($Domain) })
    if (@($matching | Where-Object { $_ -match '(?i)\bDIRECT\b' }).Count -gt 0) { return 'DIRECT' }
    if ($SelectedNode -and @($matching | Where-Object { $_ -match [regex]::Escape($SelectedNode) }).Count -gt 0) { return 'SELECTED_PROXY' }
    if (@($matching | Where-Object { $_ -match '(?i)\bPROXY\b' }).Count -gt 0) { return 'PROXY' }
    return 'UNKNOWN'
}

$result = [ordered]@{
    Timestamp = (Get-Date).ToString('o')
    Mode = 'MioProxy TUN only'
    Baseline = $null
    Tun = $null
    Core = $null
    Selection = $null
    Delay = $null
    Network = $null
    Dns = $null
    RouteClassification = $null
    RelevantMihomoLogs = @()
    Result = 'FAIL'
    Error = $null
    RecoveryInstruction = 'If this validation fails, reopen Clash Party external TUN manually to restore development connectivity.'
}
$logJob = $null
try {
    $result.Baseline = [pscustomobject]@{ Tun = Get-TunObservation; Network = Get-NetworkState }
    if ($result.Baseline.Tun.ActualOn) {
        if (-not $ValidateActiveTun) {
            throw 'MioProxy TUN is already active. Run this harness before the manual external-TUN to MioProxy-TUN handoff, or explicitly use -ValidateActiveTun.'
        }
        $result.Tun = $result.Baseline.Tun
    }
    else {
        $deadline = (Get-Date).AddSeconds($WaitForTunSeconds)
        do {
            Start-Sleep -Seconds 2
            $result.Tun = Get-TunObservation
        } until ($result.Tun.ActualOn -or (Get-Date) -ge $deadline)
        if (-not $result.Tun.ActualOn) {
            throw "MioProxy TUN did not become active within $WaitForTunSeconds seconds."
        }
    }

    Start-Sleep -Seconds $StartupGraceSeconds
    $result.Core = Get-CoreObservation
    $selection = Get-SelectionObservation
    $result.Selection = [pscustomobject]@{
        Group = $selection.Group
        SelectedNodeHash = $selection.SelectedNodeHash
    }
    $result.Delay = Invoke-Delay $selection.SelectedNode
    $logJob = Start-LogCapture -Token ((Get-Content -LiteralPath (Join-Path $dataDir 'controller-secret') -Raw).Trim()) -Seconds 25
    $result.Dns = @($domesticEndpoints + $foreignEndpoint | ForEach-Object { Invoke-DnsProbe $_ })
    $result.Network = @($domesticEndpoints + $foreignEndpoint | ForEach-Object { Invoke-TunCurl $_ })
    $rawLogs = @(Receive-Job -Job $logJob -Wait -AutoRemoveJob -ErrorAction SilentlyContinue)
    $logJob = $null
    $domains = @($domesticEndpoints + $foreignEndpoint | ForEach-Object { ([uri]$_.Url).Host })
    $result.RouteClassification = [pscustomobject]@{
        baidu = Get-RouteClassification $rawLogs $domains[0] $selection.SelectedNode
        gov = Get-RouteClassification $rawLogs $domains[1] $selection.SelectedNode
        foreign = Get-RouteClassification $rawLogs $domains[2] $selection.SelectedNode
    }
    $result.RelevantMihomoLogs = @($rawLogs |
        Where-Object { $_ -match ($domains -join '|') } |
        Select-Object -First 20 |
        ForEach-Object { Sanitize $_ $selection.SelectedNode })

    $domesticPass = @($result.Network | Where-Object { $_.Name -in @('baidu', 'gov') -and $_.Passed }).Count -eq 2
    $foreignPass = @($result.Network | Where-Object { $_.Name -eq 'gstatic' -and $_.Passed }).Count -eq 1
    $dnsPass = @($result.Dns | Where-Object { -not $_.Passed }).Count -eq 0
    if ($result.Core.Ready -and $result.Delay.Passed -and $domesticPass -and $foreignPass -and $dnsPass) {
        $result.Result = 'PASS'
    }
}
catch {
    $result.Error = Sanitize $_.Exception.Message $null
}
finally {
    if ($logJob) { Remove-Job -Job $logJob -Force -ErrorAction SilentlyContinue }
    $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $logPath -Encoding utf8
}

Write-Host "MIOPROXY TUN MODE = $($result.Result)"
Write-Host "Log: $logPath"
if ($result.Result -ne 'PASS') {
    Write-Host $result.RecoveryInstruction
    exit 1
}
