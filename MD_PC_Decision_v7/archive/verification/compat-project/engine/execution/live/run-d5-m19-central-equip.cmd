@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\..\.."
set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if not exist "%NODE_EXE%" (
  echo Node20 not found: %NODE_EXE%
  exit /b 1
)
"%NODE_EXE%" "%~dp0run-d5-m19-central-equip.js" %*
exit /b %ERRORLEVEL%
