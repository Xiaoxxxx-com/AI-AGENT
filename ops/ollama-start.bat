@echo off
chcp 65001 >nul
cd /d D:\Ollama

set "OLLAMA_MODELS=D:\Ollama\models"
set "OLLAMA_HOST=127.0.0.1:11434"

echo ============================================
echo  Ollama 0.40.6  ·  模型目录 %OLLAMA_MODELS%
echo  监听 http://127.0.0.1:11434
echo  关闭本窗口即停止服务
echo ============================================
echo.

if not exist "ollama.exe" (
  echo [!] 找不到 D:\Ollama\ollama.exe
  pause
  exit /b 1
)

ollama.exe serve
if errorlevel 1 (
  echo.
  echo [!] 启动失败。常见原因：11434 端口已被占用（任务管理器结束 ollama.exe 后重试）
)
pause
