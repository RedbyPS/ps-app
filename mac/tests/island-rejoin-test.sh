#!/bin/bash
# Unit tests for the island's every desktop watchdog (Sources/IslandRejoinCore.swift, after PS 1.71): when the island's
# window is missing from the desktop in front it is put back once, then made a new window, never in a loop, with a
# few lines in ps.log at most. Pure values only, no window opens, no sound plays. Safe while someone uses the Mac.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/island-rejoin-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/IslandRejoinCore.swift" "$OUT/main.swift" -o "$OUT/island-rejoin-test"
"$OUT/island-rejoin-test"
rm -rf "$OUT"
