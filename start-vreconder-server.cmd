@echo off
setlocal
cd /d "%~dp0"

echo ===================================================
echo   VREconder Server Launcher
echo ===================================================
echo Repository Root: %CD%
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js executable not found in PATH!
    echo Please install Node.js or add node.exe to your system PATH.
    echo.
    pause
    exit /b 1
)

netstat -ano | findstr ":8443 " >nul 2>&1
if not errorlevel 1 (
    echo [WARNING] Port 8443 is currently in use.
    echo VREconder server may already be running, or another process is occupying port 8443.
    echo.
)

echo Starting VREconder Server...
echo.

node prototype\lan_secure_origin\server.mjs
set EXIT_CODE=%ERRORLEVEL%

echo.
echo ===================================================
if %EXIT_CODE% neq 0 (
    echo [ERROR] VREconder Server exited with exit code: %EXIT_CODE%
) else (
    echo [INFO] VREconder Server stopped gracefully.
)
echo ===================================================
echo.
pause
exit /b %EXIT_CODE%