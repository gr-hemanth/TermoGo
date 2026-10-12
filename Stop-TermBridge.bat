@echo off
setlocal
cd /d "%~dp0"
title TermBridge - Stop

echo ============================================================
echo                 STOPPING TERMBRIDGE
echo ============================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js was not found in your PATH.
    pause
    exit /b 1
)

node server/stop.js

echo.
echo Press any key to close this window...
pause >nul
