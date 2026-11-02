# Q1/Q2: the standard user writes its own Startup .cmd and starts the
# launcher, then the installing process exits. Both window modes.
. "$PSScriptRoot/lib.ps1"
Write-Summary '### Q1/Q2 Startup .cmd install'
$user = (Get-ProbeUser).user
foreach ($mode in 'min', 'headless') {
  $name = "q12-$mode"
  $code = Invoke-AsUser "install-$mode" (Join-Path $Probe 'install-user.ps1') @($mode, $name, (Join-Path $Probe 'longchild.cmd'))
  $entry = "C:\Users\$user\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\$name.cmd"
  Write-Verdict "[$mode] standard user wrote its own Startup entry (installer exit $code)" ($code -eq 0 -and (Test-Path $entry)) $entry
  Start-Sleep -Seconds 5
  $procs = @(Get-ProbeProcess "state\$name\")
  $procs | Format-Table Pid, ParentPid, Name, Owner, InJob -AutoSize | Out-String -Width 200 | Write-Host
  $procs | ForEach-Object { Write-Host "$($_.Pid) $($_.CommandLine)" }
  $launcher = @($procs | Where-Object { $_.Name -eq 'cmd.exe' })
  $headless = @(Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" | Where-Object { $_.CommandLine -match '--headless' -and $_.CommandLine.Contains("state\$name\") })
  $ping = @(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $launcher.Pid -contains $_.ParentProcessId })
  Write-Verdict "[$mode] launcher alive after the installer exited, owned by $user" ($launcher.Count -ge 1 -and ($launcher | Where-Object { $_.Owner -like "*\$user" }).Count -ge 1) "launcher pids=$($launcher.Pid -join ',') inJob=$($launcher.InJob -join ',')"
  Write-Verdict "[$mode] managed child running under the launcher" ($ping.Count -ge 1) "child pids=$($ping.ProcessId -join ',')"
  if ($mode -eq 'headless') { Write-Verdict '[headless] conhost.exe --headless hosts the launcher' ($headless.Count -ge 1) "conhost pids=$($headless.ProcessId -join ',')" }
  $log = Join-Path $Probe "state\$name\launcher.log"
  if (Test-Path $log) { Write-Summary "launcher.log: $((Get-Content $log) -join ' | ')" }
}
