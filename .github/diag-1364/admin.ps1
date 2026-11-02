# DIAG #1364 (do not merge): administrator half. One fresh local standard user per job, as ci.yml does.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Stamp([string]$m) { Write-Host "[diag] utc=$([DateTime]::UtcNow.ToString('o')) $m" }
$arm = $env:BYOK_DIAG_ARM; $rep = $env:BYOK_DIAG_REP
$runId = "$env:GITHUB_RUN_ID"
$tag = '{0}{1}{2}a{3}' -f $runId.Substring([Math]::Max(0, $runId.Length - 8)), $arm.Substring(0,1), $rep, $env:GITHUB_RUN_ATTEMPT
$account = "bk$tag"
if ($account.Length -gt 20) { throw "account name $account too long" }
$scratch = "C:\byok-diag-$tag"
$checkout = "$env:GITHUB_WORKSPACE"
$nodeHome = Split-Path -Parent (Get-Command node).Source
$pwshExe = (Get-Command pwsh).Source

# E3 (job view)
Stamp "[e3] arm=$arm rep=$rep ImageOS=$env:ImageOS ImageVersion=$env:ImageVersion os=$([Environment]::OSVersion.VersionString) cpus=$([Environment]::ProcessorCount)"
try {
  $mp = Get-MpComputerStatus
  Stamp "[e3] defender AMServiceEnabled=$($mp.AMServiceEnabled) AntivirusEnabled=$($mp.AntivirusEnabled) RealTimeProtectionEnabled=$($mp.RealTimeProtectionEnabled) BehaviorMonitorEnabled=$($mp.BehaviorMonitorEnabled) IoavProtectionEnabled=$($mp.IoavProtectionEnabled) OnAccessProtectionEnabled=$($mp.OnAccessProtectionEnabled) AMRunningMode=$($mp.AMRunningMode) EngineVersion=$($mp.AMEngineVersion)"
} catch { Stamp "[e3] defender Get-MpComputerStatus failed: $($_.Exception.Message)" }
try { $pref = Get-MpPreference; Stamp "[e3] defender DisableRealtimeMonitoring=$($pref.DisableRealtimeMonitoring) DisableScriptScanning=$($pref.DisableScriptScanning) ExclusionPath=$($pref.ExclusionPath -join ';')" } catch { Stamp "[e3] Get-MpPreference failed: $($_.Exception.Message)" }
$amsi = @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\AMSI\Providers' -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName })
Stamp "[e3] amsiProviders=$($amsi -join ',') count=$($amsi.Count)"
$load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
Stamp "[e3] cpuLoadPct=$load"

$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$secret = ConvertTo-SecureString ([Convert]::ToBase64String($bytes) + '!Aa1') -AsPlainText -Force
[System.Array]::Clear($bytes, 0, $bytes.Length)
New-LocalUser -Name $account -Password $secret -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description 'ephemeral byok diag user' | Out-Null
Add-LocalGroupMember -Group 'Users' -Member $account
$cred = [System.Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$account", $secret)
Stamp "[e3] account=$account created; profileExistsBeforeChild=$(Test-Path -LiteralPath "C:\Users\$account")"

New-Item -ItemType Directory -Path $scratch | Out-Null
icacls $scratch /grant "${account}:(OI)(CI)(M)" /Q | Out-Null
icacls $checkout /grant "${account}:(OI)(CI)(M)" /T /C /Q | Out-Null
New-Item -ItemType Directory -Force -Path "$scratch\tools", "$scratch\logs" | Out-Null
Copy-Item -LiteralPath (Get-Command bun).Source -Destination "$scratch\tools\bun.exe"
$q = { param([string]$v) "'" + $v.Replace("'", "''") + "'" }
$launcher = Join-Path $scratch 'launch.ps1'
Set-Content -LiteralPath $launcher -Encoding utf8 -Value ([string[]]@(
  ('$env:BYOK_LOWPRIV_SCRATCH = ' + (& $q $scratch)),
  ('$env:BYOK_LOWPRIV_WORKSPACE = ' + (& $q $checkout)),
  ('$env:BYOK_LOWPRIV_NODEDIR = ' + (& $q $nodeHome)),
  ('$env:BYOK_DIAG_ARM = ' + (& $q $arm)),
  ('& ' + (& $q (Join-Path $checkout '.github\diag-1364\child.ps1'))),
  'exit $LASTEXITCODE'))
$out = Join-Path $scratch 'logs\out.log'; $err = Join-Path $scratch 'logs\err.log'
Stamp "starting child"
$proc = Start-Process -FilePath $pwshExe -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $launcher) -Credential $cred -WorkingDirectory $scratch -RedirectStandardOutput $out -RedirectStandardError $err -Wait -PassThru
$code = $proc.ExitCode
$profDir = "C:\Users\$account"
$profInfo = if (Test-Path -LiteralPath $profDir) { "exists created=$((Get-Item -LiteralPath $profDir -Force).CreationTimeUtc.ToString('o'))" } else { 'missing' }
Stamp "child exit=$code [e3] profileAfterChild=$profInfo"
foreach ($f in @($out, $err)) { Write-Host "===== $(Split-Path -Leaf $f) ====="; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f | ForEach-Object { Write-Host $_ } } }
try { Remove-LocalUser -Name $account } catch { Write-Host "teardown: $($_.Exception.Message)" }
exit $code
