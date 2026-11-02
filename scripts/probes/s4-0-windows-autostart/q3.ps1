# Q3: launcher loop semantics (exit != 0 -> wait 10s and rerun; exit 0 -> end;
# stop marker checked before every run).
. "$PSScriptRoot/lib.ps1"
Write-Summary '### Q3 launcher loop and stop marker'
$code = Invoke-AsUser 'q3' (Join-Path $Probe 'q3-user.ps1')
$root = Join-Path $Probe 'state\q3'
function Runs($name) {
  $f = Join-Path $root "$name\runs.log"
  if (-not (Test-Path $f)) { return @() }
  @(Get-Content $f | ForEach-Object { $p = $_ -split ' '; [pscustomobject]@{ At = [DateTime]::Parse($p[0]).ToUniversalTime(); Exit = $p[2] } })
}
function LauncherExit($name) { (Get-Content (Join-Path $root "$name\result.txt")) -replace '.*launcherExit=(\d+).*', '$1' }
foreach ($n in 'retry-then-clean', 'marker-during-run', 'marker-before-start') {
  Write-Summary "``$n`` runs: $((Runs $n | ForEach-Object { "$($_.At.ToString('HH:mm:ss.fff'))/$($_.Exit)" }) -join ', ') launcher log:"
  Write-Summary ('```' + "`n" + ((Get-Content (Join-Path $root "$n\launcher.log")) -join "`n") + "`n" + '```')
}
$a = Runs 'retry-then-clean'
$gaps = @(for ($i = 1; $i -lt $a.Count; $i++) { ($a[$i].At - $a[$i - 1].At).TotalSeconds })
Write-Verdict 'exit 3,3 then 0: three runs, launcher ends with exit 0' ($a.Count -eq 3 -and (LauncherExit 'retry-then-clean') -eq '0')
Write-Verdict 'rerun waits at least 10s after a non-zero exit' ($gaps.Count -eq 2 -and ($gaps | Where-Object { $_ -lt 10 }).Count -eq 0) "gaps(s)=$($gaps -join ',')"
$b = Runs 'marker-during-run'
Write-Verdict 'marker written during run 2 (exit 5): no run 3' ($b.Count -eq 2 -and (LauncherExit 'marker-during-run') -eq '0')
$c = Runs 'marker-before-start'
Write-Verdict 'marker present before start: child never runs' ($c.Count -eq 0)
