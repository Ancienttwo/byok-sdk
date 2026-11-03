# #1317 E1 probe part 2 (temporary, removed before freeze): what logon builds
# from HKLM and HKCU Environment, read through CreateEnvironmentBlock with
# this process's token. Runs on an ephemeral CI runner; it writes the real
# keys and restores them.
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
$machine = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
$user = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$none = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$saved = @{}
foreach ($name in 'Path', 'PATHEXT', 'E1PROBE1317', 'E1PROBEU1317') {
  $saved[$name] = @{ value = $user.GetValue($name, $null, $none); kind = $(if ($user.GetValueNames() -contains $name) { $user.GetValueKind($name) } else { $null }) }
}
function Show($label, $value) { Write-Output ("{0}: {1}" -f $label, (ConvertTo-Json -Compress -InputObject $value)) }
try {
  Show 'machine Path raw' $machine.GetValue('Path', $null, $none)
  Show 'machine Path kind' "$($machine.GetValueKind('Path'))"
  Show 'machine PATHEXT raw' $machine.GetValue('PATHEXT', $null, $none)
  Show 'user Path raw (before)' $saved['Path'].value
  Show 'user Path kind (before)' "$($saved['Path'].kind)"
  $userPath = "C:\e1 空間 é\bin;%USERPROFILE%\e1;%E1UNDEFINED1317%"
  $user.SetValue('Path', $userPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  $user.SetValue('PATHEXT', '.E1U', [Microsoft.Win32.RegistryValueKind]::String)
  $machine.SetValue('E1PROBE1317', 'machine', [Microsoft.Win32.RegistryValueKind]::String)
  $user.SetValue('E1PROBE1317', 'user', [Microsoft.Win32.RegistryValueKind]::String)
  $user.SetValue('E1PROBEU1317', '%E1PROBE1317%|%PATHEXT%', [Microsoft.Win32.RegistryValueKind]::ExpandString)
  $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
  $queryBytes = & node -e "process.stdout.write(require('child_process').execFileSync(process.argv[1], ['query', 'HKCU\\Environment', '/v', 'Path']).toString('hex'))" $reg
  Show 'HKCU Path via reg query (utf8 of raw bytes)' ([Text.Encoding]::UTF8.GetString([Convert]::FromHexString($queryBytes)))
  Show 'HKCU Path via reg query verbatim' ([Text.Encoding]::UTF8.GetString([Convert]::FromHexString($queryBytes)).Contains($userPath))
  $file = Join-Path $env:RUNNER_TEMP 'e1-user.reg'
  & $reg export 'HKCU\Environment' $file /y | Out-Null
  Show 'HKCU export exit' $LASTEXITCODE
  Show 'HKCU export text' ([IO.File]::ReadAllText($file, [Text.Encoding]::Unicode))
  $built = [E1Env]::Build()
  Show 'logon Path' $built['Path']
  Show 'logon Path == machine;user (expanded)' ($built['Path'] -eq ([Environment]::ExpandEnvironmentVariables($machine.GetValue('Path', $null, $none)) + ';' + [Environment]::ExpandEnvironmentVariables($userPath)))
  Show 'logon PATHEXT' $built['PATHEXT']
  Show 'logon E1PROBE1317' $built['E1PROBE1317']
  Show 'logon E1PROBEU1317' $built['E1PROBEU1317']
  $user.SetValue('Path', '', [Microsoft.Win32.RegistryValueKind]::ExpandString)
  Show 'logon Path with empty user Path' ([E1Env]::Build()['Path'])
} finally {
  foreach ($name in $saved.Keys) {
    if ($null -eq $saved[$name].kind) { $user.DeleteValue($name, $false) } else { $user.SetValue($name, $saved[$name].value, $saved[$name].kind) }
  }
  $machine.DeleteValue('E1PROBE1317', $false)
}
