#!/usr/bin/env bash
# render-ui-mock.sh — regenerate docs/images/skills-page.png from the real stylesheet
# (macOS / Linux twin of tools/render-ui-mock.ps1).
#
# The README's design image is generated, never hand-drawn: this script extracts the
# shipped stylesheet out of lib/client.js and renders tools/ui-mock/mock.html with
# headless Chromium. Re-run it whenever the page's CSS or markup changes.
#
# Usage:
#   bash tools/render-ui-mock.sh
#   CHROME="/Applications/Chromium.app/Contents/MacOS/Chromium" bash tools/render-ui-mock.sh
set -euo pipefail

SCRIPT_DIR="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"
MOCK="$REPO/tools/ui-mock/mock.html"
OUT="$REPO/docs/images/skills-page.png"
WIDTH="${WIDTH:-1180}"
HEIGHT="${HEIGHT:-2200}"
SCALE="${SCALE:-2}"

[ -f "$MOCK" ] || { echo "mock markup not found: $MOCK" >&2; exit 1; }

# First browser that exists wins; override with CHROME=<path>.
find_browser() {
	if [ -n "${CHROME:-}" ]; then echo "$CHROME"; return; fi
	for candidate in \
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
		"/Applications/Chromium.app/Contents/MacOS/Chromium" \
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
		"$(command -v google-chrome || true)" \
		"$(command -v chromium || true)" \
		"$(command -v chromium-browser || true)"; do
		[ -n "$candidate" ] && [ -x "$candidate" ] && { echo "$candidate"; return; }
	done
}

BROWSER="$(find_browser)"
[ -n "$BROWSER" ] || { echo "no Chromium browser found; pass CHROME=<path>" >&2; exit 1; }

echo "[1/3] Extracting the shipped stylesheet from lib/client.js ..."
node "$REPO/tools/ui-mock/extract-css.mjs"

echo "[2/3] Rendering the mockup with headless Chromium ..."
mkdir -p "$(dirname "$OUT")" "$REPO/tools/ui-mock/.chrome-profile"
"$BROWSER" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor="$SCALE" \
	--user-data-dir="$REPO/tools/ui-mock/.chrome-profile" --virtual-time-budget=6000 \
	--window-size="$WIDTH,$HEIGHT" --screenshot="$OUT" "file://$MOCK" >/dev/null 2>&1 || true
sleep 1

echo "[3/3] Result"
if [ -f "$OUT" ]; then
	echo "  $OUT ($(du -h "$OUT" | cut -f1))"
	echo "  Commit the regenerated image together with the UI change."
else
	echo "  rendering produced no file" >&2
	exit 1
fi
