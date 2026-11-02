# Runs as the standard user: Task Scheduler control group. Every line that
# starts with RESULT is read by q5.ps1.
. 'C:\byokprobe\user-env.ps1'
$ErrorActionPreference = 'Continue'
$dir = 'C:\byokprobe\q5'
$me = "$env:USERDOMAIN\$env:USERNAME"
"user=$me"

# 5a: a logon task for the user's own account.
$out = (schtasks /Create /TN byok-probe-onlogon /SC ONLOGON /TR 'cmd.exe /d /c exit 0' /F 2>&1) -join ' '
"RESULT schtasks-onlogon exit=$LASTEXITCODE :: $out"
try {
  Register-ScheduledTask -TaskName byok-probe-atlogon -Force `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) `
    -Action (New-ScheduledTaskAction -Execute cmd.exe -Argument '/d /c exit 0') `
    -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited) -ErrorAction Stop | Out-Null
  "RESULT register-atlogon-interactive ok"
} catch { "RESULT register-atlogon-interactive error :: $($_.Exception.Message)" }

# 5b: restart after a non-zero exit (RestartCount 2, RestartInterval 1 min).
$settings = New-ScheduledTaskSettingsSet -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$runnable = @()
foreach ($lt in 'Interactive', 'S4U') {
  $task = "byok-probe-restart-$lt"
  $log = Join-Path $dir "restart-$lt.log"
  try {
    Register-ScheduledTask -TaskName $task -Force -Settings $settings `
      -Action (New-ScheduledTaskAction -Execute cmd.exe -Argument "/d /c `"`"$dir\exit3.cmd`" `"$log`"`"") `
      -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType $lt -RunLevel Limited) -ErrorAction Stop | Out-Null
    "RESULT register-$lt ok"
    try { Start-ScheduledTask -TaskName $task -ErrorAction Stop; "RESULT start-$lt ok" } catch { "RESULT start-$lt error :: $($_.Exception.Message)" }
  } catch { "RESULT register-$lt error :: $($_.Exception.Message)" }
}
Start-Sleep -Seconds 170
foreach ($lt in 'Interactive', 'S4U') {
  $log = Join-Path $dir "restart-$lt.log"
  $runs = if (Test-Path $log) { @(Get-Content $log).Count } else { 0 }
  $info = Get-ScheduledTaskInfo -TaskName "byok-probe-restart-$lt" -ErrorAction SilentlyContinue
  "RESULT restart-$lt runs=$runs lastResult=$($info.LastTaskResult) lastRun=$($info.LastRunTime)"
  if ($runs -gt 0) { $runnable += $lt }
}

# 5c: /End against the byok-agent daemon run as a task action.
$store = Join-Path $env:USERPROFILE '.byok\byok-probe-q5'
if ($runnable.Count -eq 0) {
  "RESULT end-skipped no logon type ran a task for this user"
} else {
  $lt = $runnable[0]
  try {
    Register-ScheduledTask -TaskName byok-probe-daemon -Force -Settings $settings `
      -Action (New-ScheduledTaskAction -Execute cmd.exe -Argument "/d /c `"$dir\daemon.cmd`"") `
      -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType $lt -RunLevel Limited) -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName byok-probe-daemon -ErrorAction Stop
    $ready = $false
    for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
      Start-Sleep -Seconds 3
      $ready = (Test-Path "$store\control.token") -and (Test-Path "$store\daemon-owner.json")
    }
    "RESULT daemon-task-$lt ready=$ready"
    $out = (schtasks /End /TN byok-probe-daemon 2>&1) -join ' '
    "RESULT end exit=$LASTEXITCODE :: $out"
    Start-Sleep -Seconds 10
    $alive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('q5\config.json') })
    "RESULT after-end daemonAlive=$($alive.Count) controlToken=$(Test-Path "$store\control.token") daemonOwner=$(Test-Path "$store\daemon-owner.json")"
    $stopped = (Get-Content (Join-Path $dir 'daemon.log') -ErrorAction SilentlyContinue | Select-String '"kind":"daemon-stopped"').Count
    "RESULT after-end daemonStoppedRecords=$stopped"
    $alive | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  } catch { "RESULT daemon-task error :: $($_.Exception.Message)" }
}
Get-ScheduledTask -TaskName 'byok-probe-*' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
schtasks /Delete /TN byok-probe-onlogon /F 2>&1 | Out-Null
