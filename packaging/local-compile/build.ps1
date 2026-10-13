[CmdletBinding()]
param([switch]$NoLaunch, [ValidateSet('accept', 'reject', 'cancel')][string]$RuntimeFixtureDecision)

# ASCII source works with Windows PowerShell 5.1 without a UTF-8 BOM.
# Compilation is offline; optional runtime downloads require explicit consent.
# No elevation, system installer, registry change or security bypass is used.
$ErrorActionPreference = 'Stop'
$collectorCompileDir = [IO.Path]::GetFullPath($PSScriptRoot)
$collectorRoot = [IO.Path]::GetFullPath((Join-Path $collectorCompileDir '..'))
$collectorExeName = ([string][char]0x91C7) + [char]0x96C6 + [char]0x5DE5 + [char]0x5177 + '.exe'
$collectorFirstName = ([string][char]0x9996) + [char]0x6B21 + [char]0x7F16 + [char]0x8BD1 + '.cmd'
$collectorExe = Join-Path $collectorRoot $collectorExeName
$collectorFirst = Join-Path $collectorRoot $collectorFirstName
$collectorNonce = [Guid]::NewGuid().ToString('N')
$collectorTempExe = Join-Path $collectorRoot ('.collector-build-' + $collectorNonce + '.exe')
$collectorLogDir = Join-Path $collectorRoot 'data\startup-logs'
$collectorReport = Join-Path $collectorLogDir ('.self-test-' + $collectorNonce + '.json')
$collectorReady = Join-Path $collectorLogDir ('.ready-' + $collectorNonce + '.json')
$collectorBuildLog = Join-Path $collectorLogDir ('build-' + $collectorNonce + '.log')
$collectorReceipt = Join-Path $collectorLogDir 'local-compile-state.json'
$collectorCleanupApproved = $false

function ConvertTo-CollectorArgument([string]$Value) {
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Assert-CollectorRegularPath([string]$Path, [switch]$Directory) {
    $collectorItem = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($collectorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('A compiler payload path is a link or reparse point: ' + $Path)
    }
    if ([bool]$collectorItem.PSIsContainer -ne [bool]$Directory) { throw ('Unexpected compiler payload type: ' + $Path) }
}

function Get-CollectorHash([string]$Path) {
    $collectorHash = [Security.Cryptography.SHA256]::Create()
    $collectorInput = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($collectorHash.ComputeHash($collectorInput)).Replace('-', '') }
    finally { $collectorInput.Dispose(); $collectorHash.Dispose() }
}

function Invoke-CollectorProcess([string]$Executable, [string[]]$Arguments, [int]$TimeoutMs = 60000) {
    $collectorInfo = New-Object Diagnostics.ProcessStartInfo
    $collectorInfo.FileName = $Executable
    $collectorInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-CollectorArgument $_ }) -join ' ')
    $collectorInfo.WorkingDirectory = $collectorRoot
    $collectorInfo.UseShellExecute = $false
    $collectorInfo.CreateNoWindow = $true
    $collectorInfo.RedirectStandardOutput = $true
    $collectorInfo.RedirectStandardError = $true
    $collectorProcess = New-Object Diagnostics.Process
    $collectorProcess.StartInfo = $collectorInfo
    try {
        [void]$collectorProcess.Start()
        $collectorOutputTask = $collectorProcess.StandardOutput.ReadToEndAsync()
        $collectorErrorTask = $collectorProcess.StandardError.ReadToEndAsync()
        if ($TimeoutMs -eq 0) { $collectorProcess.WaitForExit() }
        elseif (-not $collectorProcess.WaitForExit($TimeoutMs)) {
            $collectorProcess.Kill()
            $collectorProcess.WaitForExit()
            throw 'Compilation or offline runtime validation timed out.'
        }
        [void]$collectorOutputTask.GetAwaiter().GetResult()
        [void]$collectorErrorTask.GetAwaiter().GetResult()
        [IO.File]::AppendAllText($collectorBuildLog, $collectorOutputTask.Result + $collectorErrorTask.Result, [Text.Encoding]::UTF8)
        return $collectorProcess.ExitCode
    } finally { $collectorProcess.Dispose() }
}

try {
    if ([IO.Path]::GetFileName($collectorCompileDir) -ne 'compile') {
        throw 'Run the compiler from the distributed compile folder.'
    }
    Assert-CollectorRegularPath $collectorRoot -Directory
    Assert-CollectorRegularPath $collectorCompileDir -Directory
    $collectorOwnedPaths = @(
        (Join-Path $collectorCompileDir 'build.ps1'),
        (Join-Path $collectorCompileDir 'Launcher.cs'),
        (Join-Path $collectorCompileDir 'launcher.manifest'),
        $collectorFirst
    )
    $collectorOwnedHashes = @{}
    foreach ($collectorOwned in $collectorOwnedPaths) {
        Assert-CollectorRegularPath $collectorOwned
        $collectorOwnedHashes[$collectorOwned] = Get-CollectorHash $collectorOwned
    }
    [void][IO.Directory]::CreateDirectory($collectorLogDir)
    Assert-CollectorRegularPath (Join-Path $collectorRoot 'data') -Directory
    Assert-CollectorRegularPath $collectorLogDir -Directory
    [IO.File]::WriteAllText($collectorBuildLog, 'Local compilation started.' + [Environment]::NewLine, [Text.Encoding]::UTF8)
    $collectorReusing = $false
    if ([IO.File]::Exists($collectorExe) -or [IO.Directory]::Exists($collectorExe)) {
        Assert-CollectorRegularPath $collectorExe
        if (-not [IO.File]::Exists($collectorReceipt)) {
            throw 'An unknown EXE already exists. It was not replaced or deleted.'
        }
        Assert-CollectorRegularPath $collectorReceipt
        $collectorPrevious = [IO.File]::ReadAllText($collectorReceipt, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($collectorPrevious.schemaVersion -ne 1 -or $collectorPrevious.filename -cne $collectorExeName -or
            $collectorPrevious.sha256 -cne (Get-CollectorHash $collectorExe) -or
            @($collectorPrevious.sources.PSObject.Properties).Count -ne $collectorOwnedPaths.Count) {
            throw 'The existing EXE does not match this local compiler receipt. Nothing was replaced or deleted.'
        }
        foreach ($collectorOwned in $collectorOwnedPaths) {
            $collectorRelative = $collectorOwned.Substring($collectorRoot.Length + 1).Replace('\', '/')
            if ($collectorPrevious.sources.PSObject.Properties[$collectorRelative].Value -cne $collectorOwnedHashes[$collectorOwned]) {
                throw 'The existing EXE was compiled from different source materials. Nothing was replaced or deleted.'
            }
        }
        $collectorReusing = $true
        Write-Host 'Retrying the previous receipt-verified local build without recompiling or replacing it.'
    } elseif ([IO.File]::Exists($collectorReceipt) -or [IO.Directory]::Exists($collectorReceipt)) {
        throw 'A previous local build receipt exists without its EXE. Preserve it for inspection; nothing was overwritten.'
    }
    $collectorFramework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not [Environment]::Is64BitOperatingSystem -or -not [IO.File]::Exists($collectorFramework)) {
        throw 'This package requires 64-bit Windows 10/11 with .NET Framework 4.x. No components were installed.'
    }
    $collectorCompileArgs = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output',
        '/reference:System.Windows.Forms.dll', '/reference:System.Runtime.Serialization.dll', '/reference:System.Drawing.dll',
        '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
        ('/win32manifest:' + (Join-Path $collectorCompileDir 'launcher.manifest')),
        ('/out:' + $collectorTempExe),
        (Join-Path $collectorCompileDir 'Launcher.cs'))
    $collectorIcon = Join-Path $collectorRoot 'app\public\media-tracker-v2.ico'
    if ([IO.File]::Exists($collectorIcon)) { $collectorCompileArgs += ('/win32icon:' + $collectorIcon) }
    if (-not $collectorReusing -and ((Invoke-CollectorProcess $collectorFramework $collectorCompileArgs) -ne 0 -or -not [IO.File]::Exists($collectorTempExe))) {
        throw 'Compilation failed. See the build log; the source files were preserved.'
    }
    $collectorValidatedExe = if ($collectorReusing) { $collectorExe } else { $collectorTempExe }
    if (-not $NoLaunch) {
        $collectorPrepareArgs = @('--prepare-runtime')
        if ($RuntimeFixtureDecision) { $collectorPrepareArgs += @('--fixture-runtime-decision', $RuntimeFixtureDecision) }
        $collectorPreparationCode = Invoke-CollectorProcess $collectorValidatedExe $collectorPrepareArgs 0
        if ($collectorPreparationCode -eq 2) {
            Write-Host 'Runtime preparation was declined or cancelled. Compiler sources and completed components were preserved.'
            exit 2
        }
        if ($collectorPreparationCode -ne 0) { throw 'Runtime preparation failed. Compiler sources and completed components were preserved.' }
    }
    if ((Invoke-CollectorProcess $collectorValidatedExe @('--self-test', '--report', $collectorReport) 20000) -ne 0) {
        throw 'Offline bundled-runtime validation failed. The source files were preserved.'
    }
    $collectorValidation = [IO.File]::ReadAllText($collectorReport, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($collectorValidation.schemaVersion -ne 1 -or $collectorValidation.ok -ne $true) {
        throw 'Offline bundled-runtime validation did not return a successful report.'
    }
    if (-not $collectorReusing) {
        # File.Move is a same-directory atomic commit and cannot replace an existing file.
        [IO.File]::Move($collectorTempExe, $collectorExe)
        $collectorSourceReceipt = @{}
        foreach ($collectorOwned in $collectorOwnedPaths) {
            $collectorRelative = $collectorOwned.Substring($collectorRoot.Length + 1).Replace('\', '/')
            $collectorSourceReceipt[$collectorRelative] = $collectorOwnedHashes[$collectorOwned]
        }
        $collectorReceiptJson = @{ schemaVersion = 1; filename = $collectorExeName;
            sha256 = (Get-CollectorHash $collectorExe); sources = $collectorSourceReceipt } | ConvertTo-Json -Depth 4
        $collectorReceiptBytes = [Text.Encoding]::UTF8.GetBytes($collectorReceiptJson)
        $collectorReceiptStream = New-Object IO.FileStream($collectorReceipt, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $collectorReceiptStream.Write($collectorReceiptBytes, 0, $collectorReceiptBytes.Length); $collectorReceiptStream.Flush($true) }
        finally { $collectorReceiptStream.Dispose() }
    }
    Write-Host ('Created: ' + $collectorExe)
    if ($NoLaunch) {
        Write-Host 'NoLaunch validation mode: compiler sources were preserved; no application was started.'
        exit 0
    }
    $collectorLaunchInfo = New-Object Diagnostics.ProcessStartInfo
    $collectorLaunchInfo.FileName = $collectorExe
    $collectorLaunchInfo.Arguments = '--ready-file ' + (ConvertTo-CollectorArgument $collectorReady) +
        ' --ready-token ' + (ConvertTo-CollectorArgument $collectorNonce)
    $collectorLaunchInfo.WorkingDirectory = $collectorRoot
    $collectorLaunchInfo.UseShellExecute = $false
    $collectorLaunchInfo.CreateNoWindow = $true
    $collectorLaunchInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $collectorLaunched = New-Object Diagnostics.Process
    $collectorLaunched.StartInfo = $collectorLaunchInfo
    try {
        [void]$collectorLaunched.Start()
        $collectorDeadline = [DateTime]::UtcNow.AddSeconds(45)
        while ([DateTime]::UtcNow -lt $collectorDeadline) {
            if ([IO.File]::Exists($collectorReady)) {
                try {
                    $collectorAck = [IO.File]::ReadAllText($collectorReady, [Text.Encoding]::UTF8) | ConvertFrom-Json
                    if ($collectorAck.schemaVersion -eq 1 -and $collectorAck.token -ceq $collectorNonce -and $collectorAck.ready -eq $true) {
                        $collectorCleanupApproved = $true
                        break
                    }
                } catch { }
            }
            if ($collectorLaunched.HasExited) { break }
            Start-Sleep -Milliseconds 100
        }
        if (-not $collectorCleanupApproved) {
            throw 'The EXE was built, but application startup was not confirmed. Compiler sources were preserved. See startup-logs.'
        }
    } finally { $collectorLaunched.Dispose() }
    # Remove only unchanged, explicitly owned payload files; never recursively
    # remove the package, app, runtime, data, licenses or user-added files.
    foreach ($collectorOwned in $collectorOwnedPaths) {
        Assert-CollectorRegularPath $collectorOwned
        if ((Get-CollectorHash $collectorOwned) -cne $collectorOwnedHashes[$collectorOwned]) {
            throw 'A compiler file changed during startup. Cleanup was cancelled; keep these files for inspection.'
        }
    }
    # Deleting a currently executing batch file can make CMD fail even when its
    # whole remaining block was parsed first. A silent GUI helper waits for
    # these exact PowerShell/CMD processes to exit before deleting that entry.
    $collectorCurrentProcess = [Diagnostics.Process]::GetProcessById($PID)
    $collectorWaitStart = $collectorCurrentProcess.StartTime.ToUniversalTime().Ticks
    $collectorCurrentProcess.Dispose()
    $collectorCallerId = 0
    $collectorCallerStart = 0L
    $collectorParentInfo = [WMI]('Win32_Process.Handle="' + $PID + '"')
    if ($collectorParentInfo.ParentProcessId) {
        try {
            $collectorCaller = [Diagnostics.Process]::GetProcessById([int]$collectorParentInfo.ParentProcessId)
            try {
                if ($collectorCaller.ProcessName -eq 'cmd') {
                    $collectorCallerId = $collectorCaller.Id
                    $collectorCallerStart = $collectorCaller.StartTime.ToUniversalTime().Ticks
                }
            } finally { $collectorCaller.Dispose() }
        } catch [ArgumentException] { }
    }
    $collectorCleanupInfo = New-Object Diagnostics.ProcessStartInfo
    $collectorCleanupInfo.FileName = $collectorExe
    $collectorCleanupInfo.WorkingDirectory = $collectorRoot
    $collectorCleanupInfo.UseShellExecute = $false
    $collectorCleanupInfo.CreateNoWindow = $true
    $collectorCleanupInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $collectorCleanupArgs = @('--cleanup-first-run', '--ready-token', $collectorNonce,
        '--source-sha', $collectorOwnedHashes[$collectorFirst], '--wait-pid', [string]$PID, '--wait-start', [string]$collectorWaitStart)
    if ($collectorCallerId) { $collectorCleanupArgs += @('--caller-pid', [string]$collectorCallerId, '--caller-start', [string]$collectorCallerStart) }
    $collectorCleanupInfo.Arguments = (($collectorCleanupArgs | ForEach-Object { ConvertTo-CollectorArgument $_ }) -join ' ')
    $collectorCleanupProcess = New-Object Diagnostics.Process
    $collectorCleanupProcess.StartInfo = $collectorCleanupInfo
    [void]$collectorCleanupProcess.Start()
    $collectorCleanupProcess.Dispose()
    foreach ($collectorOwned in $collectorOwnedPaths) {
        if ($collectorOwned -ne $collectorFirst) { Remove-Item -LiteralPath $collectorOwned -Force }
    }
    if (@(Get-ChildItem -LiteralPath $collectorCompileDir -Force).Count -eq 0) {
        Remove-Item -LiteralPath $collectorCompileDir -Force
    }
    [IO.File]::Delete($collectorReport)
    Write-Host 'Application startup was confirmed. Compiler sources were removed; the first-run entry will be removed after its caller exits.'
    exit 0
} catch {
    $collectorFailure = $_.Exception.Message
    if ([IO.Directory]::Exists($collectorLogDir)) {
        [IO.File]::AppendAllText($collectorBuildLog, $collectorFailure + [Environment]::NewLine, [Text.Encoding]::UTF8)
    }
    Write-Error ($collectorFailure + [Environment]::NewLine + 'Build log: ' + $collectorBuildLog) -ErrorAction Continue
    exit 1
} finally {
    # This unique uncommitted EXE belongs to this attempt. Committed EXEs and
    # all compiler sources survive a failure or cancellation.
    if ([IO.File]::Exists($collectorTempExe)) { [IO.File]::Delete($collectorTempExe) }
}
