# DIAG #1364 (do not merge): standard-user half. Mirrors ci.yml's lowpriv child env.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ScratchRoot = $env:BYOK_LOWPRIV_SCRATCH; $Workspace = $env:BYOK_LOWPRIV_WORKSPACE; $NodeDir = $env:BYOK_LOWPRIV_NODEDIR; $Arm = $env:BYOK_DIAG_ARM
function Stamp([string]$m) { Write-Host "[diag] utc=$([DateTime]::UtcNow.ToString('o')) $m" }
Stamp "child start arm=$Arm whoami=$((whoami).Trim())"
# E3 (child view): original profile, its creation time, CPU and load.
$origProfile = $env:USERPROFILE
$profCreated = if ($origProfile -and (Test-Path -LiteralPath $origProfile)) { (Get-Item -LiteralPath $origProfile -Force).CreationTimeUtc.ToString('o') } else { 'missing' }
Stamp "[e3] child originalUSERPROFILE=$origProfile created=$profCreated cpus=$([Environment]::ProcessorCount)"
$userHome = Join-Path $ScratchRoot 'home'
$env:USERPROFILE = $userHome; $env:HOME = $userHome
$env:APPDATA = Join-Path $userHome 'AppData\Roaming'; $env:LOCALAPPDATA = Join-Path $userHome 'AppData\Local'
$env:TEMP = Join-Path $ScratchRoot 'tmp'; $env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $ScratchRoot 'npm-cache'; $env:BUN_INSTALL_CACHE_DIR = Join-Path $ScratchRoot 'bun-cache'
foreach ($d in @($userHome, $env:APPDATA, $env:LOCALAPPDATA, $env:TEMP, $env:npm_config_cache, $env:BUN_INSTALL_CACHE_DIR)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Remove-Item Env:GITHUB_STEP_SUMMARY -ErrorAction SilentlyContinue
$env:GIT_CONFIG_COUNT = '1'; $env:GIT_CONFIG_KEY_0 = 'safe.directory'; $env:GIT_CONFIG_VALUE_0 = $Workspace.Replace('\', '/')
$env:PATH = "$ScratchRoot\tools;$NodeDir;$env:PATH"
Set-Location -LiteralPath $Workspace
bun run --filter @byok-sdk/core build
if ($LASTEXITCODE -ne 0) { Write-Host "[diag] core build failed"; exit $LASTEXITCODE }
$ps51 = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'").Count
$load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
Stamp "[e3] before-probe cpuLoadPct=$load powershellExeRunning=$ps51"
if ($Arm -eq 'baseline') {
  bun run --filter @byok-sdk/keys test -- src/pi-projection-windows.test.ts
  $code = $LASTEXITCODE
} else {
  bun build .github/diag-1364/e5-arms.ts --target=node --format=esm --packages=external --outfile packages/keys/diag-e5.bundle.mjs
  if ($LASTEXITCODE -ne 0) { Write-Host "[diag] e5 bundle failed"; exit $LASTEXITCODE }
  node packages/keys/diag-e5.bundle.mjs $Arm
  $code = $LASTEXITCODE
}
Stamp "child end exit=$code"
exit $code
