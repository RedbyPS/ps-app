#!/bin/bash
# Signs the G Squad phone build and writes its update note (PS V1.58, release.yml, job "sign phone").
#
# Runs with the G Squad phone key, so it runs nothing a pull request can change without the developer: only this script and
# Android's own apksigner and zipalign. The APK was built in another job that never had the key.
#
#   gsquad-sign-phone.sh <phone-unsigned folder> <out folder> <by>
#     the folder holds app-release-unsigned.apk, version.properties and notes.txt from the build job
# Env: GSQUAD_GOS_KEYSTORE (base64 of the .jks), GSQUAD_GOS_KEYSTORE_PASSWORD, GSQUAD_GOS_KEY_ALIAS,
#      GSQUAD_GOS_KEY_PASSWORD (secrets); GSQUAD_GOS_CERT_SHA256 (a variable: the certificate's SHA-256, the same
#      value the app pins, so a wrong key stops here).
# Writes <out>/gos-release/: version.json and ps-gos-<version>.apk (the files the phone asks GitHub for).
set -euo pipefail
IN="$(cd "${1:?phone-unsigned folder}" && pwd)"; OUT="${2:?out folder}"; BY="${3:?by}"
: "${GSQUAD_GOS_KEYSTORE:?secret GSQUAD_GOS_KEYSTORE is not set}"
: "${GSQUAD_GOS_KEYSTORE_PASSWORD:?secret GSQUAD_GOS_KEYSTORE_PASSWORD is not set}"
: "${GSQUAD_GOS_KEY_ALIAS:?secret GSQUAD_GOS_KEY_ALIAS is not set}"
: "${GSQUAD_GOS_KEY_PASSWORD:?secret GSQUAD_GOS_KEY_PASSWORD is not set}"
: "${GSQUAD_GOS_CERT_SHA256:?variable GSQUAD_GOS_CERT_SHA256 is not set}"
: "${ANDROID_HOME:?ANDROID_HOME is not set}"
BT="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
WORK="${RUNNER_TEMP:-$(mktemp -d)}/gsquad-phone"
rm -rf "$WORK"; mkdir -p "$WORK" "$OUT/gos-release"
trap 'rm -f "$WORK/ks.jks"' EXIT

UNSIGNED="$IN/app-release-unsigned.apk"
[ -f "$UNSIGNED" ] || { echo "STOP: no app-release-unsigned.apk from the build"; exit 1; }
CODE="$(sed -n 's/^code=//p' "$IN/version.properties")"
NAME="$(sed -n 's/^name=//p' "$IN/version.properties")"
KEYWORD="$(sed -n 's/^keyword=//p' "$IN/version.properties")"
NUM="${NAME#V}"
[[ "$CODE" =~ ^[0-9]+$ ]] && [[ "$NUM" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "STOP: version.properties is not stamped ($CODE, $NAME)"; exit 1; }
FILE="ps-gos-$NUM.apk"

# Already aligned by Gradle; aligned here only if it is not (signing must come after aligning).
ALIGNED="$WORK/aligned.apk"
if "$BT/zipalign" -c 4 "$UNSIGNED" > /dev/null 2>&1; then cp "$UNSIGNED" "$ALIGNED"; else "$BT/zipalign" -f 4 "$UNSIGNED" "$ALIGNED"; fi

( umask 077; printf '%s' "$GSQUAD_GOS_KEYSTORE" | base64 --decode > "$WORK/ks.jks" )
APK="$OUT/gos-release/$FILE"
# The same scheme as the phone's own signing config: v2 and v3, no v1.
"$BT/apksigner" sign --ks "$WORK/ks.jks" --ks-key-alias "$GSQUAD_GOS_KEY_ALIAS" \
  --ks-pass env:GSQUAD_GOS_KEYSTORE_PASSWORD --key-pass env:GSQUAD_GOS_KEY_PASSWORD \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
  --out "$APK" "$ALIGNED"
rm -f "$WORK/ks.jks"

# The same checks as phone/scripts/release.sh: exactly the pinned key, and no test hook in a release build.
CERT="$("$BT/apksigner" verify --print-certs "$APK" | grep 'certificate SHA-256 digest' | head -1 | awk '{print $NF}')"
PIN="$(printf '%s' "$GSQUAD_GOS_CERT_SHA256" | tr -d ': ' | tr 'A-F' 'a-f')"
[ "$CERT" = "$PIN" ] || { echo "STOP: signed with $CERT, the app pins $PIN"; exit 1; }
if "$BT/aapt2" dump xmltree "$APK" --file AndroidManifest.xml | grep -q DebugHooks; then echo "STOP: a debug hook in a release build"; exit 1; fi

# The phone's update note, as phone/scripts/release.sh writes it, plus who made it and which build it is for.
SHA="$(shasum -a 256 "$APK" | cut -d' ' -f1)"; SIZE="$(wc -c < "$APK" | tr -d ' ')"
NOTES="$(cat "$IN/notes.txt" 2>/dev/null || true)"
HIST="$(cat "$IN/history.json" 2>/dev/null || echo '[]')"
node -e 'const [code,name,keyword,apk,sha,size,cert,notes,hist,by]=process.argv.slice(1);
let h=[];try{h=JSON.parse(hist||"[]")}catch{}
const bad=/[\u2013\u2014<>]/;
if(bad.test(notes)){console.error("STOP: a long dash or HTML in the notes");process.exit(1)}
h=(Array.isArray(h)?h:[]).filter(x=>x&&/^\d{1,3}\.\d{1,3}$/.test(String(x.version))&&Array.isArray(x.notes)&&x.notes.length>0&&x.notes.length<=6&&x.notes.every(n=>typeof n==="string"&&n.trim()&&n.length<=220&&!bad.test(n))&&!bad.test(String(x.keyword||""))).slice(0,20).map(x=>({version:String(x.version),keyword:String(x.keyword||""),notes:x.notes.map(n=>n.trim())}));
const o={versionCode:+code,versionName:name,keyword,apk,sha256:sha,size:+size,cert,notes,released:new Date().toISOString(),flavour:"gsquad",by};if(h.length)o.history=h;
process.stdout.write(JSON.stringify(o,null,1))' \
  "$CODE" "$NAME" "$KEYWORD" "$FILE" "$SHA" "$SIZE" "$CERT" "$NOTES" "$HIST" "$BY" > "$OUT/gos-release/version.json"
echo "phone: $NAME ($KEYWORD), code $CODE, $FILE, signed by $CERT"
