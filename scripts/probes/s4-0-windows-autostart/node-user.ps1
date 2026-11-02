# Runs as the standard user: node <script> <args...>; exit code passes through.
param([string]$Script, [Parameter(ValueFromRemainingArguments)][string[]]$Rest)
# The logon session gets a fresh environment, so use the runner's node by path.
$node = (Get-Content -Raw 'C:\byokprobe\node.txt').Trim()
& $node $Script @($Rest | Where-Object { $_ -ne '' })
exit $LASTEXITCODE
