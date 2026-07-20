#!/usr/bin/env bash
# DataGlow build script
# Bundles src/ files into canvas/index.html for deployment.
#
# Usage:
#   ./build.sh             — full rebuild
#   ./build.sh --check     — syntax check only, no file write
#
# Source structure:
#   src/
#   ├── css/main.css         — all styles (edit this for CSS changes)
#   ├── index.html           — HTML shell (edit this for markup changes)
#   └── js/
#       ├── bundle.js        — full JS bundle (inner IIFE content, no wrapper)
#       │                      This is the authoritative JS source.
#       │                      Individual module files in subdirs are for
#       │                      reference/documentation only.
#       ├── main.js          — module manifest (@@INCLUDE directives)
#       ├── core/            — grid, sql, chart, dashboard, nl-engine
#       ├── ingestion/       — drop-zone, parsers, OCR
#       ├── features/        — mirror, replay, browser-llm
#       ├── panels/          — analyze-tab panels
#       └── data/            — sample datasets

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/src"
OUT="$ROOT/canvas/index.html"
TMP="$ROOT/.build_tmp"

CHECK_ONLY=0
if [ "$1" = "--check" ]; then CHECK_ONLY=1; fi

echo "Building DataGlow..."

# ── 1. Validate inputs ────────────────────────────────────────────────────
for f in "$SRC/css/main.css" "$SRC/index.html" "$SRC/js/bundle.js"; do
  [ -f "$f" ] || { echo "Error: $f not found"; exit 1; }
done

# ── 2. Assemble the inner JS (outer IIFE wrapper added here) ──────────────
{
  echo "(function () {"
  echo "  'use strict';"
  echo ""
  echo "  /* ============================================================"
  echo "     INLINED PURE-LOGIC MODULES (zero-build-step compatibility)"
  echo "     Built by build.sh - do not edit canvas/index.html directly."
  echo "     Edit src/ files and run ./build.sh to rebuild."
  echo "     ============================================================ */"
  cat "$SRC/js/bundle.js"
  echo ""
  echo "})();"
} > "$TMP.js"

JS_CHARS=$(wc -c < "$TMP.js")
echo "  JS: $JS_CHARS chars"

# ── 3. Syntax check ───────────────────────────────────────────────────────
node --check "$TMP.js" 2>&1
if [ $? -ne 0 ]; then
  echo "  JS syntax ERROR — aborting"
  rm -f "$TMP.js" "$TMP.css"
  exit 1
fi
echo "  JS syntax: OK"

if [ $CHECK_ONLY -eq 1 ]; then
  rm -f "$TMP.js"
  echo "Syntax check passed."
  exit 0
fi

# ── 4. CSS ────────────────────────────────────────────────────────────────
cp "$SRC/css/main.css" "$TMP.css"
CSS_CHARS=$(wc -c < "$TMP.css")
echo "  CSS: $CSS_CHARS chars"

# ── 5. Assemble final index.html ─────────────────────────────────────────
echo "  Assembling index.html..."
{
  while IFS= read -r line; do
    if [[ "$line" == *'<link rel="stylesheet" href="../src/css/main.css">'* ]]; then
      echo "  <style>"
      cat "$TMP.css"
      echo "  </style>"
    elif [[ "$line" == *'<script src="../src/js/main.js">'* ]]; then
      echo "<script>"
      cat "$TMP.js"
      echo "</script>"
    else
      echo "$line"
    fi
  done < "$SRC/index.html"
} > "$OUT"

# ── 6. Cleanup ────────────────────────────────────────────────────────────
rm -f "$TMP.js" "$TMP.css"

TOTAL=$(wc -c < "$OUT")
echo ""
echo "Build complete: canvas/index.html ($TOTAL chars)"
