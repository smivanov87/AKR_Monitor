#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p downloader/out
javac -d downloader/out downloader/src/AKRCdawebDownloader.java
java -cp downloader/out AKRCdawebDownloader "$@"
