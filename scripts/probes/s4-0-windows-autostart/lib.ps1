# Shared helpers for the #1329 probe steps. Runs in the runner's administrator pwsh.
$ErrorActionPreference = 'Stop'
$Probe = 'C:\byokprobe'
$ProbeSrc = $PSScriptRoot
$CredFile = Join-Path $env:RUNNER_TEMP 'probe-user.json'

function Get-ProbeUser { Get-Content -Raw $CredFile | ConvertFrom-Json }

function Get-ProbeCredential {
  $u = Get-ProbeUser
  [pscredential]::new($u.user, (ConvertTo-SecureString $u.password -AsPlainText -Force))
}

function Write-Summary([string]$Text) {
  Write-Host $Text
  Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $Text
}

function Write-Verdict([string]$Check, [bool]$Ok, [string]$Detail = '') {
  $mark = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Summary "- **$mark** $Check $Detail"
}

# Starts a pwsh script as the standard user through Start-Process -Credential
# (CreateProcessWithLogonW, profile loaded). Output goes to
# C:\byokprobe\out\<Tag>.txt. Waits only for that process, not its
# descendants: pwsh's -Wait would also wait for a detached launcher.
function Invoke-AsUser([string]$Tag, [string]$Script, [string[]]$ScriptArgs = @(), [int]$TimeoutSec = 600) {
  $outDir = Join-Path $Probe 'out'
  $out = Join-Path $outDir "$Tag.txt"
  $cmd = Join-Path $outDir "$Tag.cmd"
  $pwsh = (Get-Command pwsh).Source
  $argText = ($ScriptArgs | ForEach-Object { "`"$_`"" }) -join ' '
  @(
    '@echo off'
    "`"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$Script`" $argText > `"$out`" 2>&1"
    'exit /b %ERRORLEVEL%'
  ) | Set-Content -Encoding ascii $cmd
  $p = Start-Process -FilePath $cmd -Credential (Get-ProbeCredential) -WorkingDirectory $Probe -LoadUserProfile -PassThru
  $null = $p.Handle
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { Write-Summary "- $Tag did not exit within ${TimeoutSec}s" }
  $code = $p.ExitCode
  Write-Host "---- $Tag (exit $code) ----"
  if (Test-Path $out) { Get-Content $out | ForEach-Object { Write-Host $_ } }
  return $code
}

Add-Type -Namespace Probe -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern System.IntPtr OpenProcess(uint access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool IsProcessInJob(System.IntPtr process, System.IntPtr job, out bool result);
[DllImport("kernel32.dll")]
public static extern bool CloseHandle(System.IntPtr handle);
'@

# Whether a process is inside any job object (PROCESS_QUERY_LIMITED_INFORMATION).
function Test-InJob([int]$ProcessId) {
  $h = [Probe.Native]::OpenProcess(0x1000, $false, $ProcessId)
  if ($h -eq [IntPtr]::Zero) { return 'unknown (OpenProcess failed)' }
  try {
    $inJob = $false
    if (-not [Probe.Native]::IsProcessInJob($h, [IntPtr]::Zero, [ref]$inJob)) { return 'unknown (IsProcessInJob failed)' }
    return $inJob
  } finally { [void][Probe.Native]::CloseHandle($h) }
}

# Processes whose command line contains $Needle, with owner, parent and job state.
function Get-ProbeProcess([string]$Needle) {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Needle) -and $_.ProcessId -ne $PID } | ForEach-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
    [pscustomobject]@{
      Pid = $_.ProcessId
      ParentPid = $_.ParentProcessId
      Name = $_.Name
      Owner = "$($owner.Domain)\$($owner.User)"
      InJob = Test-InJob $_.ProcessId
      CommandLine = $_.CommandLine
    }
  }
}
