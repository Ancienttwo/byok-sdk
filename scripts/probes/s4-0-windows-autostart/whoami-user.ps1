# Runs as the standard user: token and access to node and the built CLI.
param([string]$Node, [string]$Cli)
. 'C:\byokprobe\user-env.ps1'
whoami /all
"LOCALAPPDATA=$env:LOCALAPPDATA APPDATA=$env:APPDATA USERPROFILE=$env:USERPROFILE"
& $Node $Cli --version
if ($LASTEXITCODE -ne 0) { "byok-agent --version exit $LASTEXITCODE"; exit 1 }
