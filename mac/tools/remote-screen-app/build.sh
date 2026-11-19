#!/bin/bash
# Builds "Remote Screen.app", the remote screen's own Dock app (tools/remote-screen-app/main.swift), into the folder given
# (build.sh puts it in PS.app/Contents/Resources). Unsigned here (the linker's own ad hoc signature): build.sh signs it with
# PS's identity as com.cincee.ps.screen, the same way as the translator helper. PS copies it to ~/Applications on the
# person's click (Sources/RemoteScreenDock.swift).
#   bash tools/remote-screen-app/build.sh <folder>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$1/Remote Screen.app"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
swiftc -O -target arm64-apple-macos13 "$HERE/main.swift" -o "$OUT/Contents/MacOS/RemoteScreen"
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.cincee.ps.screen</string>
  <key>CFBundleName</key><string>Remote Screen</string>
  <key>CFBundleDisplayName</key><string>Remote Screen</string>
  <key>CFBundleExecutable</key><string>RemoteScreen</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
SET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$SET"
ICON="$HERE/../../icon/remote-screen-1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$ICON" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$OUT/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$SET")"
echo "Built Remote Screen.app"
