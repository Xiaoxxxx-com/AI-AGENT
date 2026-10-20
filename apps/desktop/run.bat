@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PY=D:\Python\Python3.14\python.exe"
if not exist "%PY%" (
  where py >nul 2>nul
  if errorlevel 1 (
    echo [!] 找不到 Python，请先安装或修改本脚本里的 PY 路径
    pause
    exit /b 1
  )
  set "PY=py -3"
)

"%PY%" -c "import PySide6" 2>nul
if errorlevel 1 (
  echo [!] 当前 Python 没有 PySide6，正在安装...
  "%PY%" -m pip install PySide6
)

"%PY%" main.py
if errorlevel 1 pause
