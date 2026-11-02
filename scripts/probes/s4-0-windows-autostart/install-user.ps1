# Runs as the standard user: the candidate S4-3 install. Writes
# <Startup>\<Name>.cmd, then runs it once the way Explorer would at logon,
# and exits. Mode min = start "" /min; headless = conhost.exe --headless.
param([string]$Mode, [string]$Name, [string]$Child)
$ErrorActionPreference = 'Stop'
$state = Join-Path 'C:\byokprobe\state' $Name
New-Item -ItemType Directory -Force $state | Out-Null
$marker = Join-Path $state "$Name.stopped"
$log = Join-Path $state 'launcher.log'
$launcher = 'C:\byokprobe\launcher.cmd'
$inner = "cmd.exe /d /c `"`"$launcher`" `"$marker`" `"$Child`" `"$log`"`""
$line = switch ($Mode) {
  'min' { "start `"`" /min $inner" }
  'headless' { "start `"`" conhost.exe --headless $inner" }
  default { throw "unknown mode $Mode" }
}
$startup = [Environment]::GetFolderPath('Startup')
"whoami: $(whoami)"
"startup folder: $startup"
New-Item -ItemType Directory -Force $startup | Out-Null
$entry = Join-Path $startup "$Name.cmd"
@('@echo off', $line) -join "`r`n" | Set-Content -Encoding ascii -NoNewline $entry
"wrote $entry :"
Get-Content $entry
"acl owner: $((Get-Acl $entry).Owner)"
& cmd.exe /d /c "`"$entry`""
"startup entry exit $LASTEXITCODE; installer exiting pid $PID"
