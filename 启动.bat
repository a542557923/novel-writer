@echo off
title Novel Writer
cd /d "%~dp0"

rem Already running? Just open the page. (":3210 " trailing space avoids matching e.g. port 32100)
netstat -ano | findstr /c:":3210 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start
echo [INFO] Novel Writer is already running. Opening http://localhost:3210
start "" http://localhost:3210
goto :eof

:start
if not exist "node_modules" (
  echo [INIT] First run - installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

if not exist "dist\index.html" (
  echo [BUILD] Frontend build missing - building...
  call npm run build
  if errorlevel 1 goto :fail
)

rem Open browser after 2s, giving the server time to boot
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3210"

echo [RUN] Novel Writer starting: http://localhost:3210
echo       Close this window to stop the server.
call npm start
goto :eof

:fail
echo.
echo [ERROR] Startup failed. Make sure Node.js is installed, or run: npm install
pause
