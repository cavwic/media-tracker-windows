[CmdletBinding()]
param([switch]$Apply, [switch]$ProjectOnly)

# Keep ASCII source for Windows PowerShell 5.1; workspace paths are Unicode
# values obtained from the script location, never shell-built commands.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$collectorToolRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$collectorIconPath = Join-Path $collectorToolRoot 'public\media-tracker-v2.ico'
if (-not (Test-Path -LiteralPath $collectorIconPath -PathType Leaf)) { throw 'Build the local icon assets before updating shortcuts.' }
$collectorEntrypoints = @('scripts\start.vbs', 'start.cmd', 'start.vbs') | ForEach-Object { Join-Path $collectorToolRoot $_ }
# Keep exact legacy owned shortcuts recognizable without accepting another
# project, substring matches or extra arguments. This does not execute them.
$collectorVbsArguments = @('scripts\start.vbs', 'start.vbs') | ForEach-Object {
  $collectorVbsPath = Join-Path $collectorToolRoot $_
  $collectorVbsPath
  '"' + $collectorVbsPath + '"'
}
$collectorWscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$collectorCscript = Join-Path $env:SystemRoot 'System32\cscript.exe'
$collectorShell = New-Object -ComObject WScript.Shell
$collectorFolders = @($collectorToolRoot)
if (-not $ProjectOnly) {
  $collectorFolders += @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('CommonDesktopDirectory'))
}
$collectorFolders = $collectorFolders | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique
$collectorUpdated = 0
if ($Apply) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CollectorShortcutRefresh {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern void SHChangeNotify(uint eventId, uint flags, string path, IntPtr other);
}
'@
}
foreach ($collectorFolder in $collectorFolders) {
  foreach ($collectorFile in Get-ChildItem -LiteralPath $collectorFolder -Filter '*.lnk' -File) {
    if ($collectorFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    $collectorShortcut = $collectorShell.CreateShortcut($collectorFile.FullName)
    $collectorTarget = $collectorShortcut.TargetPath
    $collectorArgs = [string]$collectorShortcut.Arguments
    $collectorOwned = $collectorEntrypoints -contains $collectorTarget
    if ($collectorTarget -ieq $collectorWscript -or $collectorTarget -ieq $collectorCscript) {
      # Only our exact launcher is accepted; no substring path matches and no
      # arbitrary command/extra arguments are interpreted or executed.
      $collectorOwned = $collectorVbsArguments -contains $collectorArgs.Trim()
    }
    if (-not $collectorOwned) { continue }
    $collectorPrevious = $collectorShortcut.IconLocation
    if ($Apply) {
      $collectorShortcut.IconLocation = $collectorIconPath + ',0'
      $collectorShortcut.Save()
      [CollectorShortcutRefresh]::SHChangeNotify(0x00002000, 0x0005, $collectorFile.FullName, [IntPtr]::Zero)
      $collectorUpdated++
    }
    [pscustomobject]@{ Shortcut = $collectorFile.FullName; PreviousIcon = $collectorPrevious; NewIcon = $collectorIconPath + ',0'; Applied = [bool]$Apply } | ConvertTo-Json -Compress
  }
}
if ($Apply) { Write-Output ('Updated owned shortcuts: ' + $collectorUpdated) }
