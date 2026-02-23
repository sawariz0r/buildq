#!/usr/bin/env bash
set -euo pipefail

# ─── BuildQ E2E Test ────────────────────────────────────────────────────────
# Spins up server, runner (dry-run), and submits a build.
# Exercises the entire pipeline on a single machine with no real build deps.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT=3456
TOKEN="e2e-test-token-$(date +%s)"
SERVER_URL="http://localhost:$PORT"

STORAGE_DIR=$(mktemp -d)
WORK_DIR=$(mktemp -d)
PROJECT_DIR=$(mktemp -d)
LOG_DIR=$(mktemp -d)

SERVER_PID=""
RUNNER_PID=""

red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

cleanup() {
  dim "Cleaning up..."
  [ -n "$RUNNER_PID" ] && kill "$RUNNER_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  # Give processes time to exit
  sleep 1
  [ -n "$RUNNER_PID" ] && kill -9 "$RUNNER_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null || true
  rm -rf "$STORAGE_DIR" "$WORK_DIR" "$PROJECT_DIR" "$LOG_DIR"
}
trap cleanup EXIT

# ─── 1. Build the project ───────────────────────────────────────────────────
dim "Building project..."
(cd "$REPO_ROOT" && pnpm build > "$LOG_DIR/build.log" 2>&1)
green "Project built"

# ─── 2. Create a dummy Expo project ─────────────────────────────────────────
dim "Creating dummy project..."

cat > "$PROJECT_DIR/package.json" << 'PKGJSON'
{
  "name": "buildq-e2e-test",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {}
}
PKGJSON

cat > "$PROJECT_DIR/app.json" << 'APPJSON'
{
  "expo": {
    "name": "buildq-e2e-test",
    "slug": "buildq-e2e-test",
    "version": "1.0.0",
    "platforms": ["ios", "android"]
  }
}
APPJSON

cat > "$PROJECT_DIR/index.js" << 'INDEXJS'
console.log("BuildQ E2E test project");
INDEXJS

green "Dummy project created at $PROJECT_DIR"

# ─── 3. Start the server ────────────────────────────────────────────────────
dim "Starting server on port $PORT..."

BUILDQ_TOKEN="$TOKEN" \
STORAGE_DIR="$STORAGE_DIR" \
PORT="$PORT" \
node "$REPO_ROOT/packages/server/dist/index.js" \
  > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!

# Wait for health endpoint
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    red "Server process died. Logs:"
    cat "$LOG_DIR/server.log"
    exit 1
  fi
  sleep 0.5
done

if ! curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
  red "Server failed to start within 15s. Logs:"
  cat "$LOG_DIR/server.log"
  exit 1
fi

green "Server started (PID $SERVER_PID)"

# ─── 4. Start the runner (dry-run) ──────────────────────────────────────────
dim "Starting runner in dry-run mode..."

BUILDQ_SERVER="$SERVER_URL" \
BUILDQ_TOKEN="$TOKEN" \
NO_COLOR=1 \
node "$REPO_ROOT/packages/cli/dist/bin.js" \
  runner -p ios --dry-run -w "$WORK_DIR" \
  > "$LOG_DIR/runner.log" 2>&1 &
RUNNER_PID=$!

# Wait for runner registration
for i in $(seq 1 20); do
  if grep -q "Registered with server" "$LOG_DIR/runner.log" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$RUNNER_PID" 2>/dev/null; then
    red "Runner process died. Logs:"
    cat "$LOG_DIR/runner.log"
    exit 1
  fi
  sleep 0.5
done

if ! grep -q "Registered with server" "$LOG_DIR/runner.log" 2>/dev/null; then
  red "Runner failed to register within 10s. Logs:"
  cat "$LOG_DIR/runner.log"
  exit 1
fi

green "Runner started (PID $RUNNER_PID)"

# ─── 5. Submit a build ──────────────────────────────────────────────────────
dim "Submitting build..."

(
  cd "$PROJECT_DIR"
  BUILDQ_SERVER="$SERVER_URL" \
  BUILDQ_TOKEN="$TOKEN" \
  NO_COLOR=1 \
  node "$REPO_ROOT/packages/cli/dist/bin.js" \
    build -p ios \
    > "$LOG_DIR/build-client.log" 2>&1
)
BUILD_EXIT=$?

# ─── 6. Verify results ──────────────────────────────────────────────────────
FAILURES=0

# Check build command exit code
if [ "$BUILD_EXIT" -eq 0 ]; then
  green "PASS: Build command exited with code 0"
else
  red "FAIL: Build command exited with code $BUILD_EXIT"
  FAILURES=$((FAILURES + 1))
fi

# Check artifact was downloaded
if ls "$PROJECT_DIR/builds/"*.ipa 1>/dev/null 2>&1; then
  green "PASS: Artifact downloaded to builds/"
else
  red "FAIL: No artifact found in builds/"
  FAILURES=$((FAILURES + 1))
fi

# Check job status via API
JOB_LIST=$(curl -sf -H "Authorization: Bearer $TOKEN" "$SERVER_URL/api/jobs?status=success" 2>/dev/null || echo '{"jobs":[]}')
SUCCESS_COUNT=$(echo "$JOB_LIST" | grep -o '"status":"success"' | wc -l | tr -d ' ')

if [ "$SUCCESS_COUNT" -ge 1 ]; then
  green "PASS: Job marked as success on server"
else
  red "FAIL: No successful job found on server"
  FAILURES=$((FAILURES + 1))
fi

# ─── 7. Report ───────────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  green "All E2E tests passed"
else
  red "$FAILURES test(s) failed"
  echo ""
  dim "--- Server logs ---"
  cat "$LOG_DIR/server.log"
  echo ""
  dim "--- Runner logs ---"
  cat "$LOG_DIR/runner.log"
  echo ""
  dim "--- Build client logs ---"
  cat "$LOG_DIR/build-client.log"
  exit 1
fi
