@echo off
setlocal

rem Start dsh-coordinator from this repository directory.
rem The port owner cleanup prevents an old Coordinator instance from keeping
rem the browser UI and dsh-node connected to different server processes.

cd /d "%~dp0"
set "DSH_PORT=39472"

where node >nul 2>&1
if errorlevel 1 (
  echo [dsh-coordinator] node was not found in PATH.
  exit /b 1
)

if not exist "lib\cli.js" (
  echo [dsh-coordinator] lib\cli.js was not found.
  echo Run: pnpm --config.verify-deps-before-run=false --config.confirmModulesPurge=false run build
  exit /b 1
)

echo [dsh-coordinator] stopping old Node process(es) on port %DSH_PORT%...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%DSH_PORT% .*LISTENING"') do (
  tasklist /FI "PID eq %%P" /FI "IMAGENAME eq node.exe" | findstr /I /C:"node.exe" >nul
  if not errorlevel 1 (
    echo   stopping node process %%P
    taskkill /F /PID %%P >nul 2>&1
  )
)

powershell.exe -NoLogo -NoProfile -Command "Start-Sleep -Milliseconds 500"

set "DSH_PORT_IN_USE="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%DSH_PORT% .*LISTENING"') do (
  set "DSH_PORT_IN_USE=%%P"
  echo [dsh-coordinator] port %DSH_PORT% is still in use by PID %%P.
)
if defined DSH_PORT_IN_USE (
  echo [dsh-coordinator] port %DSH_PORT% is still in use. Close the owning process and retry.
  exit /b 1
)

echo [dsh-coordinator] starting on 0.0.0.0:%DSH_PORT%...
node lib\cli.js --host 0.0.0.0 --port %DSH_PORT% --allow-insecure-bind

exit /b %errorlevel%
