#!/bin/bash
# Cleanup script for za6zo-websocket container

echo "Stopping and removing existing za6zo-websocket container..."

# Stop the container if it's running
docker stop za6zo-websocket 2>/dev/null || true

# Remove the container
docker rm za6zo-websocket 2>/dev/null || true

# Remove the image (optional - uncomment if you want to rebuild from scratch)
# docker rmi za6zo-websocket:latest 2>/dev/null || true

echo "Cleanup complete!"
echo "You can now run: docker-compose up -d --build"
