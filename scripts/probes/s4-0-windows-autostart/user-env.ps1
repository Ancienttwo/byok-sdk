# Dot-sourced first by every script that runs as the standard user.
# Start-Process -Credential copies the runner administrator's environment
# block, so USERPROFILE, APPDATA, USERNAME and friends name runneradmin.
# Rebuild them from this process's token and its loaded profile.
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$profileDir = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($id.User.Value)").ProfileImagePath
$env:USERDOMAIN, $env:USERNAME = $id.Name.Split('\')
$env:USERPROFILE = $profileDir
$env:HOMEDRIVE = $profileDir.Substring(0, 2)
$env:HOMEPATH = $profileDir.Substring(2)
$env:APPDATA = "$profileDir\AppData\Roaming"
$env:LOCALAPPDATA = "$profileDir\AppData\Local"
$env:TEMP = "$profileDir\AppData\Local\Temp"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
