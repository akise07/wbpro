@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

title WorkBuddy + wbpro

rem ---- locate node ----
set "NODE="
where node >nul 2>&1 && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
    echo.
    echo [ERROR] Node.js not found ^(need v20.10+^).
    echo         Install from https://nodejs.org/en/download then run this again.
    echo.
    pause
    exit /b 1
)

rem ---- step 1: check plugins + install hooks ----
rem Plugins are read straight from .\plugins_pro - nothing is copied into
rem %USERPROFILE%\.workbuddy\plugins_pro any more. This step only lists them
rem and reinstalls the hooks so they point at this folder's absolute paths.
echo [1/2] Checking plugins and installing hooks ...
"%NODE%" bin\wbpro.mjs demo
if errorlevel 1 (
    echo.
    echo [ERROR] Plugin check failed. Check the message above.
    pause
    exit /b 1
)

echo.
rem ---- step 2: launch or restart WorkBuddy with the debug port, then inject ----
echo [2/2] Starting WorkBuddy with plugins ...
echo       Keep this window open while you use WorkBuddy.
echo.
"%NODE%" bin\wbpro.mjs up --restart --yes %*
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
    echo [wbpro exited with code %CODE%]
    echo If WorkBuddy was restarted in background, run:  node bin\wbpro.mjs logs
) else (
    echo wbpro finished.
)
echo.
pause
