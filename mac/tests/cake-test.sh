#!/bin/bash
# Unit tests for the Cake boot animation and logo reveal rules (Sources/CakeCore.swift). Pure values only: no window
# opens, no sound plays, PS is never started.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/cake-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/HatchCore.swift" "$HERE/Sources/CakeCore.swift" "$OUT/main.swift" -o "$OUT/cake-test"
"$OUT/cake-test"
rm -rf "$OUT"
