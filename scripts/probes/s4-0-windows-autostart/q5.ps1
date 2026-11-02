# Q5: Task Scheduler control group. First as the standard user (can it
# register a logon task; does a task it can run restart on a non-zero exit;
# does /End stop the daemon gracefully), then the same restart and /End
# measurements as the runner administrator with S4U, as the mechanism control.
. "$PSScriptRoot/lib.ps1"
function Show-Results([string]$Out, [string]$Dir) {
  Get-Content $Out | Where-Object { $_ -like 'RESULT *' } | ForEach-Object { Write-Summary "- ``$_``" }
  Write-Summary ('daemon.log tail: ```' + ((Get-Content (Join-Path $Dir 'daemon.log') -Tail 8 -ErrorAction SilentlyContinue) -join "`n") + '```')
}
Write-Summary '### Q5 Task Scheduler control group: standard user'
$pwFile = Join-Path $Probe 'q5\pw.txt'
Set-Content -Encoding ascii $pwFile (Get-ProbeUser).password
$null = Invoke-AsUser 'q5' (Join-Path $Probe 'q5-user.ps1') @((Join-Path $Probe 'q5'), 'Interactive,S4U,Password', $pwFile) -TimeoutSec 900
Remove-Item -Force $pwFile
Show-Results (Join-Path $Probe 'out\q5.txt') (Join-Path $Probe 'q5')

Write-Summary '### Q5 control: runner administrator, S4U'
$out = Join-Path $Probe 'out\q5a.txt'
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Probe 'q5-user.ps1') (Join-Path $Probe 'q5a') 'S4U' '' *> $out
Get-Content $out | Write-Host
Show-Results $out (Join-Path $Probe 'q5a')
