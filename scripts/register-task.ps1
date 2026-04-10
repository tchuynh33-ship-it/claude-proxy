$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Users\tchuy\claude-proxy\scripts\claude-proxy-watchdog.ps1'
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'claude-proxy-watchdog' -Trigger $trigger -Action $action -Settings $settings -Description 'Monitors and auto-restarts claude-proxy' -Force
Write-Host "Scheduled task registered successfully."
