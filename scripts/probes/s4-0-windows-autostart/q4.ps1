# Q4: the real byok-agent daemon as the managed process under the launcher
# (Startup .cmd, start /min), then the stop program.
. "$PSScriptRoot/lib.ps1"
Write-Summary '### Q4 byok-agent daemon under the launcher'
$name = 'q4'
$code = Invoke-AsUser 'q4-install' (Join-Path $Probe 'install-user.ps1') @('min', $name, (Join-Path $Probe 'q4\daemon.cmd'))
$ready = $false
for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
  Start-Sleep -Seconds 3
  $null = Invoke-AsUser 'q4-poll' (Join-Path $Probe 'node-user.ps1') @((Join-Path $Probe 'stop.mjs'), 'byok-probe-q4', '--no-shutdown')
  $ready = (Get-Content -Raw (Join-Path $Probe 'out\q4-poll.txt')) -match '"control.token":true,"daemon-owner.json":true'
}
Write-Verdict 'daemon started under the launcher: control.token and daemon-owner.json exist' $ready
Write-Summary ('daemon.log head: ```' + ((Get-Content (Join-Path $Probe 'q4\daemon.log') -TotalCount 15 -ErrorAction SilentlyContinue) -join "`n") + '```')
$stopCode = Invoke-AsUser 'q4-stop' (Join-Path $Probe 'node-user.ps1') @((Join-Path $Probe 'stop.mjs'), 'byok-probe-q4', (Join-Path $Probe "state\$name\$name.stopped"))
Write-Summary ('stop program: ```' + ((Get-Content (Join-Path $Probe 'out\q4-stop.txt')) -join "`n") + '```')
Write-Verdict 'stop program: shutdown RPC, daemon gone, control.token and daemon-owner.json removed' ($stopCode -eq 0)
Start-Sleep -Seconds 15
$left = @(Get-ProbeProcess "state\$name\")
$log = Get-Content (Join-Path $Probe "state\$name\launcher.log") -ErrorAction SilentlyContinue
Write-Summary "launcher.log: $($log -join ' | ')"
Write-Verdict 'launcher ended after stop without restarting the daemon' ($left.Count -eq 0 -and @($log | Select-String ' start$').Count -eq 1) "remaining=$($left.Count)"
Write-Summary ('daemon.log tail: ```' + ((Get-Content (Join-Path $Probe 'q4\daemon.log') -Tail 8 -ErrorAction SilentlyContinue) -join "`n") + '```')
