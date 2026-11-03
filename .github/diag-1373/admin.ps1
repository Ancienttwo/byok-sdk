# DIAG #1373 (do not merge): administrator half. One fresh local standard user per job, as ci.yml does.
# Builds the E2 (classification) and E4 (reparse) fixtures the standard user cannot make itself.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Stamp([string]$m) { Write-Host "[diag] utc=$([DateTime]::UtcNow.ToString('o')) $m" }
$rep = $env:BYOK_DIAG_REP
$runId = "$env:GITHUB_RUN_ID"
$tag = '{0}r{1}a{2}' -f $runId.Substring([Math]::Max(0, $runId.Length - 8)), $rep, $env:GITHUB_RUN_ATTEMPT
$account = "bk$tag"
if ($account.Length -gt 20) { throw "account name $account too long" }
$scratch = "C:\byok-diag-$tag"
$checkout = "$env:GITHUB_WORKSPACE"
$nodeHome = Split-Path -Parent (Get-Command node).Source
$pwshExe = (Get-Command pwsh).Source
Stamp "[env] rep=$rep ImageOS=$env:ImageOS ImageVersion=$env:ImageVersion os=$([Environment]::OSVersion.VersionString) cpus=$([Environment]::ProcessorCount) uiCulture=$([Globalization.CultureInfo]::CurrentUICulture.Name) oemCP=$([Console]::OutputEncoding.CodePage)"

$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$secret = ConvertTo-SecureString ([Convert]::ToBase64String($bytes) + '!Aa1') -AsPlainText -Force
[System.Array]::Clear($bytes, 0, $bytes.Length)
New-LocalUser -Name $account -Password $secret -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description 'ephemeral byok diag user' | Out-Null
Add-LocalGroupMember -Group 'Users' -Member $account
$cred = [System.Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$account", $secret)
$userSid = (Get-LocalUser -Name $account).SID.Value
Stamp "[env] account=$account sid=$userSid"

New-Item -ItemType Directory -Path $scratch | Out-Null
icacls $scratch /grant "${account}:(OI)(CI)(M)" /Q | Out-Null
icacls $checkout /grant "${account}:(RX)" /Q | Out-Null
icacls (Join-Path $checkout '.github') /grant "${account}:(OI)(CI)(RX)" /T /C /Q | Out-Null
icacls (Join-Path $checkout 'packages') /grant "${account}:(OI)(CI)(RX)" /T /C /Q | Out-Null
New-Item -ItemType Directory -Force -Path "$scratch\logs" | Out-Null

# E2 fixtures: a target the user cannot read, and a parent the user cannot read.
$e2 = Join-Path $scratch 'e2'
New-Item -ItemType Directory -Path $e2, "$e2\noread", "$e2\locked", "$e2\locked\child", "$e2\denyrc" | Out-Null
icacls "$e2\noread" /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
icacls "$e2\locked\child" /inheritance:r /grant:r "*${userSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
icacls "$e2\locked" /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
icacls "$e2\denyrc" /deny "*${userSid}:(RC)" /Q | Out-Null
'x' | Set-Content -LiteralPath "$e2\noread-file.txt"
icacls "$e2\noread-file.txt" /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' /Q | Out-Null

# E4 fixtures: symlinks (privileged), junction, and a third-party reparse tag (FSCTL_SET_REPARSE_POINT).
$e4 = Join-Path $scratch 'e4'
New-Item -ItemType Directory -Path $e4, "$e4\target-dir", "$e4\tag-dir" | Out-Null
'x' | Set-Content -LiteralPath "$e4\target-file.txt"
'' | Set-Content -LiteralPath "$e4\tag-file.txt"
function Try-Fixture([string]$name, [scriptblock]$make) {
  try { & $make | Out-Null; Stamp "[e4] fixture=$name created" } catch { Stamp "[e4] fixture=$name FAILED $($_.Exception.Message)" }
}
Try-Fixture 'symlink-dir' { cmd /d /c mklink /D "$e4\symlink-dir" "$e4\target-dir"; if ($LASTEXITCODE) { throw "mklink exit $LASTEXITCODE" } }
Try-Fixture 'symlink-file' { cmd /d /c mklink "$e4\symlink-file.txt" "$e4\target-file.txt"; if ($LASTEXITCODE) { throw "mklink exit $LASTEXITCODE" } }
Try-Fixture 'junction' { cmd /d /c mklink /J "$e4\junction" "$e4\target-dir"; if ($LASTEXITCODE) { throw "mklink exit $LASTEXITCODE" } }
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class DiagReparse {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(SafeFileHandle h, uint code, byte[] input, int inputLength, IntPtr output, int outputLength, out int returned, IntPtr overlapped);
  // REPARSE_GUID_DATA_BUFFER with a non-Microsoft tag (bit 31 clear).
  public static void Set(string path, uint tag) {
    using (var h = CreateFileW(path, 0x40000000, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero)) {
      if (h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      byte[] data = { 0x13, 0x73, 0x13, 0x73 };
      byte[] buffer = new byte[24 + data.Length];
      BitConverter.GetBytes(tag).CopyTo(buffer, 0);
      BitConverter.GetBytes((ushort)data.Length).CopyTo(buffer, 4);
      new Guid("4d1d1373-0000-4000-8000-000000001373").ToByteArray().CopyTo(buffer, 8);
      data.CopyTo(buffer, 24);
      int returned;
      if (!DeviceIoControl(h, 0x000900A4, buffer, buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
Try-Fixture 'tag-dir' { [DiagReparse]::Set("$e4\tag-dir", 0x00001373) }
Try-Fixture 'tag-file' { [DiagReparse]::Set("$e4\tag-file.txt", 0x00001373) }
# E5-3 fixtures: volume mount point and dangling links.
New-Item -ItemType Directory -Path "$e4\mount", "$e4\gone-target" | Out-Null
$volume = (Get-Volume -DriveLetter C).Path
Try-Fixture 'mount' { mountvol "$e4\mount" $volume; if ($LASTEXITCODE) { throw "mountvol exit $LASTEXITCODE" } }
Try-Fixture 'symlink-dangling' { cmd /d /c mklink /D "$e4\symlink-dangling" "$e4\no-such-target"; if ($LASTEXITCODE) { throw "mklink exit $LASTEXITCODE" } }
Try-Fixture 'junction-dangling' { cmd /d /c mklink /J "$e4\junction-dangling" "$e4\gone-target"; if ($LASTEXITCODE) { throw "mklink exit $LASTEXITCODE" }; Remove-Item -LiteralPath "$e4\gone-target" }
foreach ($n in @('symlink-dir', 'symlink-file.txt', 'junction', 'tag-dir', 'tag-file.txt', 'mount', 'symlink-dangling', 'junction-dangling')) {
  $q = (fsutil reparsepoint query "$e4\$n" 2>&1 | Select-Object -First 1) -join ''
  Stamp "[e4] admin-view name=$n fsutilExit=$LASTEXITCODE first=$q"
}

# E5-2 fixtures: owner = the standard user, DACL without any ACE for it; with and without OWNER RIGHTS (S-1-3-4) RC.
$e5 = Join-Path $scratch 'e5'
New-Item -ItemType Directory -Path $e5, "$e5\ow", "$e5\noow", "$e5\ow-userf" | Out-Null
foreach ($n in @('ow', 'noow', 'ow-userf')) {
  $d = "$e5\$n"
  icacls $d /setowner $account /Q | Out-Null; $so = $LASTEXITCODE
  $grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  if ($n -ne 'noow') { $grants += '*S-1-3-4:(RC)' }
  if ($n -eq 'ow-userf') { $grants += "*${userSid}:(OI)(CI)F" }
  icacls $d /inheritance:r /grant:r @grants /Q | Out-Null; $gr = $LASTEXITCODE
  $sd = (Get-Acl -LiteralPath $d).Sddl
  Stamp "[e5-2] fixture=$n setownerExit=$so grantExit=$gr sddl=$sd"
}
$q = { param([string]$v) "'" + $v.Replace("'", "''") + "'" }
$launcher = Join-Path $scratch 'launch.ps1'
Set-Content -LiteralPath $launcher -Encoding utf8 -Value ([string[]]@(
  ('$env:BYOK_LOWPRIV_SCRATCH = ' + (& $q $scratch)),
  ('$env:BYOK_LOWPRIV_WORKSPACE = ' + (& $q $checkout)),
  ('$env:BYOK_LOWPRIV_NODEDIR = ' + (& $q $nodeHome)),
  ('$env:BYOK_DIAG_ROUND = ' + (& $q $env:BYOK_DIAG_ROUND)),
  ('& ' + (& $q (Join-Path $checkout '.github\diag-1373\child.ps1'))),
  'exit $LASTEXITCODE'))
$out = Join-Path $scratch 'logs\out.log'; $err = Join-Path $scratch 'logs\err.log'
Stamp "starting child"
$proc = Start-Process -FilePath $pwshExe -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $launcher) -Credential $cred -WorkingDirectory $scratch -RedirectStandardOutput $out -RedirectStandardError $err -Wait -PassThru
$code = $proc.ExitCode
Stamp "child exit=$code"
foreach ($f in @($out, $err)) { Write-Host "===== $(Split-Path -Leaf $f) ====="; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f -Encoding utf8 | ForEach-Object { Write-Host $_ } } }
mountvol "$e4\mount" /D | Out-Null
try { Remove-LocalUser -Name $account } catch { Write-Host "teardown: $($_.Exception.Message)" }
exit $code
