export function buildFolderPickerScript(initialPath = "") {
  const safeInitialPath = String(initialPath || "").replaceAll("'", "''");
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; using System.Threading; public static class FolderPickerWindow { private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter); [DllImport(\"user32.dll\")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter); [DllImport(\"user32.dll\")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId); [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int count); [DllImport(\"user32.dll\")] private static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags); [DllImport(\"user32.dll\")] private static extern bool SetForegroundWindow(IntPtr handle); public static bool BringToFront(int processId, string expectedTitle) { IntPtr match = IntPtr.Zero; EnumWindows(delegate(IntPtr handle, IntPtr parameter) { uint ownerProcessId; GetWindowThreadProcessId(handle, out ownerProcessId); if (ownerProcessId != (uint)processId) return true; StringBuilder title = new StringBuilder(512); GetWindowText(handle, title, title.Capacity); if (title.ToString() != expectedTitle) return true; match = handle; return false; }, IntPtr.Zero); if (match == IntPtr.Zero) return false; SetWindowPos(match, new IntPtr(-1), 0, 0, 0, 0, 0x43); SetForegroundWindow(match); return true; } public static IDisposable Watch(int processId, string expectedTitle) { return new Timer(delegate(object state) { BringToFront(processId, expectedTitle); }, null, 80, 150); } }'",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.ShowInTaskbar = $false",
    "$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual",
    "$owner.Location = New-Object System.Drawing.Point(-32000, -32000)",
    "$owner.Size = New-Object System.Drawing.Size(1, 1)",
    "$owner.Opacity = 0",
    "$owner.TopMost = $true",
    "$dialog = New-Object System.Windows.Forms.SaveFileDialog",
    "$dialog.Title = '进入目标文件夹后，点击选择此文件夹'",
    "$dialog.FileName = '选择此文件夹'",
    "$dialog.Filter = '文件夹选择|*.folder'",
    "$dialog.AddExtension = $false",
    "$dialog.OverwritePrompt = $false",
    "$dialog.CheckPathExists = $true",
    "$dialog.RestoreDirectory = $true",
    safeInitialPath ? `$dialog.InitialDirectory = '${safeInitialPath}'` : "",
    "$focusTimer = [FolderPickerWindow]::Watch([System.Diagnostics.Process]::GetCurrentProcess().Id, $dialog.Title)",
    "try { $owner.Show(); $owner.Activate(); if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ([System.IO.Path]::GetDirectoryName($dialog.FileName)) } } finally { $focusTimer.Dispose(); $dialog.Dispose(); $owner.Close(); $owner.Dispose() }",
  ].filter(Boolean).join("; ");
}
