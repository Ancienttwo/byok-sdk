# Runs as the standard user: three launcher cases with the fake child.
. 'C:\byokprobe\user-env.ps1'
$ErrorActionPreference = 'Stop'
$root = 'C:\byokprobe\state\q3'
function Run-Case([string]$Name, [string]$Seq, [string]$MarkOnRun, [bool]$PreMarker) {
  $dir = Join-Path $root $Name
  New-Item -ItemType Directory -Force $dir | Out-Null
  $env:PROBE_COUNTER = Join-Path $dir 'counter'
  $env:PROBE_RUNLOG = Join-Path $dir 'runs.log'
  $env:PROBE_MARKER = Join-Path $dir 'probe.stopped'
  $env:PROBE_SEQ = $Seq
  $env:PROBE_MARK_ON_RUN = $MarkOnRun
  if ($PreMarker) { Set-Content $env:PROBE_MARKER 'stopped' }
  $t0 = [DateTime]::UtcNow
  & cmd.exe /d /c "`"C:\byokprobe\launcher.cmd`" `"$env:PROBE_MARKER`" `"C:\byokprobe\seqchild.cmd`" `"$dir\launcher.log`""
  $code = $LASTEXITCODE
  "case=$Name launcherExit=$code seconds=$([int]([DateTime]::UtcNow - $t0).TotalSeconds)" | Tee-Object -Append (Join-Path $dir 'result.txt')
}
Run-Case 'retry-then-clean' '3,3,0' '' $false
Run-Case 'marker-during-run' '5' '2' $false
Run-Case 'marker-before-start' '5' '' $true
