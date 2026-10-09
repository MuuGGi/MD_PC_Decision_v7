@echo off
setlocal EnableExtensions
cd /d "%~dp0..\.."

set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if not exist "%NODE_EXE%" (
  echo [V6] ERROR: required Node executable not found:
  echo %NODE_EXE%
  exit /b 1
)

for /f "delims=" %%i in ('"%NODE_EXE%" -v') do set "NODEVER=%%i"
if not "%NODEVER%"=="v20.11.1" (
  echo Node runtime: %NODEVER% FAIL - expected v20.11.1
  exit /b 1
)

echo Node runtime: %NODEVER% PASS
"%NODE_EXE%" "%CD%\tools\audit-v6-storage-assets.js" %*
exit /b %ERRORLEVEL%
