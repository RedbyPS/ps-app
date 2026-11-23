#!/bin/bash
# Unit tests for the island's progress check-ins and task timers (PS 1.77, Sources/IslandProgressCore.swift): when it buzzes,
# what keeps it from buzzing, the timer, the words and the motion's numbers. Pure values only: no window opens, no sound plays,
# PS is never started.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/island-progress-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/IslandProgressCore.swift" "$OUT/main.swift" -o "$OUT/island-progress-test"
"$OUT/island-progress-test" "$HERE"
rm -rf "$OUT"
