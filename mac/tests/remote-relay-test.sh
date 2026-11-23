#!/bin/bash
# Remote screen from anywhere (PS 1.77): the relay's bytes and rules, and a whole relayed session end to end on this Mac
# through a STAND-IN relay on 127.0.0.1 (never Cloudflare). No screen capture, no input posted, no window, no sound, no key.
# See tests/remote-relay-test.swift.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/remote-relay-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -O -target arm64-apple-macos13 "$OUT/main.swift" "$HERE/Sources/RemoteScreenCore.swift" "$HERE/Sources/RemoteScreenCodec.swift" \
  "$HERE/Sources/RemoteScreenNet.swift" "$HERE/Sources/RemoteScreenPipe.swift" "$HERE/Sources/RemoteScreenRelayCore.swift" "$HERE/Sources/RemoteScreenRelay.swift" \
  "$HERE/Sources/SecondCrypto.swift" "$HERE/Sources/SecondJobs.swift" "$HERE/Sources/KeychainQuiet.swift" "$HERE/Sources/SafeSignal.swift" -o "$OUT/remote-relay-test"
"$OUT/remote-relay-test"
rm -rf "$OUT"
