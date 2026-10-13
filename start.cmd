@echo off
setlocal
rem Compatibility entry: hand off immediately; do not host the Node service.
"%SystemRoot%\System32\wscript.exe" "%~dp0start.vbs"
exit /b %errorlevel%
