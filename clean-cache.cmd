@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Use the same Node.js installation as start.cmd.
  pause
  exit /b 1
)
node "%~dp0scripts\clean-browser-cache.mjs" --interactive
set "CACHE_CLEANUP_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %CACHE_CLEANUP_EXIT%
