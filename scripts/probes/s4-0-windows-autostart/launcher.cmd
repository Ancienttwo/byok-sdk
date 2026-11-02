@echo off
rem #1329 candidate S4-3 launcher loop.
rem   launcher.cmd <stop-marker> <child.cmd> <launcher-log>
rem Before each run: a present <name>.stopped marker ends the loop.
rem Child exit 0 ends the loop; any other exit waits 10s and reruns.
setlocal
set "MARKER=%~1"
set "CHILD=%~2"
set "LOG=%~3"
:run
if exist "%MARKER%" (
  echo %date% %time% marker-present end>>"%LOG%"
  exit /b 0
)
echo %date% %time% start>>"%LOG%"
call "%CHILD%"
set "RC=%ERRORLEVEL%"
echo %date% %time% child-exit %RC%>>"%LOG%"
if "%RC%"=="0" (
  echo %date% %time% clean-exit end>>"%LOG%"
  exit /b 0
)
rem timeout.exe refuses a redirected stdin; ping waits without a console.
ping -n 11 127.0.0.1 >nul
goto run
