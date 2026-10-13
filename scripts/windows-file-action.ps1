[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("open", "reveal")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$TargetPath
)

$ErrorActionPreference = "Stop"
$item = Get-Item -LiteralPath $TargetPath -ErrorAction Stop
if ($item.PSIsContainer) {
  throw "Target must be a file."
}

if ($Action -eq "open") {
  Add-Type -Path (Join-Path $PSScriptRoot "windows-media-open.cs")
  $result = [MediaTrackerFileOpen.Launcher]::Open($item.FullName)
  Write-Output ("launched={0}" -f $result.Launched.ToString().ToLowerInvariant())
  Write-Output ("foreground={0}" -f $result.Foreground.ToString().ToLowerInvariant())
  Write-Output ("reason={0}" -f $result.Reason)
  exit 0
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MediaTrackerWindow {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern void SwitchToThisWindow(IntPtr hWnd, bool turnOn);
}
"@

$directory = [System.IO.Path]::GetDirectoryName($item.FullName).TrimEnd("\")
$shell = New-Object -ComObject Shell.Application
$beforeHandles = [System.Collections.Generic.HashSet[long]]::new()
foreach ($window in @($shell.Windows())) {
  try { [void]$beforeHandles.Add([long]$window.HWND) } catch {}
}

$explorerArguments = '/select,"{0}"' -f $item.FullName
Start-Process -FilePath (Join-Path $env:WINDIR "explorer.exe") -ArgumentList $explorerArguments | Out-Null

$matchedWindow = $null
$existingMatch = $null
$deadline = [DateTime]::UtcNow.AddSeconds(4)
:search do {
  foreach ($window in @($shell.Windows())) {
    try {
      $windowPath = ([string]$window.Document.Folder.Self.Path).TrimEnd("\")
      if (-not $windowPath.Equals($directory, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
      if (-not $beforeHandles.Contains([long]$window.HWND)) {
        $matchedWindow = $window
        break search
      }
      if ($null -eq $existingMatch) { $existingMatch = $window }
    } catch {}
  }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)

if ($null -eq $matchedWindow) { $matchedWindow = $existingMatch }
$foreground = $false
if ($null -ne $matchedWindow) {
  $handle = [IntPtr][long]$matchedWindow.HWND
  [void][MediaTrackerWindow]::ShowWindowAsync($handle, 9)
  [void][MediaTrackerWindow]::BringWindowToTop($handle)
  [MediaTrackerWindow]::SwitchToThisWindow($handle, $true)
  $foreground = [MediaTrackerWindow]::SetForegroundWindow($handle)
}

Write-Output ("foreground={0}" -f $foreground.ToString().ToLowerInvariant())
[void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
