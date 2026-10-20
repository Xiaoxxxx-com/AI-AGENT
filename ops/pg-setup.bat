@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo ============================================
echo  初始化便携版 PostgreSQL（companion）
echo  目录: %CD%
echo  注意: 不要用「以管理员身份运行」
echo ============================================
echo.

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [!] 找不到 pnpm，请先在终端里执行 corepack enable pnpm
  pause
  exit /b 1
)

call pnpm pg:setup
if errorlevel 1 (
  echo.
  echo [!] 初始化失败。把上面的输出整段发给我，我来判断是权限、杀软还是端口占用。
) else (
  echo.
  echo [OK] 数据库已就绪，接下来可以执行:
  echo      pnpm db:migrate
  echo      pnpm db:seed
)
echo.
pause
