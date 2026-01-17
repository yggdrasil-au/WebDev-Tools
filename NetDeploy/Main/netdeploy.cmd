@echo off
setlocal

set "EXE=%~dp0dist\NetDeploy.exe"

if not exist "%EXE%" (
    echo [netdeploy] ERROR: executable not found at "%EXE%"
    echo [netdeploy] Please run 'pnpm build' in this directory.
    exit /b 1
)

"%EXE%" %*
