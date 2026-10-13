param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectPath '.runtime\sources-python'
$runtimePython = Join-Path $runtimePath 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
    if (-not $PythonPath) {
        $candidatePath = Join-Path $env:USERPROFILE '.local\bin\python3.11.exe'
        if (Test-Path -LiteralPath $candidatePath) { $PythonPath = $candidatePath }
        else { throw 'Python 3.11+ is required. Run scripts\setup-sources.ps1 -PythonPath <python.exe>.' }
    }
    & $PythonPath -m venv $runtimePath
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create project-only Python environment.' }
}
& $runtimePython -m pip install --disable-pip-version-check --index-url 'https://pypi.org/simple' --requirement (Join-Path $PSScriptRoot 'source-engines-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Source engine installation failed.' }
Write-Host 'Project yt-dlp metadata engine is ready. gallery-dl is not included in this public edition. No global Python packages were changed.'
