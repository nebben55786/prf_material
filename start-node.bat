@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :missing_node

where npm >nul 2>nul
if errorlevel 1 goto :missing_npm

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo Created .env from .env.example
  )
)

echo Installing dependencies if needed...
call npm install
if errorlevel 1 goto :fail

echo Initializing Postgres schema...
call npm run db:init
if errorlevel 1 goto :fail

if /I "%1"=="--migrate" (
  echo Migrating SQLite data into Postgres...
  call npm run db:migrate-sqlite
  if errorlevel 1 goto :fail
)

echo Starting Node app at http://127.0.0.1:3000
call npm run dev
goto :eof

:missing_node
echo.
echo Node.js is not installed or not on PATH.
echo Install Node.js 20+ from https://nodejs.org/
echo Then rerun start-node.bat
pause
exit /b 1

:missing_npm
echo.
echo npm is not installed or not on PATH.
echo Reinstall Node.js from https://nodejs.org/ and ensure npm is included.
echo Then rerun start-node.bat
pause
exit /b 1

:fail
echo.
echo Startup failed. Check Node.js, PostgreSQL, and DATABASE_URL in .env.
pause
exit /b 1
