param([string]$NodeExecutable,[string]$WorkerPath,[string]$ReportPath,[ValidateSet('original','fixed')][string]$Mode)
$ErrorActionPreference='Stop'
[IO.File]::WriteAllText($ReportPath,(@{mode=$Mode;phase='host-compiling'}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class ConsoleFixtureHost {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct STARTUPINFO {public int cb;public string reserved,desktop,title;public int x,y,xSize,ySize,xChars,yChars,fill,flags;public short show,reservedCount;public IntPtr reserved2,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION {public IntPtr process,thread;public uint processId,threadId;}
 [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT {public long processTime,jobTime;public uint flags;public UIntPtr minWorking,maxWorking;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;}
 [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMIT {public BASIC_LIMIT basic;public IO_COUNTERS io;public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;}
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr devmode,uint flags,uint access,IntPtr security);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref EXTENDED_LIMIT information,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] public static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr process,out uint code);
}
'@
$desktop=[IntPtr]::Zero; $job=[IntPtr]::Zero; $child=[ConsoleFixtureHost+PROCESS_INFORMATION]::new()
try {
 $desktopName='MediaTrackerConsoleFixture_'+[Guid]::NewGuid().ToString('N')
 $desktop=[ConsoleFixtureHost]::CreateDesktop($desktopName,[IntPtr]::Zero,[IntPtr]::Zero,0,0x1ff,[IntPtr]::Zero)
 $job=[ConsoleFixtureHost]::CreateJobObject([IntPtr]::Zero,$null)
 if($desktop -eq [IntPtr]::Zero -or $job -eq [IntPtr]::Zero){throw 'Fixture isolation unavailable'}
 $limits=[ConsoleFixtureHost+EXTENDED_LIMIT]::new();$limits.basic.flags=0x2000
 if(-not [ConsoleFixtureHost]::SetInformationJobObject($job,9,[ref]$limits,[Runtime.InteropServices.Marshal]::SizeOf($limits))){throw 'Fixture job unavailable'}
 $startup=[ConsoleFixtureHost+STARTUPINFO]::new();$startup.cb=[Runtime.InteropServices.Marshal]::SizeOf($startup);$startup.desktop='WinSta0\'+$desktopName
 $arguments='"'+$NodeExecutable+'" "'+$WorkerPath+'" "'+$ReportPath+'" "'+$Mode+'" "'+$desktopName+'"'
 $command=[Text.StringBuilder]::new($arguments)
 if(-not [ConsoleFixtureHost]::CreateProcess($NodeExecutable,$command,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x08000404,[IntPtr]::Zero,[IO.Path]::GetDirectoryName($WorkerPath),[ref]$startup,[ref]$child)){throw 'Fixture process unavailable'}
 if(-not [ConsoleFixtureHost]::AssignProcessToJobObject($job,$child.process)){throw 'Fixture job assignment failed'}
 [IO.File]::WriteAllText($ReportPath,(@{mode=$Mode;phase='host-worker-created';workerPid=$child.processId}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 if([ConsoleFixtureHost]::ResumeThread($child.thread) -eq [uint32]::MaxValue){throw 'Fixture start failed'}
 # Covers the worker's bounded browser, page, probe and force-cleanup stages,
 # including Node startup. The outer test allows a further 10s for this host.
 if([ConsoleFixtureHost]::WaitForSingleObject($child.process,45000) -ne 0){throw 'Fixture timed out; inspect its last reported phase'}
 $exitCode=[uint32]0;[void][ConsoleFixtureHost]::GetExitCodeProcess($child.process,[ref]$exitCode)
 if($exitCode -ne 0){throw 'Fixture failed; inspect its temporary report'}
} finally {
 if($job -ne [IntPtr]::Zero){[void][ConsoleFixtureHost]::CloseHandle($job)}
 if($child.process -ne [IntPtr]::Zero){[void][ConsoleFixtureHost]::TerminateProcess($child.process,1);[void][ConsoleFixtureHost]::CloseHandle($child.process)}
 if($child.thread -ne [IntPtr]::Zero){[void][ConsoleFixtureHost]::CloseHandle($child.thread)}
 if($desktop -ne [IntPtr]::Zero){[void][ConsoleFixtureHost]::CloseDesktop($desktop)}
}
