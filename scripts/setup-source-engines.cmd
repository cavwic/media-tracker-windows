@echo off
setlocal
cd /d "%~dp0.."
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-sources.ps1"
if errorlevel 1 echo Source engine setup failed. See the message above.
pause
