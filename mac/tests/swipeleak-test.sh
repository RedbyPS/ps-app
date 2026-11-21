#!/bin/bash
# Unit tests for the PS 1.73 swipe leak rules (Sources/SwipeLeakCore.swift) and source checks on how they are wired
# (Toast.swift, main.swift, PageSwipe.swift, SwipeLeak.swift). No window opens, no event is made or posted. Safe while
# someone uses the Mac.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/swipeleak-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/SwipeLeakCore.swift" "$OUT/main.swift" -o "$OUT/swipeleak-test"
"$OUT/swipeleak-test" "$HERE/Sources"
rm -rf "$OUT"
