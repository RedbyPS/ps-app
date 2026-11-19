#!/bin/bash
# Unit tests for the Tab blocked card's rules and words (Sources/TabBlockedCore.swift, PS 1.70), the front holder rule
# (Sources/SecureInputCore.swift) and SafePeek's new .secureFront case (Sources/SafePeekCore.swift).
# PS 1.71: and those cases per BUILD (Sources/Profile.swift, Sources/BuildRules.swift): G Squad on, the developer's own build off.
# No window opens, no hotkey is registered, no key is read or sent. Safe while someone uses the Mac.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/tab-blocked-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/TabBlockedCore.swift" "$HERE/Sources/SecureInputCore.swift" \
  "$HERE/Sources/Protected.swift" "$HERE/Sources/SafePeekCore.swift" "$HERE/Sources/BuildRules.swift" \
  "$HERE/Sources/Profile.swift" "$OUT/main.swift" -o "$OUT/tab-blocked-test"
cd "$HERE" && "$OUT/tab-blocked-test"
rm -rf "$OUT"
