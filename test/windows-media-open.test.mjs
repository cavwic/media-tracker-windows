import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const helperPath = path.join(root, "scripts", "windows-media-open.cs");
const scriptPath = path.join(root, "scripts", "windows-file-action.ps1");
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const run = promisify(execFile);
const quotePs = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const encoded = (source) => Buffer.from(source, "utf16le").toString("base64");

const fakeSource = String.raw`
public sealed class MediaOpenFakeApi : MediaTrackerFileOpen.IActivationApi {
  public long Foreground = 10;
  public int Sets;
  public int Waits;
  public bool Throws;
  public bool ThrowAttach;
  public bool AttachFails;
  public bool May = true;
  public bool SwitchAfterRestore;
  public System.Collections.Generic.List<string> Calls = new System.Collections.Generic.List<string>();
  public long ForegroundHandle() { return Foreground; }
  public uint CurrentThread() { return 1; }
  public uint WindowThread(long handle) { return handle == 10 ? 10u : 20u; }
  public uint WindowProcess(long handle) { return 99; }
  public bool Restore(long handle) { Calls.Add("restore:" + handle); return true; }
  public bool SetForeground(long handle) {
    Calls.Add("set:" + handle); Sets++;
    if (Throws && Sets == 2) throw new System.InvalidOperationException("fixture");
    if (Sets == 2) Foreground = handle;
    return Sets == 2;
  }
  public bool AllowForeground(uint processId) { Calls.Add("allow:" + processId); return true; }
  public bool Attach(uint from, uint to, bool attach) {
    Calls.Add("attach:" + from + ":" + to + ":" + attach);
    if (ThrowAttach && to == 20 && attach) throw new System.InvalidOperationException("fixture");
    return !AttachFails;
  }
  public void PrepareMessageQueue() { Calls.Add("queue"); }
  public void Wait(int milliseconds) { Calls.Add("wait:" + milliseconds); Waits++; if (SwitchAfterRestore) May = false; }
  public bool MayActivate(long target) { return May; }
}
`;

let fixturePromise;
function fixtureResults() {
  fixturePromise ||= run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$source=[IO.File]::ReadAllText(${quotePs(helperPath)}) + @'
${fakeSource}
'@
Add-Type -TypeDefinition $source
$association=New-Object MediaTrackerFileOpen.Association
$association.Executable='C:\\viewer\\pictures.exe'
$photo=New-Object MediaTrackerFileOpen.Association
$photo.Executable='C:\\Windows\\System32\\rundll32.exe'
$photo.PhotoViewer=$true
$uwp=New-Object MediaTrackerFileOpen.Association
$uwp.AppId='Microsoft.Windows.Photos_fixture!App'
$filename='20260822_人物W_01_1234567890abcdef.jpg'
function New-Window([long]$handle,[string]$title,[string]$executable='C:\\viewer\\pictures.exe') {
  $window=New-Object MediaTrackerFileOpen.WindowRecord
  $window.Handle=$handle
  $window.ProcessId=55
  $window.Title=$title
  $window.Executable=$executable
  $window.Visible=$true
  return $window
}
function Pick($assoc,$prior,$after,[uint32]$launchedPid=0) {
  $selection=[MediaTrackerFileOpen.Policy]::Select($assoc,$filename,$launchedPid,
    [MediaTrackerFileOpen.WindowRecord[]]$prior,[MediaTrackerFileOpen.WindowRecord[]]$after)
  if ($selection.Window) { return [string]$selection.Window.Handle }
  return $selection.Reason
}
$result=[ordered]@{}
$named=New-Window 101 "$filename - Viewer"
$other=New-Window 102 'different.jpg - Viewer'
$result.new=Pick $association @() @($named) 55
$result.pendingNewProcess=Pick $association @($named) @($named) 200
$result.sameLaunchedProcess=Pick $association @($named) @($named) 55
$result.nullProcessReuse=Pick $association @($named) @($named) 0
$result.wrongFile=Pick $association @() @($other) 55
$hiddenExtension=New-Window 103 ([IO.Path]::GetFileNameWithoutExtension($filename) + ' - Viewer')
$result.hiddenExtension=Pick $association @() @($hiddenExtension)
$wrongExtension=New-Window 104 ($filename.Replace('.jpg','.png') + ' - Viewer')
$result.wrongExtension=Pick $association @() @($wrongExtension)
$prefix=New-Window 105 ('extra_' + $filename)
$result.prefix=Pick $association @() @($prefix)
$before=New-Window 106 'older-image.jpg - Viewer'
$reused=New-Window 106 "$filename - Viewer"
$result.reused=Pick $association @($before) @($reused)
$minimized=New-Window 107 "$filename - Viewer"
$minimized.Minimized=$true
$result.minimized=Pick $association @($minimized) @($minimized)
$duplicate=New-Window 108 "$filename - Viewer"
$result.duplicate=Pick $association @() @($named,$duplicate)
$result.newPreferred=Pick $association @($named) @($named,$duplicate)
$wrongApp=New-Window 109 "$filename - Viewer" 'C:\\other\\pictures.exe'
$result.wrongApp=Pick $association @() @($wrongApp)
$photoWindow=New-Window 110 "$filename - Windows Photo Viewer" $photo.Executable
$photoWindow.ClassName='Photo_Lightweight_Viewer'
$result.photo=Pick $photo @() @($photoWindow)
$photoCom=New-Window 117 "$filename - Windows Photo Viewer" ([IO.Path]::Combine([Environment]::SystemDirectory,'dllhost.exe'))
$photoCom.ClassName='Photo_Lightweight_Viewer'
$photoCom.Minimized=$true
$result.photoCom=Pick $photo @() @($photoCom)
$comOther=New-Window 118 "$filename - unrelated COM app" $photoCom.Executable
$comOther.ClassName='UnrelatedComWindow'
$result.otherCom=Pick $photo @() @($comOther)
$comImpostor=New-Window 119 "$filename - Windows Photo Viewer" 'C:\\other\\dllhost.exe'
$comImpostor.ClassName='Photo_Lightweight_Viewer'
$result.comImpostor=Pick $photo @() @($comImpostor)
$comWrongFile=New-Window 120 'other-file.jpg - Windows Photo Viewer' $photoCom.Executable
$comWrongFile.ClassName='Photo_Lightweight_Viewer'
$result.comWrongFile=Pick $photo @() @($comWrongFile)
$unsafeCom=New-Object MediaTrackerFileOpen.Association
$unsafeCom.Executable=$photoCom.Executable
$result.genericCom=Pick $unsafeCom @() @($photoCom)
$rundllOther=New-Window 111 "$filename - unrelated" $photo.Executable
$rundllOther.ClassName='UnrelatedRundllWindow'
$result.otherRundll=Pick $photo @() @($rundllOther) 55
$unsafeRundll=New-Object MediaTrackerFileOpen.Association
$unsafeRundll.Executable=$photo.Executable
$result.genericRundll=Pick $unsafeRundll @() @($photoWindow) 55
$frame=New-Window 112 "$filename - Photos" 'C:\\Windows\\System32\\ApplicationFrameHost.exe'
$frame.AppId=$uwp.AppId
$result.uwp=Pick $uwp @() @($frame)
$otherFrame=New-Window 113 "$filename - other app" $frame.Executable
$otherFrame.AppId='Other.PackagedApp!App'
$result.otherUwp=Pick $uwp @() @($otherFrame)
$missingFrame=New-Window 114 "$filename - Photos" $frame.Executable
$result.missingUwp=Pick $uwp @() @($missingFrame)
$cloaked=New-Window 115 "$filename - Viewer"
$cloaked.Cloaked=$true
$result.cloaked=Pick $association @() @($cloaked)
$owned=New-Window 116 "$filename - Viewer"
$owned.Owned=$true
$result.owned=Pick $association @() @($owned)
$result.userSwitch=[MediaTrackerFileOpen.Policy]::UserSwitched(10,100,30,101,20)
$result.sameInput=[MediaTrackerFileOpen.Policy]::UserSwitched(10,100,30,100,20)
$result.sameApp=[MediaTrackerFileOpen.Policy]::UserSwitched(10,100,10,101,20)
$result.targetForeground=[MediaTrackerFileOpen.Policy]::UserSwitched(10,100,20,101,20)
$api=New-Object MediaOpenFakeApi
$result.activated=[MediaTrackerFileOpen.Policy]::Activate($api,20)
$result.activationCalls=@($api.Calls)
$throwing=New-Object MediaOpenFakeApi
$throwing.Throws=$true
try { [void][MediaTrackerFileOpen.Policy]::Activate($throwing,20) } catch {}
$result.throwCalls=@($throwing.Calls)
$attachThrowing=New-Object MediaOpenFakeApi
$attachThrowing.ThrowAttach=$true
try { [void][MediaTrackerFileOpen.Policy]::Activate($attachThrowing,20) } catch {}
$result.attachThrowCalls=@($attachThrowing.Calls)
$failedAttach=New-Object MediaOpenFakeApi
$failedAttach.AttachFails=$true
[void][MediaTrackerFileOpen.Policy]::Activate($failedAttach,20)
$result.failedAttachCalls=@($failedAttach.Calls)
$switched=New-Object MediaOpenFakeApi
$switched.SwitchAfterRestore=$true
$result.stoppedOnSwitch=[MediaTrackerFileOpen.Policy]::Activate($switched,20)
$result.switchCalls=@($switched.Calls)
$native=[MediaTrackerFileOpen.Policy].Assembly.GetType('MediaTrackerFileOpen.Native')
$photoAssociation=$native.GetMethod('QueryAssociation').Invoke($null,@('.jpg'))
$result.actualPhotoLauncher=if($photoAssociation.PhotoViewer){[IO.Path]::GetFileName($photoAssociation.Executable)}else{'not-photo-viewer'}
$result | ConvertTo-Json -Depth 5 -Compress
`)], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }).then(({ stdout }) => JSON.parse(stdout.trim()));
  return fixturePromise;
}

test("Windows media open is ASCII, keeps the reveal branch and never changes association or permanent focus", async () => {
  const source = await readFile(helperPath, "utf8");
  const script = await readFile(scriptPath, "utf8");
  assert.ok(!/[^\x00-\x7f]/.test(source));
  assert.ok(!/[^\x00-\x7f]/.test(script));
  assert.match(source, /SeeMaskNoCloseProcess \| SeeMaskNoAsync/);
  assert.match(source, /finally\s*\{\s*if \(launch\.ProcessHandle != IntPtr\.Zero\) Native\.CloseHandle/);
  assert.match(source, /AssocQueryString/);
  assert.match(source, /GetApplicationUserModelId/);
  assert.match(source, /Photo_Lightweight_Viewer/);
  assert.match(source, /Environment\.SystemDirectory, "dllhost\.exe"/);
  assert.match(source, /if \(result\.Foreground \|\| result\.Reason == "user-switched"\) return result/);
  assert.match(source, /DateTime\.UtcNow\.AddSeconds\(4\)/);
  assert.match(source, /EnumChildWindows/);
  assert.match(source, /!Native\.IsIconic\(window\) \|\| Native\.ShowWindowAsync/);
  assert.doesNotMatch(source, /SendInput|keybd_event|mouse_event|SetWindowPos|HWND_TOPMOST|ASFW_ANY|SystemParametersInfo|Registry\.(Set|Create)/);
  assert.match(script, /"foreground=\{0\}" -f \$result\.Foreground/);
  assert.match(script, /"reason=\{0\}" -f \$result\.Reason/);
  assert.match(script, /'\/select,"\{0\}"' -f \$item\.FullName/);
  assert.match(script, /\$windowPath\.Equals\(\$directory/);
});

const selectionCases = {
  new: "101", pendingNewProcess: "target-unconfirmed", sameLaunchedProcess: "101", nullProcessReuse: "101",
  wrongFile: "target-unconfirmed", hiddenExtension: "103", wrongExtension: "target-unconfirmed",
  prefix: "target-unconfirmed", reused: "106", minimized: "107", duplicate: "target-ambiguous", newPreferred: "108",
  wrongApp: "target-unconfirmed", photo: "110", otherRundll: "target-unconfirmed", genericRundll: "target-unconfirmed",
  photoCom: "117", otherCom: "target-unconfirmed", comImpostor: "target-unconfirmed",
  comWrongFile: "target-unconfirmed", genericCom: "target-unconfirmed",
  uwp: "112", otherUwp: "target-unconfirmed", missingUwp: "target-unconfirmed", cloaked: "target-unconfirmed", owned: "target-unconfirmed",
  userSwitch: true, sameInput: false, sameApp: false, targetForeground: false,
};
for (const [name, expected] of Object.entries(selectionCases)) {
  test(`Windows foreground policy: ${name}`, { skip: process.platform !== "win32" }, async () => {
    assert.equal((await fixtureResults())[name], expected);
  });
}

test("Windows foreground activation detaches both successful thread attachments and waits for asynchronous restore", { skip: process.platform !== "win32" }, async () => {
  const result = await fixtureResults();
  assert.equal(result.activated, true);
  assert.deepEqual(result.activationCalls, ["restore:20", "wait:80", "set:20", "allow:99", "queue", "attach:1:10:True", "attach:1:20:True", "restore:20", "wait:80", "set:20", "wait:40", "attach:1:20:False", "attach:1:10:False"]);
  assert.deepEqual(result.throwCalls.slice(-2), ["attach:1:20:False", "attach:1:10:False"]);
  assert.deepEqual(result.attachThrowCalls.slice(-1), ["attach:1:10:False"]);
  assert.equal(result.failedAttachCalls.some((entry) => entry.endsWith(":False")), false);
  assert.equal(result.stoppedOnSwitch, false);
  assert.deepEqual(result.switchCalls, ["restore:20", "wait:80"]);
  if (result.actualPhotoLauncher !== "not-photo-viewer") assert.equal(result.actualPhotoLauncher.toLowerCase(), "rundll32.exe");
});

test("native Windows minimized owned fixture restores to foreground without opening media or changing associations", {
  skip: process.platform !== "win32" || process.env.MEDIA_TRACKER_NATIVE_FOREGROUND_TEST !== "1",
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "media-tracker-foreground-"));
  const executable = path.join(temporary, "owned-foreground-fixture.exe");
  const ready = path.join(temporary, "ready.txt");
  const stop = path.join(temporary, "stop.txt");
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      // Only the exact test child created below is eligible for cleanup.
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(temporary).startsWith("media-tracker-foreground-"));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const fixtureSource = String.raw`
using System;
using System.IO;
using System.Windows.Forms;
public static class OwnedForegroundFixture {
  [STAThread] public static void Main(string[] args) {
    var form = new Form();
    form.Text = "Media Tracker owned foreground fixture";
    form.Width = 200; form.Height = 100;
    form.WindowState = FormWindowState.Minimized;
    form.Shown += delegate { File.WriteAllText(args[0], form.Handle.ToInt64().ToString()); };
    var timer = new Timer(); timer.Interval = 100;
    timer.Tick += delegate { if (File.Exists(args[1])) form.Close(); };
    timer.Start();
    Application.Run(form);
    timer.Dispose(); form.Dispose();
  }
}
`;
  await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
${fixtureSource}
'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly ${quotePs(executable)} -OutputType WindowsApplication
`)], { windowsHide: true, timeout: 15_000 });
  child = spawn(executable, [ready, stop], { windowsHide: true, stdio: "ignore" });
  let handle;
  for (let i = 0; i < 80; i++) {
    try { handle = Number((await readFile(ready, "utf8")).trim()); } catch {}
    if (handle) break;
    if (child.exitCode !== null) throw new Error("Owned native fixture exited before ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(handle > 0);
  const { stdout } = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -Path ${quotePs(helperPath)}
$assembly=[MediaTrackerFileOpen.Policy].Assembly
$native=$assembly.GetType('MediaTrackerFileOpen.Native')
$apiType=$assembly.GetType('MediaTrackerFileOpen.NativeActivationApi')
$foreground=[long]$native.GetMethod('GetForegroundWindow').Invoke($null,@()).ToInt64()
$lastInput=[uint32]$native.GetMethod('LastInput').Invoke($null,@())
$minimized=[bool]$native.GetMethod('IsIconic').Invoke($null,@([IntPtr]${handle}))
$api=[Activator]::CreateInstance($apiType,@($foreground,$lastInput))
$activated=[MediaTrackerFileOpen.Policy]::Activate($api,[long]${handle})
$after=[long]$native.GetMethod('GetForegroundWindow').Invoke($null,@()).ToInt64()
$stillMinimized=[bool]$native.GetMethod('IsIconic').Invoke($null,@([IntPtr]${handle}))
[IO.File]::WriteAllText(${quotePs(stop)},'done')
@{beforeMinimized=$minimized;afterMinimized=$stillMinimized;activated=$activated;targetForeground=($after -eq ${handle})} | ConvertTo-Json -Compress
`)], { windowsHide: true, timeout: 15_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.beforeMinimized, true);
  assert.equal(result.afterMinimized, false);
  assert.equal(result.activated, true);
  assert.equal(result.targetForeground, true);
});
