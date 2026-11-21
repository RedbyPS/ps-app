#!/bin/bash
# Unit tests for PS's audio queue (Sources/AudioQueueCore.swift, AudioQueue.swift; after the freeze of 21 Nov 2026):
# the page's microphone JSON, the gate that merges reads and logs a hung audio server once, and a fake microphone that
# hangs like the audio server did while the main thread keeps going. No real microphone is read or changed, no sound
# plays. Safe while someone uses the Mac.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
cp "$HERE/tests/audio-queue-test.swift" "$OUT/main.swift"   # top level code must be in main.swift
swiftc -Onone -target arm64-apple-macos13 "$HERE/Sources/AudioQueueCore.swift" "$HERE/Sources/AudioQueue.swift" "$OUT/main.swift" -o "$OUT/audio-queue-test"
"$OUT/audio-queue-test"
