@echo off
REM Cleanup script for za6zo-websocket container (Windows)

echo Stopping and removing existing za6zo-websocket container...

REM Stop the container if it's running
docker stop za6zo-websocket 2>nul

REM Remove the container
docker rm za6zo-websocket 2>nul

REM Remove the image (optional - uncomment if you want to rebuild from scratch)
REM docker rmi za6zo-websocket:latest 2>nul

echo Cleanup complete!
echo You can now run: docker-compose up -d --build

pause
