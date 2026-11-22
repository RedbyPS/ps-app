#!/bin/bash
# Unit tests for saving the pages before PS quits or reloads (Sources/SaveFirstCore.swift, PS 1.74). Pure values only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/savefirst-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/SaveFirstCore.swift" "$OUT/main.swift" -o "$OUT/savefirst-test"
"$OUT/savefirst-test"
rm -rf "$OUT"
