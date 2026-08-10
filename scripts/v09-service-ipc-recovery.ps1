param()

$ErrorActionPreference = 'Stop'
$service = Get-Service -Name MioProxyService -ErrorAction Stop
if ($service.Status -ne 'Running') {
    Start-Service -Name MioProxyService
}

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Test-Path '\\.\pipe\MioProxyService') {
        Write-Output 'MioProxyService is running and its IPC pipe is available.'
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

throw 'MioProxyService started but its IPC pipe did not become available within 10 seconds.'
