param(
    [ValidateRange(1, 65535)]
    [int]$MixedPort = 7893,
    [string]$Group = 'PROXY',
    [string[]]$Nodes = @('HK-1', 'SG-1', 'JP-1'),
    [ValidatePattern('^[A-Za-z0-9-]+$')]
    [string]$TestName = 'managed-dns-isolation',
    [ValidateNotNullOrEmpty()]
    [string]$Resolver = 'udp://223.5.5.5:53',
    [string]$InterfaceName,
    [ValidateSet('none', 'global', 'nodes')]
    [string]$InterfaceScope = 'none'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifactDir = Join-Path $root 'artifacts\v09-managed-outbound'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $artifactDir "$TestName-$stamp.json"
$dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
$runtimeConfig = Join-Path $dataDir 'config.yaml'
$candidatePath = Join-Path $dataDir "config.dns-isolation-$stamp.yaml"
$mihomo = 'C:\Program Files\MioProxy\mihomo.exe'
$controller = 'http://127.0.0.1:19090'
$secret = (Get-Content -LiteralPath (Join-Path $dataDir 'controller-secret') -Raw).Trim()
$headers = @{ Authorization = "Bearer $secret" }

function Hash-Value([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    $hex = -join ($hash | ForEach-Object { $_.ToString('x2') })
    return $hex.Substring(0, 16)
}

function Sanitize([string]$Text, [hashtable]$ServerNames) {
    if ($null -eq $Text) { return $null }
    $value = $Text
    $value = [regex]::Replace($value, '(?i)(authorization|token|secret|password|uuid|private-key)=?\s*[^\s,;"'']+', '$1=***')
    $value = [regex]::Replace($value, '(?i)bearer\s+\S+', 'Bearer ***')
    foreach ($server in $ServerNames.Keys) {
        $value = $value.Replace($server, "server_hash:$($ServerNames[$server])")
    }
    return $value
}

function Get-ExternalSnapshot {
    $proxy = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable, ProxyServer, ProxyOverride
    [pscustomobject]@{
        SystemProxy = [pscustomobject]@{ Enable=$proxy.ProxyEnable; Server=$proxy.ProxyServer; Override=$proxy.ProxyOverride }
        MihomoPids = @(Get-CimInstance Win32_Process -Filter "Name='mihomo.exe'" -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
        ForeignTun = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and $_.Name -notmatch 'MioProxy' -and ($_.Name -match 'mimo|meta.*tunnel|clash|mihomo|wintun|\btun\b' -or $_.InterfaceDescription -match 'mimo|meta.*tunnel|clash|mihomo|wintun|\btun\b') } | Select-Object Name, InterfaceDescription, Status, ifIndex)
        Routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object InterfaceIndex, NextHop, RouteMetric)
        Dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses.Count -gt 0 } | ForEach-Object { [pscustomobject]@{ InterfaceIndex=$_.InterfaceIndex; Servers=@($_.ServerAddresses) } })
    }
}

function Get-NodeServers([string]$Config, [string[]]$Names) {
    $servers = @{}
    foreach ($name in $Names) {
        $escaped = [regex]::Escape($name)
        $block = [regex]::Match($Config, "(?ms)^\s*-\s*name:\s*['""]?$escaped['""]?\s*$.*?(?=^\s*-\s*name:|\z)")
        if (-not $block.Success) { throw "Runtime config does not contain node '$name'." }
        $server = [regex]::Match($block.Value, '(?m)^\s*server:\s*["'']?([^\s"'']+)["'']?\s*$')
        if (-not $server.Success) { throw "Runtime config node '$name' has no server hostname." }
        $servers[$name] = $server.Groups[1].Value
    }
    return $servers
}

function Add-InterfaceBinding([string]$Config, [string]$Name, [string]$Scope, [string[]]$NodeNames) {
    if ($Scope -eq 'none') { return $Config }
    if ([string]::IsNullOrWhiteSpace($Name)) { throw 'An interface name is required for interface binding.' }
    if ($Scope -eq 'global') {
        if ($Config -match '(?m)^interface-name:\s*') { throw 'Runtime config already has a global interface-name; refusing to replace it.' }
        return "interface-name: `"$Name`"`n$Config"
    }
    $result = $Config
    foreach ($node in $NodeNames) {
        $escaped = [regex]::Escape($node)
        $pattern = "(?m)^(\s*-\s*name:\s*['""]?$escaped['""]?\s*)$"
        $replacement = "`$1`n    interface-name: `"$Name`""
        $updated = [regex]::Replace($result, $pattern, $replacement, 1)
        if ($updated -eq $result) { throw "Runtime config node '$node' cannot be bound to an interface." }
        $result = $updated
    }
    return $result
}

function Get-ManagedDns([string]$Server, [hashtable]$ServerHashes) {
    try {
        $uri = "$controller/dns/query?name=$([uri]::EscapeDataString($Server))&type=A"
        $response = Invoke-RestMethod -Headers $headers -TimeoutSec 10 -Uri $uri
        $answers = @($response.Answer | ForEach-Object { $_.data } | Where-Object { $_ })
        return [pscustomobject]@{ Answers=$answers; FakeIp=@($answers | Where-Object { $_ -match '^198\.18\.\d{1,3}\.\d{1,3}$' }).Count -gt 0 }
    } catch {
        return [pscustomobject]@{ Answers=@(); FakeIp=$false; Error=(Sanitize $_.Exception.Message $ServerHashes) }
    }
}

function Invoke-ConfigPayload([string]$Payload, [hashtable]$ServerHashes) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Method Put -Headers $headers -ContentType 'application/json; charset=utf-8' -Body (@{ payload=$Payload } | ConvertTo-Json -Compress) -TimeoutSec 15 -Uri "$controller/configs?force=true"
        return [pscustomobject]@{ Status=$response.StatusCode; Error=$null }
    } catch {
        $detail = $_.Exception.Message
        try {
            if ($_.Exception.Response.Content) {
                $detail = $_.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            } elseif ($_.Exception.Response.GetResponseStream) {
                $reader = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
                $detail = $reader.ReadToEnd()
                $reader.Dispose()
            }
        } catch {}
        return [pscustomobject]@{ Status=$null; Error=(Sanitize $detail $ServerHashes) }
    }
}

function Invoke-Delay([string]$Name, [hashtable]$ServerHashes) {
    try {
        $uri = "$controller/proxies/$([uri]::EscapeDataString($Name))/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=10000"
        $response = Invoke-WebRequest -UseBasicParsing -Headers $headers -TimeoutSec 15 -Uri $uri
        return [pscustomobject]@{ Status=$response.StatusCode; Body=(Sanitize $response.Content $ServerHashes) }
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
        return [pscustomobject]@{ Status=$status; Body=(Sanitize $_.Exception.Message $ServerHashes) }
    }
}

function Invoke-ProxyCurl([string]$Url, [switch]$Verbose, [hashtable]$ServerHashes) {
    $args = @('--proxy', "http://127.0.0.1:$MixedPort", '--max-time', '15', '-I')
    if ($Verbose) { $args += '-v' } else { $args += @('-sS', '-o', 'NUL', '-w', '%{http_code}') }
    $args += $Url
    return Sanitize ((& curl.exe @args 2>&1 | Out-String).Trim()) $ServerHashes
}

function Start-LogCapture([hashtable]$ServerHashes) {
    return Start-Job -ArgumentList $secret -ScriptBlock {
        param($Token)
        $socket = [Net.WebSockets.ClientWebSocket]::new()
        $socket.Options.SetRequestHeader('Authorization', "Bearer $Token")
        $socket.ConnectAsync([Uri]'ws://127.0.0.1:19090/logs?level=debug', [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        $deadline = [DateTime]::UtcNow.AddSeconds(35)
        $buffer = New-Object byte[] 16384
        while ([DateTime]::UtcNow -lt $deadline -and $socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
            $segment = [ArraySegment[byte]]::new($buffer)
            $receive = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None)
            if (-not $receive.Wait(1000)) { continue }
            $result = $receive.GetAwaiter().GetResult()
            if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
            [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
        }
        $socket.Dispose()
    }
}

function Get-ProxyServerDns([object[]]$RawLogs, [hashtable]$NodeServers, [hashtable]$ServerHashes, [string]$Resolver) {
    if ($Resolver -match '^(https?://)([^/]+)(/.*)$') {
        $resolverPattern = [regex]::Escape($Matches[1]) + [regex]::Escape($Matches[2]) + '(?::\d+)?' + [regex]::Escape($Matches[3])
    } else {
        $resolverPattern = [regex]::Escape($Resolver) + '(?::\d+)?'
    }
    $observations = @()
    foreach ($node in $NodeServers.Keys) {
        $hash = $ServerHashes[$NodeServers[$node]]
        $answers = @()
        foreach ($line in $RawLogs) {
            try { $payload = ($line | ConvertFrom-Json).payload } catch { continue }
            $match = [regex]::Match($payload, "server_hash:$hash --\> \[(?<answer>[^\]]*)\] A from $resolverPattern")
            if ($match.Success -and $match.Groups['answer'].Value) { $answers += $match.Groups['answer'].Value }
        }
        $answers = @($answers | Select-Object -Unique)
        $observations += [pscustomobject]@{
            Node = $node
            ServerHash = $hash
            Resolver = $Resolver
            Answers = $answers
            FakeIp = @($answers | Where-Object { $_ -match '^198\.18\.\d{1,3}\.\d{1,3}$' }).Count -gt 0
        }
    }
    return $observations
}

$result = [ordered]@{
    Before=$null; CandidateValidation=$null; Reload=$null; TemporaryCore=$null; OriginalSelection=$null; InterfaceName=$InterfaceName; InterfaceScope=$InterfaceScope
    BeforeDns=@(); AfterDns=@(); ProxyServerDns=@(); Tests=@(); ManagedLogs=@(); Restored=$false; ExternalPreserved=$false; Error=$null
}
$logJob = $null
try {
    $result.Before = Get-ExternalSnapshot
    if ($result.Before.SystemProxy.Server -match "127\.0\.0\.1:$MixedPort") { throw 'MioProxy currently owns the Windows System Proxy; refusing DNS isolation validation.' }
    $runningConfig = Invoke-RestMethod -Headers $headers -TimeoutSec 10 -Uri "$controller/configs"
    if ($runningConfig.tun.enable -eq $true) { throw 'MioProxy TUN is enabled; refusing DNS isolation validation.' }
    $original = Get-Content -LiteralPath $runtimeConfig -Raw
    if ($original -notmatch '(?m)^dns:\s*$') { throw 'Runtime config has no dns block.' }
    if ($original -match '(?m)^\s+proxy-server-nameserver:\s*$') { throw 'Runtime config already has proxy-server-nameserver; refusing to replace a user setting.' }
    $nodeServers = Get-NodeServers $original $Nodes
    $serverHashes = @{}
    foreach ($server in $nodeServers.Values | Select-Object -Unique) { $serverHashes[$server] = Hash-Value $server }
    foreach ($name in $Nodes) {
        $server = $nodeServers[$name]
        $result.BeforeDns += [pscustomobject]@{ Node=$name; ServerHash=$serverHashes[$server]; Result=(Get-ManagedDns $server $serverHashes) }
    }
    $candidate = $original -replace '(?m)^dns:\s*$', "dns:`n  proxy-server-nameserver:`n    - '$resolver'"
    $candidate = Add-InterfaceBinding $candidate $InterfaceName $InterfaceScope $Nodes
    Set-Content -LiteralPath $candidatePath -Value $candidate -Encoding utf8
    $validation = (& $mihomo -t -f $candidatePath 2>&1 | Out-String).Trim()
    $result.CandidateValidation = Sanitize $validation $serverHashes
    if ($LASTEXITCODE -ne 0) { throw 'Temporary DNS runtime config failed mihomo -t.' }
    $proxies = Invoke-RestMethod -Headers $headers -TimeoutSec 10 -Uri "$controller/proxies"
    $result.OriginalSelection = $proxies.proxies.$Group.now
    if (-not $result.OriginalSelection) { throw "Controller group '$Group' has no selected node." }
    $result.Reload = Invoke-ConfigPayload $candidate $serverHashes
    if ($result.Reload.Status -ne 204) { throw "Temporary config reload failed: $($result.Reload.Error)" }
    Invoke-RestMethod -Method Post -Headers $headers -TimeoutSec 10 -Uri "$controller/cache/dns/flush" | Out-Null
    $listener = Get-NetTCPConnection -State Listen -LocalPort $MixedPort -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } | Select-Object -First 1
    $version = Invoke-RestMethod -Headers $headers -TimeoutSec 10 -Uri "$controller/version"
    if (-not $listener -or -not $version.version) { throw 'Temporary Core health check failed.' }
    $result.TemporaryCore = [pscustomobject]@{ ControllerVersion=$version.version; MixedPort=$MixedPort; ListenerPid=$listener.OwningProcess }
    $logJob = Start-LogCapture $serverHashes
    foreach ($name in $Nodes) {
        Invoke-RestMethod -Method Put -Headers $headers -ContentType 'application/json' -Body (@{ name=$name } | ConvertTo-Json -Compress) -TimeoutSec 10 -Uri "$controller/proxies/$([uri]::EscapeDataString($Group))" | Out-Null
        $selection = (Invoke-RestMethod -Headers $headers -TimeoutSec 10 -Uri "$controller/proxies").proxies.$Group.now
        $server = $nodeServers[$name]
        $result.AfterDns += [pscustomobject]@{ Node=$name; ServerHash=$serverHashes[$server]; Result=(Get-ManagedDns $server $serverHashes) }
        $result.Tests += [pscustomobject]@{
            Node=$name; ControllerSelection=$selection; Delay=(Invoke-Delay $name $serverHashes)
            Http=(Invoke-ProxyCurl 'http://www.baidu.com/' -ServerHashes $serverHashes)
            Https=(Invoke-ProxyCurl 'https://www.baidu.com/' -Verbose -ServerHashes $serverHashes)
        }
    }
} catch {
    $result.Error = Sanitize $_.Exception.Message $(if ($serverHashes) { $serverHashes } else { @{} })
} finally {
    if ($logJob) {
        try {
            $rawLogs = @(Receive-Job -Job $logJob -Wait -AutoRemoveJob -ErrorAction SilentlyContinue)
            $result.ManagedLogs = @($rawLogs | ForEach-Object { Sanitize ([string]$_) $serverHashes } | Where-Object { $_ -match '(?i)dns|resolve|proxy|error|timeout|handshake' })
            if ($nodeServers -and $serverHashes) {
                $result.ProxyServerDns = Get-ProxyServerDns $result.ManagedLogs $nodeServers $serverHashes $Resolver
            }
        } catch {}
    }
    try {
        if ($original) {
            $restore = Invoke-ConfigPayload $original $(if ($serverHashes) { $serverHashes } else { @{} })
            if ($restore.Status -ne 204) { throw "Formal runtime restore failed: $($restore.Error)" }
            if ($result.OriginalSelection) {
                Invoke-RestMethod -Method Put -Headers $headers -ContentType 'application/json' -Body (@{ name=$result.OriginalSelection } | ConvertTo-Json -Compress) -TimeoutSec 10 -Uri "$controller/proxies/$([uri]::EscapeDataString($Group))" | Out-Null
            }
            $result.Restored = $true
        }
    } catch {
        $result.Error = "$(Sanitize $result.Error $(if ($serverHashes) { $serverHashes } else { @{} })) Restore failed: $(Sanitize $_.Exception.Message $(if ($serverHashes) { $serverHashes } else { @{} }))"
    }
    if (Test-Path -LiteralPath $candidatePath) { Remove-Item -LiteralPath $candidatePath -Force }
    $after = Get-ExternalSnapshot
    $result.ExternalPreserved = (($result.Before | ConvertTo-Json -Depth 8 -Compress) -eq ($after | ConvertTo-Json -Depth 8 -Compress))
    $result.After = $after
    $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $logPath -Encoding utf8
}

if ($result.Error) { throw "$($result.Error) Log: $logPath" }
if (-not $result.Restored -or -not $result.ExternalPreserved) { throw "Validation recovery or external-resource preservation failed. Log: $logPath" }
Write-Host "Managed DNS isolation validation completed. Log: $logPath"
