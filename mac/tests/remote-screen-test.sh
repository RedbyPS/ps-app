#!/bin/bash
# Unit and loopback tests for the Second Computer remote screen engine (PS 1.69). No screen capture, no input posted, no window,
# no sound; the network is 127.0.0.1 only. See tests/remote-screen-test.swift.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cp "$HERE/tests/remote-screen-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -O -target arm64-apple-macos13 "$OUT/main.swift" "$HERE/Sources/RemoteScreenCore.swift" "$HERE/Sources/RemoteScreenCodec.swift" \
  "$HERE/Sources/RemoteScreenNet.swift" "$HERE/Sources/RemoteScreenPipe.swift" "$HERE/Sources/RemoteScreenRelayCore.swift" "$HERE/Sources/RemoteScreenRelay.swift" "$HERE/Sources/SecondCrypto.swift" "$HERE/Sources/SecondJobs.swift" \
  "$HERE/Sources/KeychainQuiet.swift" "$HERE/Sources/SafeSignal.swift" -o "$OUT/remote-screen-test"
"$OUT/remote-screen-test"
rm -rf "$OUT"
