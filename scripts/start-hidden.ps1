[CmdletBinding()]
param([switch]$NoErrorDialog)

$collectorLaunchStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
# ASCII source is intentional: Windows PowerShell 5.1 reads UTF-8 without BOM
# as ANSI. Paths arrive as Unicode from WScript, not as hard-coded literals.
$ErrorActionPreference = 'Stop'
$collectorRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$collectorOutStream = $null
$collectorErrStream = $null
$collectorOutPath = $null
$collectorErrPath = $null
$collectorBootstrapStatusPath = $null
$collectorBootstrapToken = $null

function ConvertTo-CollectorArgument([string]$Value) {
  # CommandLineToArgvW escaping, not CMD escaping. No shell runs these commands.
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Write-CollectorLog([string]$Message) {
  $collectorBytes = [Text.Encoding]::UTF8.GetBytes(([DateTime]::UtcNow.ToString('o') + ' ' + $Message + [Environment]::NewLine))
  $collectorOutStream.Write($collectorBytes, 0, $collectorBytes.Length)
  $collectorOutStream.Flush()
}

function Write-CollectorStage([string]$Name) {
  $collectorElapsed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $collectorLaunchStartedAtMs
  Write-CollectorLog ('[startup] ' + $Name + ' elapsed=' + [Math]::Max(0, $collectorElapsed) + 'ms')
}

function Invoke-CollectorProcess([string]$Executable, [string[]]$Arguments, [switch]$Service) {
  $collectorInfo = New-Object Diagnostics.ProcessStartInfo
  $collectorInfo.FileName = $Executable
  $collectorInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-CollectorArgument $_ }) -join ' ')
  $collectorInfo.WorkingDirectory = $collectorRoot
  $collectorInfo.UseShellExecute = $false
  $collectorInfo.CreateNoWindow = $true
  $collectorInfo.RedirectStandardOutput = $true
  $collectorInfo.RedirectStandardError = $true
  if ($Service) {
    # Read the Windows UI culture inside the existing launcher; this scoped
    # child variable avoids another process or startup delay for detection.
    $collectorInfo.EnvironmentVariables['MEDIA_TRACKER_SYSTEM_UI_LANGUAGE'] = (Get-UICulture).Name
    $collectorInfo.EnvironmentVariables['MEDIA_TRACKER_BACKGROUND_START'] = '1'
    $collectorInfo.EnvironmentVariables['MEDIA_TRACKER_LAUNCH_STARTED_AT_MS'] = [string]$collectorLaunchStartedAtMs
    $collectorInfo.EnvironmentVariables['MEDIA_TRACKER_BOOTSTRAP_STATUS_FILE'] = $collectorBootstrapStatusPath
    $collectorInfo.EnvironmentVariables['MEDIA_TRACKER_BOOTSTRAP_TOKEN'] = $collectorBootstrapToken
  }
  $collectorChild = New-Object Diagnostics.Process
  $collectorChild.StartInfo = $collectorInfo
  try {
    [void]$collectorChild.Start()
    # Copy raw bytes asynchronously so neither pipe can block Node or require
    # PowerShell callbacks. Separate files keep stderr and stdout unambiguous.
    $collectorCopyOut = $collectorChild.StandardOutput.BaseStream.CopyToAsync($collectorOutStream)
    $collectorCopyErr = $collectorChild.StandardError.BaseStream.CopyToAsync($collectorErrStream)
    $collectorChild.WaitForExit()
    [void]$collectorCopyOut.GetAwaiter().GetResult()
    [void]$collectorCopyErr.GetAwaiter().GetResult()
    $collectorOutStream.Flush()
    $collectorErrStream.Flush()
    return $collectorChild.ExitCode
  } finally { $collectorChild.Dispose() }
}

function Install-CollectorDependencies {
  $collectorNpm = Join-Path ([IO.Path]::GetDirectoryName($collectorNode)) 'node_modules\npm\bin\npm-cli.js'
  if (-not (Test-Path -LiteralPath $collectorNpm -PathType Leaf)) { throw 'npm is missing from the Node.js installation. Run npm install from the project directory first.' }
  Write-CollectorLog 'Installing the missing local runtime dependencies.'
  $collectorInstallCode = Invoke-CollectorProcess $collectorNode @($collectorNpm, 'install', '--no-audit', '--no-fund')
  if ($collectorInstallCode -ne 0) { throw 'Installing runtime dependencies failed. See the startup logs.' }
}

function Read-CollectorBootstrapStatus([int]$ExitCode) {
  if (-not [IO.File]::Exists($collectorBootstrapStatusPath)) { return $null }
  try {
    $collectorStatus = [IO.File]::ReadAllText($collectorBootstrapStatusPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($collectorStatus.schemaVersion -ne 1 -or $collectorStatus.token -ne $collectorBootstrapToken -or $collectorStatus.exitCode -ne $ExitCode) {
      throw 'The startup status did not match this launch. No dependencies were installed.'
    }
    return $collectorStatus.reason
  } finally {
    # This exact, unique attempt marker is our own launcher control file.
    [IO.File]::Delete($collectorBootstrapStatusPath)
  }
}

$collectorExitCode = 0
try {
  Set-Location -LiteralPath $collectorRoot
  [Environment]::CurrentDirectory = $collectorRoot
  $collectorData = if ($env:MEDIA_TRACKER_DATA_DIR) { [IO.Path]::GetFullPath($env:MEDIA_TRACKER_DATA_DIR) } else { Join-Path $collectorRoot 'data' }
  $collectorLogs = Join-Path $collectorData 'startup-logs'
  [void][IO.Directory]::CreateDirectory($collectorLogs)
  $collectorLogId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
  $collectorOutPath = Join-Path $collectorLogs ($collectorLogId + '.out.log')
  $collectorErrPath = Join-Path $collectorLogs ($collectorLogId + '.err.log')
  $collectorOutStream = New-Object IO.FileStream($collectorOutPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read, 1, [IO.FileOptions]::Asynchronous)
  $collectorErrStream = New-Object IO.FileStream($collectorErrPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read, 1, [IO.FileOptions]::Asynchronous)
  Write-CollectorLog 'Starting Media Tracker without a console window.'
  $collectorNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  Write-CollectorStage 'launcher-ready'
  $collectorInstalledDependencies = $false
  $collectorInstalledChromium = $false
  if (-not (Test-Path -LiteralPath (Join-Path $collectorRoot 'node_modules\playwright\package.json') -PathType Leaf)) {
    # A missing-package install must never be attempted under unsupported Node.
    $collectorCode = Invoke-CollectorProcess $collectorNode @('-e', "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 20)")
    if ($collectorCode -ne 0) { throw 'Node.js 20 or newer is required. Install the official Node.js LTS release.' }
    Install-CollectorDependencies
    $collectorInstalledDependencies = $true
  }
  while ($true) {
    $collectorBootstrapToken = [Guid]::NewGuid().ToString('N')
    $collectorBootstrapStatusPath = Join-Path $collectorLogs ($collectorLogId + '.bootstrap-' + $collectorBootstrapToken + '.json')
    Write-CollectorStage 'runtime-bootstrap'
    $collectorCode = Invoke-CollectorProcess $collectorNode @((Join-Path $collectorRoot 'scripts\start-service.mjs')) -Service
    $collectorStatusReason = Read-CollectorBootstrapStatus $collectorCode
    if ($collectorCode -eq 0) { break }
    if ($collectorStatusReason -eq 'unsupported-node') { throw 'Node.js 20 or newer is required. Install the official Node.js LTS release.' }
    if ($collectorStatusReason -eq 'missing-dependencies' -and -not $collectorInstalledDependencies) {
      Install-CollectorDependencies
      $collectorInstalledDependencies = $true
      continue
    }
    if ($collectorStatusReason -eq 'missing-chromium' -and -not $collectorInstalledChromium) {
      Write-CollectorLog 'Installing the missing private Chromium runtime.'
      $collectorCli = Join-Path $collectorRoot 'node_modules\playwright\cli.js'
      $collectorCode = Invoke-CollectorProcess $collectorNode @($collectorCli, 'install', 'chromium')
      if ($collectorCode -ne 0) { throw 'Installing private Chromium failed. See the startup logs.' }
      $collectorInstalledChromium = $true
      continue
    }
    throw "The local service exited with code $collectorCode. See the startup logs."
  }
  Write-CollectorStage 'launcher-exited'
} catch {
  $collectorExitCode = 1
  $collectorError = $_.Exception.Message
  if ($collectorErrStream) {
    $collectorErrorBytes = [Text.Encoding]::UTF8.GetBytes($collectorError + [Environment]::NewLine)
    $collectorErrStream.Write($collectorErrorBytes, 0, $collectorErrorBytes.Length)
    $collectorErrStream.Flush()
  }
  if (-not $NoErrorDialog) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [void][Windows.Forms.MessageBox]::Show("Media Tracker could not start.`n`n$collectorError`n`nLogs:`n$collectorOutPath`n$collectorErrPath", 'Media Tracker', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
    } catch { }
  }
} finally {
  if ($collectorOutStream) { $collectorOutStream.Dispose() }
  if ($collectorErrStream) { $collectorErrStream.Dispose() }
}
exit $collectorExitCode
