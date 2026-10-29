#!/usr/bin/env bash
# Runs the shim behaviour tests in headless Chrome. No dependencies to install.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for candidate in \
  "${CHROME:-}" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(command -v google-chrome || true)" \
  "$(command -v chromium || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then CHROME_BIN="$candidate"; break; fi
done

if [ -z "${CHROME_BIN:-}" ]; then
  echo "No Chrome or Chromium found. Set CHROME=/path/to/chrome" >&2
  exit 1
fi

run_one() {
  "$CHROME_BIN" --headless --disable-gpu --no-sandbox \
    --virtual-time-budget=10000 --dump-dom \
    "file://$HERE/$1" 2>/dev/null |
  python3 -c '
import sys, re, html
match = re.search(r"<pre id=\"results\">(.*?)</pre>", sys.stdin.read(), re.S)
print(html.unescape(match.group(1)) if match else "test page produced no results")
'
}

status=0
for page in shim.test.html amazon.test.html popup.test.html options.test.html; do
  echo "== $page =="
  output="$(run_one "$page")"
  echo "$output"
  echo "$output" | grep -q "^ALL " || status=1
  echo
done

exit $status
