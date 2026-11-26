@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File Allow-Aks-Dairy-WiFi.ps1'"
