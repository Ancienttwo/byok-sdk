# Q3 fake child: run n exits with PROBE_SEQ[n] (last value repeats). On run
# PROBE_MARK_ON_RUN it writes the stop marker first, as stop() would.
$n = if (Test-Path $env:PROBE_COUNTER) { [int](Get-Content $env:PROBE_COUNTER) } else { 0 }
$n++
Set-Content $env:PROBE_COUNTER $n
$codes = $env:PROBE_SEQ -split ','
$code = [int]$codes[[Math]::Min($n - 1, $codes.Length - 1)]
if ($env:PROBE_MARK_ON_RUN -and $n -eq [int]$env:PROBE_MARK_ON_RUN) { Set-Content $env:PROBE_MARKER 'stopped' }
Add-Content $env:PROBE_RUNLOG "$([DateTime]::UtcNow.ToString('o')) run=$n exit=$code"
exit $code
