# DIAG #1317 -- do not merge. E1b: what Windows itself builds as the logon
# environment from HKLM ...\Session Manager\Environment and HKCU\Environment,
# read through CreateEnvironmentBlock(token, bInherit = FALSE) for this
# process's token. Each case writes the real keys on the ephemeral runner and
# the finally block restores them. E1c: reg query vs reg export of the real
# HKCU\Environment Path while it holds a non-ASCII directory.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class E1Env {
  [DllImport("userenv.dll", SetLastError = true)]
  static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, bool inherit);
  [DllImport("userenv.dll", SetLastError = true)]
  static extern bool DestroyEnvironmentBlock(IntPtr block);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  public static extern uint GetACP();
  [DllImport("kernel32.dll")]
  public static extern uint GetOEMCP();
  public static Dictionary<string, string> Build() {
    IntPtr token; IntPtr block;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008 | 0x0002, out token)) throw new System.ComponentModel.Win32Exception();
    if (!CreateEnvironmentBlock(out block, token, false)) throw new System.ComponentModel.Win32Exception();
    var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    IntPtr cursor = block;
    while (true) {
      string entry = Marshal.PtrToStringUni(cursor);
      if (string.IsNullOrEmpty(entry)) break;
      int eq = entry.IndexOf('=', 1);
      if (eq > 0) result[entry.Substring(0, eq)] = entry.Substring(eq + 1);
      cursor = new IntPtr(cursor.ToInt64() + (entry.Length + 1) * 2);
    }
    DestroyEnvironmentBlock(block);
    return result;
  }
}
'@
function Show($label, $value) { Write-Output ("{0}: {1}" -f $label, (ConvertTo-Json -Compress -InputObject $value)) }
$machine = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
$user = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$raw = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$expandKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
$stringKind = [Microsoft.Win32.RegistryValueKind]::String
$names = 'Path', 'PATHEXT', 'E1PROBE1317', 'E1PROBEU1317'
$saved = @{}
foreach ($name in $names) {
  $saved[$name] = @{ value = $user.GetValue($name, $null, $raw); kind = $(if ($user.GetValueNames() -contains $name) { $user.GetValueKind($name) } else { $null }) }
}
function Clear-Case { foreach ($name in $names) { $user.DeleteValue($name, $false) }; $machine.DeleteValue('E1PROBE1317', $false) }
$machinePath = $machine.GetValue('Path', $null, $raw)
$machinePathExt = $machine.GetValue('PATHEXT', $null, $raw)

Show 'ACP' ([E1Env]::GetACP())
Show 'OEMCP' ([E1Env]::GetOEMCP())
Show 'console output encoding' ([Console]::OutputEncoding.WebName)
Show 'machine Path raw' $machinePath
Show 'machine Path kind' "$($machine.GetValueKind('Path'))"
Show 'machine PATHEXT raw' $machinePathExt
Show 'machine PATHEXT kind' "$($machine.GetValueKind('PATHEXT'))"
Show 'user values before (names)' ($user.GetValueNames())
Show 'user Path before raw' $saved['Path'].value
Show 'user Path before kind' "$($saved['Path'].kind)"
Show 'session USERPROFILE' $env:USERPROFILE

try {
  # Case A: user Path REG_EXPAND_SZ with a non-ASCII directory, a session name and an undefined name.
  Clear-Case
  $userPath = 'C:\e1 空間 é\bin;%USERPROFILE%\e1;%E1UNDEFINED1317%'
  $user.SetValue('Path', $userPath, $expandKind)
  $a = [E1Env]::Build()
  Show 'A logon Path' $a['Path']
  Show 'A machine Path expanded by .NET' ([Environment]::ExpandEnvironmentVariables($machinePath))
  Show 'A logon Path == expand(machine) + ";" + expand(user)' ($a['Path'] -eq ([Environment]::ExpandEnvironmentVariables($machinePath) + ';' + [Environment]::ExpandEnvironmentVariables($userPath)))
  Show 'A logon USERPROFILE' $a['USERPROFILE']

  # E1c while case A's non-ASCII user Path is in place.
  $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
  $queryHex = & node -e "process.stdout.write(require('child_process').execFileSync(process.argv[1], ['query', 'HKCU\\Environment', '/v', 'Path']).toString('hex'))" $reg
  $queryBytes = [Convert]::FromHexString($queryHex)
  Show 'E1c reg query bytes as UTF-8' ([Text.Encoding]::UTF8.GetString($queryBytes))
  Show 'E1c reg query bytes as OEM' ([Text.Encoding]::GetEncoding([int][E1Env]::GetOEMCP()).GetString($queryBytes))
  Show 'E1c reg query hex' $queryHex
  Show 'E1c reg query verbatim (UTF-8)' ([Text.Encoding]::UTF8.GetString($queryBytes).Contains($userPath))
  $file = Join-Path $env:RUNNER_TEMP 'e1-user.reg'
  & $reg export 'HKCU\Environment' $file /y | Out-Null
  Show 'E1c reg export exit' $LASTEXITCODE
  $bytes = [IO.File]::ReadAllBytes($file)
  Show 'E1c reg export BOM' ([Convert]::ToHexString($bytes, 0, 2))
  Show 'E1c reg export text' ([Text.Encoding]::Unicode.GetString($bytes))

  # Case B: user Path that refers to %PATH%.
  Clear-Case
  $user.SetValue('Path', '%PATH%;C:\e1-b', $expandKind)
  Show 'B logon Path' ([E1Env]::Build()['Path'])

  # Case C: user Path REG_SZ (not REG_EXPAND_SZ) holding a %NAME%.
  Clear-Case
  $user.SetValue('Path', 'C:\e1-c;%USERPROFILE%\e1-c', $stringKind)
  Show 'C logon Path' ([E1Env]::Build()['Path'])

  # Case D: user-level PATHEXT.
  Clear-Case
  $user.SetValue('PATHEXT', '.E1U;.CMD', $stringKind)
  Show 'D logon PATHEXT' ([E1Env]::Build()['PATHEXT'])

  # Case E: user-level PATHEXT REG_EXPAND_SZ referring to %PATHEXT%.
  Clear-Case
  $user.SetValue('PATHEXT', '%PATHEXT%;.E1U', $expandKind)
  Show 'E logon PATHEXT' ([E1Env]::Build()['PATHEXT'])

  # Case F: empty user Path, and no user Path at all.
  Clear-Case
  $user.SetValue('Path', '', $expandKind)
  Show 'F empty user Path: logon Path' ([E1Env]::Build()['Path'])
  Clear-Case
  Show 'F no user Path: logon Path' ([E1Env]::Build()['Path'])

  # Case G: an ordinary name in both scopes, and a user value referring to it.
  Clear-Case
  $machine.SetValue('E1PROBE1317', 'machine', $stringKind)
  $user.SetValue('E1PROBE1317', 'user', $stringKind)
  $user.SetValue('E1PROBEU1317', '%E1PROBE1317%|%PATHEXT%', $expandKind)
  $g = [E1Env]::Build()
  Show 'G logon E1PROBE1317' $g['E1PROBE1317']
  Show 'G logon E1PROBEU1317' $g['E1PROBEU1317']
} finally {
  Clear-Case
  foreach ($name in $saved.Keys) {
    if ($null -ne $saved[$name].kind) { $user.SetValue($name, $saved[$name].value, $saved[$name].kind) }
  }
}
