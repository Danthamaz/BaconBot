@echo off
echo.
echo ==========================================
echo   BaconBot - Raid Log Parser
echo   Starting web interface...
echo ==========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed.
    echo.
    echo Download and install it from: https://nodejs.org
    echo Choose the "LTS" version. Then run this file again.
    echo.
    pause
    exit /b 1
)

cd /d "%~dp0"
start "" http://localhost:3456
node web-app.js

echo.
echo ==========================================
echo   Server stopped. Press any key to close.
echo ==========================================
pause >nul
