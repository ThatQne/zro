@echo off
setlocal
set "LOG=%~dp0publish.log"

echo zro publish - starting %date% %time% > "%LOG%"
echo running: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" >> "%LOG%"
echo. >> "%LOG%"

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

echo. >> "%LOG%"
echo exit code: %RC% >> "%LOG%"

echo.
echo ==================================================================
echo  zro publish exited (code %RC%) — full output below and in:
echo  %LOG%
echo ==================================================================
type "%LOG%"
echo.
echo Press any key to close this window . . .
pause >nul
