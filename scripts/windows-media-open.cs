// Windows PowerShell 5.1 compiles this file in memory for one user-initiated open.
// No titles, process command lines, or target paths are written to stdout.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace MediaTrackerFileOpen {
  public sealed class Association {
    public string Executable = "";
    public string AppId = "";
    public bool PhotoViewer;
  }

  public sealed class WindowRecord {
    public long Handle;
    public uint ProcessId;
    public string Executable = "";
    public string AppId = "";
    public string ClassName = "";
    public string Title = "";
    public bool Visible;
    public bool Minimized;
    public bool Cloaked;
    public bool Owned;
  }

  public sealed class Selection {
    public WindowRecord Window;
    public string Reason = "target-unconfirmed";
  }

  public sealed class OpenResult {
    public bool Launched;
    public bool Foreground;
    public string Reason;
  }

  // A small fakeable activation boundary keeps tests independent of desktop state.
  public interface IActivationApi {
    long ForegroundHandle();
    uint CurrentThread();
    uint WindowThread(long handle);
    uint WindowProcess(long handle);
    bool Restore(long handle);
    bool SetForeground(long handle);
    bool AllowForeground(uint processId);
    bool Attach(uint from, uint to, bool attach);
    void PrepareMessageQueue();
    void Wait(int milliseconds);
    bool MayActivate(long target);
  }

  public static class Policy {
    static bool Equal(string left, string right) {
      return String.Equals(left ?? "", right ?? "", StringComparison.OrdinalIgnoreCase);
    }

    static bool PhotoViewerHost(Association association, WindowRecord window) {
      if (!Equal(window.ClassName, "Photo_Lightweight_Viewer")) return false;
      if (Equal(Path.GetFileName(association.Executable), "rundll32.exe")
        && Equal(association.Executable, window.Executable)) return true;
      // Classic Photo Viewer also registers an open DropTarget. The Shell can
      // activate that COM handler inside the system surrogate instead of the
      // rundll32 command returned by AssocQueryString. Do not accept arbitrary
      // dllhost processes: the exact system executable, viewer class, and file
      // title are all required before restoring or activating its window.
      if (!Equal(Path.GetFileName(window.Executable), "dllhost.exe")) return false;
      string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      return Equal(window.Executable, Path.Combine(Environment.SystemDirectory, "dllhost.exe"))
        || (!String.IsNullOrEmpty(windows)
          && Equal(window.Executable, Path.Combine(windows, "SysWOW64", "dllhost.exe")));
    }

    public static bool IdentityMatches(Association association, WindowRecord window) {
      if (association == null || window == null) return false;
      // ApplicationFrameHost and other shared hosts are not app identities.
      if (!String.IsNullOrEmpty(association.AppId)) return Equal(association.AppId, window.AppId);
      if (association.PhotoViewer) return PhotoViewerHost(association, window);
      if (String.IsNullOrEmpty(association.Executable) || !Equal(association.Executable, window.Executable)) return false;
      string name = Path.GetFileName(association.Executable);
      return !Equal(name, "rundll32.exe") && !Equal(name, "rundll.exe")
        && !Equal(name, "dllhost.exe") && !Equal(name, "ApplicationFrameHost.exe") && !Equal(name, "explorer.exe");
    }

    static bool ContainsName(string title, string name, bool stem) {
      if (String.IsNullOrEmpty(title) || String.IsNullOrEmpty(name)) return false;
      int offset = 0;
      while (offset < title.Length) {
        int found = title.IndexOf(name, offset, StringComparison.OrdinalIgnoreCase);
        if (found < 0) return false;
        int end = found + name.Length;
        bool left = found == 0 || !(Char.IsLetterOrDigit(title[found - 1]) || title[found - 1] == '_');
        bool right = end == title.Length || !(Char.IsLetterOrDigit(title[end]) || title[end] == '_');
        // A displayed different extension is not a hidden-extension title.
        if (stem && end < title.Length && title[end] == '.') right = false;
        if (left && right) return true;
        offset = found + 1;
      }
      return false;
    }

    public static bool TitleMatches(string title, string filename) {
      if (ContainsName(title, filename, false)) return true;
      string stem = Path.GetFileNameWithoutExtension(filename ?? "");
      // Short names are too ambiguous when an application hides extensions.
      return stem.Length >= 8 && ContainsName(title, stem, true);
    }

    public static Selection Select(Association association, string filename, uint launchedProcess,
      WindowRecord[] before, WindowRecord[] after) {
      var prior = new Dictionary<long, WindowRecord>();
      foreach (var window in before ?? new WindowRecord[0]) prior[window.Handle] = window;
      var fresh = new List<WindowRecord>();
      var changed = new List<WindowRecord>();
      var existing = new List<WindowRecord>();
      foreach (var window in after ?? new WindowRecord[0]) {
        if (window.Handle == 0 || window.ProcessId == 0 || (!window.Visible && !window.Minimized) || window.Cloaked || window.Owned
          || !IdentityMatches(association, window) || !TitleMatches(window.Title, filename)) continue;
        WindowRecord old;
        if (!prior.TryGetValue(window.Handle, out old)
          || (launchedProcess != 0 && window.ProcessId == launchedProcess && old.ProcessId != window.ProcessId)) fresh.Add(window);
        else if (!Equal(window.Title, old.Title) || (old.Minimized && !window.Minimized)
          || (!old.Visible && window.Visible)) changed.Add(window);
        // A nonzero new launch PID means another window may still be starting.
        // Do not jump to a pre-existing same-named window from another process.
        // Null-PID DDE reuse may still focus a uniquely confirmed existing file.
        else if (launchedProcess == 0 || window.ProcessId == launchedProcess) existing.Add(window);
      }
      var candidates = fresh.Count > 0 ? fresh : changed.Count > 0 ? changed : existing;
      if (candidates.Count == 1) return new Selection { Window = candidates[0], Reason = "target-confirmed" };
      return new Selection { Reason = candidates.Count > 1 ? "target-ambiguous" : "target-unconfirmed" };
    }

    public static bool UserSwitched(long initialForeground, uint initialInput,
      long currentForeground, uint currentInput, long target) {
      return currentInput != initialInput && currentForeground != 0
        && currentForeground != initialForeground && currentForeground != target;
    }

    public static bool Activate(IActivationApi api, long target) {
      if (target == 0) return false;
      if (api.ForegroundHandle() == target) return true;
      if (!api.MayActivate(target)) return false;
      api.Restore(target);
      // ShowWindowAsync posts work to the viewer's UI thread. Give restoration
      // a short bounded turn before testing foreground, especially when reused.
      api.Wait(80);
      if (!api.MayActivate(target)) return false;
      if (api.SetForeground(target) && api.ForegroundHandle() == target) return true;
      if (api.ForegroundHandle() == target) return true;

      // Only the exact selected target receives a short-lived permission attempt.
      api.AllowForeground(api.WindowProcess(target));
      api.PrepareMessageQueue();
      uint current = api.CurrentThread();
      uint foreground = api.WindowThread(api.ForegroundHandle());
      uint destination = api.WindowThread(target);
      var attached = new List<uint>();
      try {
        if (foreground != 0 && foreground != current && api.Attach(current, foreground, true)) attached.Add(foreground);
        if (destination != 0 && destination != current && destination != foreground
          && api.Attach(current, destination, true)) attached.Add(destination);
        if (!api.MayActivate(target)) return false;
        api.Restore(target);
        api.Wait(80);
        if (!api.MayActivate(target)) return false;
        api.SetForeground(target);
        api.Wait(40);
        return api.ForegroundHandle() == target;
      } finally {
        for (int i = attached.Count - 1; i >= 0; i--) api.Attach(current, attached[i], false);
      }
    }
  }

  public static class Launcher {
    public static OpenResult Open(string targetPath) {
      string absolute = Path.GetFullPath(targetPath);
      if (!File.Exists(absolute)) throw new IOException("The selected media file is unavailable.");
      var association = Native.QueryAssociation(Path.GetExtension(absolute));
      long initialForeground = Native.GetForegroundWindow().ToInt64();
      uint initialInput = Native.LastInput();
      var before = Native.Snapshot(association);
      var launch = Native.Execute(absolute, initialForeground);
      var result = new OpenResult { Launched = true, Foreground = false, Reason = "target-unconfirmed" };
      try {
        // This bounded observation is only for this click, never a resident helper.
        DateTime deadline = DateTime.UtcNow.AddSeconds(4);
        do {
          var after = Native.Snapshot(association);
          var selection = Policy.Select(association, Path.GetFileName(absolute), launch.ProcessId, before, after);
          result.Reason = selection.Reason;
          long current = Native.GetForegroundWindow().ToInt64();
          long target = selection.Window == null ? 0 : selection.Window.Handle;
          if (Policy.UserSwitched(initialForeground, initialInput, current, Native.LastInput(), target)) {
            result.Reason = "user-switched";
            return result;
          }
          if (selection.Window != null) {
            if (current == target) {
              result.Foreground = true;
              result.Reason = "already-foreground";
              return result;
            }
            result.Foreground = Policy.Activate(new NativeActivationApi(initialForeground, initialInput), target);
            result.Reason = result.Foreground ? "foreground"
              : Policy.UserSwitched(initialForeground, initialInput, Native.GetForegroundWindow().ToInt64(), Native.LastInput(), target)
                ? "user-switched" : "foreground-denied";
            if (result.Foreground || result.Reason == "user-switched") return result;
            // A COM-hosted viewer can expose its file title before its UI is
            // ready to process restore/foreground messages. Keep observing
            // this one click within the same deadline rather than permanently
            // giving up after that early activation attempt. Every iteration
            // re-confirms identity/file and still stops if the user switches.
          }
          Thread.Sleep(100);
        } while (DateTime.UtcNow < deadline);
        return result;
      } finally {
        if (launch.ProcessHandle != IntPtr.Zero) Native.CloseHandle(launch.ProcessHandle);
      }
    }
  }

  sealed class LaunchInformation {
    public uint ProcessId;
    public IntPtr ProcessHandle;
  }

  sealed class NativeActivationApi : IActivationApi {
    readonly long initialForeground;
    readonly uint initialInput;
    public NativeActivationApi(long foreground, uint input) { initialForeground = foreground; initialInput = input; }
    public long ForegroundHandle() { return Native.GetForegroundWindow().ToInt64(); }
    public uint CurrentThread() { return Native.GetCurrentThreadId(); }
    public uint WindowThread(long handle) { uint ignored; return Native.GetWindowThreadProcessId(new IntPtr(handle), out ignored); }
    public uint WindowProcess(long handle) { uint pid; Native.GetWindowThreadProcessId(new IntPtr(handle), out pid); return pid; }
    public bool Restore(long handle) {
      IntPtr window = new IntPtr(handle);
      return !Native.IsIconic(window) || Native.ShowWindowAsync(window, 9);
    }
    public bool SetForeground(long handle) { return Native.SetForegroundWindow(new IntPtr(handle)); }
    public bool AllowForeground(uint processId) { return processId != 0 && Native.AllowSetForegroundWindow(processId); }
    public bool Attach(uint from, uint to, bool attach) { return Native.AttachThreadInput(from, to, attach); }
    public void PrepareMessageQueue() { Native.Message message; Native.PeekMessage(out message, IntPtr.Zero, 0, 0, 0); }
    public void Wait(int milliseconds) { Thread.Sleep(milliseconds); }
    public bool MayActivate(long target) {
      return !Policy.UserSwitched(initialForeground, initialInput, ForegroundHandle(), Native.LastInput(), target);
    }
  }

  static class Native {
    const uint QueryLimitedInformation = 0x1000;
    const uint SeeMaskNoCloseProcess = 0x40;
    const uint SeeMaskNoAsync = 0x100;
    delegate bool EnumWindowCallback(IntPtr handle, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ShellExecuteInformation {
      public uint Size, Mask;
      public IntPtr Owner;
      [MarshalAs(UnmanagedType.LPWStr)] public string Verb;
      [MarshalAs(UnmanagedType.LPWStr)] public string File;
      [MarshalAs(UnmanagedType.LPWStr)] public string Parameters;
      [MarshalAs(UnmanagedType.LPWStr)] public string Directory;
      public int Show;
      public IntPtr Instance, IdList;
      [MarshalAs(UnmanagedType.LPWStr)] public string Class;
      public IntPtr ClassKey;
      public uint HotKey;
      public IntPtr IconOrMonitor, Process;
    }
    [StructLayout(LayoutKind.Sequential)] struct LastInputInformation { public uint Size, Time; }
    [StructLayout(LayoutKind.Sequential)] public struct Message {
      public IntPtr Window;
      public uint Id;
      public UIntPtr WParam;
      public IntPtr LParam;
      public uint Time;
      public int X, Y;
      public uint Private;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] static extern bool ShellExecuteEx(ref ShellExecuteInformation information);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern int AssocQueryString(uint flags, uint kind, string association, string extra, StringBuilder result, ref uint length);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool EnumChildWindows(IntPtr parent, EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindowAsync(IntPtr handle, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AllowSetForegroundWindow(uint processId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AttachThreadInput(uint from, uint to, [MarshalAs(UnmanagedType.Bool)] bool attach);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetLastInputInfo(ref LastInputInformation information);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool PeekMessage(out Message message, IntPtr handle, uint minimum, uint maximum, uint remove);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr handle, uint attribute, out int value, uint size);

    static string AssociationString(string extension, uint kind) {
      uint length = 0;
      AssocQueryString(0, kind, extension, "open", null, ref length);
      if (length == 0 || length > 32768) return "";
      var result = new StringBuilder((int)length);
      return AssocQueryString(0, kind, extension, "open", result, ref length) == 0 ? result.ToString() : "";
    }

    public static Association QueryAssociation(string extension) {
      string executable = AssociationString(extension, 2);
      string command = AssociationString(extension, 1);
      // The association API can return the invoked DLL instead of its launcher.
      // Read only the registered first command token; never execute this string.
      string expanded = Environment.ExpandEnvironmentVariables(command ?? "").Trim();
      string launcher = "";
      if (expanded.StartsWith("\"", StringComparison.Ordinal)) {
        int closing = expanded.IndexOf('"', 1);
        if (closing > 1) launcher = expanded.Substring(1, closing - 1);
      } else {
        int closing = expanded.IndexOfAny(new char[] { ' ', '\t' });
        launcher = closing < 0 ? expanded : expanded.Substring(0, closing);
      }
      bool photoViewer = String.Equals(Path.GetFileName(launcher), "rundll32.exe", StringComparison.OrdinalIgnoreCase)
        && command.IndexOf("PhotoViewer.dll", StringComparison.OrdinalIgnoreCase) >= 0;
      if (photoViewer && Path.IsPathRooted(launcher)) executable = launcher;
      return new Association { Executable = executable, AppId = AssociationString(extension, 21),
        PhotoViewer = photoViewer };
    }

    public static LaunchInformation Execute(string absolute, long owner) {
      var information = new ShellExecuteInformation { Size = (uint)Marshal.SizeOf(typeof(ShellExecuteInformation)),
        Mask = SeeMaskNoCloseProcess | SeeMaskNoAsync, Owner = new IntPtr(owner), Verb = "open", File = absolute,
        Directory = Path.GetDirectoryName(absolute), Show = 1 };
      if (!ShellExecuteEx(ref information)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not start the default media application.");
      return new LaunchInformation { ProcessHandle = information.Process,
        ProcessId = information.Process == IntPtr.Zero ? 0 : GetProcessId(information.Process) };
    }

    public static uint LastInput() {
      var information = new LastInputInformation { Size = (uint)Marshal.SizeOf(typeof(LastInputInformation)) };
      return GetLastInputInfo(ref information) ? information.Time : 0;
    }

    sealed class ProcessIdentity { public string Executable = ""; public string AppId = ""; }
    static ProcessIdentity Identity(uint processId, Dictionary<uint, ProcessIdentity> cache) {
      ProcessIdentity result;
      if (cache.TryGetValue(processId, out result)) return result;
      result = new ProcessIdentity();
      cache[processId] = result;
      IntPtr process = OpenProcess(QueryLimitedInformation, false, processId);
      if (process == IntPtr.Zero) return result;
      try {
        uint length = 32768;
        var executable = new StringBuilder((int)length);
        if (QueryFullProcessImageName(process, 0, executable, ref length)) result.Executable = executable.ToString();
        uint appLength = 0;
        if (GetApplicationUserModelId(process, ref appLength, null) == 122 && appLength > 0 && appLength < 32768) {
          var appId = new StringBuilder((int)appLength);
          if (GetApplicationUserModelId(process, ref appLength, appId) == 0) result.AppId = appId.ToString();
        }
      } finally { CloseHandle(process); }
      return result;
    }

    public static WindowRecord[] Snapshot(Association association) {
      var result = new List<WindowRecord>();
      var identities = new Dictionary<uint, ProcessIdentity>();
      EnumWindows(delegate(IntPtr handle, IntPtr unused) {
        bool visible = IsWindowVisible(handle);
        bool minimized = IsIconic(handle);
        if (!visible && !minimized) return true;
        uint processId;
        GetWindowThreadProcessId(handle, out processId);
        var identity = Identity(processId, identities);
        var className = new StringBuilder(256);
        GetClassName(handle, className, className.Capacity);
        var window = new WindowRecord { Handle = handle.ToInt64(), ProcessId = processId,
          Executable = identity.Executable, AppId = identity.AppId, ClassName = className.ToString(),
          Visible = visible, Minimized = minimized, Owned = GetWindow(handle, 4) != IntPtr.Zero };
        if (!String.IsNullOrEmpty(association.AppId) && !Policy.IdentityMatches(association, window)) {
          // A packaged viewer can live in a shared ApplicationFrameHost window.
          // Only a child carrying the exact associated AUMID confirms that frame.
          if (String.Equals(Path.GetFileName(identity.Executable), "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) {
            EnumChildWindows(handle, delegate(IntPtr child, IntPtr childParameter) {
              uint childProcess;
              GetWindowThreadProcessId(child, out childProcess);
              var childIdentity = Identity(childProcess, identities);
              if (String.Equals(childIdentity.AppId, association.AppId, StringComparison.OrdinalIgnoreCase)) {
                window.AppId = childIdentity.AppId;
                return false;
              }
              return true;
            }, IntPtr.Zero);
          }
        }
        // Do not read titles of other applications or log any observed title.
        if (!Policy.IdentityMatches(association, window)) return true;
        int cloaked;
        window.Cloaked = DwmGetWindowAttribute(handle, 14, out cloaked, 4) == 0 && cloaked != 0;
        var title = new StringBuilder(2048);
        GetWindowText(handle, title, title.Capacity);
        window.Title = title.ToString();
        result.Add(window);
        return true;
      }, IntPtr.Zero);
      return result.ToArray();
    }
  }
}
