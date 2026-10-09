@echo off
setlocal
cd /d "%~dp0\..\.."
set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if not exist "%NODE_EXE%" (
  echo Node20 not found: %NODE_EXE%
  exit /b 1
)
"%NODE_EXE%" "%~dp0run-m13-allure-of-darkness.js" --resume-banish-prompt
exit /b %ERRORLEVEL%
