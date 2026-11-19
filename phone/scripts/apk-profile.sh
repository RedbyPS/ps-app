#!/bin/bash
# The layer profile inside an APK must be exactly the given file (V1.71, used by scripts/release.sh): a private build
# that came out without it would ask the G Squad channel for updates, so that stops the release.
#   scripts/apk-profile.sh <apk> <profile.json>     exit 0 when assets/profile.json is the same file, byte for byte
set -euo pipefail
APK="${1:?usage: scripts/apk-profile.sh <apk> <profile.json>}"
WANT="${2:?usage: scripts/apk-profile.sh <apk> <profile.json>}"
[ -f "$APK" ] || { echo "apk-profile: no APK at $APK"; exit 1; }
[ -f "$WANT" ] || { echo "apk-profile: no profile at $WANT"; exit 1; }
GOT="$(mktemp)"
trap 'rm -f "$GOT"' EXIT
if ! unzip -p "$APK" assets/profile.json > "$GOT" 2>/dev/null || [ ! -s "$GOT" ]; then
  echo "apk-profile: the APK has no assets/profile.json"; exit 1
fi
cmp -s "$GOT" "$WANT" || { echo "apk-profile: the APK's assets/profile.json is not $WANT"; exit 1; }
echo "apk-profile: the APK carries the layer profile ($(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name))' "$GOT"))"
