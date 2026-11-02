# Q1/Q2, next step: the launchers started in the previous step are still
# alive after that step's processes ended. Then stop them with the marker.
. "$PSScriptRoot/lib.ps1"
Write-Summary '### Q1/Q2 survival across the step boundary, then marker stop'
foreach ($mode in 'min', 'headless') {
  $name = "q12-$mode"
  $launcher = @(Get-ProbeProcess "state\$name\" | Where-Object { $_.Name -eq 'cmd.exe' })
  Write-Verdict "[$mode] launcher still alive in the next step" ($launcher.Count -ge 1) "pids=$($launcher.Pid -join ',')"
  # stop(): write the marker, then end the running child; the launcher must not rerun it.
  $marker = Join-Path $Probe "state\$name\$name.stopped"
  Set-Content $marker 'stopped'
  Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $launcher.Pid -contains $_.ParentProcessId } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
Start-Sleep -Seconds 20
foreach ($mode in 'min', 'headless') {
  $name = "q12-$mode"
  $left = @(Get-ProbeProcess "state\$name\")
  $log = Get-Content (Join-Path $Probe "state\$name\launcher.log") -ErrorAction SilentlyContinue
  Write-Summary "[$mode] launcher.log: $($log -join ' | ')"
  Write-Verdict "[$mode] after marker + child exit the launcher ended without a rerun" ($left.Count -eq 0 -and (@($log | Select-String ' start$').Count -eq 1)) "remaining=$($left.Count)"
}
