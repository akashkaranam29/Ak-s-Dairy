@echo off
cd /d "%~dp0"
start "Ak's Dairy database server" /min python -u server.py
timeout /t 2 /nobreak >nul
start "" http://localhost:8000
