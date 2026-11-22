#!/bin/bash
# Unit tests for what the closed Dynamic Island shows (PS 1.74, Sources/IslandCloseCore.swift): only the task when closed,
# the rest on hover. Pure values only: no window opens, no sound plays, PS is never started.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/island-close-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/IslandCloseCore.swift" "$OUT/main.swift" -o "$OUT/island-close-test"
"$OUT/island-close-test" "$HERE"
rm -rf "$OUT"
