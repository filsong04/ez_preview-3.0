@echo off
setlocal
cd /d "%~dp0"
title EZ Preview - Playback Priority Hotfix - Windows Build
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0BUILD-WINDOWS.ps1"
set "BUILD_EXIT=%ERRORLEVEL%"
echo.
if "%BUILD_EXIT%"=="0" (
  echo Build finished. The release folder should open automatically.
) else (
  echo Build did not finish successfully. See build-windows.log in this folder.
)
echo.
pause
exit /b %BUILD_EXIT%
