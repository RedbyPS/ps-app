#!/bin/bash
# Unit tests for sending to the main page in order (Sources/InOrderSendCore.swift, PS 1.74). Fake page and clock only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/inordersend-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/InOrderSendCore.swift" "$OUT/main.swift" -o "$OUT/inordersend-test"
"$OUT/inordersend-test"
rm -rf "$OUT"
