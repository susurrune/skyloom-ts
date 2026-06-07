@echo off
title Skyloom Installer
chcp 65001 >nul

echo.
echo  ✦  Skyloom 一键安装  ✦
echo  ────────────────────────────
echo.

:: ── Check Node.js ──
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  ⚠ 未检测到 Node.js
    echo.
    echo  选择安装方式：
    echo    [1] 自动下载 Node.js （推荐）
    echo    [2] 手动安装后重试
    echo    [3] 退出
    echo.
    set /p choice="  输入数字 (1/2/3): "
    if "!choice!"=="" set choice=1
    if "!choice!"=="1" (
        echo.
        echo  [34m✦[0m 正在下载 Node.js 22 LTS ...
        curl -L -o "%TEMP%\node-install.msi" https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi
        echo  [34m✦[0m 正在安装 Node.js（请按提示确认）...
        msiexec /i "%TEMP%\node-install.msi" /quiet
        echo  [32m✓[0m Node.js 安装完成，请重新运行 setup.bat
    )
    if "!choice!"=="2" (
        echo.
        echo  请访问 https://nodejs.org 下载安装后重试
    )
    pause
    exit /b
)

echo  [32m✓[0m Node.js 已安装
echo.

:: ── Install dependencies ──
echo  [34m✦[0m 安装依赖...
call npm install --no-fund --no-audit
if %ERRORLEVEL% NEQ 0 (
    echo  [31m✗[0m 依赖安装失败
    pause
    exit /b
)
echo  [32m✓[0m 依赖安装完成
echo.

:: ── Build ──
echo  [34m✦[0m 编译 TypeScript...
call npx tsc
if %ERRORLEVEL% NEQ 0 (
    echo  [31m✗[0m 编译失败
    pause
    exit /b
)
echo  [32m✓[0m 编译完成
echo.

:: ── Link global command ──
echo  [34m✦[0m 注册全局命令...
call npm link >nul 2>&1
echo  [32m✓[0m 全局命令已注册
echo.
echo  [32m✅  安装完成![0m
echo.
echo  [34m✦[0m  [2m快速开始：[0m
echo.
echo     sky chat        开始对话
echo     sky web         启动 Web 界面
echo     sky task <目标>  多 Agent 编排
echo     sky help        所有命令
echo.
echo  [34m✦[0m  http://localhost:3000  Web 界面
echo.
pause
