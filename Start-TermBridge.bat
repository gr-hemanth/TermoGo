@echo off
setlocal
cd /d "%~dp0"
title TermBridge Launcher

echo ============================================================
echo                     TERMBRIDGE
echo       Control AGY and Terminals from your Phone
echo ============================================================
echo.

:: 1. Verify Node.js is installed and in PATH
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js was not found in your PATH.
    echo Please install Node.js v18+ from https://nodejs.org/ and try again.
    echo.
    pause
    exit /b 1
)

:: 2. Verify npm is installed
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm was not found in your PATH.
    echo Please ensure Node.js and npm are properly configured.
    echo.
    pause
    exit /b 1
)

:: 3. Verify project dependencies are installed
if not exist "node_modules\" (
    echo [TermBridge] First-time setup: installing dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [ERROR] npm install encountered an error. Please verify your internet connection.
        echo.
        pause
        exit /b 1
    )
    echo [TermBridge] Dependencies installed successfully.
    echo.
)

:: 4. Start TermBridge Launcher
node server/launcher.js %*
if %ERRORLEVEL% neq 0 (
    echo.
    echo [TermBridge] Process exited with code %ERRORLEVEL%.
    pause
)
