@echo off
setlocal
set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if not exist "%NODE_EXE%" (
  echo Node runtime missing: %NODE_EXE%
  exit /b 2
)
for /f "delims=" %%V in ('"%NODE_EXE%" -v') do set "NODE_VER=%%V"
if not "%NODE_VER%"=="v20.11.1" (
  echo Node runtime mismatch: expected v20.11.1, actual %NODE_VER%
  exit /b 3
)
"%NODE_EXE%" "%~dp0tools\verify-v7.js"
exit /b %ERRORLEVEL%
