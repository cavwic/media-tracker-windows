@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-sources.ps1"
if errorlevel 1 echo Source engine setup failed. See the message above.
pause
