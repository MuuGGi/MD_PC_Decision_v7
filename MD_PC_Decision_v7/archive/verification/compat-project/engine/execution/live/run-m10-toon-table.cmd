@echo off
setlocal
cd /d "%~dp0\..\.."

set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" ".\execution\live\run-m10-toon-table.js"
exit /b %ERRORLEVEL%
