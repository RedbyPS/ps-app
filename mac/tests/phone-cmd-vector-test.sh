#!/bin/bash
# Phone (ps-gos CmdKey.kt) signatures verified as the Macs verify them. Regenerate the fixture with
# ps-gos: ./gradlew :app:testDebugUnitTest, then copy app/build/cmd-vector.json to tests/fixtures/phone-cmd-vector.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/phone-cmd-vector-test.swift" "$OUT/main.swift"
swiftc -O "$OUT/main.swift" -o "$OUT/t"
"$OUT/t" "${1:-$HERE/tests/fixtures/phone-cmd-vector.json}"
