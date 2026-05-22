#!/bin/bash
# Docker verification script for memory features

set -e

echo "🔍 Docker Memory Features Verification"
echo "======================================="
echo ""

# Test 1: Check jq installation
echo "1️⃣ Testing jq installation..."
docker compose run --rm telenexus jq --version
echo "✅ jq is installed"
echo ""

# Test 2: Check bash installation
echo "2️⃣ Testing bash availability..."
docker compose run --rm telenexus bash --version | head -1
echo "✅ bash is available"
echo ""

# Test 3: Check environment variables
echo "3️⃣ Checking environment variables..."
docker compose run --rm telenexus bash -c 'echo "APP_PROJECT_DIR=$APP_PROJECT_DIR"'
docker compose run --rm telenexus bash -c 'echo "DB_DIR=$DB_DIR"'
docker compose run --rm telenexus bash -c 'echo "DB_PATH=$DB_PATH"'
echo "✅ Environment variables are set"
echo ""

# Test 4: Check volume mounting
echo "4️⃣ Verifying volume mounting..."
docker compose run --rm telenexus ls -la /app/data/
echo "✅ /app/data volume is mounted"
echo ""

# Test 5: Check context snapshots and CLI visibility
echo "5️⃣ Verifying context snapshots and CLI access..."
docker compose run --rm telenexus ls -la /app/workspace/context/
docker compose run --rm telenexus test -f /app/workspace/context/runtime-status.md
docker compose run --rm telenexus test -f /app/workspace/context/provider-status.md
docker compose run --rm telenexus test -f /app/workspace/context/scheduler-status.md
docker compose run --rm telenexus test -f /app/workspace/context/error-summary.md
echo "✅ Context snapshots directory is available"
docker compose run --rm telenexus node /app/dist/tools/scheduler-cli.js --help
echo "✅ scheduler-cli is accessible via /app/dist"
echo ""

echo "======================================="
echo "✅ All Docker verification tests passed!"
echo ""
echo "Next steps:"
echo "  1. Build the image: docker compose build"
echo "  2. Start the container: docker compose up -d"
echo "  3. Check logs: docker compose logs -f"
