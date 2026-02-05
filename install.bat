@echo off
setlocal enabledelayedexpansion

:: ── DoctorClaw Installer (Windows) ──────────────────────────────────────────
:: Installs Node.js if not found, runs npm install, and starts DoctorClaw.
:: ─────────────────────────────────────────────────────────────────────────────

title DoctorClaw Installer
echo.
echo   --------------------------------------------------------
echo     DoctorClaw Installer
echo   --------------------------------------------------------
echo.

set "SCRIPT_DIR=%~dp0"
set "REQUIRED_NODE_MAJOR=18"

:: ── Check Node.js ──────────────────────────────────────────────────────────

echo   Checking for Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   [!] Node.js not found.
    goto :install_node_prompt
)

:: Check version
for /f "tokens=1 delims=v" %%a in ('node -v') do set "NODE_VER=%%a"
for /f "tokens=1 delims=." %%a in ("%NODE_VER%") do set "NODE_MAJOR=%%a"

if %NODE_MAJOR% geq %REQUIRED_NODE_MAJOR% (
    echo   [OK] Node.js v%NODE_VER% found
    goto :check_deps
) else (
    echo   [!] Node.js v%NODE_VER% found but v%REQUIRED_NODE_MAJOR%+ is required.
    goto :install_node_prompt
)

:install_node_prompt
echo.
set /p "INSTALL_NODE=  Install Node.js now? [Y/n] "
if /i "%INSTALL_NODE%"=="" set "INSTALL_NODE=Y"
if /i "%INSTALL_NODE%"=="n" (
    echo   [X] Node.js v%REQUIRED_NODE_MAJOR%+ is required.
    echo       Download from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: ── Install Node.js ────────────────────────────────────────────────────────

echo.
echo   Downloading Node.js LTS installer...

:: Detect architecture
set "ARCH=x64"
if "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"

set "NODE_URL=https://nodejs.org/dist/v20.18.0/node-v20.18.0-%ARCH%.msi"
set "NODE_MSI=%TEMP%\node-install.msi"

echo   URL: %NODE_URL%

:: Try PowerShell download
powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_MSI%' }" 2>nul
if %errorlevel% neq 0 (
    :: Fallback to curl
    curl -fSL "%NODE_URL%" -o "%NODE_MSI%" 2>nul
    if %errorlevel% neq 0 (
        echo   [X] Failed to download Node.js.
        echo       Please install manually from https://nodejs.org
        pause
        exit /b 1
    )
)

echo   Installing Node.js (this may request admin permission)...
echo.

:: Try silent install first, fall back to interactive
msiexec /i "%NODE_MSI%" /qn /norestart 2>nul
if %errorlevel% neq 0 (
    echo   Silent install failed, launching interactive installer...
    msiexec /i "%NODE_MSI%"
)

del "%NODE_MSI%" 2>nul

:: Refresh PATH
set "PATH=%ProgramFiles%\nodejs;%PATH%"

:: Verify
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   [X] Node.js installation may require a restart.
    echo       Please close this window, restart your terminal, and run install.bat again.
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=v" %%a in ('node -v') do set "NODE_VER=%%a"
echo   [OK] Node.js v%NODE_VER% installed successfully
echo.

:: ── Install dependencies ───────────────────────────────────────────────────

:check_deps
cd /d "%SCRIPT_DIR%"

if not exist "package.json" (
    echo   [X] package.json not found in %SCRIPT_DIR%
    echo       Make sure install.bat is in the DoctorClaw folder.
    pause
    exit /b 1
)

if exist "node_modules\.package-lock.json" (
    echo   [OK] Dependencies already installed
) else (
    echo   Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo   [X] npm install failed
        pause
        exit /b 1
    )
    echo   [OK] Dependencies installed
)

:: ── Check Ollama ───────────────────────────────────────────────────────────

where ollama >nul 2>&1
if %errorlevel% equ 0 (
    echo   [OK] Ollama found
) else (
    echo.
    echo   [!] Ollama not installed. DoctorClaw needs Ollama to run.
    echo       Install from: https://ollama.com
    echo       Then run:     ollama pull glm-4.7:cloud
    echo.
)

:: ── Start ──────────────────────────────────────────────────────────────────

echo.
echo   --------------------------------------------------------
echo     Install complete! Starting DoctorClaw...
echo   --------------------------------------------------------
echo.

cd /d "%SCRIPT_DIR%"
if exist "doctorclaw.config.json" (
    node server.mjs
) else (
    echo   Running first-time setup...
    echo.
    node server.mjs -i
)

pause
