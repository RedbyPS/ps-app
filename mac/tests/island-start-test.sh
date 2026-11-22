#!/bin/bash
# Unit tests for where the Cake boot animation and the Hatch update scene build the island at a start (PS 1.74,
# Sources/IslandStartCore.swift): every spot (home, top left, top right, the four corners, the edges, the bottom), a
# second screen, the remembered rest and the side the pieces come in from. Pure values only: no window opens, no sound
# plays, PS is never started.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/island-start-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/IslandPlace.swift" "$HERE/Sources/HatchCore.swift" "$HERE/Sources/CakeCore.swift" "$HERE/Sources/IslandStartCore.swift" "$OUT/main.swift" -o "$OUT/island-start-test"
"$OUT/island-start-test"
rm -rf "$OUT"
