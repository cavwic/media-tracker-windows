[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$TargetPath)

$ErrorActionPreference = 'Stop'
$collectorFolder = Get-Item -LiteralPath $TargetPath -ErrorAction Stop
if (-not $collectorFolder.PSIsContainer -or ($collectorFolder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Target must be a regular directory.'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MediaTrackerFolderWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
'@

$collectorInitialForeground = [MediaTrackerFolderWindow]::GetForegroundWindow()
$collectorShell = New-Object -ComObject Shell.Application
$collectorOpened = $false
$collectorForeground = $false
try {
  # COM receives the literal directory path. No CMD, command string, shell
  # concatenation or custom file association is involved, including UNC paths.
  $collectorShell.Open($collectorFolder.FullName)
  $collectorOpened = $true
  $collectorDirectory = $collectorFolder.FullName.TrimEnd('\')
  $collectorDeadline = [DateTime]::UtcNow.AddSeconds(4)
  do {
    $collectorMatches = @()
    foreach ($collectorWindow in @($collectorShell.Windows())) {
      try {
        $collectorLocation = ([string]$collectorWindow.Document.Folder.Self.Path).TrimEnd('\')
        if ($collectorLocation.Equals($collectorDirectory, [StringComparison]::OrdinalIgnoreCase)) {
          $collectorMatches += [IntPtr][long]$collectorWindow.HWND
        }
      } catch {}
    }
    if ($collectorMatches.Count -eq 1) {
      $collectorHandle = $collectorMatches[0]
      $collectorCurrentForeground = [MediaTrackerFolderWindow]::GetForegroundWindow()
      if ($collectorCurrentForeground -eq $collectorHandle) { $collectorForeground = $true; break }
      # Respect a user switching to a different application during navigation.
      if ($collectorCurrentForeground -ne $collectorInitialForeground) { break }
      if ([MediaTrackerFolderWindow]::IsIconic($collectorHandle)) {
        [void][MediaTrackerFolderWindow]::ShowWindowAsync($collectorHandle, 9)
      }
      [void][MediaTrackerFolderWindow]::SetForegroundWindow($collectorHandle)
      $collectorForeground = [MediaTrackerFolderWindow]::GetForegroundWindow() -eq $collectorHandle
      break
    }
    Start-Sleep -Milliseconds 120
  } while ([DateTime]::UtcNow -lt $collectorDeadline)
} finally {
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($collectorShell)
}
Write-Output ('launched={0}' -f $collectorOpened.ToString().ToLowerInvariant())
Write-Output ('foreground={0}' -f $collectorForeground.ToString().ToLowerInvariant())
