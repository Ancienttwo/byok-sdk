@echo off
rem Fake managed process for Q3; behavior comes from PROBE_* variables.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0seqchild.ps1"
exit /b %ERRORLEVEL%
