// DIAG #1373 E5 (do not merge): fixed JScript for cscript.exe. Codex's candidate.
//   cscript //NoLogo wsh-acl.js sd <path>    -> WMI Win32_LogicalFileSecuritySetting.GetSecurityDescriptor
//   cscript //NoLogo wsh-acl.js attr <path>  -> Scripting.FileSystemObject Attributes (0x400 = ReparsePoint)
// One output line; values are numbers and SID strings only.
var mode = WScript.Arguments(0), p = WScript.Arguments(1), out = WScript.StdOut;
function hex(n) { return '0x' + ((n < 0 ? n + 0x100000000 : n)).toString(16); }
if (mode === 'sd') {
  var obj;
  try {
    var svc = GetObject('winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2');
    obj = svc.Get('Win32_LogicalFileSecuritySetting.Path="' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
  } catch (e) { out.Write('stage=get err=' + hex(e.number)); WScript.Quit(20); }
  var res;
  try { res = obj.ExecMethod_('GetSecurityDescriptor'); } catch (e) { out.Write('stage=exec err=' + hex(e.number)); WScript.Quit(21); }
  var rv = res.ReturnValue;
  if (rv !== 0) { out.Write('stage=rv rv=' + rv); WScript.Quit(22); }
  var d = res.Descriptor, aces = [];
  var dacl = d.DACL === null ? [] : new VBArray(d.DACL).toArray();
  for (var i = 0; i < dacl.length; i++) {
    var a = dacl[i];
    aces.push('{"sid":"' + a.Trustee.SIDString + '","type":' + a.AceType + ',"flags":' + a.AceFlags + ',"mask":' + (a.AccessMask < 0 ? a.AccessMask + 0x100000000 : a.AccessMask) + '}');
  }
  out.Write('{"owner":"' + (d.Owner === null ? '' : d.Owner.SIDString) + '","control":' + d.ControlFlags + ',"aces":[' + aces.join(',') + ']}');
  WScript.Quit(0);
}
if (mode === 'attr') {
  var fso = new ActiveXObject('Scripting.FileSystemObject'), kind = 'absent', item;
  try {
    if (fso.FolderExists(p)) { kind = 'folder'; item = fso.GetFolder(p); }
    else if (fso.FileExists(p)) { kind = 'file'; item = fso.GetFile(p); }
    else { out.Write('kind=absent'); WScript.Quit(3); }
    var attrs = item.Attributes;
    out.Write('kind=' + kind + ' attrs=' + hex(attrs) + ' reparse=' + ((attrs & 0x400) !== 0));
    WScript.Quit(0);
  } catch (e) { out.Write('kind=' + kind + ' err=' + hex(e.number)); WScript.Quit(4); }
}
WScript.Quit(2);
