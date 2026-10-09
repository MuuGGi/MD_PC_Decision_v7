@echo off
setlocal
set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if "%~1"=="" (
  "%NODE_EXE%" "%~dp0src\runtime\main-v7.js" --audit
) else (
  "%NODE_EXE%" "%~dp0src\runtime\main-v7.js" --audit "%~1"
)
exit /b %ERRORLEVEL%
