@echo off
set "PROJECT=C:\Users\ADMIN\WorkBuddy\2026-05-27-task-2"
start "Proxy" /min cmd /c "cd /d %PROJECT%\proxy && node server.js"
explorer "%PROJECT%\index.html" & exit
