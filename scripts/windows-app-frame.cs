// A local, permission-free host for this tool's exact Chromium main window.
// Built with Windows' existing .NET Framework compiler; never injected into Chrome.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace MediaTrackerAppFrame {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size;public RECT Monitor,Work;public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] public struct MINMAXINFO { public POINT Reserved,MaxSize,MaxPosition,MinTrack,MaxTrack; }
    public delegate bool EnumProc(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd,int attribute,ref int value,int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor,ref MONITORINFO info);
    public static IntPtr FindOwned(uint pid) {
      IntPtr found = IntPtr.Zero; int count = 0;
      EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
        uint actual; GetWindowThreadProcessId(hwnd, out actual);
        var name = new StringBuilder(128); GetClassName(hwnd, name, name.Capacity);
        if (actual == pid && GetParent(hwnd) == IntPtr.Zero && name.ToString() == "Chrome_WidgetWin_1") { found = hwnd; count++; }
        return true;
      }, IntPtr.Zero);
      if (count != 1) throw new InvalidOperationException("The owned Chromium main window is not unique.");
      return found;
    }
  }

  public sealed class Host : Form {
    readonly uint browserPid;
    readonly IntPtr child;
    readonly bool childWasMinimized;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly object outputLock = new object();
    readonly System.Windows.Forms.Timer health = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer movement = new System.Windows.Forms.Timer();
    bool attached;
    bool stopping;
    bool stateTransition;
    Rectangle normalBounds;
    bool minimizedWasMaximized;
    bool dragging;
    Native.POINT dragCursor;
    Rectangle dragBounds;
#if OWNED_FRAME_TEST
    // Compiled only into the isolated local motion test. These providers are
    // absent from the production executable and are never an IPC/renderer API.
    internal Func<bool> TestPrimaryButton,TestForeground;
    internal Func<Native.POINT?> TestCursor;
#endif
    const int Edge = 6;
    public Host(uint pid, string iconPath, string theme) {
      browserPid = pid; child = Native.FindOwned(pid); childWasMinimized=Native.IsIconic(child);
      Native.ShowWindow(child,0);
      Text = "Media Tracker"; FormBorderStyle = FormBorderStyle.None;
      StartPosition = FormStartPosition.Manual; ApplyTheme(theme);
      MinimumSize = new Size(720,480);
      Rectangle work = Screen.FromHandle(child).WorkingArea;
      // Measured from this tool's current normal window at 150% display DPI,
      // in physical pixels (not the resized user attachment or DPI virtualization).
      Size = new Size(Math.Min(1944,work.Width),Math.Min(1372,work.Height));
      Location = new Point(work.Left+(work.Width-Width)/2,work.Top+(work.Height-Height)/2);
      normalBounds=Bounds;
      movement.Interval=16; movement.Tick+=delegate { UpdateDrag(); };
      Deactivate+=delegate { if(!ForegroundOwned())StopDrag(); };
      if (File.Exists(iconPath)) { using (var icon = new Icon(iconPath)) Icon = (Icon)icon.Clone(); }
      Shown += delegate {
        Native.ShowWindow(child,0);
        Native.SetParent(child,Handle);
        int style = Native.GetWindowLong(child,-16);
        // Kiosk suppresses Chromium's own top bar. It remains a real renderer
        // window, not a clipped monitor-sized bitmap: every resize updates it.
        style = (style & ~unchecked((int)0x80000000) & ~0x00C00000 & ~0x00040000 & ~0x00080000 & ~0x00030000) | 0x40000000;
        Native.SetWindowLong(child,-16,style);
        int exStyle = Native.GetWindowLong(child,-20);
        Native.SetWindowLong(child,-20,exStyle & ~0x00040000 & ~0x00000301 & ~0x00020000);
        attached = true; LayoutChild(); Native.ShowWindow(child,5);
        Emit("ready",0,null); Native.SetForegroundWindow(Handle);
        Thread input = new Thread(ReadInput); input.IsBackground = true; input.Start();
        health.Interval=500; health.Tick+=delegate {
          if (!Owned()) Close();
        }; health.Start();
      };
      Resize += delegate { if (attached) { LayoutChild(); if(!stateTransition && !Native.IsZoomed(Handle) && !Native.IsIconic(Handle))normalBounds=Bounds; Emit("state",0,null); } };
      LocationChanged+=delegate { if(attached && !stateTransition && !Native.IsZoomed(Handle) && !Native.IsIconic(Handle))normalBounds=Bounds; };
      FormClosed += delegate { stopping=true; StopDrag(); health.Stop(); Emit("closed",0,null); };
    }
    protected override CreateParams CreateParams {
      get { var p=base.CreateParams; p.Style |= 0x00040000 | 0x00020000 | 0x00010000 | 0x00080000; return p; }
    }
    protected override void OnHandleCreated(EventArgs e) {
      base.OnHandleCreated(e);
      // Keep the native sizing style, but disable DWM's independently colored
      // non-client outline. The only remaining 6px resize target is our own
      // themed client surface, not an OS white border.
      int disabled=1;
      try { Native.DwmSetWindowAttribute(Handle,2,ref disabled,4); } catch(EntryPointNotFoundException) { }
    }
    void ApplyTheme(string theme) { BackColor=theme=="dark"?Color.FromArgb(13,20,32):Color.FromArgb(244,247,251);if(IsHandleCreated)Refresh(); }
    bool Owned() {
      uint pid; return Native.IsWindow(child) && Native.GetWindowThreadProcessId(child,out pid)!=0
        && pid==browserPid && Native.GetParent(child)==Handle;
    }
    bool ForegroundOwned(){
#if OWNED_FRAME_TEST
      if(TestForeground!=null)return TestForeground();
#endif
      IntPtr foreground=Native.GetForegroundWindow();return foreground==Handle || Native.GetAncestor(foreground,2)==Handle;
    }
    bool PrimaryButtonDown(){
#if OWNED_FRAME_TEST
      if(TestPrimaryButton!=null)return TestPrimaryButton();
#endif
      return (Native.GetAsyncKeyState(Native.GetSystemMetrics(23)!=0?2:1)&0x8000)!=0;
    }
    bool CursorPosition(out Native.POINT cursor){
#if OWNED_FRAME_TEST
      if(TestCursor!=null){Native.POINT? value=TestCursor();cursor=value.GetValueOrDefault();return value.HasValue;}
#endif
      return Native.GetCursorPos(out cursor);
    }
    void LayoutChild() {
      if (!Owned() || Native.IsIconic(Handle)) return;
      int inset = Native.IsZoomed(Handle) ? 0 : Edge;
      Native.SetWindowPos(child,IntPtr.Zero,inset,inset,Math.Max(1,ClientSize.Width-inset*2),Math.Max(1,ClientSize.Height-inset*2),0x0034);
    }
    void Emit(string kind,int id,string error) {
      var record=new Dictionary<string,object>(); record["kind"]=kind; record["id"]=id;
      record["frameless"]=true; record["maximized"]=Native.IsZoomed(Handle); record["minimized"]=Native.IsIconic(Handle);
      Native.RECT childBounds;Native.GetWindowRect(child,out childBounds);
      record["geometry"]=new[]{Width,Height,ClientSize.Width,ClientSize.Height,childBounds.Right-childBounds.Left,childBounds.Bottom-childBounds.Top,(int)Native.GetDpiForWindow(Handle),(int)Native.GetDpiForWindow(child),Left,Top};
      if(kind=="ready")record["initialMinimized"]=childWasMinimized;
      if(error!=null)record["error"]=error;
      lock(outputLock) { Console.Out.WriteLine(json.Serialize(record)); Console.Out.Flush(); }
    }
    void ReadInput() {
      try {
        string line;
        while(!stopping && (line=Console.In.ReadLine())!=null) {
          if(line.Length>1024)continue;
          var command=json.Deserialize<Dictionary<string,object>>(line);
          if(command==null || !command.ContainsKey("id") || !command.ContainsKey("action") || command.Count>3)continue;
          int id=Convert.ToInt32(command["id"]); string action=command["action"] as string;
          if(id<1 || id>1000000000 || action==null)continue;
          BeginInvoke((Action)delegate { Perform(id,action,command); });
        }
      } catch { }
      if(!stopping)try { BeginInvoke((Action)delegate { Close(); }); } catch { }
    }
    void Perform(int id,string action,Dictionary<string,object> command) {
      if(stopping)return;
      if(!Owned()) { Emit("reply",id,"owned-window-unavailable"); Close(); return; }
      switch(action) {
        case "get-state": Emit("reply",id,null); return;
        case "minimize":
          StopDrag();
          minimizedWasMaximized=Native.IsZoomed(Handle); if(!minimizedWasMaximized)normalBounds=Bounds;
          stateTransition=true;Native.ShowWindow(Handle,6);stateTransition=false;break;
        case "toggle-maximize":
          StopDrag();
          // Windows' current monitor work area, not its full bounds: the taskbar
          // remains reachable, including after dragging to another monitor.
          stateTransition=true;
          if(Native.IsZoomed(Handle)){Native.ShowWindow(Handle,9);RestoreNormalBounds();}
          else{normalBounds=Bounds;Native.ShowWindow(Handle,3);}
          stateTransition=false;LayoutChild();break;
        case "focus":
          if(Native.IsIconic(Handle)){stateTransition=true;Native.ShowWindow(Handle,minimizedWasMaximized?3:9);if(!minimizedWasMaximized)RestoreNormalBounds();stateTransition=false;LayoutChild();}
          Native.SetForegroundWindow(Handle);break;
        case "theme":
          if(!command.ContainsKey("theme") || !(command["theme"] is string)) { Emit("reply",id,"invalid-theme");return; }
          string theme=(string)command["theme"];
          if(theme!="light" && theme!="dark") { Emit("reply",id,"invalid-theme");return; }
          ApplyTheme(theme); break;
        case "drag":
          BeginDrag(); Emit("reply",id,null); return;
        case "close": Emit("reply",id,null); BeginInvoke((Action)delegate { Close(); }); return;
        default: Emit("reply",id,"invalid-action"); return;
      }
      Emit("reply",id,null);
    }
    void BeginDrag() {
      StopDrag();
      Native.POINT cursor;
      if(!ForegroundOwned() || Native.IsIconic(Handle) || !PrimaryButtonDown() || !CursorPosition(out cursor))return;
      if(Native.IsZoomed(Handle)) {
        Rectangle maximized=Bounds;
        double fractionX=Math.Max(0,Math.Min(1,(cursor.X-maximized.Left)/(double)Math.Max(1,maximized.Width)));
        double fractionY=Math.Max(0,Math.Min(1,(cursor.Y-maximized.Top)/(double)Math.Max(1,maximized.Height)));
        stateTransition=true;Native.ShowWindow(Handle,9);RestoreNormalBounds();
        // Preserve the point under the cursor when dragging from *any* body
        // area, rather than jumping as if the gesture started on a title bar.
        Native.SetWindowPos(Handle,IntPtr.Zero,cursor.X-(int)Math.Round(Width*fractionX),cursor.Y-(int)Math.Round(Height*fractionY),Width,Height,0x0014);
        stateTransition=false;LayoutChild();Emit("state",0,null);
      }
      dragCursor=cursor;dragBounds=Bounds;dragging=true;movement.Start();
    }
    void UpdateDrag() {
      Native.POINT cursor;
      if(!dragging || stopping || !Owned() || !ForegroundOwned() || Native.IsIconic(Handle) || !PrimaryButtonDown() || !CursorPosition(out cursor)){StopDrag();return;}
      // Chromium owns capture on another thread. ReleaseCapture from this
      // helper cannot release it, and SC_MOVE therefore loses the gesture.
      // Native cursor polling avoids that capture conflict without hooks or
      // injected input; it only moves this already-owned host while held.
      int x=dragBounds.X+cursor.X-dragCursor.X,y=dragBounds.Y+cursor.Y-dragCursor.Y;
      if(x!=Left || y!=Top)Native.SetWindowPos(Handle,IntPtr.Zero,x,y,Width,Height,0x0015);
    }
    void StopDrag(){dragging=false;movement.Stop();}
    void RestoreNormalBounds(){if(normalBounds.Width>0 && normalBounds.Height>0)Native.SetWindowPos(Handle,IntPtr.Zero,normalBounds.X,normalBounds.Y,normalBounds.Width,normalBounds.Height,0x0014);}
    protected override void WndProc(ref Message message) {
      if(message.Msg==0x0024){
        Native.MINMAXINFO limits=(Native.MINMAXINFO)Marshal.PtrToStructure(message.LParam,typeof(Native.MINMAXINFO));
        Native.MONITORINFO monitor=new Native.MONITORINFO();monitor.Size=Marshal.SizeOf(typeof(Native.MONITORINFO));
        if(Native.GetMonitorInfo(Native.MonitorFromWindow(Handle,2),ref monitor)){
          limits.MaxPosition.X=monitor.Work.Left-monitor.Monitor.Left;limits.MaxPosition.Y=monitor.Work.Top-monitor.Monitor.Top;
          limits.MaxSize.X=monitor.Work.Right-monitor.Work.Left;limits.MaxSize.Y=monitor.Work.Bottom-monitor.Work.Top;
          limits.MinTrack.X=720;limits.MinTrack.Y=480;
          Marshal.StructureToPtr(limits,message.LParam,false);message.Result=IntPtr.Zero;return;
        }
      }
      if(message.Msg==0x0083 || message.Msg==0x0085) { message.Result=IntPtr.Zero;return; }
      if(message.Msg==0x0086) { message.Result=new IntPtr(1);return; }
      if(message.Msg==0x0084 && !Native.IsZoomed(Handle)) {
        long packed=message.LParam.ToInt64(); Point cursor=PointToClient(new Point((short)(packed&0xffff),(short)((packed>>16)&0xffff)));
        bool left=cursor.X<Edge,right=cursor.X>=ClientSize.Width-Edge,top=cursor.Y<Edge,bottom=cursor.Y>=ClientSize.Height-Edge;
        if(top||bottom||left||right) { message.Result=new IntPtr(top?(left?13:right?14:12):bottom?(left?16:right?17:15):left?10:11);return; }
      }
      base.WndProc(ref message);
    }
    protected override void Dispose(bool disposing) { if(disposing){movement.Stop();movement.Dispose();health.Dispose();}base.Dispose(disposing); }
  }

  public static class Program {
    [STAThread] public static int Main(string[] args) {
      try {
        uint pid; if(args.Length!=3 || !UInt32.TryParse(args[0],out pid) || pid==0 || (args[2]!="light" && args[2]!="dark"))return 2;
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch(EntryPointNotFoundException) { }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        using(var host=new Host(pid,args[1],args[2]))Application.Run(host);
        return 0;
      } catch { Console.Error.WriteLine("The private app window host could not start.");return 1; }
    }
  }
}
