#!/bin/bash
# Unit tests for the Hatch scene's rules (Sources/HatchCore.swift, PS 1.67). Pure values only: no window opens, no sound plays.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/hatch-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/HatchCore.swift" "$OUT/main.swift" -o "$OUT/hatch-test"
"$OUT/hatch-test"
rm -rf "$OUT"
