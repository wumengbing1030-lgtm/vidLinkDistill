@echo off
chcp 65001 >nul
setlocal
rem ============ B站视频笔记 · 采集服务一键启动 ============
rem 修改下面这一行为你自己的 Python（需已装 requirements.txt 里的依赖）
if "%PY%"=="" set PY=C:\Users\wumengbing\.workbuddy\binaries\python\envs\default\Scripts\python.exe

cd /d "%~dp0"

echo [1/2] 启动转写服务 127.0.0.1:8766 ...
start "transcribe-8766" /min cmd /c "set HF_ENDPOINT=https://hf-mirror.com&& set PYTHONIOENCODING=utf-8&& "%PY%" transcribe_daemon.py"

echo [2/2] 启动 OCR 服务 127.0.0.1:8767 ...
start "ocr-8767" /min cmd /c "set PYTHONIOENCODING=utf-8&& "%PY%" ocr_daemon.py"

echo.
echo 已启动。转写服务需要 15-25 秒预热（加载 whisper 模型）。
echo 检查：curl http://127.0.0.1:8766/ping  与  curl http://127.0.0.1:8767/ping
echo.
pause
