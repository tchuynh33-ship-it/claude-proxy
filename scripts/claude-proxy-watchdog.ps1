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

function Check-Process {
    if (Test-Path $pidFile) {
        $pid = Get-Content $pidFile
        try {
            $process = Get-Process -Id $pid -ErrorAction Stop
            return $true
        } catch {
            return $false
        }
    }
    return $false
}

Log "Watchdog started"

# Initial start
if (-not (Check-Process)) {
    Start-Proxy
}

# Monitor loop - check every 60 seconds
while ($true) {
    Start-Sleep -Seconds 60

    if (-not (Check-Process)) {
        Log "claude-proxy is down. Restarting..."
        Start-Proxy
    }
}
