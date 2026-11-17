#!/bin/bash
# Unit tests for Second Computer code jobs (Sources/SecondCodeCore.swift, SecondCodeRunner.swift): the sealed body's
# "code" kind, the walls against pushing, secrets kept out, timeouts and cancel. A shell script stands in for `claude`
# and `codex`, temp git repos for the code. Nothing touches the network, the Keychain, the person's own repositories or
# the real PS folder. Safe while someone uses the Mac.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
cp "$HERE/tests/secondcode-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/SecondCodeCore.swift" "$HERE/Sources/SecondCodeRunner.swift" "$OUT/main.swift" -o "$OUT/secondcode-test" 2>&1 | grep -E "error" || true
"$OUT/secondcode-test"
