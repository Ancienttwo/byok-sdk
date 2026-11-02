# Q5: Task Scheduler control group, run entirely as the standard user.
. "$PSScriptRoot/lib.ps1"
Write-Summary '### Q5 Task Scheduler control group (standard user)'
$null = Invoke-AsUser 'q5' (Join-Path $Probe 'q5-user.ps1') -TimeoutSec 900
Get-Content (Join-Path $Probe 'out\q5.txt') | Where-Object { $_ -like 'RESULT *' } | ForEach-Object { Write-Summary "- ``$_``" }
Write-Summary ('daemon.log tail: ```' + ((Get-Content (Join-Path $Probe 'q5\daemon.log') -Tail 8 -ErrorAction SilentlyContinue) -join "`n") + '```')
