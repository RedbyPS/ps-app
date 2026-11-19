#!/bin/bash
# PS GOS release. Builds a signed APK from the same web code as the website and PS on the Mac,
# checks it, and leaves it where the next website deploy picks it up. It deploys NOTHING itself:
# the manager runs `npm run release` in ~/Projects/ps/web, which publishes
# cincee.com/client/gos/ (unlisted, noindex) together with the website, and (V1.71) for a tree with
# a layer profile also the maker's own channel folder, the one this APK then asks for updates.
#
#   scripts/release.sh "What changed, in plain words"
#
# Needs the signing key in ~/.ps-gos-signing/ (outside git; back it up, see docs/release.md).
set -euo pipefail
cd "$(dirname "$0")/.."
NOTES="${1:-}"
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
export ANDROID_HOME=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
SIGN=$HOME/.ps-gos-signing/keystore.properties
STAGE=../web/gos-release
DRIVE="$HOME/YOUR_SYNC_FOLDER/PS App/GOS"

[ -f "$SIGN" ] || { echo "No signing key in ~/.ps-gos-signing. Stop."; exit 1; }
PIN=$(grep '^certSha256=' "$SIGN" | cut -d= -f2)

# 1. web's COMMITTED code only (a clean worktree of HEAD): other sessions' unfinished
#    edits in that folder never reach the developer's phone. The version comes from there too.
CLEAN=$(mktemp -d)/web
git -C ../web worktree add -q --detach "$CLEAN" HEAD
trap 'git -C ../web worktree remove --force "$CLEAN" 2>/dev/null || true' EXIT
ln -s "$(cd ../web && pwd)/node_modules" "$CLEAN/node_modules"
cp ../web/.env "$CLEAN/.env"
echo "web from web $(git -C ../web rev-parse --short HEAD) (committed code only)"

# 1b. V1.71: the maker's own update channel, for the phone too (the developer, 19 Nov 2026: his phone never got the own channel
#     his Macs follow since V1.69, kept asking the G Squad channel on GitHub and refused every APK there, which is
#     signed with the G Squad key). A web tree with a layer profile (the developer's: ps-layer/profile.json, committed) gives
#     this build that profile as assets/profile.json (-PpsProfile), so the phone asks that channel only, and the note
#     is made for it. A profile whose channel cannot be used stops here, before anything changes, and so does an APK
#     that comes out without it (step 4): never a quiet fall back to the G Squad channel.
PROFILE="$CLEAN/ps-layer/profile.json"
OWN_URL=""; OWN_NAME=""
if [ -f "$PROFILE" ]; then
  OWN_URL="$(node "$CLEAN/scripts/own-channel.mjs" url "$PROFILE")" && [ -n "$OWN_URL" ] || { echo "STOP: ps-layer/profile.json has no usable own update channel, so this phone build would ask the G Squad channel. Nothing was built."; exit 1; }
  OWN_NAME="$(node "$CLEAN/scripts/own-channel.mjs" name "$PROFILE")"
  if [ -n "${PS_UPDATE_CHANNEL:-}" ] && [ "$PS_UPDATE_CHANNEL" != "$OWN_NAME" ]; then
    echo "STOP: this release was asked for the $PS_UPDATE_CHANNEL channel, but the committed layer profile is $OWN_NAME's. Nothing was built."; exit 1
  fi
  PS_UPDATE_CHANNEL="$OWN_NAME"
  echo "own update channel: $OWN_NAME (the phone asks only there)"
elif [ -n "${PS_UPDATE_CHANNEL:-}" ] && [ "$PS_UPDATE_CHANNEL" != gsquad ]; then
  echo "STOP: a release for the $PS_UPDATE_CHANNEL channel needs that person's layer profile in the committed web tree (ps-layer/profile.json). Nothing was built."; exit 1
fi

# 2. Version. ONE PS version for the Mac and the phone (the developer, 27 Oct 2026): the name and its keyword
#    come from web's ps-version.json (the manager bumps it; this only reads it), e.g.
#    "V1.07" and "Wisdom". versionCode is the phone's own counter and always goes up, so a re-spin of
#    the same version gets a new code and a file name with -b<code>.
V=$(node "$CLEAN/scripts/ps-version.mjs")
NUM=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).version)' "$V")
KEYWORD=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).keyword || "")' "$V")
NAME="V$NUM"
CODE=$(( $(grep '^code=' version.properties | cut -d= -f2) + 1 ))
PREV=$(node -e 'try{process.stdout.write(require(process.argv[1]).versionName||"")}catch{}' "$PWD/release/version.json")
FILE="ps-gos-$NUM.apk"; [ "$PREV" = "$NAME" ] && FILE="ps-gos-$NUM-b$CODE.apk"
printf 'code=%s\nname=%s\nkeyword=%s\n' "$CODE" "$NAME" "$KEYWORD" > version.properties
echo "version: $NAME ($KEYWORD), code $CODE, file $FILE"

# 3. The real web build (never the fictional test data).
WEB_DIR="$CLEAN" ./scripts/build-web.sh
if [ -e app/src/main/assets/client/FICTIONAL-TEST-DATA ] || ls app/src/main/assets/client/assets/fake-*.js >/dev/null 2>&1; then
  echo "The web files contain fictional test data. Stop."; exit 1
fi

# 3. Signed release build.
./gradlew -q clean assembleRelease ${OWN_URL:+"-PpsProfile=$PROFILE"}
APK=app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || { echo "No release APK was built. Stop."; exit 1; }

# 4. Check the signature is exactly PS's release key and the APK holds no test hook.
CERT=$("$BT/apksigner" verify --print-certs "$APK" | grep 'certificate SHA-256 digest' | head -1 | awk '{print $NF}')
[ "$CERT" = "$PIN" ] || { echo "Signed with the wrong key ($CERT). Stop."; exit 1; }
if "$BT/aapt2" dump xmltree "$APK" --file AndroidManifest.xml | grep -q DebugHooks; then echo "Debug hook in a release build. Stop."; exit 1; fi
# V1.71: with an own channel, the APK must carry exactly the layer profile (else the phone would ask the G Squad channel).
if [ -n "$OWN_URL" ]; then ./scripts/apk-profile.sh "$APK" "$PROFILE" || { echo "The APK does not carry the layer profile. Stop."; exit 1; }; fi

# 5. The file and its manifest.
OUT=release/$FILE
mkdir -p release
cp "$APK" "$OUT"
SHA=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
SIZE=$(stat -f%z "$OUT")
# V1.52: "history" = the approved notes of the earlier versions (last 20, newest first), so an update across several
# versions shows every skipped one. The developer's approved words only (ps-public.mjs history-json), checked again here; old
# phones read only the keys they know, so it never breaks them.
HIST="${PS_HISTORY:-$(node "$CLEAN/scripts/ps-public.mjs" history-json 2>/dev/null || echo '[]')}"
# V1.58: who made the release ("by", "shared": from ps-version.json) and the channel it is for ("channel", PS_UPDATE_CHANNEL,
# default gsquad, today's). Phones read only the keys they know, so older ones simply skip them.
BY=$(node -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(typeof v.by==="string"?v.by:"")' "$V")
SHARED=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).shared===false?"false":"true")' "$V")
CHANNEL="${PS_UPDATE_CHANNEL:-gsquad}"
node -e 'const [code,name,keyword,apk,sha,size,cert,notes,hist,by,shared,channel]=process.argv.slice(1);
let h=[];try{h=JSON.parse(hist||"[]")}catch{}
const bad=/[\u2013\u2014<>]/;
h=(Array.isArray(h)?h:[]).filter(x=>x&&/^\d{1,3}\.\d{1,3}$/.test(String(x.version))&&Array.isArray(x.notes)&&x.notes.length>0&&x.notes.length<=6&&x.notes.every(n=>typeof n==="string"&&n.trim()&&n.length<=220&&!bad.test(n))&&!bad.test(String(x.keyword||""))).slice(0,20).map(x=>({version:String(x.version),keyword:String(x.keyword||""),notes:x.notes.map(n=>n.trim()),...(typeof x.by==="string"&&/^[a-z][a-z0-9-]{0,30}$/.test(x.by)?{by:x.by,shared:x.shared!==false}:{})}));
const o={versionCode:+code,versionName:name,keyword,apk,sha256:sha,size:+size,cert,notes,released:new Date().toISOString()};if(h.length)o.history=h;
if(!/^[a-z][a-z0-9-]{0,30}$/.test(channel)){console.error("PS_UPDATE_CHANNEL must be gsquad or a profile name");process.exit(1)}
if(shared==="false"&&channel==="gsquad"){console.error("A private release is never made for the G Squad channel");process.exit(1)}
o.channel=channel;if(/^[a-z][a-z0-9-]{0,30}$/.test(by)){o.by=by;o.shared=shared!=="false"}
process.stdout.write(JSON.stringify(o,null,1))' \
  "$CODE" "$NAME" "$KEYWORD" "$FILE" "$SHA" "$SIZE" "$CERT" "$NOTES" "$HIST" "$BY" "$SHARED" "$CHANNEL" > release/version.json

# 6. Staged for the website (only the newest APK; gitignored there) and a copy in Google Drive.
mkdir -p "$STAGE"
rm -f "$STAGE"/ps-gos-*.apk
cp "$OUT" release/version.json "$STAGE/"
if [ -d "$(dirname "$(dirname "$DRIVE")")" ]; then mkdir -p "$DRIVE" && rm -f "$DRIVE"/ps-gos-*.apk && cp "$OUT" "$DRIVE/" && echo "Copied to Google Drive: YOUR_SYNC_FOLDER/PS App/GOS/$FILE"
else echo "Google Drive folder not found: copy $OUT by hand."; fi

git add version.properties && git commit -q -m "PS GOS $NAME" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- version.properties || true
if [ -n "$OWN_URL" ]; then
  echo "Ready: PS GOS $NAME · $KEYWORD, code $CODE, $FILE ($SIZE bytes, sha256 $SHA), for $OWN_NAME's own channel. Not deployed: the manager's next release publishes it in that channel's folder (gos-version.json, what this build asks for) and at cincee.com/client/gos/ (V1.56 and older)."
else
  echo "Ready: PS GOS $NAME · $KEYWORD, code $CODE, $FILE ($SIZE bytes, sha256 $SHA). Not deployed: the manager's next release publishes it on GitHub (gos-version.json, what V1.57 and newer read) and at cincee.com/client/gos/ (V1.56 and older)."
fi
