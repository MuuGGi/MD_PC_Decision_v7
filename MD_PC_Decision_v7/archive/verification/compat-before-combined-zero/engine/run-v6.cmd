@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if not exist "%NODE_EXE%" (
  echo [V6] ERROR: required Node executable not found:
  echo %NODE_EXE%
  exit /b 1
)

"%NODE_EXE%" -e "if (process.versions.node !== '20.11.1') { console.error('Node runtime mismatch. Expected 20.11.1, actual ' + process.versions.node); process.exit(2); }"
if errorlevel 1 exit /b 1
echo Node runtime: v20.11.1 PASS

"%NODE_EXE%" "%~dp0runtime\main-v6.js" %*
exit /b %errorlevel%
