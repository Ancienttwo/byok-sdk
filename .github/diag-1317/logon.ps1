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

  # Case B2-B5: where %PATH% sits, its spelling, REG_SZ, and a second reference.
  $machineExpanded = [Environment]::ExpandEnvironmentVariables($machinePath)
  foreach ($case in @(
      @{ id = 'B2'; value = 'C:\e1-b2;%PATH%'; kind = $expandKind },
      @{ id = 'B3'; value = 'C:\e1-b3;%path%;C:\e1-b3z'; kind = $expandKind },
      @{ id = 'B4'; value = '%PATH%;C:\e1-b4'; kind = $stringKind },
      @{ id = 'B5'; value = '%PATH%;C:\e1-b5;%PATH%'; kind = $expandKind },
      @{ id = 'B6'; value = 'C:\e1-b6;%PATHEXT%'; kind = $expandKind },
      @{ id = 'B7'; value = 'C:\e1-b7a;;C:\e1-b7b;'; kind = $expandKind },
      @{ id = 'B8'; value = ';C:\e1-b8;'; kind = $stringKind },
      @{ id = 'B9'; value = 'C:\e1-b9a;%PATH%%PATH%;C:\e1-b9b'; kind = $expandKind },
      @{ id = 'B10'; value = 'C:\e1-b10a%PATH%C:\e1-b10b'; kind = $expandKind },
      @{ id = 'B11'; value = '%PATH%'; kind = $expandKind },
      @{ id = 'B12'; value = ('C:\e1-b12;' + ($machineExpanded -split ';')[0] + ';C:\e1-b12z'); kind = $stringKind },
      @{ id = 'B13'; value = ('C:\e1-b13;' + ($machineExpanded -split ';')[0].ToUpperInvariant() + ';C:\e1-b13z'); kind = $stringKind },
      @{ id = 'B14'; value = ('C:\e1-b14;' + ($machineExpanded -split ';')[0] + '\;C:\e1-b14z'); kind = $stringKind },
      @{ id = 'B15'; value = 'C:\e1-b15;C:\e1-b15;c:\E1-B15'; kind = $stringKind },
      @{ id = 'B16'; value = '%SystemRoot%\system32;C:\e1-b16'; kind = $expandKind })) {
    Clear-Case
    $user.SetValue('Path', $case.value, $case.kind)
    $built = [E1Env]::Build()['Path']
    Show "$($case.id) logon Path with machine replaced by <M>" ($built.Replace($machineExpanded, '<M>'))
  }

  # Case H: a user REG_EXPAND_SZ naming a variable only this session has.
  Clear-Case
  $env:E1SESSIONONLY1317 = 'from-session'
  $user.SetValue('E1PROBEU1317', '%E1SESSIONONLY1317%|%USERPROFILE%|%SystemRoot%', $expandKind)
  Show 'H logon E1PROBEU1317' ([E1Env]::Build()['E1PROBEU1317'])

  # E1d: user Path naming other user variables, by creation order and by
  # name order; chains among user and machine variables; a REG_DWORD; and
  # which machine-key names see per-user predefined names.
  $e1dUser = 'AAANVM1317', 'ZZZNVM1317', 'E1CHAINA1317', 'E1CHAINZ1317', 'E1LATER1317', 'E1DWORD1317', 'E1UREFM1317'
  $e1dMachine = 'E1MREF1317', 'E1MA1317', 'E1MZ1317', 'E1MLATE1317'
  function Clear-E1d { Clear-Case; foreach ($n in $e1dUser) { $user.DeleteValue($n, $false) }; foreach ($n in $e1dMachine) { $machine.DeleteValue($n, $false) } }
  try {
    foreach ($order in 'refs-first', 'path-first') {
      Clear-E1d
      $setRefs = { $user.SetValue('AAANVM1317', 'C:\nvm-a', $stringKind); $user.SetValue('ZZZNVM1317', 'C:\nvm-z', $stringKind) }
      $setPath = { $user.SetValue('Path', '%AAANVM1317%;%ZZZNVM1317%;C:\e1d', $expandKind) }
      if ($order -eq 'refs-first') { & $setRefs; & $setPath } else { & $setPath; & $setRefs }
      Show "E1d $order user value order" ($user.GetValueNames())
      Show "E1d $order logon Path with machine replaced by <M>" ([E1Env]::Build()['Path'].Replace($machineExpanded, '<M>'))
    }

    # Chains: a user variable naming a user variable created after it, and one created before it.
    Clear-E1d
    $user.SetValue('E1CHAINZ1317', 'zval', $stringKind)
    $user.SetValue('E1CHAINA1317', '%E1CHAINZ1317%|%E1LATER1317%', $expandKind)
    $user.SetValue('E1LATER1317', 'later', $stringKind)
    $user.SetValue('E1UREFM1317', '%E1MREF1317%', $expandKind)
    # Machine chains: a machine variable naming per-user and system predefined names, and machine variables in both orders.
    $machine.SetValue('E1MREF1317', '%USERPROFILE%|%USERNAME%|%APPDATA%|%COMPUTERNAME%|%SystemRoot%|%ProgramFiles%|%ALLUSERSPROFILE%', $expandKind)
    $machine.SetValue('E1MZ1317', 'mz', $stringKind)
    $machine.SetValue('E1MA1317', '%E1MZ1317%|%E1MLATE1317%', $expandKind)
    $machine.SetValue('E1MLATE1317', 'mlate', $stringKind)
    $user.SetValue('E1DWORD1317', 5, [Microsoft.Win32.RegistryValueKind]::DWord)
    $d = [E1Env]::Build()
    Show 'E1d user value order' ($user.GetValueNames())
    Show 'E1d machine value order (tail)' ($machine.GetValueNames() | Select-Object -Last 6)
    Show 'E1d E1CHAINA1317 (names E1CHAINZ created before, E1LATER created after)' $d['E1CHAINA1317']
    Show 'E1d E1UREFM1317 (user naming a machine variable)' $d['E1UREFM1317']
    Show 'E1d E1MREF1317 (machine naming predefined names)' $d['E1MREF1317']
    Show 'E1d E1MA1317 (machine naming machine before/after)' $d['E1MA1317']
    Show 'E1d E1DWORD1317 present' ($d.ContainsKey('E1DWORD1317'))
    Show 'E1d E1DWORD1317 value' $d['E1DWORD1317']
    & $reg export 'HKCU\Environment' $file /y | Out-Null
    Show 'E1d HKCU export DWORD line' (([IO.File]::ReadAllText($file, [Text.Encoding]::Unicode) -split "`r`n") | Where-Object { $_ -like '"E1DWORD1317"=*' })

    # The predefined set: logon block names that neither Environment key defines.
    Clear-E1d
    $volatile = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Volatile Environment')
    $volatileNames = @($volatile.GetValueNames()) + @($volatile.GetSubKeyNames() | ForEach-Object { $volatile.OpenSubKey($_).GetValueNames() })
    $p = [E1Env]::Build()
    $machineNames = $machine.GetValueNames()
    $userNames = $user.GetValueNames()
    $origin = foreach ($name in ($p.Keys | Sort-Object)) {
      $where = @()
      if ($machineNames -contains $name) { $where += 'machine' }
      if ($userNames -contains $name) { $where += 'user' }
      if ($volatileNames -contains $name) { $where += 'volatile' }
      $session = [Environment]::GetEnvironmentVariable($name)
      [pscustomobject]@{ name = $name; keys = ($where -join '+'); equalsSession = ($session -eq $p[$name]) }
    }
    Show 'E1d volatile environment names' $volatileNames
    Show 'E1d logon block names with origin' $origin
    Show 'E1d predefined (in no Environment key)' (@($origin | Where-Object { $_.keys -eq '' -or $_.keys -eq 'volatile' } | ForEach-Object { $_.name }))
    Show 'E1d machine-key names' ($machineNames | Sort-Object)
    Show 'E1d session names' (@([Environment]::GetEnvironmentVariables().Keys) | Sort-Object)

    # E1e: which names each stage expands, one name per variable.
    Clear-E1d
    $probeNames = @($p.Keys | Where-Object { $machineNames -notcontains $_ -and $userNames -notcontains $_ }) + 'USERNAME', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'TEMP', 'windir', 'ComSpec'
    $e1eMachine = @(); $e1eUser = @()
    $i = 0
    foreach ($name in $probeNames) {
      $i += 1
      $machine.SetValue("E1EM$i", "%$name%", $expandKind); $e1eMachine += "E1EM$i"
      $user.SetValue("E1EU$i", "%$name%", $expandKind); $e1eUser += "E1EU$i"
    }
    # EXPAND naming EXPAND, both creation orders, in both keys; and a non-Path user variable naming %PATH%.
    $machine.SetValue('E1EMXA', '%E1EMXB%', $expandKind); $machine.SetValue('E1EMXB', 'mxb-%SystemRoot%', $expandKind); $machine.SetValue('E1EMXC', '%E1EMXB%', $expandKind)
    $user.SetValue('E1EUXA', '%E1EUXB%', $expandKind); $user.SetValue('E1EUXB', 'uxb-%USERPROFILE%', $expandKind); $user.SetValue('E1EUXC', '%E1EUXB%', $expandKind)
    $user.SetValue('E1EUP', '%PATH%', $expandKind)
    $user.SetValue('E1EUN', '%USERNAME%|%USERPROFILE%', $expandKind)
    $user.SetValue('E1EUPE', '%PATHEXT%', $expandKind)
    $user.SetValue('Path', 'C:\e1e', $expandKind)
    $user.SetValue('E1EUQ', '%PATH%', $expandKind)
    $e1eMachine += 'E1EMXA', 'E1EMXB', 'E1EMXC'; $e1eUser += 'E1EUXA', 'E1EUXB', 'E1EUXC', 'E1EUP', 'E1EUPE', 'E1EUN', 'E1EUQ'
    try {
      $e = [E1Env]::Build()
      $i = 0
      $rows = foreach ($name in $probeNames) {
        $i += 1
        [pscustomobject]@{ name = $name; machine = ($e["E1EM$i"] -ne "%$name%"); user = ($e["E1EU$i"] -ne "%$name%") }
      }
      Show 'E1e expanded per stage' $rows
      Show 'E1e machine EXPAND naming EXPAND (A before B, C after)' @($e['E1EMXA'], $e['E1EMXB'], $e['E1EMXC'])
      Show 'E1e user EXPAND naming EXPAND (A before B, C after)' @($e['E1EUXA'], $e['E1EUXB'], $e['E1EUXC'])
      Show 'E1e user %PATH% outside Path, machine replaced by <M>' ($e['E1EUP'].Replace($machineExpanded, '<M>'))
      Show 'E1e user %PATHEXT% outside PATHEXT' $e['E1EUPE']
      Show 'E1f user USERNAME|USERPROFILE (session USERNAME, logon USERNAME)' @($e['E1EUN'], $env:USERNAME, $e['USERNAME'])
      Show 'E1f user %PATH% created after the user Path, machine replaced by <M>' ($e['E1EUQ'].Replace($machineExpanded, '<M>'))
      Show 'E1f machine Path first entry' (($machineExpanded -split ';')[0])
      Show 'E1f machine Path has system32' (@($machineExpanded -split ';' | Where-Object { $_ -like '*system32' }))
    } finally {
      foreach ($n in $e1eMachine) { $machine.DeleteValue($n, $false) }
      foreach ($n in $e1eUser) { $user.DeleteValue($n, $false) }
    }
  } finally {
    Clear-E1d
  }

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
