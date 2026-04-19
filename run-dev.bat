@echo off
title WalkieTalkAI (Dev)
cd /d "%~dp0"
echo Starting WalkieTalkAI from source...
npm start
if errorlevel 1 (
    echo.
    echo Failed to start. Make sure Node.js is installed and run "npm install" first.
    pause
)
