@echo off
rem Q5 fake task action: log one run, exit 3.
echo %date% %time% run>>"%~1"
exit /b 3
