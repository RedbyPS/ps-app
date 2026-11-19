#!/bin/bash
# Unit tests for SafePeek's rules (Sources/SafePeekCore.swift) and the per account rules (Sources/BuildRules.swift,
# V1.58): Tab over 1Password and Signal for everyone except the developer, never for the developer, and the island the same way.
# PS 1.71: and per BUILD (Sources/Profile.swift Profile.allows): the G Squad build on for every account, the developer's own build
# off for every account, for Tab, other hold keys, Secure Input, Esc, combos, the list staying up and the island.
# No window opens, no hotkey is registered, no key is sent. Safe while someone uses the Mac.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
# The real files when they are here (PS_GSQUAD_PROFILE, PS_LAYER_PROFILE to point elsewhere); else the test's stand ins.
P="${PS_GSQUAD_PROFILE:-$HOME/Projects/ps/web/core-root/profiles/gsquad.json}"
L="${PS_LAYER_PROFILE:-$HOME/Projects/ps/web/ps-layer/profile.json}"
cp "$HERE/tests/safepeek-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/SafePeekCore.swift" "$HERE/Sources/BuildRules.swift" \
  "$HERE/Sources/Profile.swift" "$HERE/Sources/OpenKeysCore.swift" "$HERE/Sources/SquadIslandCore.swift" \
  "$HERE/Sources/Protected.swift" "$OUT/main.swift" -o "$OUT/safepeek-test"
cd "$HERE" && "$OUT/safepeek-test" "$P" "$L"
rm -rf "$OUT"
# PS 1.71: the app asks the build's answer (BuildRules.now) at every place the two rules are used.
S="$HERE/Sources"
need() { grep -qF "$2" "$S/$1" && echo "wired:$1:$3=ok" || { echo "wired:$1:$3=FAIL"; exit 1; }; }
need SafePeek.swift 'tabOverProtected: BuildRules.now.tabOverProtected,' inputs
[ "$(grep -cF 'if Protected.front && !BuildRules.now.tabOverProtected { return }' "$S/SafePeek.swift")" = 2 ] && echo "wired:SafePeek.swift:hold-and-combo=ok" || { echo "wired:SafePeek.swift:hold-and-combo=FAIL"; exit 1; }
need main.swift 'tabOverProtected: BuildRules.now.tabOverProtected) {' list-left-up
need main.swift '"overProtected": BuildRules.now.tabOverProtected]' settings
need Island.swift 'IslandRules.show(protectedFront: Protected.front, rules: BuildRules.now)' island
need SquadIsland.swift 'islandOverProtected: BuildRules.now.islandOverProtected)' squad-island
need BigIsland.swift '!BuildRules.now.islandOverProtected { drop() }' big-island
need Owner.swift 'return testAccount != nil ? a : fromProfile(a)' build-decides
