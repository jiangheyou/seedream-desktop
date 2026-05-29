@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   === 火山引擎余额同步代理 ===
echo.
node server.js
pause
