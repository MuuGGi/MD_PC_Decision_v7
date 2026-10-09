@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=D:\01_Software\AutoX_JS\01 Node_JS\node.exe"
if exist "%NODE_EXE%" goto run
set "NODE_EXE=node"

:run
"%NODE_EXE%" run-m18-foolish-burial.js %*
exit /b %ERRORLEVEL%
