# Creates the standard user and C:\byokprobe, copies the probe scripts with
# CRLF line endings, and bundles the stop program.
. "$PSScriptRoot/lib.ps1"
$user = 'byokprobe'
# net user prompts for confirmation above 14 characters.
$password = 'Aa1!' + [guid]::NewGuid().ToString('N').Substring(0, 10)
net user $user $password /add | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'standard user creation failed' }
@{ user = $user; password = $password } | ConvertTo-Json | Set-Content $CredFile
foreach ($d in 'out', 'state', 'q4', 'q5') { New-Item -ItemType Directory -Force (Join-Path $Probe $d) | Out-Null }
Get-ChildItem $ProbeSrc -File | Where-Object { $_.Extension -in '.cmd', '.ps1' } | ForEach-Object {
  ((Get-Content -Raw $_.FullName) -replace "`r?`n", "`r`n") | Set-Content -Encoding ascii -NoNewline (Join-Path $Probe $_.Name)
}
$ws = $env:GITHUB_WORKSPACE
$node = (Get-Command node).Source
Set-Content -Encoding ascii (Join-Path $Probe 'node.txt') $node
bun build (Join-Path $ProbeSrc 'stop.ts') --target=node --format=esm --outfile (Join-Path $Probe 'stop.mjs')
if ($LASTEXITCODE -ne 0) { throw 'stop program bundle failed' }
# The managed process: the real byok-agent CLI, unpaired, in service
# enrollment mode (control server up, no server connection needed).
foreach ($q in 'q4', 'q5') {
  $dir = Join-Path $Probe $q
  @{ productName = 'Probe'; productId = "byok-probe-$q"; serverUrl = 'http://127.0.0.1:9'; serviceEnrollment = @{ enabled = $true } } |
    ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $dir 'config.json')
  @(
    '@echo off'
    "`"$node`" `"$ws\packages\client\dist\bin\byok-agent.js`" start --config `"$dir\config.json`" >> `"$dir\daemon.log`" 2>&1"
    'exit /b %ERRORLEVEL%'
  ) | Set-Content -Encoding ascii (Join-Path $dir 'daemon.cmd')
}
icacls $Probe /grant "${user}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'probe directory grant failed' }
Write-Summary "### Runner $env:ImageOS $env:ImageVersion"
Write-Summary "- runner step process in a job: $(Test-InJob $PID)"
$code = Invoke-AsUser 'setup-whoami' (Join-Path $Probe 'whoami-user.ps1') @($node, "$ws\packages\client\dist\bin\byok-agent.js")
$token = Get-Content -Raw (Join-Path $Probe 'out\setup-whoami.txt')
Write-Verdict 'probe runs as the standard user without Administrators' (($token -match "\\$user\b") -and ($token -notmatch 'S-1-5-32-544') -and $code -eq 0)
