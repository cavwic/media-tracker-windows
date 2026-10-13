@echo off
setlocal
rem The completed entry is removed only after this CMD process has exited.
(
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0compile\build.ps1"
  if errorlevel 1 (
    echo.
    echo Compilation or startup failed. The source files were preserved.
    pause
  )
  exit /b
)
