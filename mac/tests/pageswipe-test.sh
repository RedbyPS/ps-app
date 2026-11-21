#!/bin/bash
# Unit tests for the trackpad phases the Tab list hears (Sources/PageSwipe.swift, V1.55). No window opens, nothing is
# sent. Safe while someone uses the Mac.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/pageswipe-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/PageSwipe.swift" "$HERE/Sources/SwipeLeak.swift" "$HERE/Sources/SwipeLeakCore.swift" "$OUT/main.swift" -o "$OUT/pageswipe-test"
"$OUT/pageswipe-test"
rm -rf "$OUT"
