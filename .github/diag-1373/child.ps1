# DIAG #1373 (do not merge): standard-user half. Runs no native tool before the probe, so its first icacls/whoami is cold.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ScratchRoot = $env:BYOK_LOWPRIV_SCRATCH; $Workspace = $env:BYOK_LOWPRIV_WORKSPACE; $NodeDir = $env:BYOK_LOWPRIV_NODEDIR
$userHome = Join-Path $ScratchRoot 'home'
$env:USERPROFILE = $userHome; $env:HOME = $userHome
$env:APPDATA = Join-Path $userHome 'AppData\Roaming'; $env:LOCALAPPDATA = Join-Path $userHome 'AppData\Local'
$env:TEMP = Join-Path $ScratchRoot 'tmp'; $env:TMP = $env:TEMP
foreach ($d in @($userHome, $env:APPDATA, $env:LOCALAPPDATA, $env:TEMP)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Remove-Item Env:GITHUB_STEP_SUMMARY -ErrorAction SilentlyContinue
$env:PATH = "$NodeDir;$env:PATH"
Set-Location -LiteralPath $Workspace
& (Join-Path $NodeDir 'node.exe') .github/diag-1373/probe.mjs $ScratchRoot
$code = $LASTEXITCODE
Write-Host "[diag] child end exit=$code"
exit $code
