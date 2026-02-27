@echo off
setlocal enabledelayedexpansion

echo.
echo ==========================================
echo   BaconBot -- Raid Log Submission
echo ==========================================
echo.

:: ── Check Node.js ─────────────────────────────────────────────────────────
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

:: ── Character name ─────────────────────────────────────────────────────────
set /p CHARACTER=Your character name (e.g. Lyri):
if "%CHARACTER%"=="" (
    echo No character name entered.
    pause
    exit /b 1
)

:: ── Timezone ───────────────────────────────────────────────────────────────
echo.
echo What is your timezone?
echo.
echo   1. Arizona / Phoenix (no daylight saving)
echo   2. Pacific  (California, Nevada, Washington)
echo   3. Mountain (Colorado, Utah, New Mexico)
echo   4. Central  (Texas, Illinois, Minnesota)
echo   5. Eastern  (New York, Florida, Georgia)
echo.
set /p TZ_CHOICE=Enter a number (1-5):

if "%TZ_CHOICE%"=="1" set TIMEZONE=America/Phoenix
if "%TZ_CHOICE%"=="2" set TIMEZONE=America/Los_Angeles
if "%TZ_CHOICE%"=="3" set TIMEZONE=America/Denver
if "%TZ_CHOICE%"=="4" set TIMEZONE=America/Chicago
if "%TZ_CHOICE%"=="5" set TIMEZONE=America/New_York

if not defined TIMEZONE (
    echo Invalid selection. Run the file again and enter a number between 1 and 5.
    pause
    exit /b 1
)

:: ── Find log file ──────────────────────────────────────────────────────────
echo.
set LOG_FILE=
set EQ_DIR=
set CFG_FILE=%~dp0parse-log.cfg

:: Check if we saved the EQ folder from a previous run
if exist "!CFG_FILE!" (
    set /p EQ_DIR=<"!CFG_FILE!"
    echo Saved EQ folder: !EQ_DIR!
    :: Look for the log file in the saved folder
    for %%F in ("!EQ_DIR!\eqlog_%CHARACTER%_*.txt") do (
        if not defined LOG_FILE set LOG_FILE=%%F
    )
    if defined LOG_FILE (
        echo Found: !LOG_FILE!
        goto :found_log
    )
    echo Could not find a log for %CHARACTER% in saved folder.
    echo.
)

:: Ask the user for their EQ folder
echo Where is your EverQuest folder?
echo   Example: C:\Apps\TAKPv22  or  D:\Games\EverQuest
echo   Tip: you can drag-and-drop the folder onto this window.
echo.
set /p EQ_DIR=EQ folder path:
if "!EQ_DIR!"=="" (
    echo No folder path entered.
    pause
    exit /b 1
)

:: Strip surrounding quotes if the user pasted them
set EQ_DIR=!EQ_DIR:"=!

:: Try to find the log in that folder
for %%F in ("!EQ_DIR!\eqlog_%CHARACTER%_*.txt") do (
    if not defined LOG_FILE set LOG_FILE=%%F
)

if not defined LOG_FILE (
    echo.
    echo ERROR: No log file found for "%CHARACTER%" in:
    echo   !EQ_DIR!
    echo.
    echo Expected a file like: eqlog_%CHARACTER%_pq.proj.txt
    echo Double-check the folder path and character name.
    pause
    exit /b 1
)

:: Save the EQ folder for next time
echo !EQ_DIR!>"!CFG_FILE!"
echo Saved EQ folder for next time.
echo Found: !LOG_FILE!

:found_log
if not exist "!LOG_FILE!" (
    echo.
    echo ERROR: File not found:
    echo   !LOG_FILE!
    echo.   
    echo Double-check the path and try again.
    pause
    exit /b 1
)

:: ── Run ───────────────────────────────────────────────────────────────────
echo.
echo ============================================
echo   Scanning log — this may take a few minutes
echo ============================================
echo.

cd /d "%~dp0"
node parse-local.js --file "%LOG_FILE%" --timezone "%TIMEZONE%" --character "%CHARACTER%"

echo.
echo ==========================================
echo   Done. Press any key to close.
echo ==========================================
pause >nul
