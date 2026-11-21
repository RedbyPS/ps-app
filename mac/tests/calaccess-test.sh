#!/bin/bash
# Unit tests for what PS does with macOS's Calendar access answer (Sources/CalAccessCore.swift). Temp folder only, no window, no EventKit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/calaccess-test.swift" "$OUT/main.swift"
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/CalAccessCore.swift" "$OUT/main.swift" -o "$OUT/calaccess-test"
"$OUT/calaccess-test"
rm -rf "$OUT"
