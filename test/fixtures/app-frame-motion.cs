// Compiled with OWNED_FRAME_TEST into a private temporary executable only.
// No input is injected and no unrelated window, pointer, or OS setting is moved.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using MediaTrackerAppFrame;

public static class CollectorMotionFixture {
  [DllImport("user32.dll")]static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
  [DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
  static void Require(bool condition,string label){if(!condition)throw new InvalidOperationException(label);}
  static void Call(Host host,string method,params object[] arguments){typeof(Host).GetMethod(method,BindingFlags.Instance|BindingFlags.NonPublic).Invoke(host,arguments);}
  static object Field(Host host,string name){return typeof(Host).GetField(name,BindingFlags.Instance|BindingFlags.NonPublic).GetValue(host);}
  static void Action(Host host,string action){Call(host,"Perform",1000,action,new Dictionary<string,object>{{"id",1000},{"action",action}});}
  static void Record(string kind,bool passed){Console.WriteLine("{\"kind\":\""+kind+"\",\"frameless\":true,\"maximized\":false,\"minimized\":false,\"passed\":"+(passed?"true":"false")+"}");Console.Out.Flush();}
  static void AssertFrameColor(Host host){
    using(var image=new Bitmap(host.Width,host.Height))using(var graphics=Graphics.FromImage(image)){
      IntPtr dc=graphics.GetHdc();try{Require(PrintWindow(host.Handle,dc,2),"Exact own HWND must paint");}finally{graphics.ReleaseHdc(dc);}
      foreach(var point in new[]{new Point(0,0),new Point(host.Width-1,0),new Point(0,host.Height-1),new Point(host.Width-1,host.Height-1)})
        Require(image.GetPixel(point.X,point.Y).ToArgb()==host.BackColor.ToArgb(),"Outer frame must use the UI theme, never DWM's white outline: "+point+" expected="+host.BackColor+" actual="+image.GetPixel(point.X,point.Y));
    }
  }
  static int Hit(Host host,int x,int y){long packed=((long)(ushort)y<<16)|(ushort)x;return SendMessage(host.Handle,0x0084,IntPtr.Zero,new IntPtr(packed)).ToInt32();}
  [STAThread] public static int Main(string[] args){
    uint pid;if(args.Length!=3||!UInt32.TryParse(args[0],out pid)||pid==0)return 2;
    Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
    Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
    bool passed=false,closedSafely=false;
    using(var host=new Host(pid,args[1],args[2]))using(var timer=new Timer()){
      bool held=false,foreground=true;Native.POINT cursor=new Native.POINT();
      host.TestPrimaryButton=()=>held;host.TestForeground=()=>foreground;host.TestCursor=()=>cursor;
      host.FormClosed+=delegate{
        closedSafely=!(bool)Field(host,"dragging")&&!((Timer)Field(host,"movement")).Enabled&&!((Timer)Field(host,"health")).Enabled;
        Record("motion-close-test",closedSafely);
      };
      timer.Interval=250;host.Shown+=delegate{timer.Start();};
      timer.Tick+=delegate{
        timer.Stop();
        try{
          Rectangle original=host.Bounds;
          AssertFrameColor(host);
          Call(host,"Perform",1001,"theme",new Dictionary<string,object>{{"id",1001},{"action","theme"},{"theme","light"}});AssertFrameColor(host);
          Call(host,"Perform",1002,"theme",new Dictionary<string,object>{{"id",1002},{"action","theme"},{"theme","dark"}});AssertFrameColor(host);
          IntPtr ownedChild=(IntPtr)Field(host,"child");
          Require((Native.GetWindowLong(ownedChild,-16)&0x00C40000)==0,"The actual Chromium child must not retain caption or sizing borders");
          Require((Native.GetWindowLong(ownedChild,-20)&0x00020301)==0,"The actual Chromium child must not retain raised/sunken/static edges");
          Require(Hit(host,host.Left+1,host.Top+1)==13&&Hit(host,host.Right-1,host.Top+1)==14&&Hit(host,host.Left+1,host.Bottom-1)==16&&Hit(host,host.Right-1,host.Bottom-1)==17,"The themed gutter must retain all four native resize corners");
          cursor.X=original.X+300;cursor.Y=original.Y+250;
          Call(host,"BeginDrag");Require(!(bool)Field(host,"dragging"),"A released button must not start motion");
          held=true;Call(host,"BeginDrag");Require((bool)Field(host,"dragging"),"Held pointer must start motion");
          cursor.X+=80;cursor.Y+=55;Call(host,"UpdateDrag");
          Require(host.Bounds==new Rectangle(original.X+80,original.Y+55,original.Width,original.Height),"The actual host HWND must move by the native cursor delta");
          Native.RECT actual;Native.GetWindowRect(host.Handle,out actual);
          Require(actual.Left==host.Left&&actual.Top==host.Top,"Bounds must match the real native HWND, not just a mock");
          held=false;Call(host,"UpdateDrag");Rectangle released=host.Bounds;cursor.X+=100;cursor.Y+=100;Call(host,"UpdateDrag");
          Require(host.Bounds==released&&!(bool)Field(host,"dragging"),"Release must stop motion");
          Action(host,"toggle-maximize");Require(Native.IsZoomed(host.Handle),"Native window must really maximize");
          Rectangle maximized=host.Bounds;cursor.X=maximized.Left+maximized.Width/3;cursor.Y=maximized.Top+maximized.Height/2;
          double fx=(cursor.X-maximized.Left)/(double)maximized.Width,fy=(cursor.Y-maximized.Top)/(double)maximized.Height;
          held=true;Call(host,"BeginDrag");
          Rectangle restored=host.Bounds;
          Require(!Native.IsZoomed(host.Handle)&&restored.Width==released.Width&&restored.Height==released.Height,"Drag must restore the saved normal size");
          Require(restored.X==cursor.X-(int)Math.Round(restored.Width*fx)&&restored.Y==cursor.Y-(int)Math.Round(restored.Height*fy),"Restore must preserve both cursor anchors without a DPI jump");
          cursor.X+=21;cursor.Y+=19;Call(host,"UpdateDrag");Require(host.Left==restored.Left+21&&host.Top==restored.Top+19,"Restored host must continue following the native cursor");
          foreground=false;Rectangle blurred=host.Bounds;cursor.X+=100;Call(host,"UpdateDrag");Require(host.Bounds==blurred&&!(bool)Field(host,"dragging"),"Loss of foreground must stop motion");
          foreground=true;Call(host,"BeginDrag");Action(host,"minimize");Require(Native.IsIconic(host.Handle)&&!(bool)Field(host,"dragging"),"Minimize must stop motion");
          Action(host,"focus");Call(host,"BeginDrag");Require((bool)Field(host,"dragging"),"Final held gesture starts before closure");
          passed=true;Record("motion-test",true);
        }catch(Exception error){Console.Error.WriteLine(error);Record("motion-test",false);}
        host.Close();
      };
      Application.Run(host);
    }
    return passed&&closedSafely?0:1;
  }
}
