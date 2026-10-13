import { chromium } from "playwright";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { writeFile } from "node:fs/promises";
const [reportPath, mode, desktopName] = process.argv.slice(2);
const run = promisify(childProcess.execFile);
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
let browser, browserPid;
try {
  let executablePath;
  if (mode === "fixed") ({ BACKGROUND_CHROMIUM_EXECUTABLE: executablePath } = await import("../../lib/background-chromium.mjs"));
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => { const child = spawn(command, args, options); if (args?.includes("--remote-debugging-pipe") && args.some((arg) => arg.startsWith("--headless"))) browserPid = child.pid; return child; };
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ["--disable-background-networking"], timeout: 10_000 });
  const page = await browser.newPage(); await page.setContent("<p>Offline console fixture</p>");
  const source = `
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class ProbeConsole {
 [DllImport("kernel32.dll",SetLastError=true)]public static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")]public static extern bool FreeConsole();
 [DllImport("kernel32.dll")]public static extern IntPtr GetConsoleWindow();
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr hwnd,out RECT rectangle);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr hwnd,StringBuilder value,int size);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr OpenDesktop(string name,uint flags,bool inherit,uint access);
 [DllImport("user32.dll")]public static extern bool CloseDesktop(IntPtr desktop);
 public delegate bool Callback(IntPtr hwnd,IntPtr unused);
 [DllImport("user32.dll")]public static extern bool EnumDesktopWindows(IntPtr desktop,Callback callback,IntPtr unused);
 // Windows may inject input-indicator overlays even into headless processes.
 // They are not browser/console windows; report them separately via Describe.
 public static int Count(IntPtr desktop,uint pid){int count=0;EnumDesktopWindows(desktop,delegate(IntPtr hwnd,IntPtr unused){uint found;GetWindowThreadProcessId(hwnd,out found);if(found==pid&&IsWindowVisible(hwnd)){var name=new StringBuilder(256);GetClassName(hwnd,name,256);var value=name.ToString();if(value!="UAC_InputIndicatorOverlayWnd"&&value!="UAC Input Indicator")count++;}return true;},IntPtr.Zero);return count;}
 public static string[] Describe(IntPtr desktop,uint pid){var result=new List<string>();EnumDesktopWindows(desktop,delegate(IntPtr hwnd,IntPtr unused){uint found;GetWindowThreadProcessId(hwnd,out found);if(found==pid&&IsWindowVisible(hwnd)){RECT r;GetWindowRect(hwnd,out r);var name=new StringBuilder(256);GetClassName(hwnd,name,256);result.Add(name+":"+r.Left+","+r.Top+","+r.Right+","+r.Bottom);}return true;},IntPtr.Zero);return result.ToArray();}
}
'@
$attached=[ProbeConsole]::AttachConsole(${browserPid});$console=[ProbeConsole]::GetConsoleWindow()
$private=[ProbeConsole]::OpenDesktop('${desktopName}',0,$false,0x41)
$user=[ProbeConsole]::OpenDesktop('Default',0,$false,0x41)
try{@{consoleAttached=$attached;consoleVisible=($console -ne [IntPtr]::Zero -and [ProbeConsole]::IsWindowVisible($console));visibleBrowserWindows=[ProbeConsole]::Count($private,${browserPid});privateWindowDetails=[ProbeConsole]::Describe($private,${browserPid});userDesktopWindows=[ProbeConsole]::Count($user,${browserPid})}|ConvertTo-Json -Compress}
finally{if($attached){[void][ProbeConsole]::FreeConsole()};[void][ProbeConsole]::CloseDesktop($private);[void][ProbeConsole]::CloseDesktop($user)}
`;
  const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", source], { windowsHide: true, timeout: 10_000 });
  const result = JSON.parse(stdout.trim());
  if (mode === "fixed") {
    // Exercise the exact dependency force-cleanup command for this fixture's own
    // registered browser. The runtime guard changes it to direct, hidden taskkill.
    const cleanupCommand = `taskkill /pid ${browserPid} /T /F`;
    const disconnected = new Promise((resolve) => browser.once("disconnected", resolve));
    const killed = childProcess.spawnSync(cleanupCommand, { shell: true });
    if (killed.status !== 0) throw new Error(`Fixture force cleanup failed (${killed.status})`);
    await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error("Fixture browser did not exit")), 3_000).unref())]);
    Object.assign(result, { killPid: browserPid, cleanupCommand, killExited: !browser.isConnected() });
  }
  await browser.close().catch(() => {}); browser = null;
  await writeFile(reportPath, JSON.stringify({ ...result, browserPid }));
} catch (error) { await writeFile(reportPath, JSON.stringify({ error: error.message, stack: error.stack })); process.exitCode = 1; }
finally { await browser?.close().catch(() => {}); }
