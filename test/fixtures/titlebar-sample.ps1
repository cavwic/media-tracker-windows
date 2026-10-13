param([int]$BrowserProcessId,[string]$OutputPath)
$ErrorActionPreference='Stop'
# Read only the isolated test process's exact owned window, never the desktop
# or a user browser. PrintWindow remains correct when the fixture is covered.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
public static class CollectorTitlebarFixturePixels {
 public delegate bool EnumProc(IntPtr hwnd,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] static extern int GetClassName(IntPtr hwnd,StringBuilder text,int size);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] static extern IntPtr GetWindowDC(IntPtr hwnd);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd,IntPtr hdc);
 [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr hdc,int x,int y);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);
 public static string Read(int pid,string path) {
  IntPtr match=IntPtr.Zero;
  EnumWindows(delegate(IntPtr hwnd,IntPtr data) {uint owned;GetWindowThreadProcessId(hwnd,out owned);var cls=new StringBuilder(100);GetClassName(hwnd,cls,100);if(owned==pid&&cls.ToString()=="Chrome_WidgetWin_1"){if(match!=IntPtr.Zero)throw new InvalidOperationException("Ambiguous fixture");match=hwnd;}return true;},IntPtr.Zero);
  if(match==IntPtr.Zero)throw new InvalidOperationException("Fixture window missing");
  RECT rect;GetWindowRect(match,out rect);
  var dc=GetWindowDC(match);uint pixel;
  try{pixel=GetPixel(dc,Math.Min(300,(rect.Right-rect.Left)/2),15);}finally{ReleaseDC(match,dc);}
  using(var image=new Bitmap(rect.Right-rect.Left,rect.Bottom-rect.Top))using(var graphics=Graphics.FromImage(image)){var target=graphics.GetHdc();try{if(!PrintWindow(match,target,2))throw new InvalidOperationException("Owned window could not render for inspection");}finally{graphics.ReleaseHdc(target);}image.Save(path);}
  return String.Format("#{0:x2}{1:x2}{2:x2}",pixel&255,(pixel>>8)&255,(pixel>>16)&255);
 }
}
'@
[CollectorTitlebarFixturePixels]::Read($BrowserProcessId,$OutputPath)
