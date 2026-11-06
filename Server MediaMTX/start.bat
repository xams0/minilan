@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\start_dashboard.ps1"