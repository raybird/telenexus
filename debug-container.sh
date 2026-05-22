#!/bin/bash
# Debug helper script for container
set -e

echo "=== Container Debug Info ==="
echo "Date: $(date)"
echo "User: $(whoami)"
echo "Workdir: $(pwd)"
echo "Node: $(node -v)"
echo "NPM: $(npm -v)"
echo "Python: $(python3 --version)"

echo -e "\n=== Environment Variables ==="
env | grep -E "NODE_|APP_|DB_|AI_|TELEGRAM_" || true

echo -e "\n=== Network Check ==="
curl -I https://www.google.com 2>/dev/null | head -n 1 || echo "No internet access?"

echo -e "\n=== Storage Check ==="
df -h /app/data

echo -e "\n=== Done ==="
exec "$@"
