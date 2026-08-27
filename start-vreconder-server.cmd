@echo off
setlocal
cd /d "%~dp0"

echo ===================================================
echo   VREconder Server Launcher
echo ===================================================
echo Repository Root: %CD%
echo.

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js executable not found in PATH!
    echo Please install Node.js (v18+) or add node.exe to your system PATH.
    echo.
    pause
    exit /b 1
)

netstat -ano | findstr ":8443 " >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [WARNING] Port 8443 is currently in use.
    echo VREconder server may already be running, or another process is occupying port 8443.
    echo.
)

echo Starting VREconder Server (prototype\lan_secure_origin\server.mjs)...
echo.

node prototype\lan_secure_origin\server.mjs
set EXIT_CODE=%ERRORLEVEL%

echo.
echo ===================================================
if %EXIT_CODE% neq 0 (
    echo [ERROR] VREconder Server exited unexpectedly with exit code: %EXIT_CODE%
) else (
    echo [INFO] VREconder Server stopped gracefully.
)
echo ===================================================
echo.
pause
exit /b %EXIT_CODE%