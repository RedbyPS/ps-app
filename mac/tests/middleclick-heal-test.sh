#!/bin/bash
# Offline test of the middle click helper healing (Sources/MiddleClickHealCore.swift, 16 Nov 2026): an older helper
# still running after a PS update is found, and a helper stuck with its taps off is restarted once, never in a loop.
# Plus the wiring in MiddleClick.swift read from the source. Asks macOS nothing, starts no helper, opens no window.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${TMPDIR:-/tmp}/ps-middleclick-heal"; mkdir -p "$OUT"
cp "$HERE/tests/middleclick-heal-test.swift" "$OUT/main.swift"
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/MiddleClickHealCore.swift" "$OUT/main.swift" -o "$OUT/test"
PS_MAC_DIR="$HERE" "$OUT/test"
