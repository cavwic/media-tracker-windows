param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$ProfileDirectory,
  [Parameter(Mandatory=$true)][int]$Port,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$LaunchId
)
$ErrorActionPreference = 'Stop'
$profilePath = [IO.Path]::GetFullPath($ProfileDirectory)
if (-not [IO.Path]::IsPathRooted($ProfileDirectory) -or -not (Test-Path -LiteralPath $profilePath -PathType Container)) { throw 'Invalid browser profile.' }
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or $Port -lt 1 -or $Port -gt 65535) { throw 'Invalid browser executable or port.' }
$readyFile = [IO.Path]::Combine($profilePath, ('media-tracker-launch-' + $LaunchId + '.json'))
$stopFile = [IO.Path]::Combine($profilePath, ('media-tracker-stop-' + $LaunchId))
$desktopName = 'MediaTrackerBackground_' + $LaunchId
$desktop = [IntPtr]::Zero
$browserJob = [IntPtr]::Zero
$nativeProcess = $null

function Publish-LaunchStatus($status) {
  $temporaryStatus = $readyFile + '.tmp'
  [IO.File]::WriteAllText($temporaryStatus, ($status | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($readyFile)) { [IO.File]::Delete($readyFile) }
  [IO.File]::Move($temporaryStatus, $readyFile)
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MediaTrackerPrivateDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
    public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit,PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass,SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr devmode,uint flags,uint access,IntPtr security);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int informationClass,ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,uint length);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process,uint exitCode);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
  if ([IO.File]::Exists($stopFile)) { return }
  # This desktop is owned only by this worker. Never SwitchDesktop, hook the
  # user's desktop, or change any existing window/desktop/security setting.
  $desktop = [MediaTrackerPrivateDesktop]::CreateDesktop($desktopName,[IntPtr]::Zero,[IntPtr]::Zero,0,0x01ff,[IntPtr]::Zero)
  if ($desktop -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  # A non-inheritable, unnamed job belongs only to this helper. Closing its last
  # handle (including abrupt helper termination) reclaims our browser tree; it
  # cannot include the user's Chrome or any pre-existing process.
  $browserJob = [MediaTrackerPrivateDesktop]::CreateJobObject([IntPtr]::Zero,$null)
  if ($browserJob -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  $jobLimits = [MediaTrackerPrivateDesktop+JOBOBJECT_EXTENDED_LIMIT_INFORMATION]::new()
  $basicLimits = [MediaTrackerPrivateDesktop+JOBOBJECT_BASIC_LIMIT_INFORMATION]::new()
  $basicLimits.LimitFlags = 0x2000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  $jobLimits.BasicLimitInformation = $basicLimits
  if (-not [MediaTrackerPrivateDesktop]::SetInformationJobObject($browserJob,9,[ref]$jobLimits,[Runtime.InteropServices.Marshal]::SizeOf($jobLimits))) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  $startup = [MediaTrackerPrivateDesktop+STARTUPINFO]::new()
  $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
  $startup.lpDesktop = 'WinSta0\' + $desktopName
  $nativeProcess = [MediaTrackerPrivateDesktop+PROCESS_INFORMATION]::new()
  # All values with whitespace are quoted; Windows paths cannot contain quotes.
  # The session switch is only an ownership marker, not a browser behavior flag.
  $arguments = @(('"' + $Executable + '"'), ('"--user-data-dir=' + $profilePath.TrimEnd('\') + '"'), '--no-first-run', '--disable-background-mode', '--no-startup-window', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--remote-debugging-address=127.0.0.1', ('--remote-debugging-port=' + $Port), ('--media-tracker-background-session=' + $LaunchId))
  $command = [Text.StringBuilder]::new(($arguments -join ' '))
  # CREATE_SUSPENDED prevents Chromium spawning children before job assignment.
  # If assignment fails, finally closes this exact still-suspended child; never
  # continue unguarded or fall back to a visible browser.
  if (-not [MediaTrackerPrivateDesktop]::CreateProcess($Executable,$command,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x08000404,[IntPtr]::Zero,[IO.Path]::GetDirectoryName($Executable),[ref]$startup,[ref]$nativeProcess)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  if (-not [MediaTrackerPrivateDesktop]::AssignProcessToJobObject($browserJob,$nativeProcess.hProcess)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  if ([MediaTrackerPrivateDesktop]::ResumeThread($nativeProcess.hThread) -eq [uint32]::MaxValue) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  Publish-LaunchStatus @{ pid=[int]$nativeProcess.dwProcessId; helperPid=$PID; launchId=$LaunchId; desktopName=$desktopName }
  # Keep the desktop handle alive until OUR exact child exits. A unique stop
  # marker is used only for launch cancellation/failure, never process matching.
  while ([MediaTrackerPrivateDesktop]::WaitForSingleObject($nativeProcess.hProcess,250) -eq 258) {
    if ([IO.File]::Exists($stopFile)) {
      [void][MediaTrackerPrivateDesktop]::TerminateProcess($nativeProcess.hProcess,1)
      [void][MediaTrackerPrivateDesktop]::WaitForSingleObject($nativeProcess.hProcess,5000)
      break
    }
  }
} catch {
  $nativeError = $null
  if ($_.Exception -is [ComponentModel.Win32Exception]) { $nativeError = $_.Exception.NativeErrorCode }
  Publish-LaunchStatus @{ error='private-desktop-unavailable'; nativeError=$nativeError; launchId=$LaunchId; helperPid=$PID }
} finally {
  # Job closure also collects any browser children left after normal Browser.close.
  if ($browserJob -ne [IntPtr]::Zero) { [void][MediaTrackerPrivateDesktop]::CloseHandle($browserJob) }
  if ($null -ne $nativeProcess) {
    if ($nativeProcess.hThread -ne [IntPtr]::Zero) { [void][MediaTrackerPrivateDesktop]::CloseHandle($nativeProcess.hThread) }
    if ($nativeProcess.hProcess -ne [IntPtr]::Zero) {
      if ([MediaTrackerPrivateDesktop]::WaitForSingleObject($nativeProcess.hProcess,0) -eq 258) {
        [void][MediaTrackerPrivateDesktop]::TerminateProcess($nativeProcess.hProcess,1)
        [void][MediaTrackerPrivateDesktop]::WaitForSingleObject($nativeProcess.hProcess,5000)
      }
      [void][MediaTrackerPrivateDesktop]::CloseHandle($nativeProcess.hProcess)
    }
  }
  if ($desktop -ne [IntPtr]::Zero) { [void][MediaTrackerPrivateDesktop]::CloseDesktop($desktop) }
  # Remove only this invocation's marker. Leave diagnostic launch status local.
  if ([IO.File]::Exists($stopFile)) { [IO.File]::Delete($stopFile) }
}
