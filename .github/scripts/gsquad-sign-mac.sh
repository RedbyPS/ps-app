#!/bin/bash
# Signs the G Squad Mac build and makes its signed update note (PS V1.58, release.yml, job "sign mac").
#
# Runs with the G Squad signing keys, so it runs only files that a pull request can not change without the developer
# (.github/scripts/protected-check.mjs): this script, mac/release/publish.sh, mac/release/dmg/, mac/tools/pstool.swift,
# mac/ps.entitlements. The app itself was built in another job that never had a key; here it is only signed.
#
#   gsquad-sign-mac.sh <core checkout> <mac-unsigned.tgz> <out folder>
# Env (GitHub secrets of the environment gsquad-release):
#   GSQUAD_MAC_CERT_P12        base64 of the .p12 with the "PS G Squad Signing" certificate and its private key
#   GSQUAD_MAC_CERT_PASSWORD   the .p12 password
#   GSQUAD_UPDATE_KEY          base64 of the Ed25519 update key (the 32 raw bytes pstool keygen writes)
# Writes <out>/ps-release/: ps-update.json, updates/PS-app-*.zip, updates/PS-web-*.zip, PS.dmg.
set -euo pipefail
CORE="$(cd "${1:?core checkout}" && pwd)"; TGZ="${2:?mac-unsigned.tgz}"; OUT="${3:?out folder}"
: "${GSQUAD_MAC_CERT_P12:?secret GSQUAD_MAC_CERT_P12 is not set}"
: "${GSQUAD_MAC_CERT_PASSWORD:?secret GSQUAD_MAC_CERT_PASSWORD is not set}"
: "${GSQUAD_UPDATE_KEY:?secret GSQUAD_UPDATE_KEY is not set}"
WORK="${RUNNER_TEMP:-$(mktemp -d)}/gsquad-mac"
KC="$WORK/gsquad-signing.keychain-db"
KEY="$CORE/mac/signing/update-ed25519.key"
rm -rf "$WORK"; mkdir -p "$WORK/in" "$OUT"
# publish.sh reads "$OUT/ps-update.json" with node require(), which takes a relative path for a package name
# ("Cannot find module 'signed/ps-release/ps-update.json'" in the 1.68 run), so the out folder is made absolute.
OUT="$(cd "$OUT" && pwd)"
OLD_KCS=""
cleanup() {
  # Put the runner's own keychain list back before the throwaway keychain goes.
  [ -n "$OLD_KCS" ] && security list-keychains -d user -s $OLD_KCS 2>/dev/null || true
  security delete-keychain "$KC" 2>/dev/null || true
  rm -f "$KEY" "$WORK/cert.p12"
}
trap cleanup EXIT

tar -xzf "$TGZ" -C "$WORK/in"
APP="$WORK/in/PS.app"; WEB="$WORK/in/dist-ps"
[ -d "$APP" ] && [ -d "$WEB" ] || { echo "STOP: the build has no PS.app or dist-ps"; exit 1; }

# 1. A throwaway keychain with the G Squad certificate, for this run only.
KCPASS="$(openssl rand -hex 24)"
security create-keychain -p "$KCPASS" "$KC"
security set-keychain-settings -lut 3600 "$KC"
security unlock-keychain -p "$KCPASS" "$KC"
printf '%s' "$GSQUAD_MAC_CERT_P12" | base64 --decode > "$WORK/cert.p12"
security import "$WORK/cert.p12" -k "$KC" -P "$GSQUAD_MAC_CERT_PASSWORD" -T /usr/bin/codesign > /dev/null
rm -f "$WORK/cert.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KC" > /dev/null
# codesign finds the identity through the user keychain search list, --keychain alone is not enough on the
# macOS runners ("no identity found" in the 1.67 runs), so the throwaway keychain goes on the list for this run.
OLD_KCS="$(security list-keychains -d user | tr -d '"' | xargs)"
security list-keychains -d user -s "$KC" $OLD_KCS
# Self signed (no Apple team, like PS Local Signing), so it is not "valid" to find-identity -v; it signs all the same.
ID="$(security find-identity -p codesigning "$KC" | sed -n 's/^ *[0-9][0-9]*) \([0-9A-F]\{40\}\) .*/\1/p' | head -1)"
[ -n "$ID" ] || { echo "STOP: no code signing identity in GSQUAD_MAC_CERT_P12"; exit 1; }
echo "signing identity $ID"
# Try the identity on a throwaway copy first, so a signing problem stops here with a clear message.
cp /usr/bin/true "$WORK/sign-check"
codesign --force --keychain "$KC" --sign "$ID" "$WORK/sign-check" || { echo "STOP: codesign can not use identity $ID"; exit 1; }

# 2. Sign inside out, as mac/build.sh does for a signed build (hardened runtime everywhere).
sign() { codesign --force --options runtime --timestamp=none --keychain "$KC" --sign "$ID" "$@"; }
[ -f "$APP/Contents/Resources/PSTranslate" ] && sign --identifier com.cincee.ps.translate "$APP/Contents/Resources/PSTranslate"
[ -f "$APP/Contents/Resources/rebootd" ] && sign --identifier com.cincee.ps.rebootd "$APP/Contents/Resources/rebootd"
if [ -d "$APP/Contents/Library/LoginItems" ]; then
  for helper in "$APP"/Contents/Library/LoginItems/*.app; do
    [ -d "$helper" ] || continue
    hid="$(codesign -dv "$helper" 2>&1 | sed -n 's/^Identifier=//p')"
    sign --identifier "${hid:?no identifier on $helper}" "$helper"
  done
fi
sign --entitlements "$CORE/mac/ps.entitlements" --identifier com.cincee.ps "$APP"
codesign --verify --strict --deep "$APP"
codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|Authority|CodeDirectory)' || true

# 3. The signed update note and its files (mac/release/publish.sh: the same note format every PS reads).
mkdir -p "$(dirname "$KEY")"
( umask 077; printf '%s' "$GSQUAD_UPDATE_KEY" | base64 --decode > "$KEY" )
[ "$(stat -f %z "$KEY")" = 32 ] || { echo "STOP: GSQUAD_UPDATE_KEY is not a 32 byte Ed25519 key"; exit 1; }
NOTES="$(cat "$WORK/in/notes.txt" 2>/dev/null || true)"
HISTORY="$(cat "$WORK/in/history.json" 2>/dev/null || echo '[]')"
PS_RELEASE_OUT="$OUT/ps-release" PS_NOTES="$NOTES" PS_HISTORY="$HISTORY" \
  bash "$CORE/mac/release/publish.sh" app "$WEB" "$APP"
rm -f "$KEY"
[ -f "$OUT/ps-release/ps-update.json" ] || { echo "STOP: publish.sh made no ps-update.json"; exit 1; }
ls -l "$OUT/ps-release" "$OUT/ps-release/updates"
