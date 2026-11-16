#!/bin/bash
# Builds PS.app from the SAME web code as the website (~/Projects/ps/web, --mode ps),
# installs it in /Applications and installs the web files PS reads.
# Signed with the developer's own "PS Local Signing" certificate (signing/, no Apple Developer account), so
# the Accessibility permission survives rebuilds. A running PS installs the new build itself and
# hands over its sign in; each new build still gets one Little Snitch prompt.
# NO_INSTALL=1 only builds build/PS.app (self test copies). PS_BUILD=<n> sets the build number.
# PS_APP_OUT=<folder>/PS.app builds there instead (a staging build; implies NO_INSTALL=1).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$(cd "${PS_WEB_DIR:-$HERE/../web}" && pwd)"   # PS_WEB_DIR: a clean checkout (staging builds)
APP="${PS_APP_OUT:-$HERE/build/PS.app}"
[ -n "${PS_APP_OUT:-}" ] && NO_INSTALL=1
# PS_SIGNING_DIR: the signing folder of the main checkout, read where it is (a worktree has none; never copy it).
SIGN="${PS_SIGNING_DIR:-$HERE/signing}"

[ "${SKIP_WEB:-}" = 1 ] || (cd "$WEB" && npm run build:ps)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -target arm64-apple-macos13 "$HERE"/Sources/*.swift "$HERE/Helper/RebootXPC.swift" -o "$APP/Contents/MacOS/PS"
# Restart helper (Helper/rebootd.swift): shipped inside the app, registered with SMAppService only
# when the developer clicks Set up, and run by macOS only after he switches it on in Login Items & Extensions.
# It stays in Resources: codesign --deep would re-sign anything in MacOS as com.cincee.ps.
# V1.45: the signed helper is the pinned one from Helper/pinned while its code is unchanged (macOS ties its approval
# to the helper's exact cdhash, so a rebuilt helper is switched off on every Mac; tools/helper-pin.sh says why).
bash "$HERE/tools/helper-pin.sh" "$APP/Contents/Resources/rebootd" "$SIGN"
# Minecraft mode (Sources/Minecraft.swift): the offline translator (tools/translate, CTranslate2 and SentencePiece
# built once into ~/Library/Caches/ps-build) and the Latin Georgian word lists.
# The translation model is NOT in the app: PS downloads it once, on the developer's click, into Application Support.
if ! bash "$HERE/tools/translate/build-helper.sh" "$APP/Contents/Resources/PSTranslate" > "$(dirname "$APP")/translate-build.log" 2>&1; then
  echo "WARNING: the translator helper did not build (see $(dirname "$APP")/translate-build.log); Minecraft mode says so"
  rm -f "$APP/Contents/Resources/PSTranslate"
fi
mkdir -p "$APP/Contents/Resources/translate"
cp "$HERE"/translate/*.txt.gz "$APP/Contents/Resources/translate/"
mkdir -p "$APP/Contents/Library/LaunchDaemons"
cp "$HERE/Helper/com.cincee.ps.rebootd.plist" "$APP/Contents/Library/LaunchDaemons/"
# Force Touch middle click helper "PS Middle Click.app", built from ~/Projects/middle-click (the same code
# as the standalone PSMiddleClicker app) and signed there as com.cincee.ps.middleclick with the same identity.
# PS starts and stops it (Sources/MiddleClick.swift); it runs as its own process.
# V1.65: the public core carries the helper's source in mac/middle-click/ (web scripts/open-source.mjs), so a
# build from core has it too; the private tree has it next door. A tree with neither builds PS without it and says so.
MCDIR="${PS_MIDDLECLICK_DIR:-}"
if [ -z "$MCDIR" ]; then if [ -f "$HERE/middle-click/build.sh" ]; then MCDIR="$HERE/middle-click"; else MCDIR="$HERE/../middle-click"; fi; fi
if MC="$(cd "$MCDIR" 2>/dev/null && pwd)"; then
  mkdir -p "$APP/Contents/Library/LoginItems"
  PS_SIGNING_DIR="$SIGN" bash "$MC/build.sh" helper "$APP/Contents/Library/LoginItems" | grep -E "checks|Built|WARNING"
else
  echo "WARNING: no middle-click folder (mac/middle-click, or next to this one): PS is built without the Force Touch middle click helper"
fi
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
# V1.49 (the developer, 12 Nov 2026: the app is called "PS app" for everyone): Finder, the Dock, Launchpad, Spotlight, the
# menu bar and notifications read the app's name from here. Info.plist keeps "PS" (it matches the folder PS.app
# older versions made, so macOS shows this name for it; a folder a person renamed keeps its own name, and a
# fresh install is already "PS app.app"). The bundle id, the executable and the signature identity do not change.
mkdir -p "$APP/Contents/Resources/en.lproj"
cp "$HERE/ui/InfoPlist.strings" "$APP/Contents/Resources/en.lproj/InfoPlist.strings"
# The build number the updater compares (UTC yymmddHHMM, so a later build is always a bigger number).
BUILD="${PS_BUILD:-$(date -u +%y%m%d%H%M)}"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$APP/Contents/Info.plist"
# The version the developer sees, one for the Mac and the phone (web/ps-version.json): "V1.07 · Wisdom".
PSV="$(node "$WEB/scripts/ps-version.mjs")"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $(node -pe 'JSON.parse(process.argv[1]).version' "$PSV")" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :PSKeyword" "$APP/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :PSKeyword string $(node -pe 'JSON.parse(process.argv[1]).keyword' "$PSV")" "$APP/Contents/Info.plist"
# The update card and install screen (Sources/UpdateUI.swift): built in, so they work without the web files.
cp "$HERE/ui/update.html" "$APP/Contents/Resources/update.html"
# "Connect your own Supabase" (Sources/ProjectSetup.swift): its window, and the kit it sets a project up with
# (core migrations and the sign in function from web supabase/ps-core.json, each with its SHA-256).
cp "$HERE/ui/supabase.html" "$APP/Contents/Resources/supabase.html"
# V1.49: the token guide's step card (Sources/SetupGuide.swift), docked beside the browser.
cp "$HERE/ui/guide.html" "$APP/Contents/Resources/guide.html"
node "$WEB/scripts/ps-kit.mjs" "$APP/Contents/Resources/project-kit"

# V1.58 layers (core tools/assemble.mjs): an assembled tree has ps-build.json at its top (flavour, commits, the
# full profile). The app gets it and the profile as Resources/ps-build.json and Resources/profile.json. A build
# from the private tree as in V1.57 has no profile, and the app keeps its per account answers.
# V1.61: such a build still gets Resources/ps-build.json with core's feature list (tools/bundle-features.mjs), so
# Features.on knows every feature and core's defaults before the page loads. Before, it had no registry at all.
if [ -f "$HERE/../ps-build.json" ]; then
  cp "$HERE/../ps-build.json" "$APP/Contents/Resources/ps-build.json"
  node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!b.profile) process.exit(0); require("fs").writeFileSync(process.argv[2], JSON.stringify(b.profile,null,2)+"\n")' "$HERE/../ps-build.json" "$APP/Contents/Resources/profile.json"
else
  node "$HERE/tools/bundle-features.mjs" "$WEB" "$APP/Contents/Resources/ps-build.json"
fi

# Icon: to swap the logo, replace icon/icon-1024.png (or rerun icon/make-icon.swift on a new logo).
ICONSET="$(dirname "$APP")/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$HERE/icon/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$HERE/icon/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

ditto "$WEB/dist-ps" "$APP/Contents/Resources/web"
# Offline IP to country file for the network monitor (geo/README.md).
cp "$HERE/geo/ip-country.bin" "$APP/Contents/Resources/"
# Sign with the stable local identity "PS Local Signing" (self-signed, its own keychain in
# signing/, no Apple account, no admin). macOS then knows PS by "com.cincee.ps + this certificate",
# so the Accessibility permission survives rebuilds. Keychain items do NOT: with no Apple team the login
# Keychain ties each item to the exact build (a cdhash partition), so the update hands them over
# (UpdateHandoff.swift) and every Keychain call refuses to ask (KeychainQuiet.swift). Ad hoc only as a fallback.
KC="$SIGN/ps-signing.keychain-db"; ID=C0E302F2CE304D062A50D6EBDAFF97D5F7D4B6E6
if [ -f "$KC" ] && [ -f "$SIGN/.keychain-pass" ]; then
  security unlock-keychain -p "$(cat "$SIGN/.keychain-pass")" "$KC"
  # Hardened runtime (27 Oct 2026): no code can be injected into PS, so only the genuine PS can read its
  # Keychain item or take the sign in hand over (UpdateHandoff.swift). ps.entitlements lists the exceptions.
  # rebootd is already signed (tools/helper-pin.sh): signing it again here would be fine for its cdhash, but it is
  # left exactly as pinned.
  [ -f "$APP/Contents/Resources/PSTranslate" ] && codesign --force --options runtime --keychain "$KC" --sign "$ID" --identifier com.cincee.ps.translate "$APP/Contents/Resources/PSTranslate"
  # Not --deep: the middle click helper inside is already signed as itself (--deep with --identifier
  # would sign it again as com.cincee.ps). The outer signature still seals it.
  codesign --force --options runtime --entitlements "$HERE/ps.entitlements" --keychain "$KC" --sign "$ID" --identifier com.cincee.ps "$APP"
else
  echo "WARNING: signing keychain missing, signing ad hoc (Accessibility will need granting again)"
  [ -f "$APP/Contents/Resources/PSTranslate" ] && codesign --force --sign - --identifier com.cincee.ps.translate "$APP/Contents/Resources/PSTranslate"
  codesign --force --sign - --identifier com.cincee.ps "$APP"   # the middle click helper inside is already signed ad hoc
fi

codesign --verify --strict --deep "$APP"   # PS and everything inside it, helper included
if [ "${NO_INSTALL:-}" != 1 ]; then
  # A running PS that has the updater installs the new build itself: same atomic swap and roll back
  # as an update from Drive, and it hands its sign in to the new build (no new sign in for the developer).
  . "$HERE/tools/installed-app.sh"; INSTALLED="$(ps_installed_app)"   # under any name (V1.36: PS can be renamed)
  SUPPORT="$HOME/Library/Application Support/PS/update"
  handed=0
  # PS_DIRECT_INSTALL=1: straight in, around the running PS's updater (release/direct-install.sh).
  if [ "${PS_DIRECT_INSTALL:-}" = 1 ]; then bash "$HERE/release/direct-install.sh" "$APP"; handed=1
  elif [ -f "$INSTALLED/Contents/Resources/update.html" ] && pgrep -qf "$INSTALLED/Contents/MacOS/PS"; then
    mkdir -p "$SUPPORT"; rm -f "$SUPPORT/local-result.json"
    printf '{"app":"%s","web":"%s"}' "$APP" "$WEB/dist-ps" > "$SUPPORT/local-request.json"
    swiftc -O "$HERE/tools/pstool.swift" -o "$HERE/build/pstool" 2>/dev/null
    "$HERE/build/pstool" notify com.cincee.ps.installLocal
    for _ in $(seq 1 100); do [ -f "$SUPPORT/local-result.json" ] && break; sleep 0.2; done
    if grep -q '"ok":true' "$SUPPORT/local-result.json" 2>/dev/null; then
      for _ in $(seq 1 150); do grep -q '"phase":"ok"\|"phase":"rolledBack"\|"phase":"failed"' "$SUPPORT/journal.json" 2>/dev/null && break; sleep 0.4; done
      if grep -q '"phase":"ok"' "$SUPPORT/journal.json" 2>/dev/null; then handed=1; echo "PS installed the new build itself (sign in handed over)"
      else echo "WARNING: the new build did not confirm it started: $(cat "$SUPPORT/journal.json" 2>/dev/null)"; handed=1; fi
    else
      echo "PS did not take the build ($(cat "$SUPPORT/local-result.json" 2>/dev/null || echo no answer)), installing the old way"
      rm -f "$SUPPORT/local-request.json"
    fi
  fi
  if [ "$handed" != 1 ]; then
    osascript -e 'tell application id "com.cincee.ps" to quit' >/dev/null 2>&1 || true
    # Wait until it is really gone: one PS at a time (a second one quits at once).
    for _ in $(seq 1 100); do pgrep -qf "$INSTALLED/Contents/MacOS/PS" || break; sleep 0.2; done
    if [ -d "$INSTALLED" ]; then mv "$INSTALLED" "$HOME/.Trash/PS-$(date +%Y%m%d-%H%M%S).app"; fi
    ditto "$APP" "$INSTALLED"
    open -g "$INSTALLED" || true
  fi
  bash "$HERE/install-web.sh" "$WEB/dist-ps"
  echo "Installed $INSTALLED (build $BUILD)"
fi
