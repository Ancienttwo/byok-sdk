$ErrorActionPreference = 'Stop'
try { [void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35') } catch { exit 5 }
try {
  $serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
  $requestText = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false, $true)).ReadToEnd()
  try { $request = $serializer.DeserializeObject($requestText) } catch { exit 2 }
  if ($request -isnot [System.Collections.Generic.IDictionary[string, object]] -or $request.Count -ne 1 -or $request['path'] -isnot [string]) { exit 2 }
  $path = [string]$request['path']
  $sidType = [System.Security.Principal.SecurityIdentifier]
  $reparsePoint = ([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  $acl = [System.IO.Directory]::GetAccessControl($path)
  $rules = [System.Collections.Generic.List[object]]::new()
  foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
    $entry = [System.Collections.Generic.Dictionary[string, object]]::new()
    $entry['sid'] = [string]$rule.IdentityReference.Value
    $entry['allow'] = [bool]($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow)
    $entry['fullControl'] = [bool](($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
    $entry['inherits'] = [bool](($rule.InheritanceFlags -band 3) -eq 3 -and $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None)
    $rules.Add($entry)
  }
  $result = [System.Collections.Generic.Dictionary[string, object]]::new()
  $result['reparsePoint'] = [bool]$reparsePoint
  $result['owner'] = [string]$acl.GetOwner($sidType).Value
  $result['currentUser'] = [string][System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $result['protected'] = [bool]$acl.AreAccessRulesProtected
  $result['rules'] = $rules.ToArray()
  [Console]::Out.Write($serializer.Serialize($result))
  exit 0
} catch {
  $failure = $_.Exception
  while ($failure -is [System.Management.Automation.MethodInvocationException] -and $null -ne $failure.InnerException) { $failure = $failure.InnerException }
  if ($failure -is [System.IO.FileNotFoundException] -or $failure -is [System.IO.DirectoryNotFoundException]) { exit 3 }
  if ($failure -is [System.UnauthorizedAccessException] -or $failure -is [System.Security.AccessControl.PrivilegeNotHeldException]) { exit 4 }
  exit 1
}
