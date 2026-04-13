# claude-proxy-watchdog.ps1
# Monitors claude-proxy process and auto-restarts if it crashes

$proxyPath = "C:\Users\tchuy\claude-proxy"
$proxyScript = "$proxyPath\proxy.js"
$logFile = "$proxyPath\logs\watchdog.log"
$pidFile = "$proxyPath\logs\proxy.pid"

# Ensure logs directory exists
$logsDir = Split-Path $logFile
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

function Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp - $Message" | Out-File -FilePath $logFile -Append
    Write-Host $Message
}

function Start-Proxy {
    Log "Starting claude-proxy..."
    $process = Start-Process -FilePath "node" -ArgumentList $proxyScript -PassThru -WindowStyle Hidden -RedirectStandardOutput "$proxyPath\logs\stdout.log" -RedirectStandardError "$proxyPath\logs\stderr.log"
    $process.Id | Out-File -FilePath $pidFile -Force
    Log "claude-proxy started (PID: $($process.Id))"
    return $process
}

function Test-ProxyHealth {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:9182/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

Log "Watchdog started"

# Initial start - only launch if health check fails
if (-not (Test-ProxyHealth)) {
    # Check if something is already on port 9182
    $portInUse = Get-NetTCPConnection -LocalPort 9182 -ErrorAction SilentlyContinue
    if ($portInUse) {
        Log "Port 9182 in use (PID: $($portInUse[0].OwningProcess)) but health check failed. Skipping start."
    } else {
        Start-Proxy
    }
} else {
    Log "Proxy already healthy. Monitoring."
}

# Monitor loop - check every 60 seconds
while ($true) {
    Start-Sleep -Seconds 60

    if (-not (Test-ProxyHealth)) {
        Log "Health check failed. Checking port..."
        $portInUse = Get-NetTCPConnection -LocalPort 9182 -ErrorAction SilentlyContinue
        if ($portInUse) {
            Log "Port 9182 in use (PID: $($portInUse[0].OwningProcess)) but not responding. Killing stale process..."
            Stop-Process -Id $portInUse[0].OwningProcess -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
        }
        Start-Proxy
    }
}
