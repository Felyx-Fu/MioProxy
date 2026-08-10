param(
    [ValidateRange(1, 65535)]
    [int[]]$Port = @(7890, 7891, 7892, 7893),
    [switch]$ServiceIpc
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifactDir = Join-Path $root 'artifacts\v09-port-isolation'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $artifactDir "port-diagnostics-$stamp.json"
$helper = Join-Path $root 'src-tauri\target\debug\mioproxy-service.exe'
if (-not (Test-Path -LiteralPath $helper)) {
    throw "Missing development helper: $helper. Run cargo build first."
}

$service = Get-CimInstance Win32_Service -Filter "Name='MioProxyService'" -ErrorAction SilentlyContinue
$servicePid = if ($service) { [int]$service.ProcessId } else { $null }
$managed = if ($servicePid) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $servicePid -and $_.Name -ieq 'mihomo.exe' } |
        Select-Object -First 1
}

$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -ge 7885 -and $_.LocalPort -le 7910 } |
    Sort-Object LocalPort, LocalAddress |
    Select-Object LocalAddress, LocalPort, State, OwningProcess
$processes = $listeners.OwningProcess | Sort-Object -Unique | ForEach-Object {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue
    if ($process) {
        [pscustomobject]@{
            ProcessId = $process.ProcessId
            ParentProcessId = $process.ParentProcessId
            Name = $process.Name
            ExecutablePath = $process.ExecutablePath
            CommandLine = $process.CommandLine
        }
    }
}

function Invoke-PortDiagnostics([int]$TargetPort) {
    $output = & $helper port-diagnostics $TargetPort
    if ($LASTEXITCODE -ne 0) {
        throw "port-diagnostics failed for $TargetPort with exit code $LASTEXITCODE"
    }
    return $output | ConvertFrom-Json
}

function Invoke-ServicePortDiagnostics([int]$TargetPort) {
    $dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
    $token = (Get-Content -LiteralPath (Join-Path $dataDir 'service-token') -Raw).Trim()
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'MioProxyService', [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(2000)
        $writer = [System.IO.StreamWriter]::new($client)
        $writer.AutoFlush = $true
        $request = @{ protocolVersion = 1; clientVersion = '0.9.1'; token = $token; command = @{ command = 'portDiagnostics'; port = $TargetPort } } | ConvertTo-Json -Compress -Depth 4
        $writer.WriteLine($request)
        $reader = [System.IO.StreamReader]::new($client)
        $response = $reader.ReadLine() | ConvertFrom-Json
        if (-not $response.ok) { throw "Service port diagnostics failed: $($response.error)" }
        return $response.data
    }
    finally {
        $client.Dispose()
    }
}

$native = @{}
$serviceNative = @{}
foreach ($target in $Port) {
    $native["$target"] = Invoke-PortDiagnostics $target
    if ($ServiceIpc) { $serviceNative["$target"] = Invoke-ServicePortDiagnostics $target }
}

$result = [pscustomobject]@{
    CapturedAt = (Get-Date).ToUniversalTime().ToString('o')
    RangeListeners = $listeners
    ListenerProcesses = $processes
    Service = if ($service) { [pscustomobject]@{ ProcessId = $servicePid; State = $service.State; PathName = $service.PathName } } else { $null }
    ManagedMihomo = if ($managed) { [pscustomobject]@{ ProcessId = $managed.ProcessId; ParentProcessId = $managed.ParentProcessId; ExecutablePath = $managed.ExecutablePath; CommandLine = $managed.CommandLine } } else { $null }
    InteractiveNativeDiagnostics = $native
    ServiceNativeDiagnostics = if ($ServiceIpc) { $serviceNative } else { $null }
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $logPath -Encoding utf8
[pscustomobject]@{
    LogPath = $logPath
    ListenerCount = @($listeners).Count
    ServiceIpcQueried = [bool]$ServiceIpc
    ManagedMihomoPid = if ($managed) { $managed.ProcessId } else { $null }
} | ConvertTo-Json -Compress
