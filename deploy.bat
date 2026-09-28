@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   deploy blog to Cloudflare Pages
echo ========================================
echo.

echo [1/2] building...
call npm run build
if errorlevel 1 (
  echo.
  echo BUILD FAILED - nothing was deployed.
  pause
  exit /b 1
)

echo.
echo [2/2] uploading...
call npx --yes wrangler pages deploy dist --project-name=xx1mc1xx --branch=main --commit-dirty=true

echo.
echo Done. Site: https://xx1mc1xx.pages.dev/
pause
