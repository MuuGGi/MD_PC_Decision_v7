@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0\..\.."
set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if not exist "%NODE_EXE%" (
  echo Node20 not found: %NODE_EXE%
  exit /b 1
)
"%NODE_EXE%" "%~dp0run-composite-route-observer.js" %*
exit /b %ERRORLEVEL%
