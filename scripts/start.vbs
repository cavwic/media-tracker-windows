Option Explicit
Dim launcherShell, launcherFiles, launcherRoot, powershellPath, launcherCommand
Set launcherShell = CreateObject("WScript.Shell")
Set launcherFiles = CreateObject("Scripting.FileSystemObject")
launcherRoot = launcherFiles.GetParentFolderName(launcherFiles.GetParentFolderName(WScript.ScriptFullName))
powershellPath = launcherShell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
launcherCommand = """" & powershellPath & """ -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & launcherRoot & "\scripts\start-hidden.ps1"""
On Error Resume Next
launcherShell.Run launcherCommand, 0, False
If Err.Number <> 0 Then
  MsgBox "Media Tracker could not start. " & Err.Description, vbOKOnly + vbExclamation, "Media Tracker"
  WScript.Quit 1
End If
WScript.Quit 0
