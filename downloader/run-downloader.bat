@echo off
cd /d "%~dp0.."
if not exist downloader\out mkdir downloader\out
javac -d downloader\out downloader\src\AKRCdawebDownloader.java
if errorlevel 1 exit /b 1
java -cp downloader\out AKRCdawebDownloader %*
