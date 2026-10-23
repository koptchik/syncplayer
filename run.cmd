@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org/ and run npm ci.
  exit /b 1
)
node --env-file-if-exists=.env src/server/index.mjs
