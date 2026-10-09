@echo off
setlocal
set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if not exist "%NODE_EXE%" (
  echo V7 Node 20.11.1 runtime missing.
  exit /b 2
)
"%NODE_EXE%" "%~dp0autotest\runner.js" %*
exit /b %ERRORLEVEL%
