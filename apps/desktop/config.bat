@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PY=D:\Python\Python3.14\python.exe"
if not exist "%PY%" (
  where py >nul 2>nul
  if errorlevel 1 (
    echo [!] 找不到 Python
    pause
    exit /b 1
  )
  set "PY=py -3"
)

"%PY%" configurator.py
if errorlevel 1 pause
