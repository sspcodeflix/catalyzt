#!/usr/bin/env bash
# Browser checks against a throwaway server: a fresh database, no model key, the real workspace.
#   cd app && ./e2e/run.sh            # needs: pip install playwright && playwright install chromium
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${E2E_PORT:-5199}"
TMP="$(mktemp -d)"
DEEPSEEK_API_KEY= HORIZON_DB_PATH="$TMP/e2e.db" HORIZON_FILES_DIR="$TMP/files" ./node_modules/.bin/vite --port "$PORT" --strictPort --host 127.0.0.1 > "$TMP/vite.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
curl -s --retry 40 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/api/health" > /dev/null
status=0
for f in e2e/chat_persistence.py e2e/drawer_focus.py e2e/attachments.py e2e/context_huddle.py e2e/review_items.py e2e/branding.py e2e/recovery.py e2e/a11y.py e2e/chat_scroll.py e2e/panel_scroll.py; do
  echo "== $f"
  E2E_BASE="http://127.0.0.1:$PORT" python3 "$f" || status=1
done
exit $status
