@echo off
rem Q1/Q2 long-lived fake managed process (about 20 minutes).
ping -n 1200 127.0.0.1 >nul
exit /b %ERRORLEVEL%
