#!/bin/bash
# Builds PSMiddleClicker.app, runs the click logic tests first (stops if one fails), signs it with
# The developer's own "PS Local Signing" certificate (the PS signing keychain, no Apple account) so the
# Accessibility permission survives rebuilds, then installs it in /Applications and starts it.
#   ./build.sh          test, build, sign, install, start
#   ./build.sh test     tests only
#   NO_INSTALL=1 ./build.sh   build/PSMiddleClicker.app only
#   ./build.sh helper <dir>   build the PS helper "PS Middle Click.app" into <dir> (PS's build.sh
#                             calls this for PS.app/Contents/Library/LoginItems); signed, not installed
# Never touches /Applications/Middle.app (the separate third party app).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/build/PSMiddleClicker.app"
DEST="/Applications/PSMiddleClicker.app"
# The signing folder: PS_SIGNING_DIR (PS's build.sh passes its own), else ps-mac's next door, else the one next to this
# folder (the public core keeps this helper in mac/middle-click/, beside mac/signing/). Without a signing keychain the
# helper is signed ad hoc, so anyone can build it.
SIGNING="${PS_SIGNING_DIR:-}"
if [ -z "$SIGNING" ]; then
  for d in "$HERE/../mac/signing" "$HERE/../signing"; do [ -d "$d" ] && { SIGNING="$d"; break; }; done
  SIGNING="${SIGNING:-$HERE/../mac/signing}"
fi
mkdir -p "$HERE/build"

swiftc -swift-version 5 -O "$HERE/Sources/ClickMachine.swift" "$HERE/Sources/Recovery.swift" "$HERE/Tests/main.swift" -o "$HERE/build/tests"
"$HERE/build/tests"
[ "${1:-}" = test ] && exit 0

# PS_SIGNING_ID: the certificate's SHA-1 in that keychain, when it is someone else's own certificate.
KC="$SIGNING/ps-signing.keychain-db"; ID="${PS_SIGNING_ID:-C0E302F2CE304D062A50D6EBDAFF97D5F7D4B6E6}"
sign() {   # sign <app> <identifier>: the stable "PS Local Signing" identity, ad hoc only as a fallback
  if [ -f "$KC" ] && [ -f "$SIGNING/.keychain-pass" ]; then
    security unlock-keychain -p "$(cat "$SIGNING/.keychain-pass")" "$KC"
    codesign --force --options runtime --keychain "$KC" --sign "$ID" --identifier "$2" "$1"
  else
    echo "WARNING: signing keychain missing, signing ad hoc (Accessibility will need allowing again)"
    codesign --force --sign - --identifier "$2" "$1"
  fi
  codesign --verify --strict "$1"
}
icons() {  # icons <app>
  local set="$HERE/build/AppIcon.iconset"
  rm -rf "$set"; mkdir -p "$set"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$HERE/icon/icon-1024.png" --out "$set/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2)); sips -z $d $d "$HERE/icon/icon-1024.png" --out "$set/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$1/Contents/Resources/AppIcon.icns"
}

if [ "${1:-}" = helper ]; then
  OUT="${2:?usage: ./build.sh helper <dir>}"
  H="$OUT/PS Middle Click.app"
  rm -rf "$H"; mkdir -p "$H/Contents/MacOS" "$H/Contents/Resources"
  swiftc -swift-version 5 -O -target arm64-apple-macos14 "$HERE"/Sources/*.swift -o "$H/Contents/MacOS/PSMiddleClick"
  cp "$HERE/Info-helper.plist" "$H/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(date -u +%y%m%d%H%M)" "$H/Contents/Info.plist"
  icons "$H"
  sign "$H" com.cincee.ps.middleclick
  echo "Built $H"
  exit 0
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Universal (Apple silicon and Intel), so the download works on any Mac with a Force Touch trackpad.
for arch in arm64 x86_64; do
  swiftc -swift-version 5 -O -target $arch-apple-macos14 "$HERE"/Sources/*.swift -o "$HERE/build/PSMiddleClicker-$arch"
done
lipo -create "$HERE/build/PSMiddleClicker-arm64" "$HERE/build/PSMiddleClicker-x86_64" -output "$APP/Contents/MacOS/PSMiddleClicker"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(date -u +%y%m%d%H%M)" "$APP/Contents/Info.plist"

icons "$APP"
sign "$APP" com.cincee.psmiddleclicker


if [ "${NO_INSTALL:-}" != 1 ]; then
  # The first build was called "Middle Click" (com.cincee.middleclick): quit it and move it to the
  # Trash so only PSMiddleClicker runs. Never /Applications/Middle.app (the third party app).
  OLD="/Applications/Middle Click.app"
  if [ -d "$OLD" ]; then
    osascript -e 'tell application id "com.cincee.middleclick" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do pgrep -qf "$OLD/Contents/MacOS/MiddleClick" || break; sleep 0.2; done
    mv "$OLD" "$HOME/.Trash/Middle Click-$(date +%Y%m%d-%H%M%S).app"
  fi
  # Quit only our own running copy, politely, by its bundle id; then wait until it is gone.
  osascript -e 'tell application id "com.cincee.psmiddleclicker" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do pgrep -qf "$DEST/Contents/MacOS/PSMiddleClicker" || break; sleep 0.2; done
  if [ -d "$DEST" ]; then mv "$DEST" "$HOME/.Trash/PSMiddleClicker-$(date +%Y%m%d-%H%M%S).app"; fi
  ditto "$APP" "$DEST"
  open -g "$DEST"
  echo "Installed $DEST"
fi
