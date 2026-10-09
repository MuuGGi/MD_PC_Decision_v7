@echo off
setlocal
set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if "%~1"=="" (
  echo Usage: run-v7-audit.cmd ^<V6_AUTOTEST_ENGINE_ROOT^>
  exit /b 2
)
"%NODE_EXE%" "%~dp0src\runtime\main-v7.js" --audit "%~1"
exit /b %ERRORLEVEL%
