#!/bin/bash
# Unit tests for the day countdown's island rules (Sources/DayCountdownCore.swift, PS 1.70). Pure values only: no window opens.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/daycount-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/DayCountdownCore.swift" "$OUT/main.swift" -o "$OUT/daycount-test"
"$OUT/daycount-test"
rm -rf "$OUT"
